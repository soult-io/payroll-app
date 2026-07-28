/**
 * Mount Better Auth at /api/auth/* (spec 3). Converts Fastify requests to Fetch
 * Requests for auth.handler and streams the response back, preserving Set-Cookie.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Auth } from "../auth/auth.js";
import type { AppConfig } from "../config.js";

function toFetchRequest(req: FastifyRequest, config: AppConfig): Request {
  const url = new URL(req.raw.url ?? "/", config.baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(","));
  }
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined) {
    init.body = JSON.stringify(req.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Request(url, init);
}

async function sendFetchResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
  });
  for (const cookie of response.headers.getSetCookie()) {
    reply.header("set-cookie", cookie);
  }
  const body = await response.text();
  await reply.send(body.length > 0 ? body : null);
}

export function mountBetterAuth(app: FastifyInstance, deps: { auth: Auth; config: AppConfig }): void {
  const { auth, config } = deps;
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        // Rate limit applies to credential/MFA endpoints only (spec 3:
        // login + reset + invite-accept). Session reads stay unlimited.
        allowList: (req) => {
          const url = req.raw.url ?? "";
          const sensitive =
            url.includes("/api/auth/sign-in") ||
            url.includes("/api/auth/forget-password") ||
            url.includes("/api/auth/reset-password") ||
            url.includes("/api/auth/two-factor") ||
            url.includes("/api/auth/backup-code");
          return !sensitive;
        },
      },
    },
    handler: async (req, reply) => {
      const response = await auth.handler(toFetchRequest(req, config));
      await sendFetchResponse(reply, response);
    },
  });
}
