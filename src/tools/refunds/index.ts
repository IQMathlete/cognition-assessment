// Barrel file. Approval hooks are registered by ./service itself at module
// load, so importing either path wires the refunds tool into the approvals
// primitive.
export * from "./service";
export { MockPaymentsClient } from "./payments";
export type { PaymentsClient } from "./payments";
