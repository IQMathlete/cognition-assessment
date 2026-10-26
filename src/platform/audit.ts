import { AUDIT_GUARD_STATEMENTS, auditGuardsReady, db, type Tx } from "./db";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

// Writes audit rows inside an existing transaction. Internal to the platform —
// callers should almost always use withAudit() instead.
//
// The append-only triggers are (re)installed inside this transaction: audit
// writes outside withAudit (e.g. createApprovalRequest inside a caller's own
// transaction) would otherwise leave the log unguarded on a fresh database.
export async function recordAudit(
  tx: Tx,
  actorId: string,
  entries: AuditEntry | AuditEntry[],
): Promise<void> {
  for (const stmt of AUDIT_GUARD_STATEMENTS) {
    await tx.$executeRawUnsafe(stmt);
  }
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    await tx.auditEvent.create({
      data: {
        actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: toJson(entry.before),
        after: toJson(entry.after),
      },
    });
  }
}

/**
 * Runs `work` in a transaction and writes the audit entries it returns in the
 * SAME transaction, so a change and its audit trail commit or roll back
 * together.
 *
 * Usage:
 *   const refund = await withAudit(actor.id, async (tx) => {
 *     const created = await tx.refund.create({ data: ... });
 *     return { value: created, audit: { action: "refund.requested", ... } };
 *   });
 */
export async function withAudit<T>(
  actorId: string,
  work: (tx: Tx) => Promise<{ value: T; audit: AuditEntry | AuditEntry[] }>,
): Promise<T> {
  await auditGuardsReady();
  return db.$transaction(async (tx) => {
    const { value, audit } = await work(tx);
    await recordAudit(tx, actorId, audit);
    return value;
  });
}
