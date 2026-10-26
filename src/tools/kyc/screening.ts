export interface SubmitVerdictInput {
  caseExternalId: string;
  verdict: "verify" | "reject";
  idempotencyKey: string;
}

export type SubmitVerdictResult =
  | { ok: true; screeningResultId: string }
  | { ok: false; failureReason: string };

// Boundary for the (real) screening vendor. Swap MockScreeningClient for an
// HTTP client to the vendor without touching review logic.
export interface ScreeningClient {
  submitVerdict(input: SubmitVerdictInput): Promise<SubmitVerdictResult>;
}

/**
 * Deterministic fake. Cases whose externalId ends in "FAIL" are rejected by
 * the mock vendor so the "failed" status is easy to exercise; everything
 * else succeeds.
 */
export class MockScreeningClient implements ScreeningClient {
  async submitVerdict(
    input: SubmitVerdictInput,
  ): Promise<SubmitVerdictResult> {
    if (input.caseExternalId.endsWith("FAIL")) {
      return {
        ok: false,
        failureReason: "Mock decline: screening vendor rejected the verdict.",
      };
    }
    return {
      ok: true,
      screeningResultId: `scr_${input.idempotencyKey.slice(0, 16)}`,
    };
  }
}
