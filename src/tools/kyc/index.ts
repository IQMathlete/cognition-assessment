// Barrel file. Approval hooks are registered by ./service itself at module
// load, so importing either path wires the KYC tool into the approvals
// primitive.
export * from "./service";
export { MockScreeningClient } from "./screening";
export type { ScreeningClient } from "./screening";
