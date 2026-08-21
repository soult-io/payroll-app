/**
 * Session store (step 2): loads the BA session once, exposes user + role.
 *
 * PAY-8: also caches the linked employee record's employment type ("w2" /
 * "1099", null when no record exists) — the nav and route guards scope
 * worker-type-bound features (Payslips vs Invoices) from it.
 */

import { defineStore } from "pinia";
import { authClient, type SessionUser } from "../lib/auth-client";
import { myApi } from "../lib/api";

interface AuthState {
  user: SessionUser | null;
  loaded: boolean;
  employmentType: string | null;
  employeeLoaded: boolean;
}

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({
    user: null,
    loaded: false,
    employmentType: null,
    employeeLoaded: false,
  }),
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
    /**
     * Fetch the linked employee record's employment type at most once per
     * user (force=true re-probes, e.g. after a user switch). No linked
     * record → null (pure admin accounts, or not-yet-linked employees).
     */
    async ensureEmployee(force = false): Promise<void> {
      if (this.employeeLoaded && !force) return;
      if (!this.user) {
        this.employmentType = null;
        this.employeeLoaded = true;
        return;
      }
      try {
        const { profile } = await myApi.profile();
        this.employmentType = profile.employmentType;
      } catch {
        this.employmentType = null;
      } finally {
        this.employeeLoaded = true;
      }
    },
    async logout(): Promise<void> {
      await authClient.signOut();
      this.user = null;
      this.employmentType = null;
      this.employeeLoaded = false;
    },
  },
});
