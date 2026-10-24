import Link from "next/link";
import { requireUser } from "@/platform/auth";
import { toolsForRole } from "@/platform/registry";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireUser();
  const tools = toolsForRole(user.role);

  return (
    <>
      <h1>Welcome, {user.displayName}</h1>
      <p className="subtle">
        Signed in as <strong>{user.username}</strong> ({user.role})
      </p>
      <h2>Your tools</h2>
      {tools.length === 0 ? (
        <p className="subtle">
          Your role does not have access to any tools yet.
        </p>
      ) : (
        <div className="cards">
          {tools.map((tool) => (
            <Link key={tool.slug} href={tool.path} className="card">
              <div className="name">{tool.name}</div>
              <div className="desc">{tool.description}</div>
              <div className="desc" style={{ marginTop: 8 }}>
                <span className={`badge ${tool.sensitivity}`}>
                  {tool.sensitivity}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
