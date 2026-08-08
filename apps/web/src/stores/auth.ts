/**
 * Session store (step 2): loads the BA session once, exposes user + role.
 */

import { defineStore } from "pinia";
import { authClient, type SessionUser } from "../lib/auth-client";

interface AuthState {
  user: SessionUser | null;
  loaded: boolean;
}

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({ user: null, loaded: false }),
  getters: {
    isAdmin: (s) => s.user?.role === "admin",
  },
  actions: {
    /** Fetch the session at most once per page load (call refresh() to force). */
    async ensureLoaded(): Promise<void> {
      if (this.loaded) return;
      await this.refresh();
    },
    async refresh(): Promise<void> {
      try {
        const { data } = await authClient.getSession();
        this.user = (data?.user as SessionUser | undefined) ?? null;
      } catch {
        this.user = null;
      } finally {
        this.loaded = true;
      }
    },
    async logout(): Promise<void> {
      await authClient.signOut();
      this.user = null;
    },
  },
});
