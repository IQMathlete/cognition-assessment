"use client";

import { useActionState } from "react";
import { revealPiiAction, type FormState } from "@/tools/kyc/actions";

export function RevealForm({ caseId }: { caseId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    revealPiiAction,
    {},
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="caseId" value={caseId} />
      <div className="row">
        <input
          type="text"
          name="reason"
          placeholder="Reveal reason (audited)"
          required
          style={{ flex: 1, minWidth: 160 }}
        />
        <button type="submit" className="secondary" disabled={pending}>
          Reveal PII
        </button>
      </div>
      {state.revealed && (
        <div className="mono" style={{ fontSize: 12, marginTop: 6 }}>
          SSN {state.revealed.ssn} · DOB {state.revealed.dob}
        </div>
      )}
      {state.error && <div className="error-text">{state.error}</div>}
    </form>
  );
}
