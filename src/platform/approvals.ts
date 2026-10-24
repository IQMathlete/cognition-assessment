import type { ApprovalRequest } from "@prisma/client";
import { db, type Tx } from "./db";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { withAudit } from "./audit";

export interface ApprovalHooks {
  /** Runs after an approval request transitions to "approved". */
  onApproved?: (request: ApprovalRequest) => Promise<void>;
  /** Runs after an approval request transitions to "rejected". */
  onRejected?: (request: ApprovalRequest) => Promise<void>;
}

// Tools plug into the approvals primitive by registering hooks for the
// entityType they request approvals over (e.g. the refunds tool registers
// "refund"). Registered at module load; see src/tools/refunds/index.ts.
const hooks = new Map<string, ApprovalHooks>();

export function registerApprovalHooks(
  entityType: string,
  toolHooks: ApprovalHooks,
): void {
  hooks.set(entityType, toolHooks);
}

/**
 * Creates a pending ApprovalRequest. Call inside the same transaction that
 * creates the entity needing approval so both commit together.
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
  return tx.approvalRequest.create({ data: input });
}

export async function decideApproval(input: {
  requestId: string;
  decider: { id: string; role: string };
  approve: boolean;
  note?: string;
}): Promise<ApprovalRequest> {
  const { requestId, decider, approve, note } = input;

  const decided = await withAudit(decider.id, async (tx) => {
    const request = await tx.approvalRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundError("Approval request not found.");
    if (request.status !== "pending") {
      throw new ConflictError("This request has already been decided.");
    }
    if (request.requesterId === decider.id) {
      throw new ForbiddenError("You cannot approve or reject your own request.");
    }
    if (decider.role !== request.requiredRole) {
      throw new ForbiddenError(
        `This request requires a ${request.requiredRole} decision.`,
      );
    }

    const status = approve ? "approved" : "rejected";
    const updated = await tx.approvalRequest.update({
      where: { id: request.id },
      data: {
        status,
        decidedById: decider.id,
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

  // Tool callbacks run after the decision commits: they may call external
  // systems (payments) which should not hold a DB transaction open.
  const toolHooks = hooks.get(decided.entityType);
  if (decided.status === "approved") {
    await toolHooks?.onApproved?.(decided);
  } else if (decided.status === "rejected") {
    await toolHooks?.onRejected?.(decided);
  }
  return decided;
}

export function listPendingApprovalsFor(role: string) {
  return db.approvalRequest.findMany({
    where: { status: "pending", requiredRole: role },
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
