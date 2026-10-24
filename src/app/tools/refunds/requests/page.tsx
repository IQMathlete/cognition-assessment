import { requireUser } from "@/platform/auth";
import { hasPermission } from "@/platform/rbac";
import { listApprovals, listPendingApprovalsFor } from "@/platform/approvals";
import { db } from "@/platform/db";
import "@/tools/refunds"; // registers approval hooks
import { DecisionForm } from "./decision";

export const dynamic = "force-dynamic";

function dollars(cents: number) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

export default async function RefundRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user.role, "refunds:read")) {
    return (
      <div className="panel">
        <h1>Access denied</h1>
      </div>
    );
  }

  const [queue, all] = await Promise.all([
    listPendingApprovalsFor(user.role),
    listApprovals(),
  ]);

  // Attach refund + transaction context to each request row.
  const refunds = await db.refund.findMany({
    where: { approvalRequestId: { in: all.map((a) => a.id) } },
    include: { transaction: true },
  });
  const refundByApprovalId = new Map(
    refunds.map((r) => [r.approvalRequestId, r]),
  );

  const canDecide = hasPermission(user.role, "refunds:approve");

  return (
    <>
      <h1>Approval queue</h1>
      <p className="subtle">
        Pending requests routed to <strong>{user.role}</strong>.
      </p>

      <h2>Waiting on you</h2>
      {queue.length === 0 ? (
        <p className="subtle">Nothing pending for your role.</p>
      ) : (
        queue.map((req) => {
          const refund = refundByApprovalId.get(req.id);
          return (
            <div className="panel" key={req.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div>
                    <strong>{req.entityType}</strong>{" "}
                    <span className="mono">{req.entityId.slice(0, 8)}…</span>
                    {refund && (
                      <>
                        {" — "}
                        {dollars(refund.amountCents)} on{" "}
                        <span className="mono">
                          {refund.transaction.externalId}
                        </span>{" "}
                        ({refund.transaction.merchant})
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
                    : "Your role cannot decide refund requests."}
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
          {all.map((req) => (
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
          {all.length === 0 && (
            <tr>
              <td colSpan={5} className="subtle">
                No approval requests yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
