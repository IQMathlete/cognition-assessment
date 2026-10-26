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
import { MockScreeningClient, type ScreeningClient } from "./screening";

export const HIGH_RISK_SCORE = 70;

// Standard cases are decided by a kyc_senior; high-risk applicants escalate to
// the finance_approver, which stands in for the financial-crimes committee a
// real deployment would route to. Mirrors the refunds amount threshold.
export function requiredRoleForReview(riskScore: number): string {
  return riskScore < HIGH_RISK_SCORE ? "kyc_senior" : "finance_approver";
}

// Statuses that reserve the case for a review in flight. Rejected and failed
// reviews free the case for a retry.
const ACTIVE_STATUSES = ["requested", "approved"] as const;

const REVIEW_TRANSITIONS: Record<string, readonly string[]> = {
  requested: ["approved", "rejected", "failed"],
  approved: ["executed", "failed"],
  rejected: [],
  executed: [],
  failed: [],
};

const REVIEW_RECOMMENDATIONS = ["verify", "reject"] as const;
export type ReviewRecommendation = (typeof REVIEW_RECOMMENDATIONS)[number];

let screeningClient: ScreeningClient = new MockScreeningClient();

/** Test seam — inject a stub ScreeningClient. */
export function setScreeningClient(client: ScreeningClient): void {
  screeningClient = client;
}

