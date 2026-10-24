import { cookies } from "next/headers";
import { db } from "../db";
import type { AuthProvider } from "./provider";

const SESSION_COOKIE = "itp_user_id";

/**
 * Development-only provider: the login page lists seeded users and picking one
 * drops an httpOnly cookie with that user's id. No passwords — never ship this
 * to a real environment.
 */
export class DevAuthProvider implements AuthProvider {
  readonly id = "dev";

  async getCurrentUser() {
    const store = await cookies();
    const userId = store.get(SESSION_COOKIE)?.value;
    if (!userId) return null;
    return db.user.findUnique({ where: { id: userId } });
  }

  async signIn(username: string) {
    const user = await db.user.findUnique({ where: { username } });
    if (!user) throw new Error(`Unknown user "${username}".`);
    const store = await cookies();
    store.set(SESSION_COOKIE, user.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  }

  async signOut() {
    const store = await cookies();
    store.delete(SESSION_COOKIE);
  }
}
