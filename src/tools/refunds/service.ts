import { db } from "@/platform/db";
import { withAudit } from "@/platform/audit";
import {
  createApprovalRequest,
  decideApproval,
  registerApprovalHooks,
} from "@/platform/approvals";
import { requirePermission } from "@/platform/rbac";
import { ConflictError, NotFoundError, ValidationError } from "@/platform/errors";
import { MockPaymentsClient, type PaymentsClient } from "./payments";

export const SMALL_REFUND_LIMIT_CENTS = 25000; // $250

// Refunds at or under $250 are decided by a support lead; anything larger
// routes to a finance approver.
export function requiredRoleForRefund(amountCents: number): string {
  return amountCents <= SMALL_REFUND_LIMIT_CENTS
    ? "support_lead"
    : "finance_approver";
}

// Statuses that reserve money against a transaction. Rejected and failed
// refunds free their amount for a retry.
const COMMITTED_STATUSES = ["requested", "approved", "executed"] as const;

const REFUND_TRANSITIONS: Record<string, readonly string[]> = {
  requested: ["approved", "rejected", "failed"],
  approved: ["executed", "failed"],
  rejected: [],
  executed: [],
  failed: [],
};

let paymentsClient: PaymentsClient = new MockPaymentsClient();

/** Test seam — inject a stub PaymentsClient. */
export function setPaymentsClient(client: PaymentsClient): void {
  paymentsClient = client;
}

type Actor = { id: string; role: string };

