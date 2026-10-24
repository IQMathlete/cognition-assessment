import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { ForbiddenError, ValidationError } from "@/platform/errors";
import { decideApproval, listPendingApprovalsFor } from "@/platform/approvals";
import "@/tools/refunds"; // registers approval hooks
import {
  decideRefund,
  requestRefund,
} from "@/tools/refunds";
import { resetDb, seedTransaction, seedUsers } from "./helpers";

let users: Record<string, { id: string; role: string }>;

beforeEach(async () => {
  await resetDb();
  users = await seedUsers();
});

describe("over-refund", () => {
  it("rejects a request that would exceed the transaction total", async () => {
    const txn = await seedTransaction(25000, "txn_over");
    await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 20000,
      reason: "first",
    });
    // $100 remaining on a $250 txn — another $100 is fine, $101 is not.
    await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "second",
    });
    await expect(
      requestRefund(users.alice, {
        transactionId: txn.id,
        amountCents: 1,
        reason: "one cent too many",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("fails, rather than executes, an approval whose balance was consumed", async () => {
    const txn = await seedTransaction(25000, "txn_race");
    // Two pending refunds with a complete request audit trail but created
    // outside requestRefund — e.g. requests that slipped past the aggregate
    // cap in a race. The approval-time balance recheck is the backstop this
    // test exercises.
    const mkRefund = async (cents: number) =>
      db.$transaction(async (tx) => {
        const refund = await tx.refund.create({
          data: {
            transactionId: txn.id,
            amountCents: cents,
            reason: "race",
            requestedById: users.alice.id,
            status: "requested",
          },
        });
        const approval = await tx.approvalRequest.create({
          data: {
            requesterId: users.alice.id,
            requiredRole: "support_lead",
            entityType: "refund",
            entityId: refund.id,
            reason: "race",
          },
        });
        const linked = await tx.refund.update({
          where: { id: refund.id },
          data: { approvalRequestId: approval.id },
        });
        await recordAudit(tx, users.alice.id, [
          {
            action: "refund.requested",
            entityType: "refund",
            entityId: refund.id,
            after: linked,
          },
          {
            action: "approval.requested",
            entityType: "approval_request",
            entityId: approval.id,
            after: approval,
          },
        ]);
        return { refund: linked, approval };
      });
    const a = await mkRefund(20000);
    const b = await mkRefund(20000);

    await decideRefund(users.bob, {
      approvalRequestId: a.approval.id,
      approve: true,
    });
    expect(
      (await db.refund.findUniqueOrThrow({ where: { id: a.refund.id } })).status,
    ).toBe("executed");

    // Approving B is allowed (the request is valid) but execution must not
    // happen: the balance is already gone.
    await decideRefund(users.bob, {
      approvalRequestId: b.approval.id,
      approve: true,
    });
    const bFinal = await db.refund.findUniqueOrThrow({
      where: { id: b.refund.id },
    });
    expect(bFinal.status).toBe("failed");
    expect(bFinal.failureReason).toContain("remaining refundable amount");
  });
});

describe("transaction + state-machine guards", () => {
  it("refuses refunds on non-settled transactions", async () => {
    const txn = await db.transaction.create({
      data: {
        externalId: "txn_pending",
        merchant: "M",
        cardholder: "C",
        amountCents: 10000,
        status: "pending",
      },
    });
    await expect(
      requestRefund(users.alice, {
        transactionId: txn.id,
        amountCents: 5000,
        reason: "too early",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("blocks illegal status transitions via the hook path", async () => {
    const txn = await seedTransaction(10000, "txn_sm");
    const refund = await db.refund.create({
      data: {
        transactionId: txn.id,
        amountCents: 5000,
        reason: "crafted",
        requestedById: users.alice.id,
        status: "executed", // terminal state
      },
    });
    const approval = await db.approvalRequest.create({
      data: {
        requesterId: users.alice.id,
        requiredRole: "support_lead",
        entityType: "refund",
        entityId: refund.id,
        reason: "crafted",
      },
    });
    // The refund is terminal — the crafted decision is rejected inside the
    // decision transaction (nothing commits) and the failure is audited.
    await expect(
      decideRefund(users.bob, {
        approvalRequestId: approval.id,
        approve: true,
      }),
    ).rejects.toThrow();
    expect(
      (await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status,
    ).toBe("executed");
    expect(
      (await db.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } }))
        .status,
    ).toBe("pending");
    const actions = (await db.auditEvent.findMany()).map((e) => e.action);
    expect(actions).toContain("approval.decide_failed");
  });
});

describe("approval queue access", () => {
  it("scopes the pending queue to the caller's own role", async () => {
    await expect(listPendingApprovalsFor(users.kai)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(listPendingApprovalsFor(users.erin)).rejects.toThrow(
      ForbiddenError,
    );

    const txn = await seedTransaction(300000, "txn_q"); // finance route
    await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 300000,
      reason: "big",
    });
    expect(await listPendingApprovalsFor(users.fiona)).toHaveLength(1);
    // bob cannot see fiona's queue.
    expect(await listPendingApprovalsFor(users.bob)).toHaveLength(0);
  });

  it("rejects anonymous and already-decided requests", async () => {
    const txn = await seedTransaction(10000, "txn_anon");
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "x",
    });
    await expect(
      decideApproval({
        requestId: refund.approvalRequestId!,
        decider: null,
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);

    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: false,
    });
    // Re-deciding is rejected — no replay.
    await expect(
      decideRefund(users.fiona, {
        approvalRequestId: refund.approvalRequestId!,
        approve: true,
      }),
    ).rejects.toThrow();
  });
});

describe("audit immutability", () => {
  it("blocks update and delete on audit rows at the database level", async () => {
    const txn = await seedTransaction(10000, "txn_audit");
    await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "setup",
    });
    await expect(
      db.auditEvent.updateMany({ data: { action: "tampered" } }),
    ).rejects.toThrow();
    await expect(db.auditEvent.deleteMany()).rejects.toThrow();
  });
});
