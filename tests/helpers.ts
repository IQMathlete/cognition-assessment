import { db, dropAuditGuards } from "@/platform/db";

export const USERS = {
  alice: "support_agent",
  bob: "support_lead",
  fiona: "finance_approver",
  erin: "engineer",
  kai: "kyc_reviewer",
  adam: "platform_admin",
} as const;

export async function resetDb() {
  // Audit rows are append-only via DB triggers; tests lift the guards to
  // reset, and the next withAudit() call reinstalls them.
  await dropAuditGuards();
  await db.$transaction([
    db.auditEvent.deleteMany(),
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
