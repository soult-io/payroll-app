/**
 * Security headers (spec 3 "Edge hardening"): strict CSP on the SPA (no inline
 * scripts), X-Content-Type-Options, Referrer-Policy. HSTS is set at the NPM
 * proxy (spec 8), not here.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // PrimeVue injects component styles at runtime; scripts stay non-inline.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export async function securityHeaders(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header("Content-Security-Policy", CSP);
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("X-Frame-Options", "DENY");
}
