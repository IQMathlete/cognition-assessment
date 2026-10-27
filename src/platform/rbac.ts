import { ForbiddenError } from "./errors";

// Roles and permissions are defined in code — there is no role admin UI.
// To change who can do what, edit ROLE_PERMISSIONS below.
export const ROLES = [
  "support_agent",
  "support_lead",
  "finance_approver",
  "engineer",
  "kyc_reviewer",
  "kyc_senior",
  "platform_admin",
] as const;

export type Role = (typeof ROLES)[number];

export type Permission =
  | "refunds:read"
  | "refunds:create"
  | "refunds:approve"
  | "kyc:read"
  | "kyc:review"
  | "kyc:approve"
  | "kyc:reveal"
  | "admin:access";

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  support_agent: ["refunds:read", "refunds:create"],
  support_lead: ["refunds:read", "refunds:create", "refunds:approve"],
  finance_approver: ["refunds:read", "refunds:approve"],
  engineer: ["refunds:read"],
  kyc_reviewer: ["kyc:read", "kyc:review"],
  kyc_senior: ["kyc:read", "kyc:review", "kyc:approve", "kyc:reveal"],
  platform_admin: ["admin:access", "refunds:read", "kyc:read"],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: string, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsForRole(role: string): readonly Permission[] {
  return isRole(role) ? ROLE_PERMISSIONS[role] : [];
}

// Single choke point for authorization in server code. Call this in every
// server action / service function before mutating or reading restricted data.
export function requirePermission(
  user: { id: string; role: string } | null,
  permission: Permission,
): asserts user is { id: string; role: string } {
  if (!user) {
    throw new ForbiddenError("You must be signed in.");
  }
  if (!hasPermission(user.role, permission)) {
    throw new ForbiddenError(
      `Role "${user.role}" lacks permission "${permission}".`,
    );
  }
}
