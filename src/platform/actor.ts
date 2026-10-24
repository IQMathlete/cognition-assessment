import { db } from "./db";

// A caller-supplied user object is just a claim: services must not trust the
// `role` field on it. resolveActor re-reads the user from the database so
// authorization decisions always use the stored role.
export type Actor = { id: string; role: string };

export async function resolveActor(
  user: { id: string } | null,
): Promise<Actor | null> {
  if (!user) return null;
  const row = await db.user.findUnique({ where: { id: user.id } });
  return row ? { id: row.id, role: row.role } : null;
}
