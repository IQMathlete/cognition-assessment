import { db, type Tx } from "@/platform/db";
import { withAudit } from "@/platform/audit";
import {
  createApprovalRequest,
  decideApproval,
  registerApprovalHooks,
} from "@/platform/approvals";
import { hasPermission, requirePermission } from "@/platform/rbac";
import { resolveActor } from "@/platform/actor";
import {
  ConflictError,
  HookRefusalError,
  NotFoundError,
  ValidationError,
} from "@/platform/errors";

// Cases at or above this risk score need a second review by a kyc_senior
// before the reviewer's approval becomes final.
export const SECOND_REVIEW_RISK = 80;

const SENIOR_ROLE = "kyc_senior";

// Statuses that hold a case in the senior queue: the linked approval request
// reserves the verdict, so no other disposition may touch the case.
const AWAITING_SENIOR = ["escalated", "pending_second_review"] as const;

const CASE_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["verified", "rejected", "escalated", "pending_second_review"],
  escalated: ["verified", "rejected"],
  pending_second_review: ["verified", "rejected"],
  verified: [],
  rejected: [],
};

const DISPOSITIONS = ["approve", "reject", "escalate"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

// --- PII masking -------------------------------------------------------------
// ssn and dob never leave the service unmasked: every read path returns masked
// values; only revealPii (kyc:reveal, audited) returns the raw fields.

export function maskSsn(ssn: string): string {
  return `***-**-${ssn.slice(-4)}`;
}

export function maskDob(dob: string): string {
  return dob.slice(0, 4); // year only
}

function masked<T extends { ssn: string; dob: string }>(row: T) {
  return { ...row, ssn: maskSsn(row.ssn), dob: maskDob(row.dob) };
}

// Audit snapshots of a case get the same masking — otherwise /admin's audit
// log would hand unmasked PII to a platform_admin with no reveal reason.
function auditedCase<T extends { ssn: string; dob: string }>(row: T) {
  return masked(row);
}

// A kyc_reviewer only sees cases assigned to them; a kyc_senior sees the whole
// queue. The check keys on stored permissions, not a role-name comparison.
function caseScope(actor: { id: string; role: string }) {
  return hasPermission(actor.role, "kyc:approve")
    ? {}
    : { assigneeId: actor.id };
}

async function loadVisibleCase(
  tx: Tx,
  actor: { id: string; role: string },
  caseId: string,
) {
  const kycCase = await tx.kycCase.findUnique({ where: { id: caseId } });
  // NotFound rather than Forbidden: a reviewer must not learn that another
  // reviewer's case exists by probing ids.
  if (!kycCase) throw new NotFoundError("KYC case not found.");
  if (
    !hasPermission(actor.role, "kyc:approve") &&
    kycCase.assigneeId !== actor.id
  ) {
    throw new NotFoundError("KYC case not found.");
  }
  return kycCase;
}

export async function searchCases(
  user: { id: string; role: string } | null,
  query?: string,
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "kyc:read");
  const q = query?.trim();
  const rows = await db.kycCase.findMany({
    where: {
      ...caseScope(actor),
      ...(q
        ? {
            OR: [
              { externalId: { contains: q } },
              { applicant: { contains: q } },
              { country: { contains: q } },
            ],
          }
        : {}),
    },
    include: { assignee: { select: { username: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(masked);
}

export async function getCase(
  user: { id: string; role: string } | null,
  caseId: string,
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "kyc:read");
  const row = await loadVisibleCase(db, actor, caseId);
  return masked(row);
}

/**
 * The reviewer's disposition on an assigned case:
 *  - approve: riskScore >= SECOND_REVIEW_RISK routes the case into the senior
 *    queue as a second-review request; below the threshold the case is
 *    verified immediately.
 *  - reject: closes the case rejected.
 *  - escalate: routes the case into the senior queue unresolved.
 * Every disposition requires a reason and is audited; a case awaiting a
 * senior decision cannot be dispositioned again.
 */
export async function dispositionCase(
  user: { id: string; role: string } | null,
  input: { caseId: string; action: string; reason: string },
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "kyc:review");
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("A reason is required.");
  if (!(DISPOSITIONS as readonly string[]).includes(input.action)) {
    throw new ValidationError("Action must be approve, reject, or escalate.");
  }

  return withAudit(actor.id, async (tx) => {
    const before = await loadVisibleCase(tx, actor, input.caseId);
    if (before.status !== "pending") {
      throw new ConflictError(
        `Case is not awaiting review (status: ${before.status}).`,
      );
    }

    if (input.action === "reject") {
      const after = await tx.kycCase.update({
        where: { id: before.id },
        data: { status: "rejected" },
      });
      return {
        value: after,
        audit: {
          action: "kyc_case.rejected",
          entityType: "kyc_case",
          entityId: before.id,
          before: auditedCase(before),
          after: { ...auditedCase(after), reason },
        },
      };
    }

    if (input.action === "approve" && before.riskScore < SECOND_REVIEW_RISK) {
      const after = await tx.kycCase.update({
        where: { id: before.id },
        data: { status: "verified" },
      });
      return {
        value: after,
        audit: {
          action: "kyc_case.verified",
          entityType: "kyc_case",
          entityId: before.id,
          before: auditedCase(before),
          after: { ...auditedCase(after), reason },
        },
      };
    }

    // Escalate, or approve on a high-risk case: the senior queue decides.
    const toStatus =
      input.action === "escalate" ? "escalated" : "pending_second_review";
    const approval = await createApprovalRequest(tx, {
      requesterId: actor.id,
      requiredRole: SENIOR_ROLE,
      entityType: "kyc_case",
      entityId: before.id,
      reason,
    });
    const after = await tx.kycCase.update({
      where: { id: before.id },
      data: { status: toStatus, approvalRequestId: approval.id },
    });
    return {
      value: after,
      audit: {
        action:
          input.action === "escalate"
            ? "kyc_case.escalated"
            : "kyc_case.second_review_requested",
        entityType: "kyc_case",
        entityId: before.id,
        before: auditedCase(before),
        after: { ...auditedCase(after), reason },
      },
    };
  });
}

/**
 * kyc_senior-only: reveal the unmasked SSN and DOB of a case. Requires a
 * reason and writes an audit event naming the fields revealed — the audit
 * row deliberately does NOT contain the values themselves.
 */
export async function revealPii(
  user: { id: string; role: string } | null,
  input: { caseId: string; reason: string },
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "kyc:reveal");
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("A reason is required.");

  return withAudit(actor.id, async (tx) => {
    const kycCase = await tx.kycCase.findUnique({
      where: { id: input.caseId },
    });
    if (!kycCase) throw new NotFoundError("KYC case not found.");
    return {
      value: { ssn: kycCase.ssn, dob: kycCase.dob },
      audit: {
        action: "kyc_case.pii_revealed",
        entityType: "kyc_case",
        entityId: kycCase.id,
        after: { fields: ["ssn", "dob"], reason },
      },
    };
  });
}

/** Approving or rejecting a senior-queue request. Role checks live in decideApproval. */
export async function decideCase(
  user: { id: string; role: string } | null,
  input: { approvalRequestId: string; approve: boolean; note?: string },
) {
  const actor = await resolveActor(user);
  requirePermission(actor, "kyc:approve");
  const request = await db.approvalRequest.findUnique({
    where: { id: input.approvalRequestId },
  });
  if (!request) throw new NotFoundError("Approval request not found.");
  if (request.entityType !== "kyc_case") {
    throw new ValidationError("Not a KYC case approval request.");
  }
  return decideApproval({
    requestId: request.id,
    decider: actor,
    approve: input.approve,
    note: input.note,
  });
}

async function setCaseStatus(actorId: string, caseId: string, to: string) {
  return withAudit(actorId, async (tx) => {
    const before = await tx.kycCase.findUniqueOrThrow({
      where: { id: caseId },
    });
    if (!CASE_TRANSITIONS[before.status]?.includes(to)) {
      throw new ConflictError(
        `Case cannot transition ${before.status} -> ${to}.`,
      );
    }
    const after = await tx.kycCase.update({
      where: { id: caseId },
      data: { status: to },
    });
    return {
      value: after,
      audit: {
        action: `kyc_case.${to}`,
        entityType: "kyc_case",
        entityId: caseId,
        before: auditedCase(before),
        after: auditedCase(after),
      },
    };
  });
}

// --- Approval hooks ----------------------------------------------------------

async function assertLinkedCase(caseId: string, requestId?: string) {
  const kycCase = await db.kycCase.findUnique({
    where: { id: caseId },
    select: { approvalRequestId: true },
  });
  if (kycCase && kycCase.approvalRequestId !== requestId) {
    throw new HookRefusalError(
      "Approval request is not linked to this case.",
    );
  }
}

export async function onCaseApproved(request: {
  id?: string;
  entityId: string;
  decidedById: string | null;
}) {
  await assertLinkedCase(request.entityId, request.id);
  await setCaseStatus(
    request.decidedById ?? "system",
    request.entityId,
    "verified",
  );
}

export async function onCaseRejected(request: {
  id?: string;
  entityId: string;
  decidedById: string | null;
}) {
  await assertLinkedCase(request.entityId, request.id);
  await setCaseStatus(
    request.decidedById ?? "system",
    request.entityId,
    "rejected",
  );
}

// Plug into the approvals primitive. requiredPermission keeps deciding
// impossible for roles that merely share a name with requiredRole;
// validateEntity keeps decisions on crafted or dangling requests from
// committing at all.
registerApprovalHooks("kyc_case", {
  requiredPermission: "kyc:approve",
  // Runs inside the decision transaction: the request may only decide a case
  // that exists, is awaiting a senior decision, is linked to THIS request,
  // and arrived via the audited disposition path. Provenance failures throw
  // HookRefusalError so the decision rolls back rather than committing.
  validateEntity: async (tx: Tx, request) => {
    const kycCase = await tx.kycCase.findUnique({
      where: { id: request.entityId },
    });
    if (!kycCase) throw new NotFoundError("KYC case not found.");
    if (!(AWAITING_SENIOR as readonly string[]).includes(kycCase.status)) {
      throw new ConflictError(
        `Case is not awaiting a senior decision (status: ${kycCase.status}).`,
      );
    }
    if (kycCase.approvalRequestId !== request.id) {
      throw new HookRefusalError(
        "Approval request is not linked to this case.",
      );
    }
    // The requester must be the actor who routed this case into the senior
    // queue — which need not be the assignee (a senior may escalate or
    // second-review another reviewer's case). Provenance is proven by the
    // audited disposition row carrying the requester as its actor.
    const requestedAudit = await tx.auditEvent.findFirst({
      where: {
        entityType: "kyc_case",
        entityId: kycCase.id,
        actorId: request.requesterId,
        action: { in: ["kyc_case.escalated", "kyc_case.second_review_requested"] },
      },
    });
    if (!requestedAudit) {
      throw new HookRefusalError(
        "Case was not routed to the senior queue through the audited path.",
      );
    }
  },
  onApproved: onCaseApproved,
  onRejected: onCaseRejected,
});
