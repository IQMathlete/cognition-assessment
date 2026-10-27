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

  // The senior queue requires kyc:approve; readers without it still see
  // the full request history below.
  const canDecide = hasPermission(user.role, "kyc:approve");
  const [queue, all] = await Promise.all([
    canDecide
      ? listPendingApprovalsFor(user, "kyc:approve", "kyc_case")
      : Promise.resolve([]),
    listApprovals(),
  ]);
  // A reviewer only sees requests they routed; the senior sees all of them.
  // listApprovals returns every request — scoping here keeps the assigned-
  // case boundary from leaking other reviewers' cases through the history.
  const kycRequests = all.filter(
    (r) => r.entityType === "kyc_case" && (canDecide || r.requesterId === user.id),
  );

  // Attach case context to each request row — no PII is selected here; the
  // queue only needs the routing context (case id, applicant, risk).
  const cases = await db.kycCase.findMany({
    where: { approvalRequestId: { in: kycRequests.map((a) => a.id) } },
    select: {
      approvalRequestId: true,
      externalId: true,
      applicant: true,
      riskScore: true,
      status: true,
    },
  });
  const caseByApprovalId = new Map(
    cases.map((c) => [c.approvalRequestId, c]),
  );

  return (
    <>
      <h1>Senior queue</h1>
      <p className="subtle">
        Escalated cases and second reviews waiting on{" "}
        <strong>{user.role}</strong>.
      </p>

      <h2>Waiting on you</h2>
      {queue.length === 0 ? (
        <p className="subtle">Nothing pending for your role.</p>
      ) : (
        queue.map((req) => {
          const kycCase = caseByApprovalId.get(req.id);
          return (
            <div className="panel" key={req.id}>
              <div>
                <strong>{req.entityType}</strong>{" "}
                <span className="mono">{req.entityId.slice(0, 8)}…</span>
                {kycCase && (
                  <>
                    {" — "}
                    <span className="mono">{kycCase.externalId}</span> (
                    {kycCase.applicant}, risk {kycCase.riskScore}) —{" "}
                    <span className={`badge ${kycCase.status}`}>
                      {kycCase.status}
                    </span>
                  </>
                )}
              </div>
              <div className="subtle" style={{ marginTop: 4 }}>
                Routed by {req.requester.username} · Reason: {req.reason}
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
            <th>Routed by</th>
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
                No requests yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
