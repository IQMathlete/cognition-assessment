import { PrismaClient } from "@prisma/client";

// Singleton so Next.js dev-mode hot reloads don't exhaust SQLite connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

// --- Append-only enforcement -----------------------------------------------
// The audit log is append-only by contract, but a convention is not a control:
// these SQLite triggers make AuditEvent rows physically immutable. They are
// installed lazily (db push does not manage triggers) and awaited by
// withAudit() before any audited write, so the guard is always in place
// before the log can be touched. Tests drop the guards to reset the DB.

const AUDIT_GUARD_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS audit_no_update
   BEFORE UPDATE ON "AuditEvent"
   BEGIN SELECT RAISE(ABORT, 'AuditEvent is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS audit_no_delete
   BEFORE DELETE ON "AuditEvent"
   BEGIN SELECT RAISE(ABORT, 'AuditEvent is append-only'); END`,
];

let auditGuardPromise: Promise<void> | null = null;

export function auditGuardsReady(): Promise<void> {
  auditGuardPromise ??= (async () => {
    for (const sql of AUDIT_GUARD_STATEMENTS) {
      await db.$executeRawUnsafe(sql);
    }
  })();
  return auditGuardPromise;
}

/** Test hook: drop the append-only triggers so audit rows can be reset. */
export async function dropAuditGuards(): Promise<void> {
  auditGuardPromise = null;
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_no_update`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_no_delete`);
}
