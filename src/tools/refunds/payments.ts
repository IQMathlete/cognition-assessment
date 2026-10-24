export interface RefundPaymentInput {
  transactionExternalId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}

export type RefundPaymentResult =
  | { ok: true; paymentRefundId: string }
  | { ok: false; failureReason: string };

// Boundary for the (real) payments processor. Swap MockPaymentsClient for an
// HTTP client to the payments gateway without touching refund logic.
export interface PaymentsClient {
  refund(input: RefundPaymentInput): Promise<RefundPaymentResult>;
}

/**
 * Deterministic fake. Transactions whose externalId ends in "FAIL" are
 * declined by the mock issuer so the "failed" status is easy to exercise;
 * everything else succeeds.
 */
export class MockPaymentsClient implements PaymentsClient {
  async refund(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    if (input.transactionExternalId.endsWith("FAIL")) {
      return {
        ok: false,
        failureReason: "Mock decline: issuing bank rejected the refund.",
      };
    }
    return {
      ok: true,
      paymentRefundId: `payref_${input.idempotencyKey.slice(0, 16)}`,
    };
  }
}
