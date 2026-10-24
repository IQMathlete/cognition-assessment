"use client";

import { useActionState } from "react";
import {
  requestRefundAction,
  type FormState,
} from "@/tools/refunds/actions";

export function RefundRequestForm({
  transactionId,
  defaultAmount,
}: {
  transactionId: string;
  defaultAmount: string;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    requestRefundAction,
    {},
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="transactionId" value={transactionId} />
      <label htmlFor="amount">Amount (USD)</label>
      <input
        id="amount"
        name="amount"
        type="number"
        step="0.01"
        min="0.01"
        defaultValue={defaultAmount}
        required
      />
      <label htmlFor="reason">Reason (required)</label>
      <textarea
        id="reason"
        name="reason"
        placeholder="Why is this refund being issued?"
        required
      />
      <div style={{ marginTop: 12 }}>
        <button type="submit" disabled={pending}>
          {pending ? "Submitting…" : "Submit for approval"}
        </button>
      </div>
      {state.error && <div className="error-text">{state.error}</div>}
    </form>
  );
}
