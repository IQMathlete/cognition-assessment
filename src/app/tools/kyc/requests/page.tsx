import { requireUser } from "@/platform/auth";
import { hasPermission } from "@/platform/rbac";
import { listApprovals, listPendingApprovalsFor } from "@/platform/approvals";
import { db } from "@/platform/db";
import "@/tools/kyc"; // registers approval hooks
import { DecisionForm } from "./decision";

export const dynamic = "force-dynamic";

export default async function KycRequestsPage() {
  const user = await requireUser();
  if (!hasPermission(user.role, "kyc:read")) {
    return (
      <div className="panel">
        <h1>Access denied</h1>
      </div>
    );
  }

  // The pending queue requires kyc:approve; readers without it still see
  // the full request history below.
  const canDecide = hasPermission(user.role, "kyc:approve");
  const [queue, all] = await Promise.all([
    canDecide
      ? listPendingApprovalsFor(user, "kyc:approve", "kyc_review")
      : Promise.resolve([]),
    listApprovals(),
  ]);
  const kycRequests = all.filter((r) => r.entityType === "kyc_review");

  // Attach review + case context to each request row.
  const reviews = await db.kycReview.findMany({
    where: { approvalRequestId: { in: kycRequests.map((a) => a.id) } },
    include: { case: true },
  });
  const reviewByApprovalId = new Map(
    reviews.map((r) => [r.approvalRequestId, r]),
  );

  return (
    <>
      <h1>Approval queue</h1>
      <p className="subtle">
        Pending KYC requests routed to <strong>{user.role}</strong>.
      </p>

      <h2>Waiting on you</h2>
      {queue.length === 0 ? (
        <p className="subtle">Nothing pending for your role.</p>
      ) : (
        queue.map((req) => {
          const review = reviewByApprovalId.get(req.id);
          return (
            <div className="panel" key={req.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div>
                    <strong>{req.entityType}</strong>{" "}
                    <span className="mono">{req.entityId.slice(0, 8)}…</span>
                    {review && (
                      <>
                        {" — "}
                        {review.recommendation} on{" "}
                        <span className="mono">
                          {review.case.externalId}
                        </span>{" "}
                        ({review.case.applicant}, risk {review.case.riskScore})
                      </>
                    )}
                  </div>
                  <div className="subtle" style={{ marginTop: 4 }}>
                    Requested by {req.requester.username} · Reason: {req.reason}
                  </div>
                </div>
              </div>
              {canDecide && req.requesterId !== user.id ? (
                <DecisionForm approvalRequestId={req.id} />
              ) : (
                <div className="subtle" style={{ marginTop: 8, fontSize: 13 }}>
                  {req.requesterId === user.id
                    ? "You cannot decide your own request."
                    : "Your role cannot decide KYC requests."}
                </div>
              )}
            </div>
          );
        })
      )}

      <h2>All requests</h2>
      <table>
        <thead>
          <tr>
            <th>Entity</th>
            <th>Requester</th>
            <th>Required role</th>
            <th>Status</th>
            <th>Decided by</th>
          </tr>
        </thead>
        <tbody>
          {kycRequests.map((req) => (
            <tr key={req.id}>
              <td>
                {req.entityType}{" "}
                <span className="mono">{req.entityId.slice(0, 8)}…</span>
              </td>
              <td>{req.requester.username}</td>
              <td>{req.requiredRole}</td>
              <td>
                <span className={`badge ${req.status}`}>{req.status}</span>
              </td>
              <td>
                {req.decidedBy?.username ?? "—"}
                {req.decisionNote ? (
                  <div className="subtle" style={{ fontSize: 12 }}>
                    {req.decisionNote}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          {kycRequests.length === 0 && (
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
