/**
 * QA-only mailbox endpoint (spec 14 §3): registered only under APP_ENV=qa,
 * gated by the export-token bearer credential, proxies Mailpit's HTTP API.
 * Tests use a stub Mailpit (node:http) — the real Mailpit never leaves the
 * QA internal network.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "./helpers.js";

const EXPORT_TOKEN = "test-export-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${EXPORT_TOKEN}` };

const MAILPIT_MESSAGES = {
  messages: [
    {
      ID: "msg2",
      Subject: "Example Corp Payroll — test email",
      From: { Address: "payroll@example.test" },
      To: [{ Address: "qa-admin@example.test" }],
      Created: "2026-08-20T10:00:00Z",
    },
    {
      ID: "msg1",
      Subject: "Example Corp Payroll — payslip issued",
      From: { Address: "payroll@example.test" },
      To: [{ Address: "qa-employee@example.test" }],
      Created: "2026-08-19T09:00:00Z",
    },
  ],
};

const MAILPIT_DETAIL = {
  ID: "msg2",
  Subject: "Example Corp Payroll — test email",
  From: { Address: "payroll@example.test", Name: "Payroll" },
  To: [{ Address: "qa-admin@example.test" }],
  Date: "2026-08-20T10:00:01Z",
  Text: "Test email from Example Corp Payroll admin settings. SMTP delivery is working.",
  HTML: "<p>Test email…</p>",
};

let mailpit: Server;
let mailpitUrl: string;

beforeAll(async () => {
  mailpit = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/v1/messages")) {
      res.end(JSON.stringify(MAILPIT_MESSAGES));
    } else if (req.url === "/api/v1/message/msg2") {
      res.end(JSON.stringify(MAILPIT_DETAIL));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => mailpit.listen(0, "127.0.0.1", resolve));
  mailpitUrl = `http://127.0.0.1:${(mailpit.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => mailpit.close(resolve));
});

describe("APP_ENV gate", () => {
  let prodCtx: TestContext;

  afterAll(async () => {
    await prodCtx?.close();
  });

  it("404s in production — the route does not exist outside APP_ENV=qa", async () => {
    prodCtx = await createTestApp({ exportToken: EXPORT_TOKEN, mailpitUrl });
    const res = await prodCtx.app.inject({
      method: "GET",
      url: "/api/qa/mailbox?to=qa-admin@example.test&latest=true",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/qa/mailbox (APP_ENV=qa)", () => {
  let ctx: TestContext;

  afterAll(async () => {
    await ctx?.close();
  });

  async function get(url: string, headers: Record<string, string> = AUTH) {
    if (!ctx) ctx = await createTestApp({ appEnv: "qa", exportToken: EXPORT_TOKEN, mailpitUrl });
    return ctx.app.inject({ method: "GET", url, headers });
  }

  it("requires the export-token bearer credential", async () => {
    const noAuth = await get("/api/qa/mailbox?to=qa-admin@example.test", {});
    expect(noAuth.statusCode).toBe(401);
    const wrong = await get("/api/qa/mailbox?to=qa-admin@example.test", {
      authorization: "Bearer wrong",
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("503s when no export token is configured", async () => {
    const bare = await createTestApp({ appEnv: "qa", mailpitUrl });
    try {
      const res = await bare.app.inject({
        method: "GET",
        url: "/api/qa/mailbox?to=qa-admin@example.test",
        headers: AUTH,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("qa_mailbox_disabled");
    } finally {
      await bare.close();
    }
  });

  it("validates the query", async () => {
    const missing = await get("/api/qa/mailbox");
    expect(missing.statusCode).toBe(400);
    const badLatest = await get("/api/qa/mailbox?to=qa-admin@example.test&latest=false");
    expect(badLatest.statusCode).toBe(400);
  });

  it("returns the latest message to an address with subject/to/text", async () => {
    const res = await get("/api/qa/mailbox?to=qa-admin@example.test&latest=true");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      subject: string;
      to: { Address: string }[];
      text: string;
      date: string;
    };
    expect(body.subject).toBe("Example Corp Payroll — test email");
    expect(body.to[0]?.Address).toBe("qa-admin@example.test");
    expect(body.text).toContain("SMTP delivery is working");
  });

  it("404s when no mail exists for the address", async () => {
    const res = await get("/api/qa/mailbox?to=nobody@example.test");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});
