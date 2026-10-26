import { db } from "./db";
import { ForbiddenError } from "./errors";

// A caller-supplied user object is just a claim: services must not trust the
// `role` field on it. resolveActor re-reads the user from the database so
// authorization decisions always use the stored role — and a claim that
// contradicts the stored role is rejected outright instead of silently
// resolved, so identity confusion fails loudly.
export type Actor = { id: string; role: string };

export async function resolveActor(
  user: { id: string; role?: string } | null,
): Promise<Actor | null> {
  if (!user) return null;
  const row = await db.user.findUnique({ where: { id: user.id } });
  if (!row) return null;
  if (user.role !== undefined && user.role !== row.role) {
    throw new ForbiddenError(
      "Claimed role does not match the stored role.",
    );
  }
  return { id: row.id, role: row.role };
}
