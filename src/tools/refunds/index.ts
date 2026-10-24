import { registerApprovalHooks } from "@/platform/approvals";
import { onRefundApproved, onRefundRejected } from "./service";

// Side-effect import: registering here wires the refunds tool into the shared
// approvals primitive — when a "refund" ApprovalRequest is decided, these
// callbacks run.
registerApprovalHooks("refund", {
  onApproved: onRefundApproved,
  onRejected: onRefundRejected,
});

export * from "./service";
export { MockPaymentsClient } from "./payments";
export type { PaymentsClient } from "./payments";
