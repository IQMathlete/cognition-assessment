import { db, type Tx } from "@/platform/db";
import { withAudit } from "@/platform/audit";
import {
  createApprovalRequest,
  decideApproval,
  registerApprovalHooks,
} from "@/platform/approvals";
import { requirePermission } from "@/platform/rbac";
import { resolveActor } from "@/platform/actor";
import {
  ConflictError,
  HookRefusalError,
  NotFoundError,
  ValidationError,
} from "@/platform/errors";
import { MockPaymentsClient, type PaymentsClient } from "./payments";

export const SMALL_REFUND_LIMIT_CENTS = 25000; // $250

// Refunds at or under $250 are decided by a support lead; anything larger
// routes to a finance approver. Routing is cumulative-aware: once pending
// refunds on the transaction would push the running total past the limit,
// further requests escalate to finance — so a large refund cannot be
// smuggled through as small slices.
export function requiredRoleForRefund(
  amountCents: number,
  committedCents = 0,
): string {
  return committedCents + amountCents <= SMALL_REFUND_LIMIT_CENTS
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

export async function searchTransactions(
  user: { id: string; role: string } | null,
  query?: string,
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "refunds:read");
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
  user: { id: string; role: string } | null,
  input: { transactionId: string; amountCents: number; reason: string },
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "refunds:create");
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("A reason is required.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ValidationError("Refund amount must be a positive number.");
  }

  return withAudit(actor.id, async (tx) => {
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
        requestedById: actor.id,
        status: "requested",
      },
    });
    // createApprovalRequest writes its own approval.requested audit row.
    const approval = await createApprovalRequest(tx, {
      requesterId: actor.id,
      requiredRole: requiredRoleForRefund(input.amountCents, committed),
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
      audit: {
        action: "refund.requested",
        entityType: "refund",
        entityId: refund.id,
        after: value,
      },
    };
  });
}

/** Approving or rejecting a refund request. Role checks live in decideApproval. */
export async function decideRefund(
  user: { id: string; role: string } | null,
  input: { approvalRequestId: string; approve: boolean; note?: string },
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "refunds:approve");
  const request = await db.approvalRequest.findUnique({
    where: { id: input.approvalRequestId },
  });
  if (!request) throw new NotFoundError("Approval request not found.");
  if (request.entityType !== "refund") {
    throw new ValidationError("Not a refund approval request.");
  }
  return decideApproval({
    requestId: request.id,
    decider: actor,
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
  id?: string;
  entityId: string;
  decidedById: string | null;
}) {
  const actorId = request.decidedById ?? "system";

  // Approve inside a single transaction that re-verifies the decision's
  // linkage and the refundable balance: the reservation is made atomically
  // with the status change, so crafted or racing approvals cannot execute
  // an over-refund.
  const refund = await withAudit(actorId, async (tx) => {
    const before = await tx.refund.findUniqueOrThrow({
      where: { id: request.entityId },
      include: { transaction: true },
    });

    // Only the refund's own linked approval request may execute it — a
    // request crafted by another path must not move money.
    if (before.approvalRequestId !== request.id) {
      throw new HookRefusalError(
        "Approval request is not linked to this refund.",
      );
    }
    if (!REFUND_TRANSITIONS[before.status]?.includes("approved")) {
      throw new ConflictError(
        `Refund cannot transition ${before.status} -> approved.`,
      );
    }
    if (before.transaction.status !== "settled") {
      const failed = await tx.refund.update({
        where: { id: before.id },
        data: {
          status: "failed",
          failureReason: "Transaction is no longer settled.",
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
    // A transport-level failure marks the refund failed (audited) and
    // propagates so the decider sees the execution problem.
    await setRefundStatus(actorId, refund.refund.id, "failed", {
      failureReason: `Payments client error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
    throw e;
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

export async function listRefunds(
  user: { id: string; role: string } | null,
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "refunds:read");
  return db.refund.findMany({
    include: { transaction: true, requestedBy: true },
    orderBy: { createdAt: "desc" },
  });
}

// Plug into the approvals primitive. Living in this module (not the barrel
// file) means any import path that can reach the service also registers the
// hooks — an approval can never land without its execution callbacks.
//
// requiredPermission makes deciding impossible for roles that merely share
// a name with requiredRole; validateEntity keeps decisions on dangling
// entities from committing at all.
registerApprovalHooks("refund", {
  requiredPermission: "refunds:approve",
  validateEntity: async (tx: Tx, request) => {
    const refund = await tx.refund.findUnique({
      where: { id: request.entityId },
    });
    if (!refund) throw new NotFoundError("Refund not found.");
  },
  onApproved: onRefundApproved,
  onRejected: onRefundRejected,
});
