import { db } from "@/platform/db";
import { getCurrentUser } from "@/platform/auth";
import { redirect } from "next/navigation";
import { signInAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");

  const users = await db.user.findMany({ orderBy: { username: "asc" } });

  return (
    <div style={{ maxWidth: 760, margin: "60px auto" }}>
      <h1>Internal Tools</h1>
      <p className="subtle">
        Dev sign-in — pick a seeded user. No passwords in this environment.
      </p>
      <div className="login-grid">
        {users.map((u) => (
          <form key={u.id} action={signInAction}>
            <input type="hidden" name="username" value={u.username} />
            <button type="submit" className="login-card">
              <div className="uname">{u.displayName}</div>
              <div className="urole">
                @{u.username} · {u.role}
              </div>
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
