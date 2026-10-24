import Link from "next/link";
import { requireUser } from "@/platform/auth";
import { hasPermission } from "@/platform/rbac";
import { searchTransactions, listRefunds } from "@/tools/refunds";

export const dynamic = "force-dynamic";

function dollars(cents: number) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

export default async function RefundsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user.role, "refunds:read")) {
    return (
      <div className="panel">
        <h1>Access denied</h1>
        <p className="subtle">Your role cannot open the Refunds tool.</p>
      </div>
    );
  }

  const { q } = await searchParams;
  const [transactions, refunds] = await Promise.all([
    searchTransactions(user, q),
    listRefunds(user),
  ]);

  return (
    <>
      <h1>Refunds</h1>
      <p className="subtle">
        Search transactions and request refunds.{" "}
        <Link href="/tools/refunds/requests">Go to approval queue →</Link>
      </p>

      <div className="panel">
        <form method="get" className="row">
          <input
            type="text"
            name="q"
            placeholder="Search by transaction ID, merchant, or cardholder"
            defaultValue={q ?? ""}
            style={{ flex: 1, minWidth: 260 }}
          />
          <button type="submit">Search</button>
        </form>
      </div>

      <table>
        <thead>
          <tr>
            <th>Transaction</th>
            <th>Merchant</th>
            <th>Cardholder</th>
            <th>Amount</th>
            <th>Date</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => (
            <tr key={t.id}>
              <td className="mono">{t.externalId}</td>
              <td>{t.merchant}</td>
              <td>{t.cardholder}</td>
              <td>{dollars(t.amountCents)}</td>
              <td>{t.createdAt.toISOString().slice(0, 10)}</td>
              <td>
                <Link
                  className="btn secondary"
                  href={`/tools/refunds/new?txn=${t.id}`}
                >
                  Request refund
                </Link>
              </td>
            </tr>
          ))}
          {transactions.length === 0 && (
            <tr>
              <td colSpan={6} className="subtle">
                No transactions match.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Refund requests</h2>
      <table>
        <thead>
          <tr>
            <th>Transaction</th>
            <th>Amount</th>
            <th>Requested by</th>
            <th>Reason</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {refunds.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.transaction.externalId}</td>
              <td>{dollars(r.amountCents)}</td>
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
          {refunds.length === 0 && (
            <tr>
              <td colSpan={5} className="subtle">
                No refund requests yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
