import Link from "next/link";
import { requireUser } from "@/platform/auth";
import { hasPermission } from "@/platform/rbac";
import { searchCases } from "@/tools/kyc";
import { DispositionForm } from "./disposition";
import { RevealForm } from "./reveal";

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
        <p className="subtle">Your role cannot open the KYC queue.</p>
      </div>
    );
  }

  const { q } = await searchParams;
  const cases = await searchCases(user, q);
  const canDisposition = hasPermission(user.role, "kyc:review");
  const canReveal = hasPermission(user.role, "kyc:reveal");
  const seesAll = hasPermission(user.role, "kyc:approve");

  return (
    <>
      <h1>KYC Review</h1>
      <p className="subtle">
        {seesAll
          ? "All applicant cases."
          : "Cases assigned to you."}{" "}
        <Link href="/tools/kyc/requests">Go to senior queue →</Link>
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
            <th>SSN</th>
            <th>DOB</th>
            <th>Country</th>
            <th>Risk</th>
            <th>Documents</th>
            <th>Status</th>
            {seesAll && <th>Assignee</th>}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.externalId}</td>
              <td>{c.applicant}</td>
              <td className="mono">{c.ssn}</td>
              <td className="mono">{c.dob}</td>
              <td>{c.country}</td>
              <td>
                {c.riskScore}
                {c.riskScore >= 80 && (
                  <span
                    className="badge pending_second_review"
                    style={{ marginLeft: 6 }}
                  >
                    2nd review
                  </span>
                )}
              </td>
              <td className="subtle">{c.documents}</td>
              <td>
                <span className={`badge ${c.status}`}>{c.status}</span>
              </td>
              {seesAll && <td>{c.assignee.username}</td>}
              <td>
                {canDisposition && c.status === "pending" ? (
                  <DispositionForm caseId={c.id} />
                ) : null}
                {canReveal ? <RevealForm caseId={c.id} /> : null}
              </td>
            </tr>
          ))}
          {cases.length === 0 && (
            <tr>
              <td colSpan={seesAll ? 10 : 9} className="subtle">
                No cases match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
