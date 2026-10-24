import { redirect } from "next/navigation";
import type { AuthProvider } from "./provider";
import { DevAuthProvider } from "./dev-provider";

// --- OIDC plug-in point -----------------------------------------------------
// Production deployments replace DevAuthProvider with an OIDC provider
// (Okta, Microsoft Entra ID, ...). Implement the AuthProvider interface
// (authorization-code flow, verify the ID token, map the `sub` /
// `preferred_username` claim onto a User row) and swap the instance below —
// no other platform code needs to change.
// ---------------------------------------------------------------------------
export const authProvider: AuthProvider = new DevAuthProvider();

export function getCurrentUser() {
  return authProvider.getCurrentUser();
}

/** Returns the signed-in user or redirects to /login. Use in pages/actions. */
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
