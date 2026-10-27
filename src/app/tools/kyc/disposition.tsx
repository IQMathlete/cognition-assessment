"use client";

import { useActionState } from "react";
import { dispositionAction, type FormState } from "@/tools/kyc/actions";

export function DispositionForm({ caseId }: { caseId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    dispositionAction,
    {},
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="caseId" value={caseId} />
      <div className="row">
        <input
          type="text"
          name="reason"
          placeholder="Reason (required)"
          required
          style={{ flex: 1, minWidth: 180 }}
        />
        <button type="submit" name="action" value="approve" disabled={pending}>
          Approve
        </button>
        <button
          type="submit"
          name="action"
          value="reject"
          className="danger"
          disabled={pending}
        >
          Reject
        </button>
        <button
          type="submit"
          name="action"
          value="escalate"
          className="secondary"
          disabled={pending}
        >
          Escalate
        </button>
      </div>
      {state.error && <div className="error-text">{state.error}</div>}
    </form>
  );
}
