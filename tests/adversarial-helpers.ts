import { db } from "@/platform/db";
import { createApprovalRequest } from "@/platform/approvals";
import type {
  PaymentsClient,
  RefundPaymentInput,
  RefundPaymentResult,
} from "@/tools/refunds/payments";

// Extra seed users beyond tests/helpers.ts USERS (e.g. a second support_agent).
export async function seedUser(username: string, role: string) {
  return db.user.create({ data: { username, displayName: username, role } });
}

export async function setTransactionStatus(
  transactionId: string,
  status: string,
) {
  return db.transaction.update({ where: { id: transactionId }, data: { status } });
}

// Records every call so tests can prove payments were executed 0/1/N times,
// and can simulate declines or transport-level throws.
export class RecordingPaymentsClient implements PaymentsClient {
  calls: RefundPaymentInput[] = [];

  constructor(public behavior: "ok" | "fail" | "throw" = "ok") {}

  async refund(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    this.calls.push(input);
    if (this.behavior === "throw") {
      throw new Error("payments gateway unreachable");
    }
    if (this.behavior === "fail") {
      return { ok: false, failureReason: "stub decline" };
    }
    return { ok: true, paymentRefundId: `payref_${input.idempotencyKey.slice(0, 16)}` };
  }
}

// Creates an ApprovalRequest without going through requestRefund — i.e. the
// way any platform tool (or a bug in one) can hand-craft a request pointing at
// an arbitrary entityId / requiredRole.
export function craftApproval(input: {
  requesterId: string;
  requiredRole: string;
  entityType?: string;
  entityId: string;
  reason?: string;
}) {
  return db.$transaction((tx) =>
    createApprovalRequest(tx, {
      entityType: "refund",
      reason: "crafted request",
      ...input,
    }),
  );
}

export function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
