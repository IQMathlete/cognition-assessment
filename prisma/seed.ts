import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const USERS: Array<{ username: string; displayName: string; role: string }> = [
  { username: "alice", displayName: "Alice Alvarez", role: "support_agent" },
  { username: "bob", displayName: "Bob Becker", role: "support_lead" },
  { username: "fiona", displayName: "Fiona Fontaine", role: "finance_approver" },
  { username: "erin", displayName: "Erin Engel", role: "engineer" },
  { username: "eli", displayName: "Eli Ellis", role: "engineer" },
  { username: "kai", displayName: "Kai Kimura", role: "kyc_reviewer" },
  { username: "sam", displayName: "Sam Santos", role: "kyc_senior" },
  { username: "adam", displayName: "Adam Adams", role: "platform_admin" },
];

const MERCHANTS = [
  "Blue Bottle Coffee",
  "Lyft",
  "AWS",
  "Delta Airlines",
  "Sweetgreen",
  "Stripe",
  "Figma",
  "Uber Eats",
  "Notion",
  "Shell",
  "Trader Joe's",
  "Zoom",
  "Amtrak",
  "Hotel Meridian",
  "Best Buy",
];

const CARDHOLDERS = [
  "M. Okafor",
  "J. Rivera",
  "T. Nakamura",
  "S. Patel",
  "L. Novak",
  "C. Dubois",
];

const APPLICANTS = [
  "A. Whitfield",
  "B. Tanaka",
  "C. Osei",
  "D. Lindqvist",
  "E. Moreau",
  "F. Castellanos",
  "G. Petrov",
  "H. Adeyemi",
  "I. Kowalski",
  "J. Reyes",
];

const COUNTRIES = ["US", "CA", "GB", "DE", "BR", "NG", "JP", "FR"];

const DOCUMENT_SETS = [
  "passport, utility bill",
  "driver's license, bank statement",
  "passport, tax return",
  "national ID, utility bill",
  "driver's license, pay stub",
];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

async function main() {
  for (const u of USERS) {
    await db.user.upsert({ where: { username: u.username }, update: u, create: u });
  }

  const existing = await db.transaction.count();
  if (existing < 30) {
    // ~30 synthetic card transactions; a handful end in "FAIL" so the mock
    // payments client can exercise the refund-failed path.
    const amounts = [
      4200, 1850, 12999, 25000, 7600, 480000, 9950, 31000, 1500, 66000,
      28900, 8200, 175000, 5400, 9999, 24000, 37500, 6100, 15200, 88000,
      43000, 2750, 19600, 305000, 7300, 52000, 11800, 20000, 9550, 140000,
    ];
    for (let i = 0; i < amounts.length; i++) {
      const daysAgo = (i * 2) % 60;
      const externalId =
        i === 4 || i === 17
          ? `txn_${1000 + i}_FAIL`
          : `txn_${1000 + i}`;
      await db.transaction.upsert({
        where: { externalId },
        update: {},
        create: {
          externalId,
          merchant: pick(MERCHANTS, i),
          cardholder: pick(CARDHOLDERS, i),
          amountCents: amounts[i],
          status: "settled",
          createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        },
      });
    }
  } else {
    console.log("Seed: transactions already present, skipping.");
  }

  const existingCases = await db.kycCase.count();
  if (existingCases < 40) {
    // 40 synthetic KYC cases. All PII is invented: SSNs use the 9xx area
    // reserved for fictional/ITIN-style numbers, DOBs are arbitrary.
    // Assignees alternate between kai (kyc_reviewer) and sam (kyc_senior);
    // risk >= 80 routes a reviewer approval into the senior second-review
    // queue.
    const kai = await db.user.findUniqueOrThrow({ where: { username: "kai" } });
    const sam = await db.user.findUniqueOrThrow({ where: { username: "sam" } });
    const riskScores = [
      12, 45, 88, 23, 71, 34, 92, 18, 55, 67,
      81, 29, 41, 95, 8, 62, 50, 84, 15, 36,
      73, 90, 27, 58, 11, 86, 39, 64, 21, 97,
      48, 76, 5, 82, 31, 69, 53, 89, 17, 44,
    ];
    for (let i = 0; i < riskScores.length; i++) {
      const daysAgo = (i * 3) % 45;
      const externalId = `kyc_${3000 + i}`;
      await db.kycCase.upsert({
        where: { externalId },
        update: {},
        create: {
          externalId,
          applicant: pick(APPLICANTS, i),
          ssn: `9${String(i).padStart(2, "0")}-45-${String(6000 + i)}`,
          dob: `${1955 + (i % 40)}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
          country: pick(COUNTRIES, i * 3),
          riskScore: riskScores[i],
          documents: pick(DOCUMENT_SETS, i),
          status: "pending",
          assigneeId: i % 4 === 3 ? sam.id : kai.id,
          createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        },
      });
    }
  } else {
    console.log("Seed: KYC cases already present, skipping.");
  }

  console.log("Seed complete: 8 users, 30 transactions, 40 KYC cases.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
