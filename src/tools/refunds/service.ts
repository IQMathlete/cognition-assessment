import { db } from "@/platform/db";
import { withAudit } from "@/platform/audit";
import { createApprovalRequest, decideApproval } from "@/platform/approvals";
import { requirePermission } from "@/platform/rbac";
import { NotFoundError, ValidationError } from "@/platform/errors";
import { MockPaymentsClient, type PaymentsClient } from "./payments";

export const SMALL_REFUND_LIMIT_CENTS = 25000; // $250

// Refunds at or under $250 are decided by a support lead; anything larger
// routes to a finance approver.
export function requiredRoleForRefund(amountCents: number): string {
  return amountCents <= SMALL_REFUND_LIMIT_CENTS
    ? "support_lead"
    : "finance_approver";
}

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
    if (input.amountCents > transaction.amountCents) {
      throw new ValidationError(
        "Refund cannot exceed the original transaction amount.",
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
  const refund = await db.refund.findUniqueOrThrow({
    where: { id: request.entityId },
    include: { transaction: true },
  });

  await setRefundStatus(actorId, refund.id, "approved");

  const result = await paymentsClient.refund({
    transactionExternalId: refund.transaction.externalId,
    amountCents: refund.amountCents,
    currency: refund.transaction.currency,
    idempotencyKey: refund.id,
  });

  await setRefundStatus(
    actorId,
    refund.id,
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
