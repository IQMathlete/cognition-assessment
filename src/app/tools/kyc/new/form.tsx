"use client";

import { useActionState } from "react";
import {
  requestReviewAction,
  type FormState,
} from "@/tools/kyc/actions";

export function ReviewRequestForm({ caseId }: { caseId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    requestReviewAction,
    {},
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="caseId" value={caseId} />
      <label htmlFor="recommendation">Recommendation</label>
      <select id="recommendation" name="recommendation" required>
        <option value="verify">Verify — applicant clears KYC</option>
        <option value="reject">Reject — applicant fails KYC</option>
      </select>
      <label htmlFor="reason">Reason (required)</label>
      <textarea
        id="reason"
        name="reason"
        placeholder="Why is this verdict being recommended?"
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
