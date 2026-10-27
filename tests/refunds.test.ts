import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import { ForbiddenError, ValidationError } from "@/platform/errors";
import { hasPermission, requirePermission } from "@/platform/rbac";
import "@/tools/refunds"; // registers approval hooks
import {
  decideRefund,
  requestRefund,
  requiredRoleForRefund,
  searchTransactions,
} from "@/tools/refunds";
import { resetDb, seedTransaction, seedUsers } from "./helpers";

let users: Record<string, { id: string; role: string }>;

beforeEach(async () => {
  await resetDb();
  users = await seedUsers();
});

describe("RBAC / server-side authorization", () => {
  it("rejects roles without the permission server-side", async () => {
    const txn = await seedTransaction(10000);

    // kai (kyc_reviewer) cannot even read the refunds tool
    expect(() => requirePermission(users.kai, "refunds:read")).toThrow(
      ForbiddenError,
    );
    await expect(searchTransactions(users.kai)).rejects.toThrow(ForbiddenError);

    // erin (engineer) can read but cannot create refunds
    await expect(searchTransactions(users.erin)).resolves.toHaveLength(1);
    await expect(
      requestRefund(users.erin, {
        transactionId: txn.id,
        amountCents: 5000,
        reason: "test",
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("audit trail", () => {
  it("writes an audit event for every refund mutation", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "duplicate charge",
    });

    const events = await db.auditEvent.findMany({ orderBy: { createdAt: "asc" } });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("refund.requested");
    expect(actions).toContain("approval.requested");
    for (const e of events) {
      expect(e.actorId).toBe(users.alice.id);
    }

    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: true,
        note: "test justification",
      });

    const after = await db.auditEvent.findMany({ orderBy: { createdAt: "asc" } });
    const afterActions = after.map((e) => e.action);
    // Decision + every refund status transition is audited:
    // approved (decision) -> refund approved -> refund executed.
    expect(afterActions).toContain("approval.approved");
    expect(afterActions.filter((a) => a === "refund.status")).toHaveLength(2);

    const refundEvents = after.filter((e) => e.entityType === "refund");
    for (const e of refundEvents) {
      expect(e.after).toBeTruthy(); // JSON snapshot recorded
      expect(e.entityId).toBe(refund.id);
    }

    const final = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(final.status).toBe("executed");
    expect(final.paymentRefundId).toBeTruthy();
  });

  it("audits the failed path when the payments client declines", async () => {
    const txn = await seedTransaction(5000, "txn_1_FAIL");
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "cancel order",
    });
    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: true,
        note: "test justification",
      });
    const final = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(final.status).toBe("failed");
    expect(final.failureReason).toBeTruthy();
  });
});

describe("self-approval", () => {
  it("rejects a decision by the requester even with the required role", async () => {
    const txn = await seedTransaction(10000); // $100 -> support_lead route
    // bob is a support_lead AND the requester.
    const refund = await requestRefund(users.bob, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "agent error",
    });
    await expect(
      decideRefund(users.bob, {
        approvalRequestId: refund.approvalRequestId!,
        approve: true,
        note: "test justification",
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("threshold routing", () => {
  it("routes <= $250 to support_lead and > $250 to finance_approver", async () => {
    expect(requiredRoleForRefund(25000)).toBe("support_lead");
    expect(requiredRoleForRefund(25001)).toBe("finance_approver");

    const small = await seedTransaction(20000, "txn_small");
    const big = await seedTransaction(300000, "txn_big");

    const smallRefund = await requestRefund(users.alice, {
      transactionId: small.id,
      amountCents: 20000,
      reason: "small",
    });
    const bigRefund = await requestRefund(users.alice, {
      transactionId: big.id,
      amountCents: 300000,
      reason: "big",
    });

    const smallReq = await db.approvalRequest.findUniqueOrThrow({
      where: { id: smallRefund.approvalRequestId! },
    });
    const bigReq = await db.approvalRequest.findUniqueOrThrow({
      where: { id: bigRefund.approvalRequestId! },
    });
    expect(smallReq.requiredRole).toBe("support_lead");
    expect(bigReq.requiredRole).toBe("finance_approver");

    // The wrong role cannot decide.
    await expect(
      decideRefund(users.fiona, {
        approvalRequestId: smallReq.id,
        approve: true,
        note: "test justification",
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      decideRefund(users.bob, { approvalRequestId: bigReq.id, approve: true, note: "test justification" }),
    ).rejects.toThrow(ForbiddenError);

    // The right roles can.
    await expect(
      decideRefund(users.bob, { approvalRequestId: smallReq.id, approve: true, note: "test justification" }),
    ).resolves.toMatchObject({ status: "approved" });
    await expect(
      decideRefund(users.fiona, {
        approvalRequestId: bigReq.id,
        approve: false,
        note: "insufficient documentation",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
  });
});

describe("validation", () => {
  it("requires a reason and a valid amount", async () => {
    const txn = await seedTransaction(10000);
    await expect(
      requestRefund(users.alice, {
        transactionId: txn.id,
        amountCents: 5000,
        reason: "   ",
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      requestRefund(users.alice, {
        transactionId: txn.id,
        amountCents: 99999,
        reason: "too big",
      }),
    ).rejects.toThrow(ValidationError);
  });
});
