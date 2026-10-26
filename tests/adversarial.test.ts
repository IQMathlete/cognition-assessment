import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/platform/db";
import { ForbiddenError, ValidationError } from "@/platform/errors";
import { decideApproval } from "@/platform/approvals";
import "@/tools/refunds"; // registers approval hooks
import {
  decideRefund,
  listRefunds,
  onRefundApproved,
  requestRefund,
  searchTransactions,
  setPaymentsClient,
} from "@/tools/refunds";
import { requestRefundAction } from "@/tools/refunds/actions";
import { resetDb, seedTransaction, seedUsers } from "./helpers";
import {
  RecordingPaymentsClient,
  craftApproval,
  makeFormData,
  setTransactionStatus,
} from "./adversarial-helpers";

// --- Server-action environment mocks ---------------------------------------
// DevAuthProvider reads the itp_user_id cookie via next/headers; the actions
// redirect via next/navigation. Mocked here so server actions can be invoked
// directly in tests.
const session = vi.hoisted(() => ({
  cookies: {} as Record<string, string>,
  redirects: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name in session.cookies ? { value: session.cookies[name] } : undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    session.redirects.push(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// ---------------------------------------------------------------------------

let users: Record<string, { id: string; role: string }>;
let payments: RecordingPaymentsClient;

type Actor = { id: string; role: string };
const asActor = (u: { id: string; role: string }): Actor => ({
  id: u.id,
  role: u.role,
});

/** Runs requestRefundAction; a successful action redirects, which our mock
 *  throws. Returns the FormState on validation failure. */
async function runRequestAction(fields: Record<string, string>) {
  try {
    return await requestRefundAction({}, makeFormData(fields));
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT:")) {
      return { redirected: true };
    }
    throw e;
  }
}

async function refundStatus(id: string) {
  return (await db.refund.findUniqueOrThrow({ where: { id } })).status;
}

async function auditActions() {
  const rows = await db.auditEvent.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((r) => r.action);
}

beforeEach(async () => {
  await resetDb();
  users = await seedUsers();
  session.cookies = {};
  session.redirects = [];
  payments = new RecordingPaymentsClient();
  setPaymentsClient(payments);
});

describe("cumulative limits / over-refund", () => {
  it("rejects a request that would push total refunds over the transaction amount", async () => {
    const txn = await seedTransaction(25000); // $250
    await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 20000,
      reason: "first",
    });
    await expect(
      requestRefund(users.alice, {
        transactionId: txn.id,
        amountCents: 20000,
        reason: "second exceeds remaining balance",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("never executes more than the transaction amount across multiple approvals", async () => {
    const txn = await seedTransaction(25000);
    const r1 = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 20000,
      reason: "first",
    });
    // The second request may be rejected outright at request time — that is
    // itself a secure outcome.
    const r2 = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 20000,
      reason: "second",
    }).catch(() => null);
    await decideRefund(users.bob, {
      approvalRequestId: r1.approvalRequestId!,
      approve: true,
    });
    if (r2) {
      await decideRefund(users.bob, {
        approvalRequestId: r2.approvalRequestId!,
        approve: true,
      });
    }

    const paid = payments.calls.reduce((s, c) => s + c.amountCents, 0);
    const executed = await db.refund.findMany({
      where: { transactionId: txn.id, status: "executed" },
    });
    const executedTotal = executed.reduce((s, r) => s + r.amountCents, 0);
    expect(executedTotal).toBeLessThanOrEqual(txn.amountCents);
    expect(paid).toBeLessThanOrEqual(txn.amountCents);
  });

  it("routes refund requests to finance once cumulative pending refunds exceed the small-refund limit", async () => {
    const txn = await seedTransaction(100000); // $1,000
    await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 20000,
      reason: "first slice",
    });
    const second = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 20000,
      reason: "second slice — cumulative $400 > $250 limit",
    });
    const req = await db.approvalRequest.findUniqueOrThrow({
      where: { id: second.approvalRequestId! },
    });
    // A support lead should not be able to approve a transaction whose
    // outstanding refunds now total more than the $250 small-refund limit.
    expect(req.requiredRole).toBe("finance_approver");
  });
});

