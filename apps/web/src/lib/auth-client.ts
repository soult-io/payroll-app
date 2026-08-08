/**
 * Better Auth client (step 2). Same-origin /api/auth (Vite proxy in dev,
 * Fastify static serving in prod), so cookies + CSRF Origin checks just work.
 */

import { createAuthClient } from "better-auth/vue";
import { twoFactorClient, adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [twoFactorClient(), adminClient()],
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role?: string | undefined;
  twoFactorEnabled?: boolean | undefined;
  banned?: boolean | null | undefined;
};
