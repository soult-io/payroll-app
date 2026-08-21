/**
 * Better Auth client (step 2). Same-origin /api/auth (Vite proxy in dev,
 * Fastify static serving in prod), so cookies + CSRF Origin checks just work.
 */

import { createAuthClient } from "better-auth/vue";
import { twoFactorClient, adminClient } from "better-auth/client/plugins";
import { notifySessionExpired } from "./session-expired";

export const authClient = createAuthClient({
  plugins: [twoFactorClient(), adminClient()],
  fetchOptions: {
    // PAY-6: an unexpected 401 from /api/auth (e.g. list-sessions after the
    // session expired) gets the same redirect treatment as the typed client.
    // Pre-auth 401s (wrong password/TOTP) are no-ops — the handler registered
    // in main.ts only acts when a session is actually loaded.
    onError: (ctx) => {
      if (ctx.response.status === 401) notifySessionExpired();
    },
  },
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role?: string | undefined;
  twoFactorEnabled?: boolean | undefined;
  banned?: boolean | null | undefined;
};
