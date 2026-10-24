import { requireUser } from "@/platform/auth";
import { hasPermission } from "@/platform/rbac";
import { toolRegistry, toolsForRole } from "@/platform/registry";
import { db } from "@/platform/db";

export const dynamic = "force-dynamic";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user.role, "admin:access")) {
    return (
      <div className="panel">
        <h1>Access denied</h1>
        <p className="subtle">This page is restricted to platform_admin.</p>
      </div>
    );
  }

  const { q } = await searchParams;
  const query = q?.trim();

  const [users, auditEvents] = await Promise.all([
    db.user.findMany({ orderBy: { username: "asc" } }),
    db.auditEvent.findMany({
      where: query
        ? {
            OR: [
              { action: { contains: query } },
              { entityType: { contains: query } },
              { entityId: { contains: query } },
              { actor: { username: { contains: query } } },
            ],
          }
        : undefined,
      include: { actor: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  const accessRows = users.map((u) => ({
    user: u,
    tools: new Set(toolsForRole(u.role).map((t) => t.slug)),
  }));

  return (
    <>
      <h1>Platform admin</h1>
      <p className="subtle">Tool inventory, audit log, and access review.</p>

      <h2>Tool inventory</h2>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Owner</th>
            <th>Sensitivity</th>
            <th>Opens with</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {toolRegistry.map((tool) => (
            <tr key={tool.slug}>
              <td>
                <strong>{tool.name}</strong>
                <div className="subtle mono">{tool.path}</div>
              </td>
              <td>{tool.owner}</td>
              <td>
                <span className={`badge ${tool.sensitivity}`}>
                  {tool.sensitivity}
                </span>
              </td>
              <td className="mono">{tool.requiredPermission}</td>
              <td className="subtle">{tool.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Audit log</h2>
      <div className="panel">
        <form method="get" className="row">
          <input
            type="text"
            name="q"
            placeholder="Filter by actor, action, or entity"
            defaultValue={q ?? ""}
            style={{ flex: 1, minWidth: 260 }}
          />
          <button type="submit">Search</button>
        </form>
      </div>
      <table>
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Entity</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {auditEvents.map((e) => (
            <tr key={e.id}>
              <td className="mono">{e.createdAt.toISOString()}</td>
              <td>{e.actor.username}</td>
              <td className="mono">{e.action}</td>
              <td className="mono">
                {e.entityType}:{e.entityId.slice(0, 8)}…
              </td>
              <td>
                <details className="diff">
                  <summary>before → after</summary>
                  <pre>
                    {e.before ?? "null"}
                    {"\n→\n"}
                    {e.after ?? "null"}
                  </pre>
                </details>
              </td>
            </tr>
          ))}
          {auditEvents.length === 0 && (
            <tr>
              <td colSpan={5} className="subtle">
                No audit events match.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Access review</h2>
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            {toolRegistry.map((t) => (
              <th key={t.slug}>{t.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {accessRows.map(({ user: u, tools }) => (
            <tr key={u.id}>
              <td>
                {u.displayName}
                <div className="subtle">@{u.username}</div>
              </td>
              <td className="mono">{u.role}</td>
              {toolRegistry.map((t) => (
                <td key={t.slug}>{tools.has(t.slug) ? "✓" : "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
