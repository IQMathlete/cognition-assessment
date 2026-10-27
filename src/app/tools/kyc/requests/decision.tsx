"use client";

import { useActionState } from "react";
import { decideCaseAction, type FormState } from "@/tools/kyc/actions";

export function DecisionForm({ approvalRequestId }: { approvalRequestId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    decideCaseAction,
    {},
  );

  return (
    <form action={formAction} style={{ marginTop: 10 }}>
      <input type="hidden" name="approvalRequestId" value={approvalRequestId} />
      <div className="row">
        <input
          type="text"
          name="note"
          placeholder="Decision note (optional)"
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
