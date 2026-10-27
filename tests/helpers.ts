import { db, dropAuditGuards } from "@/platform/db";

export const USERS = {
  alice: "support_agent",
  bob: "support_lead",
  fiona: "finance_approver",
  erin: "engineer",
  kai: "kyc_reviewer",
  sam: "kyc_senior",
  adam: "platform_admin",
} as const;

export async function resetDb() {
  // Audit rows are append-only via DB triggers; tests lift the guards to
  // reset, and the next withAudit() call reinstalls them.
  await dropAuditGuards();
  await db.$transaction([
    db.auditEvent.deleteMany(),
    db.kycCase.deleteMany(),
    db.refund.deleteMany(),
    db.approvalRequest.deleteMany(),
    db.transaction.deleteMany(),
    db.user.deleteMany(),
  ]);
}

export async function seedUsers() {
  for (const [username, role] of Object.entries(USERS)) {
    await db.user.create({
      data: { username, displayName: username, role },
    });
  }
  const rows = await db.user.findMany();
  return Object.fromEntries(rows.map((u) => [u.username, u]));
}

export async function seedTransaction(amountCents: number, externalId = "txn_t1") {
  return db.transaction.create({
    data: {
      externalId,
      merchant: "Test Merchant",
      cardholder: "T. Tester",
      amountCents,
    },
  });
}

export async function seedCase(
  riskScore: number,
  assigneeId: string,
  externalId = "kyc_t1",
  status = "pending",
) {
  return db.kycCase.create({
    data: {
      externalId,
      applicant: "T. Applicant",
      ssn: "999-00-1234",
      dob: "1985-04-12",
      country: "US",
      riskScore,
      documents: "passport, utility bill",
      status,
      assigneeId,
    },
  });
}
