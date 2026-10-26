import { requireUser } from "@/platform/auth";
import { hasPermission } from "@/platform/rbac";
import { db } from "@/platform/db";
import { requiredRoleForReview } from "@/tools/kyc";
import { ReviewRequestForm } from "./form";

export const dynamic = "force-dynamic";

export default async function NewReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ case?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user.role, "kyc:create")) {
    return (
      <div className="panel">
        <h1>Access denied</h1>
        <p className="subtle">Your role cannot request KYC reviews.</p>
      </div>
    );
  }

  const { case: caseId } = await searchParams;
  const kycCase = caseId
    ? await db.kycCase.findUnique({ where: { id: caseId } })
    : null;
  if (!kycCase) {
    return (
      <div className="panel">
        <h1>Case not found</h1>
      </div>
    );
  }

  return (
    <>
      <h1>Request review</h1>
      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>Case</th>
              <td className="mono">{kycCase.externalId}</td>
            </tr>
            <tr>
              <th>Applicant</th>
              <td>{kycCase.applicant}</td>
            </tr>
            <tr>
              <th>Country</th>
              <td>{kycCase.country}</td>
            </tr>
            <tr>
              <th>Risk score</th>
              <td>{kycRiskLabel(kycCase.riskScore)}</td>
            </tr>
            <tr>
              <th>Approval route</th>
              <td>
                {requiredRoleForReview(kycCase.riskScore)} (risk &lt; 70 routes to
                kyc_senior, high-risk to finance_approver)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="panel" style={{ maxWidth: 480 }}>
        <ReviewRequestForm caseId={kycCase.id} />
      </div>
    </>
  );
}

function kycRiskLabel(riskScore: number) {
  return `${riskScore}/100${riskScore >= 70 ? " (high risk)" : ""}`;
}