describe("decision replay and double execution", () => {
  it("rejects a second decision on an already-decided request (approve then reject)", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "replay target",
    });
    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: true,
    });
    await expect(
      decideRefund(users.bob, {
        approvalRequestId: refund.approvalRequestId!,
        approve: false,
      }),
    ).rejects.toThrow();
    expect(await refundStatus(refund.id)).toBe("executed");
  });

  it("commits at most one decision when two decisions race", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "race target",
    });
    const results = await Promise.allSettled([
      decideRefund(users.bob, {
        approvalRequestId: refund.approvalRequestId!,
        approve: true,
      }),
      decideRefund(users.bob, {
        approvalRequestId: refund.approvalRequestId!,
        approve: true,
      }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won.length).toBeLessThanOrEqual(1);
    // At most one payment may execute no matter how the race resolves.
    expect(payments.calls.length).toBeLessThanOrEqual(1);
  });

  it("cannot re-execute an already-executed refund via the approval hook", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "double pay target",
    });
    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: true,
    });
    expect(payments.calls).toHaveLength(1);

    // Invoking the hook again must not issue a second payment.
    await expect(
      onRefundApproved({
        entityId: refund.id,
        decidedById: users.bob.id,
      }),
    ).rejects.toThrow();
    expect(payments.calls).toHaveLength(1);
    expect(await refundStatus(refund.id)).toBe("executed");
  });
});