export async function searchTransactions(user: Actor, query?: string) {
  requirePermission(user, "refunds:read");
  const q = query?.trim();
  return db.transaction.findMany({
    where: q
      ? {
          OR: [
            { externalId: { contains: q } },
            { merchant: { contains: q } },
            { cardholder: { contains: q } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
  });
}

export async function requestRefund(
  user: Actor,
  input: { transactionId: string; amountCents: number; reason: string },
) {
  requirePermission(user, "refunds:create");
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("A reason is required.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ValidationError("Refund amount must be a positive number.");
  }

  return withAudit(user.id, async (tx) => {
    const transaction = await tx.transaction.findUnique({
      where: { id: input.transactionId },
    });
    if (!transaction) throw new NotFoundError("Transaction not found.");
    if (transaction.status !== "settled") {
      throw new ValidationError(
        "Only settled transactions can be refunded.",
      );
    }
    if (input.amountCents > transaction.amountCents) {
      throw new ValidationError(
        "Refund cannot exceed the original transaction amount.",
      );
    }

    // Over-refund guard: outstanding refunds (requested/approved/executed)
    // reserve money against the transaction, so several smaller refunds
    // cannot together exceed what was paid.
    const committed =
      (
        await tx.refund.aggregate({
          _sum: { amountCents: true },
          where: {
            transactionId: transaction.id,
            status: { in: [...COMMITTED_STATUSES] },
          },
        })
      )._sum.amountCents ?? 0;
    if (committed + input.amountCents > transaction.amountCents) {
      throw new ValidationError(
        "Refunds against this transaction already reserve its full amount.",
      );
    }

    const refund = await tx.refund.create({
      data: {
        transactionId: transaction.id,
        amountCents: input.amountCents,
        reason,
        requestedById: user.id,
        status: "requested",
      },
    });
    const approval = await createApprovalRequest(tx, {
      requesterId: user.id,
      requiredRole: requiredRoleForRefund(input.amountCents),
      entityType: "refund",
      entityId: refund.id,
      reason,
    });
    const value = await tx.refund.update({
      where: { id: refund.id },
      data: { approvalRequestId: approval.id },
    });

    return {
      value,
      audit: [
        {
          action: "refund.requested",
          entityType: "refund",
          entityId: refund.id,
          after: value,
        },
        {
          action: "approval.requested",
          entityType: "approval_request",
          entityId: approval.id,
          after: approval,
        },
      ],
    };
  });
}

/** Approving or rejecting a refund request. Role checks live in decideApproval. */
export async function decideRefund(
  user: Actor,
  input: { approvalRequestId: string; approve: boolean; note?: string },
) {
  requirePermission(user, "refunds:approve");
  const request = await db.approvalRequest.findUnique({
    where: { id: input.approvalRequestId },
  });
  if (!request) throw new NotFoundError("Approval request not found.");
  if (request.entityType !== "refund") {
    throw new ValidationError("Not a refund approval request.");
  }
  return decideApproval({
    requestId: request.id,
    decider: user,
    approve: input.approve,
    note: input.note,
  });
}

async function setRefundStatus(
  actorId: string,
  refundId: string,
  to: string,
  extra: { paymentRefundId?: string; failureReason?: string } = {},
) {
  return withAudit(actorId, async (tx) => {
    const before = await tx.refund.findUniqueOrThrow({
      where: { id: refundId },
    });
    if (!REFUND_TRANSITIONS[before.status]?.includes(to)) {
      throw new ConflictError(
        `Refund cannot transition ${before.status} -> ${to}.`,
      );
    }
    const after = await tx.refund.update({
      where: { id: refundId },
      data: { status: to, ...extra },
    });
    return {
      value: after,
      audit: {
        action: "refund.status",
        entityType: "refund",
        entityId: refundId,
        before,
        after,
      },
    };
  });
}

// --- Approval hooks (registered by src/tools/refunds/index.ts) --------------

export async function onRefundApproved(request: {
  entityId: string;
  decidedById: string | null;
}) {
  const actorId = request.decidedById ?? "system";

  // Approve inside a single transaction that re-checks the refundable
  // balance: requests committed after this refund was created may have
  // consumed it, so the reservation is made atomically with the status
  // change and over-refund is impossible even under concurrent approvals.
  const refund = await withAudit(actorId, async (tx) => {
    const before = await tx.refund.findUniqueOrThrow({
      where: { id: request.entityId },
      include: { transaction: true },
    });
    if (!REFUND_TRANSITIONS[before.status]?.includes("approved")) {
      throw new ConflictError(
        `Refund cannot transition ${before.status} -> approved.`,
      );
    }

    const committedByOthers =
      (
        await tx.refund.aggregate({
          _sum: { amountCents: true },
          where: {
            transactionId: before.transactionId,
            status: { in: ["approved", "executed"] },
            id: { not: before.id },
          },
        })
      )._sum.amountCents ?? 0;

    if (
      before.amountCents >
      before.transaction.amountCents - committedByOthers
    ) {
      const failed = await tx.refund.update({
        where: { id: before.id },
        data: {
          status: "failed",
          failureReason:
            "Refund would exceed the transaction's remaining refundable amount.",
        },
      });
      return {
        value: { refund: failed, transaction: before.transaction, proceed: false },
        audit: {
          action: "refund.status",
          entityType: "refund",
          entityId: before.id,
          before,
          after: failed,
        },
      };
    }

    const approved = await tx.refund.update({
      where: { id: before.id },
      data: { status: "approved" },
    });
    return {
      value: { refund: approved, transaction: before.transaction, proceed: true },
      audit: {
        action: "refund.status",
        entityType: "refund",
        entityId: before.id,
        before,
        after: approved,
      },
    };
  });

  if (!refund.proceed) return;

  let result;
  try {
    result = await paymentsClient.refund({
      transactionExternalId: refund.transaction.externalId,
      amountCents: refund.refund.amountCents,
      currency: refund.transaction.currency,
      idempotencyKey: refund.refund.id,
    });
  } catch (e) {
    result = {
      ok: false as const,
      failureReason: `Payments client error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  await setRefundStatus(
    actorId,
    refund.refund.id,
    result.ok ? "executed" : "failed",
    result.ok
      ? { paymentRefundId: result.paymentRefundId }
      : { failureReason: result.failureReason },
  );
}

export async function onRefundRejected(request: {
  entityId: string;
  decidedById: string | null;
}) {
  await setRefundStatus(request.decidedById ?? "system", request.entityId, "rejected");
}

export async function listRefunds(user: Actor) {
  requirePermission(user, "refunds:read");
  return db.refund.findMany({
    include: { transaction: true, requestedBy: true },
    orderBy: { createdAt: "desc" },
  });
}

// Plug into the approvals primitive. Living in this module (not the barrel
// file) means any import path that can reach the service also registers the
// hooks — an approval can never land without its execution callbacks.
registerApprovalHooks("refund", {
  onApproved: onRefundApproved,
  onRejected: onRefundRejected,
});
