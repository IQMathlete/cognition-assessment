import type { User } from "@prisma/client";

/**
 * Pluggable authentication. The rest of the platform only depends on this
 * interface — see src/platform/auth/index.ts for where the concrete provider
 * is selected.
 */
export interface AuthProvider {
  readonly id: string;
  /** Returns the signed-in user, or null when there is no session. */
  getCurrentUser(): Promise<User | null>;
  /** Establishes a session for the given username. */
  signIn(username: string): Promise<void>;
  signOut(): Promise<void>;
}