describe("role spoofing and confused deputy", () => {
  it("requestRefund verifies the caller's role against the database", async () => {
    const txn = await seedTransaction(10000);
    // erin is an engineer (refunds:read only) claiming support_agent rights.
    await expect(
      requestRefund(
        { id: users.erin.id, role: "support_agent" },
        { transactionId: txn.id, amountCents: 5000, reason: "forged role" },
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("decideApproval verifies the decider's stored role, not the supplied one", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "forged decider",
    });
    // kai is a kyc_reviewer with no refund permissions claiming support_lead.
    await expect(
      decideApproval({
        requestId: refund.approvalRequestId!,
        decider: { id: users.kai.id, role: "support_lead" },
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(await refundStatus(refund.id)).toBe("requested");
    expect(payments.calls).toHaveLength(0);
  });

  it("requires the approver permission for the entity type, not just role-name equality", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "victim refund",
    });
    // A crafted request routed to kyc_reviewer — a role with zero permissions.
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "kyc_reviewer",
      entityId: refund.id,
    });
    await expect(
      decideApproval({
        requestId: crafted.id,
        decider: asActor(users.kai),
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(await refundStatus(refund.id)).toBe("requested");
    expect(payments.calls).toHaveLength(0);
  });

  it("still blocks self-approval when going through decideApproval directly", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.bob, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "self approval",
    });
    await expect(
      decideApproval({
        requestId: refund.approvalRequestId!,
        decider: asActor(users.bob),
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects a null decider with an authz error, not a TypeError", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "bad decider",
    });
    await expect(
      decideApproval({
        requestId: refund.approvalRequestId!,
        decider: null as unknown as { id: string; role: string },
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(await refundStatus(refund.id)).toBe("requested");
  });

  it("rejects a decider id that does not exist", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "ghost decider",
    });
    await expect(
      decideApproval({
        requestId: refund.approvalRequestId!,
        decider: { id: "ghost-user-id", role: "support_lead" },
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(await refundStatus(refund.id)).toBe("requested");
    expect(payments.calls).toHaveLength(0);
  });
});

describe("entity confusion and linkage", () => {
  it("does not execute a refund decided by a request that is not its own", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "linked request is still pending",
    });
    // Attacker crafts a second request pointing at the same refund.
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: refund.id,
    });
    await decideRefund(users.bob, {
      approvalRequestId: crafted.id,
      approve: true,
    });
    // The refund's real approval request is still pending — it must not have
    // been executed by an unrelated decision.
    expect(await refundStatus(refund.id)).toBe("requested");
    expect(payments.calls).toHaveLength(0);
  });

  it("cannot resurrect a rejected refund with a second crafted approval request", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "reject me",
    });
    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: false,
    });
    expect(await refundStatus(refund.id)).toBe("rejected");

    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: refund.id,
    });
    // The refund is terminal — the decision itself is rejected in-transaction.
    await expect(
      decideRefund(users.bob, {
        approvalRequestId: crafted.id,
        approve: true,
      }),
    ).rejects.toThrow();
    expect(await refundStatus(refund.id)).toBe("rejected");
    expect(payments.calls).toHaveLength(0);
  });

  it("does not double-pay when a refund's own request and a crafted request are both approved", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 10000,
      reason: "two approvals",
    });
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: refund.id,
    });
    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: true,
    });
    // The refund already executed — the crafted decision is rejected
    // in-transaction rather than recorded and refused.
    await expect(
      decideRefund(users.bob, {
        approvalRequestId: crafted.id,
        approve: true,
      }),
    ).rejects.toThrow();
    expect(payments.calls).toHaveLength(1);
  });

  it("fails atomically when the approved entity does not exist", async () => {
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: "nonexistent-refund-id",
    });
    await expect(
      decideRefund(users.bob, { approvalRequestId: crafted.id, approve: true }),
    ).rejects.toThrow();
    // The decision must not be committed when the entity cannot be resolved.
    const req = await db.approvalRequest.findUniqueOrThrow({
      where: { id: crafted.id },
    });
    expect(req.status).toBe("pending");
  });

  it("rejects decideRefund for requests that are not refund entities", async () => {
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityType: "user_role_change",
      entityId: users.erin.id,
    });
    await expect(
      decideRefund(users.bob, { approvalRequestId: crafted.id, approve: true }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("transaction and state-machine integrity", () => {
  it("rejects refund requests on non-settled transactions", async () => {
    const txn = await seedTransaction(10000);
    await setTransactionStatus(txn.id, "failed");
    await expect(
      requestRefund(users.alice, {
        transactionId: txn.id,
        amountCents: 5000,
        reason: "refund a failed txn",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("re-checks transaction status at execution time", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "txn settles then fails",
    });
    // Transaction fails (e.g. chargeback) between request and decision.
    await setTransactionStatus(txn.id, "failed");
    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: true,
    });
    expect(await refundStatus(refund.id)).not.toBe("executed");
    expect(payments.calls).toHaveLength(0);
  });

  it("does not strand a refund in 'approved' when the payment call throws", async () => {
    const txn = await seedTransaction(10000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "gateway down",
    });
    payments.behavior = "throw";
    await expect(
      decideRefund(users.bob, {
        approvalRequestId: refund.approvalRequestId!,
        approve: true,
      }),
    ).rejects.toThrow();
    // Secure outcomes: refund marked failed, or request still pending so the
    // decision can be retried. A terminal 'approved' with no payment is a
    // stranded state — the request is already decided and cannot re-fire.
    const status = await refundStatus(refund.id);
    const req = await db.approvalRequest.findUniqueOrThrow({
      where: { id: refund.approvalRequestId! },
    });
    expect(status === "failed" || req.status === "pending").toBe(true);
  });

  it("marks declined payments as failed and audits every transition", async () => {
    payments.behavior = "fail";
    const txn = await seedTransaction(5000);
    const refund = await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "declined path",
    });
    await decideRefund(users.bob, {
      approvalRequestId: refund.approvalRequestId!,
      approve: true,
    });
    expect(await refundStatus(refund.id)).toBe("failed");
    const refundEvents = (await db.auditEvent.findMany({
      where: { entityType: "refund", entityId: refund.id },
    })).filter((e) => e.action === "refund.status");
    expect(refundEvents.length).toBeGreaterThanOrEqual(2);
  });
});

