/**
 * Spec 22 (PAY-66) — the product name comes from one setting.
 *
 * Covers: BRAND_NAME parsing + validation (D1), config wiring and the TOTP
 * issuer fallback (D3), the enrollment URI issuer, the D4 email copy (pinned
 * verbatim), and the company-name placeholder (D5).
 */

import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_BRAND_NAME, parseBrandName } from "@payroll/shared";
import {
  adminTestEmail,
  payslipIssued,
  securityInvite,
  securityLoginNewDevice,
  securityPasswordReset,
  type TemplateContext,
} from "@payroll/notifications";
import { loadConfig } from "../src/config.js";
import { companyName } from "../src/notify/outbox.js";
import { createTestApp, type TestContext } from "./helpers.js";
import { inviteAndOnboard } from "./flow-helpers.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("parseBrandName (D1)", () => {
  it("defaults to Wagon Payroll when unset, empty, or whitespace", () => {
    expect(DEFAULT_BRAND_NAME).toBe("Wagon Payroll");
    expect(parseBrandName(undefined)).toBe("Wagon Payroll");
    expect(parseBrandName("")).toBe("Wagon Payroll");
    expect(parseBrandName("   ")).toBe("Wagon Payroll");
  });

  it("trims surrounding whitespace", () => {
    expect(parseBrandName(" Acme ")).toBe("Acme");
  });

  it("accepts exactly 60 characters", () => {
    expect(parseBrandName("A".repeat(60))).toBe("A".repeat(60));
  });

  it("rejects more than 60 characters", () => {
    expect(() => parseBrandName("A".repeat(61))).toThrow(/BRAND_NAME/);
  });

  it("rejects control characters (header / URI injection)", () => {
    expect(() => parseBrandName("A\r\nBcc: x")).toThrow(/BRAND_NAME/);
    expect(() => parseBrandName("A\u0000")).toThrow(/BRAND_NAME/);
    expect(() => parseBrandName("A\u007fB")).toThrow(/BRAND_NAME/);
    expect(() => parseBrandName("A\tB")).toThrow(/BRAND_NAME/);
    expect(() => parseBrandName("A\u0085B")).toThrow(/BRAND_NAME/); // C1 NEL
  });

  it("rejects zero-width, separator, and bidi characters (spoofing)", () => {
    expect(() => parseBrandName("Acme\u202dPay")).toThrow(/BRAND_NAME/); // LRO
    expect(() => parseBrandName("Acme\u202ePay")).toThrow(/BRAND_NAME/); // RLO
    expect(() => parseBrandName("Acme\u2028Pay")).toThrow(/BRAND_NAME/); // line separator
    expect(() => parseBrandName("Acme\u200bPay")).toThrow(/BRAND_NAME/); // zero-width space
    expect(() => parseBrandName("Acme\u2067Pay")).toThrow(/BRAND_NAME/); // RLI
  });

  it("accepts ordinary non-ASCII names", () => {
    expect(parseBrandName("Nómina Café — Pagos")).toBe("Nómina Café — Pagos");
  });
});

describe("loadConfig brand + TOTP issuer (D1, D3)", () => {
  it("no env: brandName and totpIssuer are both Wagon Payroll", () => {
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: undefined }, () => {
      const config = loadConfig();
      expect(config.brandName).toBe("Wagon Payroll");
      expect(config.totpIssuer).toBe("Wagon Payroll");
    });
  });

  it("BRAND_NAME=Acme: both follow the brand", () => {
    withEnv({ BRAND_NAME: "Acme", TOTP_ISSUER: undefined }, () => {
      const config = loadConfig();
      expect(config.brandName).toBe("Acme");
      expect(config.totpIssuer).toBe("Acme");
    });
  });

  it("TOTP_ISSUER overrides the issuer only", () => {
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: "Old" }, () => {
      const config = loadConfig();
      expect(config.brandName).toBe("Wagon Payroll");
      expect(config.totpIssuer).toBe("Old");
    });
  });

  it("empty TOTP_ISSUER falls back to the brand", () => {
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: "" }, () => {
      expect(loadConfig().totpIssuer).toBe("Wagon Payroll");
    });
  });

  it("a brandName override moves the issuer too", () => {
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: undefined }, () => {
      const config = loadConfig({ brandName: "X" });
      expect(config.brandName).toBe("X");
      expect(config.totpIssuer).toBe("X");
    });
  });

  it("TOTP_ISSUER env or an explicit totpIssuer override wins over a brandName override", () => {
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: "Old" }, () => {
      expect(loadConfig({ brandName: "X" }).totpIssuer).toBe("Old");
    });
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: undefined }, () => {
      expect(loadConfig({ brandName: "X", totpIssuer: "Y" }).totpIssuer).toBe("Y");
    });
  });

  it("TOTP_ISSUER is trimmed and validated like BRAND_NAME; invalid fails boot", () => {
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: "  Old  " }, () => {
      expect(loadConfig().totpIssuer).toBe("Old");
    });
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: "A\r\nB" }, () => {
      expect(() => loadConfig()).toThrow(/TOTP_ISSUER/);
    });
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: "A\u202eB" }, () => {
      expect(() => loadConfig()).toThrow(/TOTP_ISSUER/);
    });
    withEnv({ BRAND_NAME: undefined, TOTP_ISSUER: "A".repeat(61) }, () => {
      expect(() => loadConfig()).toThrow(/TOTP_ISSUER/);
    });
  });

  it("an invalid BRAND_NAME fails boot", () => {
    withEnv({ BRAND_NAME: "A\r\nB" }, () => {
      expect(() => loadConfig()).toThrow(/BRAND_NAME/);
    });
  });
});

