import Link from "next/link";
import { requireUser } from "@/platform/auth";
import { hasPermission } from "@/platform/rbac";
import { listReviews, searchCases } from "@/tools/kyc";

export const dynamic = "force-dynamic";

export default async function KycPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user.role, "kyc:read")) {
    return (
      <div className="panel">
        <h1>Access denied</h1>
        <p className="subtle">Your role cannot open the KYC Review tool.</p>
      </div>
    );
  }

  const { q } = await searchParams;
  const [cases, reviews] = await Promise.all([
    searchCases(user, q),
    listReviews(user),
  ]);
  const canRequest = hasPermission(user.role, "kyc:create");

  return (
    <>
      <h1>KYC Review</h1>
      <p className="subtle">
        Pending applicant cases.{" "}
        <Link href="/tools/kyc/requests">Go to approval queue →</Link>
      </p>

      <div className="panel">
        <form method="get" className="row">
          <input
            type="text"
            name="q"
            placeholder="Search by case ID, applicant, or country"
            defaultValue={q ?? ""}
            style={{ flex: 1, minWidth: 260 }}
          />
          <button type="submit">Search</button>
        </form>
      </div>

      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>Applicant</th>
            <th>Country</th>
            <th>Risk score</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.externalId}</td>
              <td>{c.applicant}</td>
              <td>{c.country}</td>
              <td>{c.riskScore}</td>
              <td>
                <span className={`badge ${c.status}`}>{c.status}</span>
              </td>
              <td>
                {canRequest && c.status === "pending" ? (
                  <Link
                    className="btn secondary"
                    href={`/tools/kyc/new?case=${c.id}`}
                  >
                    Request review
                  </Link>
                ) : null}
              </td>
            </tr>
          ))}
          {cases.length === 0 && (
            <tr>
              <td colSpan={6} className="subtle">
                No cases match.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Review requests</h2>
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>Recommendation</th>
            <th>Requested by</th>
            <th>Reason</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.case.externalId}</td>
              <td>{r.recommendation}</td>
              <td>{r.requestedBy.username}</td>
              <td>{r.reason}</td>
              <td>
                <span className={`badge ${r.status}`}>{r.status}</span>
                {r.failureReason ? (
                  <div className="subtle" style={{ fontSize: 12 }}>
                    {r.failureReason}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          {reviews.length === 0 && (
            <tr>
              <td colSpan={5} className="subtle">
                No review requests yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
