/**
 * Read-only payroll export (D10 activation) — requested by the Accountant
 * agent (2026-07-30) for downstream compliance: 941 federal deposits, the
 * quarterly/annual tax package (941/940/W-2/W-3), compliance tracking.
 *
 * Contract (docs/export-api.md):
 * - READ-ONLY. Never mutates payroll data; the D4 sole-writer rule is
 *   untouched (this endpoint only SELECTs, plus its own audit_events row).
 * - Auth: scoped service credential — `Authorization: Bearer <token>` against
 *   $SECRETS_DIR/export-token. Never interactive TOTP, so unattended agents
 *   can call it. No token configured → 503 (explicit deployment decision).
 * - ISSUED runs only — draft/void figures are not authoritative.
 * - Deterministic: figures come from stored payroll_entries (the validated,
 *   frozen truth), ordered canonically; identical request → identical bytes.
 * - No surplus PII: the payload carries company legal_name + ein (required
 *   for filings) but never employee tax_id/bank_details/address.
 * - Range filter keys on pay_date — deposits and filings are keyed on when
 *   wages were PAID, not the period worked.
 * - Every successful call writes an audit_events row (who/when/how many runs).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { auditEvents, company, payrollEntries, payrollRuns } from "@payroll/db";
import type { AppConfig } from "../config.js";
import { decryptField } from "../crypto/field-encryption.js";
import type { Db } from "../db.js";

export const EXPORT_ACTOR = "service:export";

/** Canonical category order — the 9 payroll_entries categories, fixed for byte-determinism. */
const ENTRY_CATEGORIES = [
  "gross_pay",
  "federal_withholding",
  "social_security",
  "medicare",
  "state_withholding",
  "net_pay",
  "employer_social_security",
  "employer_medicare",
  "employer_futa",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ExportDeps {
  db: Db;
  config: AppConfig;
}

interface ExportParams {
  from?: string | undefined;
  to?: string | undefined;
  format: "json" | "csv";
}

interface RunPayload {
  employeeId: number;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: string;
  snapshotHash: string | null;
  entries: Record<string, string | null>;
}

/** Constant-time token comparison (hashed first so length never leaks). */
function tokenOk(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function badRequest(reply: FastifyReply, error: string, message: string) {
  return reply.code(400).send({ error, message });
}

/**
 * Validate the query string. Returns null after sending the error reply —
 * callers just `if (!params) return;`.
 */
function parseParams(req: FastifyRequest, reply: FastifyReply): ExportParams | null {
  const q = req.query as { from?: string; to?: string; status?: string; format?: string };
  if ((q.status ?? "issued") !== "issued") {
    badRequest(
      reply,
      "unsupported_status",
      "only status=issued is exportable — draft/void figures are not authoritative",
    );
    return null;
  }
  if (q.from && !DATE_RE.test(q.from)) {
    badRequest(reply, "invalid_date", "from must be YYYY-MM-DD");
    return null;
  }
  if (q.to && !DATE_RE.test(q.to)) {
    badRequest(reply, "invalid_date", "to must be YYYY-MM-DD");
    return null;
  }
  if (q.from && q.to && q.from > q.to) {
    badRequest(reply, "invalid_range", "from must be on or before to");
    return null;
  }
  const format = q.format ?? "json";
  if (format !== "json" && format !== "csv") {
    badRequest(reply, "unsupported_format", "format must be json or csv");
    return null;
  }
  return { from: q.from, to: q.to, format };
}

/** Issued runs in range (pay_date-keyed) with their stored entries, canonical order. */
async function fetchRuns(db: Db, params: ExportParams): Promise<RunPayload[]> {
  const conditions = [eq(payrollRuns.status, "issued")];
  if (params.from) conditions.push(gte(payrollRuns.payDate, params.from));
  if (params.to) conditions.push(lte(payrollRuns.payDate, params.to));

  const runs = await db
    .select({
      id: payrollRuns.id,
      employeeId: payrollRuns.employeeId,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
      payDate: payrollRuns.payDate,
      status: payrollRuns.status,
      snapshotHash: payrollRuns.snapshotHash,
    })
    .from(payrollRuns)
    .where(and(...conditions))
    .orderBy(asc(payrollRuns.payDate), asc(payrollRuns.employeeId));

  const entryRows =
    runs.length === 0
      ? []
      : await db
          .select({
            runId: payrollEntries.runId,
            category: payrollEntries.category,
            amount: payrollEntries.amount,
          })
          .from(payrollEntries)
          .where(
            inArray(
              payrollEntries.runId,
              runs.map((r) => r.id),
            ),
          );
  const byRun = new Map<number, Map<string, string>>();
  for (const e of entryRows) {
    let m = byRun.get(e.runId);
    if (!m) {
      m = new Map();
      byRun.set(e.runId, m);
    }
    m.set(e.category, e.amount);
  }

  return runs.map((r) => ({
    employeeId: r.employeeId,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    payDate: r.payDate,
    status: r.status,
    snapshotHash: r.snapshotHash,
    // Canonical order; null (not "0.00") if a category is missing — a
    // corrupted run must be visible, never silently zeroed.
    entries: Object.fromEntries(ENTRY_CATEGORIES.map((c) => [c, byRun.get(r.id)?.get(c) ?? null])),
  }));
}

function toCsv(runs: RunPayload[]): string {
  const header = [
    "employee_id",
    "period_start",
    "period_end",
    "pay_date",
    "status",
    "snapshot_hash",
    ...ENTRY_CATEGORIES,
  ].join(",");
  const lines = runs.map((r) =>
    [
      r.employeeId,
      r.periodStart,
      r.periodEnd,
      r.payDate,
      r.status,
      r.snapshotHash,
      ...ENTRY_CATEGORIES.map((c) => r.entries[c] ?? ""),
    ].join(","),
  );
  return `${[header, ...lines].join("\n")}\n`;
}

/**
 * Bearer-token gate. Returns true when authorized; otherwise the error reply
 * is already sent (503 when unconfigured, 401 on missing/wrong token).
 */
async function authorize(
  req: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): Promise<boolean> {
  if (!config.exportToken) {
    await reply.code(503).send({
      error: "export_disabled",
      message: "no export-token in SECRETS_DIR — the export endpoint is disabled",
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

export function registerExportRoutes(app: FastifyInstance, deps: ExportDeps): void {
  const { db, config } = deps;

  app.get("/api/export/payroll-runs", async (req, reply) => {
    if (!(await authorize(req, reply, config))) return;

    const params = parseParams(req, reply);
    if (!params) return;

    const runsPayload = await fetchRuns(db, params);

    const [companyRow] = await db.select().from(company).limit(1);
    const companyPayload = {
      legalName: companyRow?.legalName ?? null,
      // Filings need the full EIN (decrypted at read); absent until configured.
      ein: companyRow?.ein ? decryptField(companyRow.ein, config.encryptionKey) : null,
    };

    // Auditable access trail — one row per successful call.
    await db.insert(auditEvents).values({
      actorId: EXPORT_ACTOR,
      action: "export.payroll_runs",
      entity: "export",
      entityId: `${params.from ?? ""}..${params.to ?? ""}`,
      after: { format: params.format, status: "issued", runCount: runsPayload.length },
    });

    if (params.format === "csv") {
      // Company header is JSON-only — CSV consumers key on one known company.
      return reply.header("content-type", "text/csv; charset=utf-8").send(toCsv(runsPayload));
    }

    return {
      company: companyPayload,
      status: "issued",
      range: { from: params.from ?? null, to: params.to ?? null },
      runs: runsPayload,
    };
  });
}