describe("amount integrity", () => {
  it("rejects zero, negative, non-integer and NaN cent amounts at the service layer", async () => {
    const txn = await seedTransaction(10000);
    for (const amountCents of [0, -1, -5000, 2.5, Number.NaN]) {
      await expect(
        requestRefund(users.alice, {
          transactionId: txn.id,
          amountCents,
          reason: "bad amount",
        }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("rejects sub-cent precision at the action layer instead of rounding", async () => {
    const txn = await seedTransaction(100000);
    session.cookies["itp_user_id"] = users.alice.id;
    // "10.005" dollars = 1000.5 cents — not representable. The action must
    // reject it, not silently round up to a different amount than submitted.
    const result = await runRequestAction({
      transactionId: txn.id,
      amount: "10.005",
      reason: "rounding probe",
    });
    expect(result).toHaveProperty("error");
    expect(await db.refund.count()).toBe(0);
  });

  it("rejects non-numeric, negative and absurd amounts at the action layer", async () => {
    const txn = await seedTransaction(10000);
    session.cookies["itp_user_id"] = users.alice.id;
    for (const amount of ["abc", "", "NaN", "Infinity", "-5", "0", "1e9"]) {
      const result = await runRequestAction({
        transactionId: txn.id,
        amount,
        reason: "fuzz",
      });
      expect(result).toHaveProperty("error");
    }
    expect(await db.refund.count()).toBe(0);
  });

  it("rejects action calls from unauthenticated sessions", async () => {
    const txn = await seedTransaction(10000);
    await expect(
      runRequestAction({
        transactionId: txn.id,
        amount: "5",
        reason: "no session",
      }),
    ).resolves.toEqual({ redirected: true });
    expect(session.redirects).toContain("/login");
    expect(await db.refund.count()).toBe(0);
  });
});

describe("audit integrity", () => {
  it("does not allow audit events to be updated", async () => {
    const txn = await seedTransaction(10000);
    await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "audit me",
    });
    await expect(
      db.auditEvent.updateMany({ data: { action: "tampered" } }),
    ).rejects.toThrow();
  });

  it("does not allow audit events to be deleted", async () => {
    const txn = await seedTransaction(10000);
    await requestRefund(users.alice, {
      transactionId: txn.id,
      amountCents: 5000,
      reason: "audit me",
    });
    await expect(db.auditEvent.deleteMany()).rejects.toThrow();
  });

  it("audits creation of every approval request, including hand-crafted ones", async () => {
    const txn = await seedTransaction(10000);
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: txn.id,
    });
    const events = await db.auditEvent.findMany({
      where: { entityType: "approval_request", entityId: crafted.id },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("audits post-commit hook failures instead of silently swallowing them", async () => {
    const crafted = await craftApproval({
      requesterId: users.alice.id,
      requiredRole: "support_lead",
      entityId: "missing-refund",
    });
    await expect(
      decideRefund(users.bob, { approvalRequestId: crafted.id, approve: true }),
    ).rejects.toThrow();
    const actions = await auditActions();
    expect(
      actions.some(
        (a) => a.includes("fail") || a.includes("error") || a.includes("hook"),
      ),
    ).toBe(true);
  });
});

describe("baseline defenses that must keep holding", () => {
  it("blocks kyc and platform_admin roles from mutating refunds", async () => {
    const txn = await seedTransaction(10000);
    await expect(
      requestRefund(users.kai, {
        transactionId: txn.id,
        amountCents: 1000,
        reason: "kyc",
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      requestRefund(users.adam, {
        transactionId: txn.id,
        amountCents: 1000,
        reason: "admin",
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(searchTransactions(users.kai)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("blocks unauthenticated callers from service functions", async () => {
    const txn = await seedTransaction(10000);
    await expect(
      requestRefund(null as unknown as { id: string; role: string }, {
        transactionId: txn.id,
        amountCents: 1000,
        reason: "anon",
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      listRefunds(null as unknown as { id: string; role: string }),
    ).rejects.toThrow(ForbiddenError);
  });
});
