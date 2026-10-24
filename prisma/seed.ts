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

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

async function main() {
  for (const u of USERS) {
    await db.user.upsert({ where: { username: u.username }, update: u, create: u });
  }

  const existing = await db.transaction.count();
  if (existing >= 30) {
    console.log("Seed: users upserted; transactions already present, skipping.");
    return;
  }

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

  console.log("Seed complete: 8 users, 30 transactions.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
