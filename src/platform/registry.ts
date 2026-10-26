import type { Permission } from "./rbac";
import { hasPermission } from "./rbac";

// Inventory of internal tools on the platform — the /admin tool inventory and
// the sidebar both read from this list.
export interface ToolRegistration {
  slug: string;
  name: string;
  path: string;
  owner: string;
  sensitivity: "low" | "medium" | "high";
  requiredPermission: Permission;
  description: string;
}

export const toolRegistry: ToolRegistration[] = [
  {
    slug: "refunds",
    name: "Refunds",
    path: "/tools/refunds",
    owner: "Payments Engineering",
    sensitivity: "high",
    requiredPermission: "refunds:read",
    description:
      "Search card transactions and request cardholder refunds, subject to approval.",
  },
  {
    slug: "kyc",
    name: "KYC Review",
    path: "/tools/kyc",
    owner: "Compliance Operations",
    sensitivity: "high",
    requiredPermission: "kyc:read",
    description:
      "Submit applicant cases for KYC verdicts, subject to senior or financial-crimes approval.",
  },
];

export function toolsForRole(role: string): ToolRegistration[] {
  return toolRegistry.filter((tool) =>
    hasPermission(role, tool.requiredPermission),
  );
}
