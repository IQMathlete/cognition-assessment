import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/platform/db";
import { ForbiddenError, ValidationError } from "@/platform/errors";
import { hasPermission, requirePermission } from "@/platform/rbac";
import "@/tools/kyc"; // registers approval hooks
import {
  decideReview,
  listReviews,
  requestReview,
  requiredRoleForReview,
  searchCases,
} from "@/tools/kyc";
import { resetDb, seedCase, seedUsers } from "./helpers";

let users: Record<string, { id: string; role: string }>;

beforeEach(async () => {
  await resetDb();
  users = await seedUsers();
});

describe("RBAC / server-side authorization", () => {
  it("rejects roles without the permission server-side", async () => {
    const kycCase = await seedCase(30);

    // alice (support_agent) cannot even read the KYC tool
    expect(() => requirePermission(users.alice, "kyc:read")).toThrow(
      ForbiddenError,
    );
    await expect(searchCases(users.alice)).rejects.toThrow(ForbiddenError);
    await expect(listReviews(users.alice)).rejects.toThrow(ForbiddenError);

    // kai (kyc_reviewer) can read and request but cannot decide
    await expect(searchCases(users.kai)).resolves.toHaveLength(1);
    const review = await requestReview(users.kai, {
      caseId: kycCase.id,
      recommendation: "verify",
      reason: "docs look clean",
    });
    await expect(
      decideReview(users.kai, {
        approvalRequestId: review.approvalRequestId!,
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("audit trail", () => {
  it("writes an audit event for every review mutation", async () => {
    const kycCase = await seedCase(30);
    const review = await requestReview(users.kai, {
      caseId: kycCase.id,
      recommendation: "verify",
      reason: "verified against registry",
    });

    const events = await db.auditEvent.findMany({
      orderBy: { createdAt: "asc" },
    });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("kyc_review.requested");
    expect(actions).toContain("approval.requested");
    for (const e of events) {
      expect(e.actorId).toBe(users.kai.id);
    }

    await decideReview(users.sam, {
      approvalRequestId: review.approvalRequestId!,
      approve: true,
    });

    const after = await db.auditEvent.findMany({
      orderBy: { createdAt: "asc" },
    });
    const afterActions = after.map((e) => e.action);
    // Decision + review transitions + the case verdict are all audited:
    // approval.approved -> review approved -> review executed + case verified.
    expect(afterActions).toContain("approval.approved");
    expect(
      afterActions.filter((a) => a === "kyc_review.status"),
    ).toHaveLength(2);
    expect(afterActions).toContain("kyc_case.status");

    const final = await db.kycReview.findUniqueOrThrow({
      where: { id: review.id },
    });
    expect(final.status).toBe("executed");
    expect(final.screeningResultId).toBeTruthy();

    const closed = await db.kycCase.findUniqueOrThrow({
      where: { id: kycCase.id },
    });
    expect(closed.status).toBe("verified");
  });

  it("applies a reject recommendation to the case when approved", async () => {
    const kycCase = await seedCase(45);
    const review = await requestReview(users.kai, {
      caseId: kycCase.id,
      recommendation: "reject",
      reason: "sanctions list hit",
    });
    await decideReview(users.sam, {
      approvalRequestId: review.approvalRequestId!,
      approve: true,
    });
    const closed = await db.kycCase.findUniqueOrThrow({
      where: { id: kycCase.id },
    });
    expect(closed.status).toBe("rejected");
  });

  it("audits the failed path when the screening vendor declines", async () => {
    const kycCase = await seedCase(30, "kyc_x_FAIL");
    const review = await requestReview(users.kai, {
      caseId: kycCase.id,
      recommendation: "verify",
      reason: "docs look clean",
    });
    await decideReview(users.sam, {
      approvalRequestId: review.approvalRequestId!,
      approve: true,
    });
    const final = await db.kycReview.findUniqueOrThrow({
      where: { id: review.id },
    });
    expect(final.status).toBe("failed");
    expect(final.failureReason).toBeTruthy();
    // The case is freed — no verdict was filed.
    const kycCaseAfter = await db.kycCase.findUniqueOrThrow({
      where: { id: kycCase.id },
    });
    expect(kycCaseAfter.status).toBe("pending");
  });
});

describe("self-approval", () => {
  it("rejects a decision by the requester even with the required role", async () => {
    const kycCase = await seedCase(30); // standard -> kyc_senior route
    // sam is a kyc_senior AND the requester.
    const review = await requestReview(users.sam, {
      caseId: kycCase.id,
      recommendation: "verify",
      reason: "spot check",
    });
    await expect(
      decideReview(users.sam, {
        approvalRequestId: review.approvalRequestId!,
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("risk routing", () => {
  it("routes standard cases to kyc_senior and high-risk to finance_approver", async () => {
    expect(requiredRoleForReview(69)).toBe("kyc_senior");
    expect(requiredRoleForReview(70)).toBe("finance_approver");

    const low = await seedCase(30, "kyc_low");
    const high = await seedCase(85, "kyc_high");

    const lowReview = await requestReview(users.kai, {
      caseId: low.id,
      recommendation: "verify",
      reason: "standard",
    });
    const highReview = await requestReview(users.kai, {
      caseId: high.id,
      recommendation: "reject",
      reason: "high risk",
    });

    const lowReq = await db.approvalRequest.findUniqueOrThrow({
      where: { id: lowReview.approvalRequestId! },
    });
    const highReq = await db.approvalRequest.findUniqueOrThrow({
      where: { id: highReview.approvalRequestId! },
    });
    expect(lowReq.requiredRole).toBe("kyc_senior");
    expect(highReq.requiredRole).toBe("finance_approver");

    // The wrong role cannot decide.
    await expect(
      decideReview(users.fiona, {
        approvalRequestId: lowReq.id,
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      decideReview(users.sam, {
        approvalRequestId: highReq.id,
        approve: true,
      }),
    ).rejects.toThrow(ForbiddenError);

    // The right roles can.
    await expect(
      decideReview(users.sam, {
        approvalRequestId: lowReq.id,
        approve: true,
      }),
    ).resolves.toMatchObject({ status: "approved" });
    await expect(
      decideReview(users.fiona, {
        approvalRequestId: highReq.id,
        approve: false,
        note: "escalate to committee instead",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
  });
});

describe("validation", () => {
  it("requires a reason and a valid recommendation", async () => {
    const kycCase = await seedCase(30);
    await expect(
      requestReview(users.kai, {
        caseId: kycCase.id,
        recommendation: "verify",
        reason: "   ",
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      requestReview(users.kai, {
        caseId: kycCase.id,
        recommendation: "maybe",
        reason: "unsure",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("blocks a second active review and reviews on closed cases", async () => {
    const kycCase = await seedCase(30);
    await requestReview(users.kai, {
      caseId: kycCase.id,
      recommendation: "verify",
      reason: "first",
    });
    await expect(
      requestReview(users.kai, {
        caseId: kycCase.id,
        recommendation: "reject",
        reason: "second",
      }),
    ).rejects.toThrow(ValidationError);

    const closed = await seedCase(30, "kyc_closed", "verified");
    await expect(
      requestReview(users.kai, {
        caseId: closed.id,
        recommendation: "reject",
        reason: "redo",
      }),
    ).rejects.toThrow(ValidationError);
  });
});
