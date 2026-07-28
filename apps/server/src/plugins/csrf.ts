/**
 * CSRF protection (spec 3): SameSite=Lax cookies (set by BA) PLUS an explicit
 * Origin/Referer check on every mutating /api request. SPA + API are same-origin
 * behind NPM, so a matching Origin (or Referer fallback) is required.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function originOf(header: string | undefined): string | null {
  if (!header) return null;
  try {
    return new URL(header).host;
  } catch {
    return null;
  }
}

export function csrfOriginCheck(config: AppConfig) {
  const allowed = new Set<string>([originOf(config.baseUrl)].filter(Boolean) as string[]);
  return async function check(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!MUTATING.has(req.method)) return;
    if (!req.url.startsWith("/api/")) return;
    const host =
      originOf(req.headers.origin) ?? originOf(req.headers.referer as string | undefined);
    const ownHost = req.headers.host;
    if (ownHost) allowed.add(ownHost);
    if (!host || !allowed.has(host)) {
      await reply.code(403).send({ error: "csrf_origin_check_failed" });
    }
  };
}
