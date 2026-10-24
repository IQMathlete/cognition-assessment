import type { ApprovalRequest } from "@prisma/client";
import { db, type Tx } from "./db";
import {
  ConflictError,
  ForbiddenError,
  HookRefusalError,
  NotFoundError,
  ValidationError,
} from "./errors";
import { recordAudit, withAudit } from "./audit";
import { hasPermission, isRole, requirePermission, type Permission } from "./rbac";

export interface ApprovalHooks {
  /**
   * Permission a decider must hold for this entity type (e.g.
   * "refunds:approve"). Checked against the decider's stored role — without
   * it, a request crafted with a permission-less requiredRole could be
   * decided by a role that should never approve anything.
   */
  requiredPermission?: Permission;
  /**
   * Runs inside the decision transaction, before the status is committed.
   * Throwing rolls the whole decision back — use it to prove the target
   * entity exists and is in a decidable state.
   */
  validateEntity?: (tx: Tx, request: ApprovalRequest) => Promise<void>;
  /** Runs after an approval request transitions to "approved". */
  onApproved?: (request: ApprovalRequest) => Promise<void>;
  /** Runs after an approval request transitions to "rejected". */
  onRejected?: (request: ApprovalRequest) => Promise<void>;
}

// Tools plug into the approvals primitive by registering hooks for the
// entityType they request approvals over (e.g. the refunds tool registers
// "refund" in src/tools/refunds/service.ts).
const hooks = new Map<string, ApprovalHooks>();

export function registerApprovalHooks(
  entityType: string,
  toolHooks: ApprovalHooks,
): void {
  hooks.set(entityType, toolHooks);
}

/**
 * Creates a pending ApprovalRequest. Call inside the same transaction that
 * creates the entity needing approval so both commit together; the request's
 * creation is itself audited in that transaction.
 */
export async function createApprovalRequest(
  tx: Tx,
  input: {
    requesterId: string;
    requiredRole: string;
    entityType: string;
    entityId: string;
    reason: string;
  },
): Promise<ApprovalRequest> {
  if (!isRole(input.requiredRole)) {
    throw new ValidationError(
      `Cannot require an unknown role "${input.requiredRole}".`,
    );
  }
  const request = await tx.approvalRequest.create({ data: input });
  await recordAudit(tx, input.requesterId, {
    action: "approval.requested",
    entityType: "approval_request",
    entityId: request.id,
    after: request,
  });
  return request;
}

export async function decideApproval(input: {
  requestId: string;
  decider: { id: string; role: string } | null;
  approve: boolean;
  note?: string;
}): Promise<ApprovalRequest> {
  const { requestId, decider, approve, note } = input;
  if (!decider) {
    throw new ForbiddenError("You must be signed in to decide requests.");
  }

  let decided: ApprovalRequest;
  try {
    decided = await withAudit(decider.id, async (tx) => {
      const request = await tx.approvalRequest.findUnique({
        where: { id: requestId },
      });
      if (!request) throw new NotFoundError("Approval request not found.");
      if (request.status !== "pending") {
        throw new ConflictError("This request has already been decided.");
      }

      // The decider's role comes from the database — a caller-supplied role
      // is just a claim.
      const deciderRow = await tx.user.findUnique({
        where: { id: decider.id },
      });
      if (!deciderRow) {
        throw new ForbiddenError("Deciding user not found.");
      }
      if (request.requesterId === deciderRow.id) {
        throw new ForbiddenError(
          "You cannot approve or reject your own request.",
        );
      }
      if (deciderRow.role !== request.requiredRole) {
        throw new ForbiddenError(
          `This request requires a ${request.requiredRole} decision.`,
        );
      }

      const toolHooks = hooks.get(request.entityType);
      if (
        toolHooks?.requiredPermission &&
        !hasPermission(deciderRow.role, toolHooks.requiredPermission)
      ) {
        throw new ForbiddenError(
          `Role "${deciderRow.role}" lacks permission "${toolHooks.requiredPermission}".`,
        );
      }
      await toolHooks?.validateEntity?.(tx, request);

      const status = approve ? "approved" : "rejected";
      const updated = await tx.approvalRequest.update({
        where: { id: request.id },
        data: {
          status,
          decidedById: deciderRow.id,
          decisionNote: note ?? null,
          decidedAt: new Date(),
        },
      });
      return {
        value: updated,
        audit: {
          action: `approval.${status}`,
          entityType: "approval_request",
          entityId: request.id,
          before: request,
          after: updated,
        },
      };
    });
  } catch (e) {
    // Failed decisions are themselves auditable events — an unauthorized or
    // unresolvable attempt should leave a trail.
    try {
      await recordStandaloneAudit(decider.id, {
        action: "approval.decide_failed",
        entityType: "approval_request",
        entityId: requestId,
        after: { error: e instanceof Error ? e.message : String(e) },
      });
    } catch (auditErr) {
      console.error("Failed to audit a rejected decision:", auditErr);
    }
    throw e;
  }

  // Tool callbacks run after the decision commits: they may call external
  // systems (payments) which should not hold a DB transaction open. A
  // HookRefusalError is a handled outcome (recorded, not rethrown); any other
  // hook failure is audited and propagated to the caller.
  const toolHooks = hooks.get(decided.entityType);
  const hook =
    decided.status === "approved"
      ? toolHooks?.onApproved
      : decided.status === "rejected"
        ? toolHooks?.onRejected
        : undefined;
  if (decided.status !== "pending" && !toolHooks) {
    console.warn(
      `No approval hooks registered for entityType "${decided.entityType}".`,
    );
  }
  if (hook) {
    try {
      await hook(decided);
    } catch (e) {
      const refused = e instanceof HookRefusalError;
      await recordStandaloneAudit(decider.id, {
        action: refused ? "approval.execution_refused" : "approval.hook_failed",
        entityType: "approval_request",
        entityId: decided.id,
        after: {
          error: e instanceof Error ? e.message : String(e),
          status: decided.status,
        },
      });
      if (!refused) throw e;
    }
  }
  return decided;
}

async function recordStandaloneAudit(
  actorId: string,
  entry: Parameters<typeof recordAudit>[2],
) {
  await db.$transaction((tx) => recordAudit(tx, actorId, entry));
}

export async function listPendingApprovalsFor(
  user: { id: string; role: string } | null,
) {
  requirePermission(user, "refunds:approve");
  const row = await db.user.findUnique({ where: { id: user.id } });
  if (!row) throw new ForbiddenError("Unknown user.");
  return db.approvalRequest.findMany({
    where: { status: "pending", requiredRole: row.role },
    include: { requester: true },
    orderBy: { createdAt: "desc" },
  });
}

export function listApprovals() {
  return db.approvalRequest.findMany({
    include: { requester: true, decidedBy: true },
    orderBy: { createdAt: "desc" },
  });
}