export async function searchCases(
  user: { id: string; role: string } | null,
  query?: string,
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "kyc:read");
  const q = query?.trim();
  return db.kycCase.findMany({
    where: q
      ? {
          OR: [
            { externalId: { contains: q } },
            { applicant: { contains: q } },
            { country: { contains: q } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
  });
}

export async function requestReview(
  user: { id: string; role: string } | null,
  input: { caseId: string; recommendation: string; reason: string },
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "kyc:create");
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("A reason is required.");
  if (
    !(REVIEW_RECOMMENDATIONS as readonly string[]).includes(
      input.recommendation,
    )
  ) {
    throw new ValidationError("Recommendation must be verify or reject.");
  }

  return withAudit(actor.id, async (tx) => {
    const kycCase = await tx.kycCase.findUnique({
      where: { id: input.caseId },
    });
    if (!kycCase) throw new NotFoundError("KYC case not found.");
    if (kycCase.status !== "pending") {
      throw new ValidationError(
        "Only pending cases can be submitted for review.",
      );
    }

    // One active review per case: an outstanding requested/approved review
    // already reserves the decision, so a second request cannot race it.
    const active = await tx.kycReview.count({
      where: { caseId: kycCase.id, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (active > 0) {
      throw new ValidationError(
        "This case already has a review in flight.",
      );
    }

    const review = await tx.kycReview.create({
      data: {
        caseId: kycCase.id,
        recommendation: input.recommendation,
        reason,
        requestedById: actor.id,
        status: "requested",
      },
    });
    // createApprovalRequest writes its own approval.requested audit row.
    const approval = await createApprovalRequest(tx, {
      requesterId: actor.id,
      requiredRole: requiredRoleForReview(kycCase.riskScore),
      entityType: "kyc_review",
      entityId: review.id,
      reason,
    });
    const value = await tx.kycReview.update({
      where: { id: review.id },
      data: { approvalRequestId: approval.id },
    });

    return {
      value,
      audit: {
        action: "kyc_review.requested",
        entityType: "kyc_review",
        entityId: review.id,
        after: value,
      },
    };
  });
}

/** Approving or rejecting a review request. Role checks live in decideApproval. */
export async function decideReview(
  user: { id: string; role: string } | null,
  input: { approvalRequestId: string; approve: boolean; note?: string },
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "kyc:approve");
  const request = await db.approvalRequest.findUnique({
    where: { id: input.approvalRequestId },
  });
  if (!request) throw new NotFoundError("Approval request not found.");
  if (request.entityType !== "kyc_review") {
    throw new ValidationError("Not a KYC review approval request.");
  }
  return decideApproval({
    requestId: request.id,
    decider: actor,
    approve: input.approve,
    note: input.note,
  });
}

async function setReviewStatus(
  actorId: string,
  reviewId: string,
  to: string,
  extra: { screeningResultId?: string; failureReason?: string } = {},
) {
  return withAudit(actorId, async (tx) => {
    const before = await tx.kycReview.findUniqueOrThrow({
      where: { id: reviewId },
    });
    if (!REVIEW_TRANSITIONS[before.status]?.includes(to)) {
      throw new ConflictError(
        `Review cannot transition ${before.status} -> ${to}.`,
      );
    }
    const after = await tx.kycReview.update({
      where: { id: reviewId },
      data: { status: to, ...extra },
    });
    return {
      value: after,
      audit: {
        action: "kyc_review.status",
        entityType: "kyc_review",
        entityId: reviewId,
        before,
        after,
      },
    };
  });
}

// --- Approval hooks ---------------------------------------------------------

export async function onReviewApproved(request: {
  id?: string;
  entityId: string;
  decidedById: string | null;
}) {
  const actorId = request.decidedById ?? "system";

  // Approve inside a single transaction that re-verifies the decision's
  // linkage and that the case is still awaiting a verdict, so crafted or
  // racing approvals cannot apply a decision to a closed case.
  const review = await withAudit(actorId, async (tx) => {
    const before = await tx.kycReview.findUniqueOrThrow({
      where: { id: request.entityId },
      include: { case: true },
    });

    // Only the review's own linked approval request may execute it.
    if (before.approvalRequestId !== request.id) {
      throw new HookRefusalError(
        "Approval request is not linked to this review.",
      );
    }
    if (!REVIEW_TRANSITIONS[before.status]?.includes("approved")) {
      throw new ConflictError(
        `Review cannot transition ${before.status} -> approved.`,
      );
    }
    if (before.case.status !== "pending") {
      const failed = await tx.kycReview.update({
        where: { id: before.id },
        data: {
          status: "failed",
          failureReason: "Case is no longer pending.",
        },
      });
      return {
        value: { review: failed, kycCase: before.case, proceed: false },
        audit: {
          action: "kyc_review.status",
          entityType: "kyc_review",
          entityId: before.id,
          before,
          after: failed,
        },
      };
    }

    const approved = await tx.kycReview.update({
      where: { id: before.id },
      data: { status: "approved" },
    });
    return {
      value: { review: approved, kycCase: before.case, proceed: true },
      audit: {
        action: "kyc_review.status",
        entityType: "kyc_review",
        entityId: before.id,
        before,
        after: approved,
      },
    };
  });

  if (!review.proceed) return;

  let result;
  try {
    result = await screeningClient.submitVerdict({
      caseExternalId: review.kycCase.externalId,
      verdict: review.review.recommendation as ReviewRecommendation,
      idempotencyKey: review.review.id,
    });
  } catch (e) {
    // A transport-level failure marks the review failed (audited) and
    // propagates so the decider sees the execution problem.
    await setReviewStatus(actorId, review.review.id, "failed", {
      failureReason: `Screening client error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
    throw e;
  }

  if (result.ok) {
    // Verdict lands on the case in the same transaction that closes the
    // review — the two can never disagree.
    await withAudit(actorId, async (tx) => {
      const before = await tx.kycReview.findUniqueOrThrow({
        where: { id: review.review.id },
      });
      if (!REVIEW_TRANSITIONS[before.status]?.includes("executed")) {
        throw new ConflictError(
          `Review cannot transition ${before.status} -> executed.`,
        );
      }
      const beforeCase = await tx.kycCase.findUniqueOrThrow({
        where: { id: before.caseId },
      });
      const caseStatus =
        before.recommendation === "verify" ? "verified" : "rejected";
      const after = await tx.kycReview.update({
        where: { id: before.id },
        data: { status: "executed", screeningResultId: result.screeningResultId },
      });
      const afterCase = await tx.kycCase.update({
        where: { id: beforeCase.id },
        data: { status: caseStatus },
      });
      return {
        value: after,
        audit: [
          {
            action: "kyc_review.status",
            entityType: "kyc_review",
            entityId: before.id,
            before,
            after,
          },
          {
            action: "kyc_case.status",
            entityType: "kyc_case",
            entityId: beforeCase.id,
            before: beforeCase,
            after: afterCase,
          },
        ],
      };
    });
  } else {
    await setReviewStatus(actorId, review.review.id, "failed", {
      failureReason: result.failureReason,
    });
  }
}

export async function onReviewRejected(request: {
  id?: string;
  entityId: string;
  decidedById: string | null;
}) {
  // Same linkage rule as the approve path: a crafted rejection must not
  // move a review that belongs to a different approval request.
  const review = await db.kycReview.findUnique({
    where: { id: request.entityId },
    select: { approvalRequestId: true },
  });
  if (review && review.approvalRequestId !== request.id) {
    throw new HookRefusalError(
      "Approval request is not linked to this review.",
    );
  }
  await setReviewStatus(
    request.decidedById ?? "system",
    request.entityId,
    "rejected",
  );
}

export async function listReviews(
  user: { id: string; role: string } | null,
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "kyc:read");
  return db.kycReview.findMany({
    include: { case: true, requestedBy: true },
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
registerApprovalHooks("kyc_review", {
  requiredPermission: "kyc:approve",
  // Runs inside the decision transaction: a request may only decide a review
  // that exists, is still awaiting its decision, is linked to THIS request,
  // names the same requester, and came through the audited requestReview path.
  // Provenance checks throw HookRefusalError — the decision rolls back and is
  // recorded as a failed decision rather than committed.
  validateEntity: async (tx: Tx, request) => {
    const review = await tx.kycReview.findUnique({
      where: { id: request.entityId },
    });
    if (!review) throw new NotFoundError("KYC review not found.");
    if (review.status !== "requested") {
      throw new ConflictError(
        `Review is no longer awaiting a decision (status: ${review.status}).`,
      );
    }
    if (review.approvalRequestId !== request.id) {
      throw new HookRefusalError(
        "Approval request is not linked to this review.",
      );
    }
    if (review.requestedById !== request.requesterId) {
      throw new HookRefusalError(
        "Approval requester does not match the review requester.",
      );
    }
    const requestedAudit = await tx.auditEvent.findFirst({
      where: {
        action: "kyc_review.requested",
        entityType: "kyc_review",
        entityId: review.id,
      },
    });
    if (!requestedAudit) {
      throw new HookRefusalError(
        "Review was not created through the audited request path.",
      );
    }
  },
  onApproved: onReviewApproved,
  onRejected: onReviewRejected,
});
