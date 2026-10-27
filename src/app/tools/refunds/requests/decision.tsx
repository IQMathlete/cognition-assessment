"use client";

import { useActionState } from "react";
import { decideRefundAction, type FormState } from "@/tools/refunds/actions";

export function DecisionForm({ approvalRequestId }: { approvalRequestId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    decideRefundAction,
    {},
  );

  return (
    <form action={formAction} style={{ marginTop: 10 }}>
      <input type="hidden" name="approvalRequestId" value={approvalRequestId} />
      <div className="row">
        <input
          type="text"
          name="note"
          placeholder="Justification (required, at least 10 characters)"
          required
          minLength={10}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button type="submit" name="decision" value="approve" disabled={pending}>
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="reject"
          className="danger"
          disabled={pending}
        >
          Reject
        </button>
      </div>
      {state.error && <div className="error-text">{state.error}</div>}
    </form>
  );
}
