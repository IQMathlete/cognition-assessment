import { requireUser } from "@/platform/auth";
import { hasPermission } from "@/platform/rbac";
import { db } from "@/platform/db";
import { requiredRoleForRefund } from "@/tools/refunds";
import { RefundRequestForm } from "./form";

export const dynamic = "force-dynamic";

export default async function NewRefundPage({
  searchParams,
}: {
  searchParams: Promise<{ txn?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user.role, "refunds:create")) {
    return (
      <div className="panel">
        <h1>Access denied</h1>
        <p className="subtle">Your role cannot request refunds.</p>
      </div>
    );
  }

  const { txn } = await searchParams;
  const transaction = txn
    ? await db.transaction.findUnique({ where: { id: txn } })
    : null;
  if (!transaction) {
    return (
      <div className="panel">
        <h1>Transaction not found</h1>
      </div>
    );
  }

  const amountDollars = (transaction.amountCents / 100).toFixed(2);

  return (
    <>
      <h1>Request refund</h1>
      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>Transaction</th>
              <td className="mono">{transaction.externalId}</td>
            </tr>
            <tr>
              <th>Merchant</th>
              <td>{transaction.merchant}</td>
            </tr>
            <tr>
              <th>Cardholder</th>
              <td>{transaction.cardholder}</td>
            </tr>
            <tr>
              <th>Amount</th>
              <td>${amountDollars}</td>
            </tr>
            <tr>
              <th>Approval route</th>
              <td>
                {requiredRoleForRefund(transaction.amountCents)} (refunds ≤ $250
                route to support_lead, larger to finance_approver)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="panel" style={{ maxWidth: 480 }}>
        <RefundRequestForm
          transactionId={transaction.id}
          defaultAmount={amountDollars}
        />
      </div>
    </>
  );
}
