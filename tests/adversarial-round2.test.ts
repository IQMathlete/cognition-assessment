import { beforeEach, describe, expect, it } from "vitest";
import { db, dropAuditGuards } from "@/platform/db";
import { ForbiddenError, ValidationError } from "@/platform/errors";
import { decideApproval, listPendingApprovalsFor } from "@/platform/approvals";
import "@/tools/refunds"; // registers approval hooks
import {
  decideRefund,
  onRefundRejected,
  requestRefund,
  setPaymentsClient,
} from "@/tools/refunds";
import { resetDb, seedTransaction, seedUsers } from "./helpers";
import {
  RecordingPaymentsClient,
  craftApproval,
} from "./adversarial-helpers";

let users: Record<string, { id: string; role: string }>;
let payments: RecordingPaymentsClient;

async function refundStatus(id: string) {
  return (await db.refund.findUniqueOrThrow({ where: { id } })).status;
}

beforeEach(async () => {
  await resetDb();
  users = await seedUsers();
  payments = new RecordingPaymentsClient();
  setPaymentsClient(payments);
});

describe("rejection-side linkage — crafted rejections must not touch refunds", () => {
  it("rejecting a request that is not the refund's own must not reject the refund", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "legit request",
    });
    // Crafted request pointing at the same refund — bob thinks it's junk and
    // rejects it. onRefundApproved verifies linkage; onRefundRejected does not.
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: refund.id,
    });
    await decideRefund(users.bob, {
      approvalRequestId: crafted.id,
      approve: false,
    });
    expect(await refundStatus(refund.id)).toBe("requested");
  });

  it("a crafted rejection cannot permanently kill a refund", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "legit request",
    });
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: refund.id,
    });
    await decideRefund(users.bob, {
      approvalRequestId: crafted.id,
      approve: false,
    });

    // Even if the crafted rejection landed, the refund's OWN pending request
    // must still be able to execute it — a murdered refund should not stay dead.
    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: true,
    });
    expect(await refundStatus(refund.id)).toBe("executed");
    expect(payments.calls).toHaveLength(1);
  });

  it("rejecting a crafted request on a terminal refund fails without mutation", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "executed then targeted",
    });
    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: true,
    });
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: refund.id,
    });
    await expect(
      decideRefund(users.bob, {
        approvalRequestId: crafted.id,
        approve: false,
      }),
    ).rejects.toThrow();
    expect(await refundStatus(refund.id)).toBe("executed");
  });

  it("calling the reject hook directly cannot reject an unlinked refund", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "direct hook probe",
    });
    await expect(
      onRefundRejected({ entityId: refund.id, decidedById: users.bob.id }),
    ).rejects.toThrow();
    expect(await refundStatus(refund.id)).toBe("requested");
  });
});

describe("entity provenance and registered-tool governance", () => {
  it("a fully crafted refund + linked approval pair cannot execute", async () => {
    const txn = await seedTransaction(25000);
    // Craft both the refund row AND its linked approval request — the linkage
    // check passes because the crafted request IS the linked one, so the
    // request pipeline (reason validation, requester, audit of request) is
    // bypassed entirely.
    const refund = await db.refund.create({
      data: {
        transactionId: txn.id,
        amountCents: 25000,
        reason: "crafted",
        requestedById: users.alice.id,
        status: "requested",
      },
    });
    const approval = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: refund.id,
    });
    await db.refund.update({
      where: { id: refund.id },
      data: { approvalRequestId: approval.id },
    });

    await decideRefund(users.bob, {
      approvalRequestId: approval.id,
      approve: true,
    });
    expect(await refundStatus(refund.id)).not.toBe("executed");
    expect(payments.calls).toHaveLength(0);
  });

  it("decisions on unregistered entity types are rejected, not silently approved", async () => {
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityType: "unregistered_tool",
      entityId: "some-entity",
    });
    await expect(
      decideApproval({
        requestId: crafted.id,
        decider: users.bob,
        approve: true,
      }),
    ).rejects.toThrow();
  });

  it("an approval whose entity the hook refuses must not be recorded as approved", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "owned by a different request",
    });
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: refund.id,
    });
    await decideRefund(users.bob, {
      approvalRequestId: crafted.id,
      approve: true,
    });
    // The hook refused execution — the decision itself should not stand.
    const req = await db.approvalRequest.findUniqueOrThrow({
      where: { id: crafted.id },
    });
    expect(req.status).not.toBe("approved");
    expect(await refundStatus(refund.id)).toBe("requested");
  });
});

describe("identity and role-claim consistency", () => {
  it("rejects a user object whose claimed role disagrees with the stored role", async () => {
    const txn = await seedTransaction(300000); // finance route
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 300000,
      reason: "finance routed",
    });
    // Claims to be fiona but asserts the wrong role — an inconsistent claim
    // should be rejected, not silently resolved to the stored role.
    await expect(
      decideRefund(
        { id: users.fiona.id, role: "support_agent" },
        { approvalRequestId: refund.approvalRequestId!, approve: true },
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(await refundStatus(refund.id)).toBe("requested");
    expect(payments.calls).toHaveLength(0);
  });

  it("forged decider role claims are still rejected (round-1 fix holds)", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "forged role probe",
    });
    await expect(
      decideApproval({
        requestId: refund.approvalRequestId!,
        decider: { id: users.kai.id, role: "support_lead" },
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(await refundStatus(refund.id)).toBe("requested");
  });

  it("listPendingApprovalsFor checks permission against the stored role", async () => {
    // erin is an engineer (no refunds:approve) claiming finance_approver —
    // the function checks the claim but queries by the stored role.
    await expect(
      listPendingApprovalsFor({ id: users.erin.id, role: "finance_approver" }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("audit guard coverage", () => {
  it("audit rows written outside withAudit are still immutably guarded", async () => {
    // createApprovalRequest writes its audit row inside the caller's tx —
    // outside withAudit no trigger installation happens, leaving the log
    // mutable on a freshly-reset database.
    await dropAuditGuards();
    await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: "entity-1",
    });
    await expect(
      db.auditEvent.updateMany({ data: { action: "tampered" } }),
    ).rejects.toThrow();
  });

  it("raw SQL updates to the audit log are also blocked", async () => {
    const txn = await seedTransaction(10000);
    await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "seed audit rows",
    });
    await expect(
      db.$executeRaw`UPDATE "AuditEvent" SET "action" = 'tampered'`,
    ).rejects.toThrow();
  });
});

describe("request-side concurrency", () => {
  it("concurrent refund requests cannot over-commit a transaction", async () => {
    const txn = await seedTransaction(25000);
    const results = await Promise.allSettled([
      requestRefund(users.alice, {
        transactionId: txn.id,
        amountCents: 20000,
        reason: "a",
      }),
      requestRefund(users.alice, {
        transactionId: txn.id,
        amountCents: 20000,
        reason: "b",
      }),
    ]);
    const committed =
      (
        await db.refund.aggregate({
          _sum: { amountCents: true },
          where: {
            transactionId: txn.id,
            status: { in: ["requested", "approved", "executed"] },
          },
        })
      )._sum.amountCents ?? 0;
    expect(committed).toBeLessThanOrEqual(txn.amountCents);
    // At least one request should succeed; a system that fails both is just
    // fragile. The key invariant is the cap.
    expect(
      results.filter((r) => r.status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("creation-time validation", () => {
  it("createApprovalRequest rejects an unknown requiredRole", async () => {
    await expect(
      craftApproval({
        requesterId: users.alice.id,
        requiredRole: "not_a_real_role",
        entityId: "x",
      }),
    ).rejects.toThrow(ValidationError);
  });
});
