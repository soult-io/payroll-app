/**
 * QA-only mailbox read endpoint (spec 14 §3): proxies Mailpit's HTTP API so
 * the nightly e2e suite (running on GitHub-hosted runners that cannot reach
 * the Mailpit UI on the internal network) can assert captured email content.
 *
 * Registered ONLY when APP_ENV=qa — in any other environment this module adds
 * no routes at all, so the path 404s like any unknown URL (verified by test).
 *
 * Auth: the same scoped bearer credential as the export API
 * ($SECRETS_DIR/export-token) — read-only, unattended-agent friendly, no
 * interactive TOTP. No token configured → 503 (explicit deployment decision).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";

interface MailpitSummary {
  ID: string;
  Subject: string;
  From: { Address: string };
  To: { Address: string }[];
  Created: string;
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  From: { Address: string; Name?: string };
  To: { Address: string; Name?: string }[];
  Date: string;
  Text?: string;
  HTML?: string;
}

/** Constant-time comparison (hashed first so length never leaks) — same discipline as routes/export.ts. */
function tokenOk(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function authorize(
  req: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): Promise<boolean> {
  if (!config.exportToken) {
    await reply.code(503).send({
      error: "qa_mailbox_disabled",
      message: "no export-token in SECRETS_DIR — the QA mailbox endpoint is disabled",
    });
    return false;
  }
  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!provided || !tokenOk(provided, config.exportToken)) {
    await reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

async function mailpitJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mailpit ${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Latest message to `to` (Mailpit lists newest first), or null. */
async function latestTo(mailpitUrl: string, to: string): Promise<MailpitMessage | null> {
  const list = await mailpitJson<{ messages: MailpitSummary[] }>(
    `${mailpitUrl}/api/v1/messages?limit=100`,
  );
  const wanted = to.trim().toLowerCase();
  const match = list.messages.find((m) =>
    (m.To ?? []).some((t) => t.Address.toLowerCase() === wanted),
  );
  if (!match) return null;
  return mailpitJson<MailpitMessage>(`${mailpitUrl}/api/v1/message/${match.ID}`);
}

export function registerQaRoutes(app: FastifyInstance, deps: { config: AppConfig }): void {
  const { config } = deps;
  // Hard gate: outside QA this route must not exist (404, not 403/401).
  if (config.appEnv !== "qa") return;

  app.get("/api/qa/mailbox", async (req, reply) => {
    if (!(await authorize(req, reply, config))) return;

    const q = req.query as { to?: string; latest?: string };
    if (!q.to?.includes("@")) {
      return reply.code(400).send({ error: "invalid_query", message: "to=<address> is required" });
    }
    if (q.latest !== undefined && q.latest !== "true") {
      return reply
        .code(400)
        .send({ error: "invalid_query", message: "only latest=true is supported" });
    }

    let message: MailpitMessage | null;
    try {
      message = await latestTo(config.mailpitUrl, q.to);
    } catch (err) {
      req.log.warn({ err }, "mailpit proxy failed");
      return reply.code(502).send({ error: "mailpit_unreachable" });
    }
    if (!message) {
      return reply.code(404).send({ error: "not_found", message: `no mail for ${q.to}` });
    }
    return {
      id: message.ID,
      subject: message.Subject,
      from: message.From,
      to: message.To,
      date: message.Date,
      text: message.Text ?? "",
      html: message.HTML ?? "",
    };
  });
}
