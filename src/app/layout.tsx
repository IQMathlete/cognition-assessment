import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getCurrentUser } from "@/platform/auth";
import { toolsForRole } from "@/platform/registry";
import { hasPermission } from "@/platform/rbac";
import { signOutAction } from "./actions";

export const metadata: Metadata = {
  title: "Internal Tools",
  description: "Internal tools platform",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  const tools = user ? toolsForRole(user.role) : [];
  const isAdmin = user ? hasPermission(user.role, "admin:access") : false;

  return (
    <html lang="en">
      <body>
        <div className="shell">
          {user ? (
            <aside className="sidebar">
              <div className="brand">Internal Tools</div>
              <nav>
                <Link href="/">Overview</Link>
                {tools.length > 0 && <div className="nav-label">Tools</div>}
                {tools.map((tool) => (
                  <Link key={tool.slug} href={tool.path}>
                    {tool.name}
                  </Link>
                ))}
                {isAdmin && (
                  <>
                    <div className="nav-label">Platform</div>
                    <Link href="/admin">Admin</Link>
                  </>
                )}
              </nav>
              <div className="who">
                <div>{user.displayName}</div>
                <div className="role">{user.role}</div>
                <form action={signOutAction}>
                  <button className="link" type="submit">
                    Sign out
                  </button>
                </form>
              </div>
            </aside>
          ) : null}
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