describe("TOTP enrollment URI (D3)", () => {
  let t: TestContext;
  afterAll(async () => {
    await t?.close();
  });

  it("the onboarding totpURI names Wagon Payroll as issuer and label prefix", async () => {
    t = await createTestApp();
    const onboarded = await inviteAndOnboard(t, { email: "brand-totp@example.test" });
    // The OTP library form-encodes the query (issuer=Wagon+Payroll) and
    // percent-encodes the label path (Wagon%20Payroll:<email>); parse, don't
    // string-match the encoding.
    const uri = new URL(onboarded.totpURI);
    expect(uri.searchParams.get("issuer")).toBe("Wagon Payroll");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/Wagon Payroll:brand-totp@example.test");
  });
});

describe("email copy (D4)", () => {
  const CTX: TemplateContext = {
    companyName: "Acme Co",
    brandName: "Wagon Payroll",
    appUrl: "http://localhost",
  };
  const FOOTER =
    "Sent by Wagon Payroll on behalf of Acme Co. This is an automated message — please don't reply. Questions? Contact Acme Co directly.";
  const LINK = "http://localhost/setup#token=abc";

  it("subject leads with the employer, no product name", () => {
    expect(payslipIssued(CTX, { periodLabel: "2026-06", payDate: "2026-06-30" }).subject).toBe(
      "Acme Co — payslip issued",
    );
    expect(adminTestEmail(CTX, { by: "a@example.test" }).subject).toBe("Acme Co — test email");
  });

  it("footer names the brand as the sender on behalf of the employer (HTML + text)", () => {
    const rendered = payslipIssued(CTX, { periodLabel: "2026-06", payDate: "2026-06-30" });
    expect(rendered.html).toContain(FOOTER);
    expect(rendered.text.endsWith(FOOTER)).toBe(true);
  });

  it("the h2 heading stays the company name", () => {
    const rendered = adminTestEmail(CTX, { by: "a@example.test" });
    expect(rendered.html).toContain('<h2 style="margin:0 0 16px">Acme Co</h2>');
  });

  it("invite copy", () => {
    const rendered = securityInvite(CTX, { setupLink: LINK });
    const lead =
      "Acme Co has invited you to view your pay and tax documents in Wagon Payroll, the payroll system Acme Co uses.";
    expect(rendered.html).toContain(
      `<p>${lead}</p><p><a href="${LINK}">Set up your account</a> (single-use link, valid 24 hours). You will choose a password and enroll an authenticator app.</p>`,
    );
    expect(rendered.text).toContain(
      `${lead} Set up your account with this single-use link (valid 24 hours): ${LINK}`,
    );
  });

  it("password reset copy", () => {
    const rendered = securityPasswordReset(CTX, { setupLink: LINK });
    const lead = "Someone asked to reset the password for your Acme Co account in Wagon Payroll.";
    expect(rendered.html).toContain(
      `<p>${lead} You will need to set a new password and re-enroll your authenticator app.</p><p><a href="${LINK}">Reset your password</a> (single-use link, valid 24 hours). If you did not request this, contact Acme Co.</p>`,
    );
    expect(rendered.text).toContain(lead);
    expect(rendered.text).toContain("If you did not request this, contact Acme Co.");
    expect(rendered.html).not.toContain("administrator");
  });

  it("new-device sign-in copy", () => {
    const rendered = securityLoginNewDevice(CTX, {
      userAgent: "Firefox",
      ip: "203.0.113.9",
      at: "2026-09-26T10:00:00.000Z",
    });
    const lead =
      "Your Acme Co account in Wagon Payroll was just signed in to from a device we haven't seen before:";
    const close = "If this wasn't you, contact Acme Co right away.";
    expect(rendered.html).toContain(
      `<p>${lead}</p><ul><li>Device: Firefox</li><li>IP: 203.0.113.9</li><li>Time: 2026-09-26T10:00:00.000Z</li></ul><p>${close}</p>`,
    );
    expect(rendered.text).toContain(lead);
    expect(rendered.text).toContain(close);
  });

  it("test email copy", () => {
    const rendered = adminTestEmail(CTX, { by: "owner@example.test" });
    const sentence =
      "This is a test email from Wagon Payroll settings for Acme Co, requested by owner@example.test. Email delivery is working.";
    expect(rendered.html).toContain(`<p>${sentence}</p>`);
    expect(rendered.text).toContain(sentence);
    expect(rendered.text).not.toContain("SMTP delivery");
  });

  it("brandName is HTML-escaped", () => {
    const rendered = securityInvite({ ...CTX, brandName: "<b>Evil</b>" }, { setupLink: LINK });
    expect(rendered.html).not.toContain("<b>Evil</b>");
    expect(rendered.html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
  });

  it("no template glues the company name to 'Payroll'", () => {
    const all = [
      payslipIssued(CTX, { periodLabel: "2026-06", payDate: "2026-06-30" }),
      securityInvite(CTX, { setupLink: LINK }),
      securityPasswordReset(CTX, { setupLink: LINK }),
      securityLoginNewDevice(CTX, { userAgent: null, ip: null, at: "now" }),
      adminTestEmail(CTX, { by: "x@example.test" }),
    ];
    for (const r of all) {
      for (const part of [r.subject, r.html, r.text]) {
        expect(part).not.toContain("Acme Co Payroll");
      }
    }
  });
});

describe("companyName placeholder (D5)", () => {
  it("returns 'Your company' when no company row exists", async () => {
    const emptyDb = {
      select: () => ({ from: () => ({ limit: async () => [] }) }),
    } as unknown as Parameters<typeof companyName>[0];
    expect(await companyName(emptyDb)).toBe("Your company");
  });
});
