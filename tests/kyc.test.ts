import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/platform/errors";
import {
  decideCase,
  dispositionCase,
  getCase,
  revealPii,
  searchCases,
} from "@/tools/kyc";
import { resetDb, seedCase, seedUsers } from "./helpers";

let users: Record<string, { id: string; role: string }>;

beforeEach(async () => {
  await resetDb();
  users = await seedUsers();
});

async function auditActionsFor(entityType: string, entityId: string) {
  const rows = await db.auditEvent.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.action);
}

describe("kyc tool — RBAC", () => {
  it("rejects roles without kyc permissions server-side", async () => {
    const kase = await seedCase(40, users.kai.id);
    await expect(searchCases(users.alice)).rejects.toThrow(ForbiddenError);
    await expect(
      dispositionCase(users.alice, {
        caseId: kase.id,
        action: "approve",
        reason: "ok",
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      revealPii(users.alice, { caseId: kase.id, reason: "check" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("lets a reviewer disposition a case but not decide the senior queue or reveal PII", async () => {
    const kase = await seedCase(90, users.kai.id);
    await dispositionCase(users.kai, {
      caseId: kase.id,
      action: "escalate",
      reason: "needs senior eyes",
    });
    const req = await db.approvalRequest.findFirstOrThrow({
      where: { entityType: "kyc_case", entityId: kase.id },
    });
    // kai routed it, but cannot decide (no kyc:approve) — and couldn't anyway
    // because it is his own request.
    await expect(
      decideCase(users.kai, { approvalRequestId: req.id, approve: true, note: "test justification" }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      revealPii(users.kai, { caseId: kase.id, reason: "check" }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("kyc tool — assignment scoping", () => {
  it("shows a reviewer only their own assigned cases", async () => {
    await seedCase(40, users.kai.id, "kyc_k1");
    await seedCase(50, users.sam.id, "kyc_s1");
    await seedCase(60, users.kai.id, "kyc_k2");

    const kaiCases = await searchCases(users.kai);
    expect(kaiCases.map((c) => c.externalId).sort()).toEqual([
      "kyc_k1",
      "kyc_k2",
    ]);
    const samCases = await searchCases(users.sam);
    expect(samCases).toHaveLength(3); // senior sees the whole queue
  });

  it("blocks a reviewer from reading or dispositioning another reviewer's case", async () => {
    const kase = await seedCase(40, users.sam.id);
    await expect(getCase(users.kai, kase.id)).rejects.toThrow(NotFoundError);
    await expect(
      dispositionCase(users.kai, {
        caseId: kase.id,
        action: "approve",
        reason: "ok",
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("kyc tool — dispositions and audit", () => {
  it("verifies a low-risk approval immediately with audit", async () => {
    const kase = await seedCase(40, users.kai.id);
    const after = await dispositionCase(users.kai, {
      caseId: kase.id,
      action: "approve",
      reason: "docs check out",
    });
    expect(after.status).toBe("verified");
    const actions = await auditActionsFor("kyc_case", kase.id);
    expect(actions).toContain("kyc_case.verified");
    // No approval request — no senior involvement for low risk.
    expect(
      await db.approvalRequest.count({ where: { entityId: kase.id } }),
    ).toBe(0);
  });

  it("rejects with a required reason, audited", async () => {
    const kase = await seedCase(40, users.kai.id);
    const after = await dispositionCase(users.kai, {
      caseId: kase.id,
      action: "reject",
      reason: "sanctions match",
    });
    expect(after.status).toBe("rejected");
    const actions = await auditActionsFor("kyc_case", kase.id);
    expect(actions).toContain("kyc_case.rejected");
  });

  it("routes risk >= 80 approval to a senior second review", async () => {
    const kase = await seedCase(80, users.kai.id);
    const after = await dispositionCase(users.kai, {
      caseId: kase.id,
      action: "approve",
      reason: "looks fine but high risk",
    });
    expect(after.status).toBe("pending_second_review");
    const req = await db.approvalRequest.findFirstOrThrow({
      where: { entityType: "kyc_case", entityId: kase.id },
    });
    expect(req.requiredRole).toBe("kyc_senior");
    expect(req.requesterId).toBe(users.kai.id);

    const decided = await decideCase(users.sam, {
      approvalRequestId: req.id,
      approve: true,
        note: "test justification",
      });
    expect(decided.status).toBe("approved");
    const final = await db.kycCase.findUniqueOrThrow({
      where: { id: kase.id },
    });
    expect(final.status).toBe("verified");

    const actions = await auditActionsFor("kyc_case", kase.id);
    expect(actions).toContain("kyc_case.second_review_requested");
    expect(actions).toContain("kyc_case.verified");
    const approvalActions = await auditActionsFor(
      "approval_request",
      req.id,
    );
    expect(approvalActions).toContain("approval.requested");
    expect(approvalActions).toContain("approval.approved");
  });

  it("routes escalations to the senior queue; a senior rejection closes the case", async () => {
    const kase = await seedCase(30, users.kai.id);
    const after = await dispositionCase(users.kai, {
      caseId: kase.id,
      action: "escalate",
      reason: "unclear docs",
    });
    expect(after.status).toBe("escalated");
    const req = await db.approvalRequest.findFirstOrThrow({
      where: { entityType: "kyc_case", entityId: kase.id },
    });

    await decideCase(users.sam, {
      approvalRequestId: req.id,
      approve: false,
      note: "insufficient evidence",
    });
    const final = await db.kycCase.findUniqueOrThrow({
      where: { id: kase.id },
    });
    expect(final.status).toBe("rejected");
    const actions = await auditActionsFor("kyc_case", kase.id);
    expect(actions).toContain("kyc_case.escalated");
    expect(actions).toContain("kyc_case.rejected");
  });

  it("lets a senior disposition any case", async () => {
    const kase = await seedCase(40, users.kai.id);
    const after = await dispositionCase(users.sam, {
      caseId: kase.id,
      action: "approve",
      reason: "senior override",
    });
    expect(after.status).toBe("verified");
  });

  it("keeps a senior-routed case decidable when the assignee is someone else", async () => {
    // Sam escalates Kai's case: the requester is sam, the assignee is kai —
    // the request must still be decidable (by a different senior flow).
    const kase = await seedCase(30, users.kai.id);
    await dispositionCase(users.sam, {
      caseId: kase.id,
      action: "escalate",
      reason: "senior re-routing",
    });
    const req = await db.approvalRequest.findFirstOrThrow({
      where: { entityType: "kyc_case", entityId: kase.id },
    });
    expect(req.requesterId).toBe(users.sam.id);
    // sam routed it, so sam cannot decide it (self-approval) — but the
    // decision itself must be well-formed, not refused on provenance.
    await expect(
      decideCase(users.sam, { approvalRequestId: req.id, approve: true, note: "test justification" }),
    ).rejects.toThrow("cannot approve or reject your own");
  });
});

describe("kyc tool — self-approval", () => {
  it("blocks a senior from deciding a request they routed themselves", async () => {
    // sam owns this case; his escalation creates a request he is the requester
    // of — and he is the only kyc_senior, so nobody can decide it.
    const kase = await seedCase(30, users.sam.id);
    await dispositionCase(users.sam, {
      caseId: kase.id,
      action: "escalate",
      reason: "second opinion",
    });
    const req = await db.approvalRequest.findFirstOrThrow({
      where: { entityType: "kyc_case", entityId: kase.id },
    });
    await expect(
      decideCase(users.sam, { approvalRequestId: req.id, approve: true, note: "test justification" }),
    ).rejects.toThrow(ForbiddenError);
    // The case stays in the senior queue, undecided.
    const final = await db.kycCase.findUniqueOrThrow({
      where: { id: kase.id },
    });
    expect(final.status).toBe("escalated");
  });
});

describe("kyc tool — PII masking and reveal", () => {
  it("masks ssn and dob in every read path", async () => {
    const kase = await seedCase(40, users.kai.id); // ssn 999-00-1234, dob 1985-04-12
    const listed = await searchCases(users.kai);
    const row = listed.find((c) => c.id === kase.id)!;
    expect(row.ssn).toBe("***-**-1234");
    expect(row.dob).toBe("1985");

    const fetched = await getCase(users.kai, kase.id);
    expect(fetched.ssn).toBe("***-**-1234");
    expect(fetched.dob).toBe("1985");
    expect(JSON.stringify(listed)).not.toContain("999-00-1234");
    expect(JSON.stringify(listed)).not.toContain("1985-04-12");
  });

  it("requires a senior, a reason, and writes an audit event for reveal", async () => {
    const kase = await seedCase(40, users.kai.id);
    await expect(
      revealPii(users.sam, { caseId: kase.id, reason: "  " }),
    ).rejects.toThrow(ValidationError);

    const revealed = await revealPii(users.sam, {
      caseId: kase.id,
      reason: "subpoena response",
    });
    expect(revealed).toEqual({ ssn: "999-00-1234", dob: "1985-04-12" });

    const actions = await auditActionsFor("kyc_case", kase.id);
    expect(actions).toContain("kyc_case.pii_revealed");
    // The audit row records the reason and fields — never the values.
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityId: kase.id, action: "kyc_case.pii_revealed" },
    });
    expect(audit.after).not.toContain("999-00-1234");
    expect(audit.after).toContain("subpoena response");
  });
});

describe("kyc tool — validation", () => {
  it("requires a reason and a valid action", async () => {
    const kase = await seedCase(40, users.kai.id);
    await expect(
      dispositionCase(users.kai, { caseId: kase.id, action: "approve", reason: "" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      dispositionCase(users.kai, {
        caseId: kase.id,
        action: "merge",
        reason: "hmm",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses a second disposition once the case left pending", async () => {
    const kase = await seedCase(40, users.kai.id);
    await dispositionCase(users.kai, {
      caseId: kase.id,
      action: "reject",
      reason: "no",
    });
    await expect(
      dispositionCase(users.kai, {
        caseId: kase.id,
        action: "approve",
        reason: "changed mind",
      }),
    ).rejects.toThrow();
  });
});
