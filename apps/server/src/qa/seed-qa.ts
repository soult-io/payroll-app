/**
 * QA synthetic dataset (spec 14 §2) — deterministic, obviously fake, never
 * prod data. Idempotent: every writer existence-checks by natural key (or
 * relies on the table's own idempotency constraint), so re-running is a no-op.
 *
 * Persona inventory (see docs/qa.md for the full table):
 * - 3 W-2 employees — varied work states; Ada (W-4 exempt), Bob (mid-year
 *   salary change, two compensation rows), Carol (pending address change
 *   request with a comment thread + the QA employee login).
 * - 2 domestic 1099 contractors — Dave (YTD payments above the NEC threshold,
 *   form required) and Erin (below threshold, backup withholding on).
 * - 2 international contractors — Frida (clean W-8BEN) and Gustav (us_days_log
 *   → 1042-S review flag, W-8 expiring inside the 30-day renewal window).
 * - Issued payroll history: the previous calendar year in full + the current
 *   year through last month ("2 years of history"), computed through the REAL
 *   run pipeline (generateDraft → approve → issue) so entries and snapshots
 *   are exactly what the engine produces, to the cent. One draft run for the
 *   current period is left awaiting approval (Ada).
 * - Recurring invoice templates incl. one approved-but-unpaid generated
 *   invoice for the previous period (payment-due reminder fodder).
 * - QA logins with fixed documented credentials + fixed TOTP secrets (QA-only,
 *   fake — safe to publish in docs/qa.md and the nightly workflow).
 */

import { and, eq, ne } from "drizzle-orm";
import { symmetricEncrypt } from "better-auth/crypto";
import {
  authUser,
  changeRequestComments,
  changeRequests,
  company,
  compensation,
  contractorDetails,
  contractorInvoices,
  contractorPayments,
  contractorRecurringInvoices,
  employees,
  notificationSettings,
  payrollRuns,
  seedDatabase,
  w4Elections,
  type SeedDb,
} from "@payroll/db";
import { WORKFLOW_EVENTS } from "@payroll/notifications";
import type { Auth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import type { AppConfig } from "../config.js";
import { encryptField } from "../crypto/field-encryption.js";
import type { Db } from "../db.js";
import { generateDraft, monthlyPeriod, transitionRun, type Period } from "../payroll/runs.js";

// ---------------------------------------------------------------------------
// Fixed QA credentials (FAKE — QA-only, documented in docs/qa.md)
// ---------------------------------------------------------------------------

export const QA_ADMIN = {
  name: "Quinn Adminster",
  email: "qa-admin@example.test",
  password: "qa-admin-passphrase-742",
  /** Fixed RAW TOTP secret (createOTP key); base32 form documented in docs/qa.md. */
  totpSecret: "QAADMIN0FIXED1TOTP2SECRET3SEED456",
  role: "admin",
} as const;

export const QA_EMPLOYEE_LOGIN = {
  name: "Carol Mockington",
  email: "qa-employee@example.test",
  password: "qa-employee-passphrase-318",
  totpSecret: "QAEMPLOYEE0FIXED1TOTP2SECRET3SEED",
  role: "employee",
} as const;

// ---------------------------------------------------------------------------
// Date helpers (seed is deterministic given `today`)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** First row or throw — inserts with .returning() always yield exactly one row. */
function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`seed-qa: expected a row for ${what}`);
  return row;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface YearMonth {
  year: number;
  month: number;
}

/**
 * Issued-history months: the previous calendar year in full plus the current
 * year through last month (spec 14 §2 "2 years of issued payroll history" —
 * spanning two calendar years, which is also exactly the span the seeded tax
 * configs cover).
 */
export function historyMonths(today: string): YearMonth[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const months: YearMonth[] = [];
  for (let m = 1; m <= 12; m++) months.push({ year: year - 1, month: m });
  for (let m = 1; m < month; m++) months.push({ year, month: m });
  return months;
}

// ---------------------------------------------------------------------------
// QA users (admin + employee login) — direct inserts mirroring the onboarding
// flow's end state (credential account + TOTP enrolled + settings defaults)
// ---------------------------------------------------------------------------

interface QaDeps {
  db: Db;
  auth: Auth;
  config: AppConfig;
}

type QaUser = typeof QA_ADMIN | typeof QA_EMPLOYEE_LOGIN;

async function ensureQaUser(deps: QaDeps, user: QaUser): Promise<{ id: string; created: boolean }> {
  const { db, auth, config } = deps;
  const existing = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, user.email))
    .limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };

  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser({
    name: user.name,
    email: user.email,
    emailVerified: true,
    role: user.role,
    banned: false,
  });
  const hashed = await hashPassword(user.password);
  await ctx.internalAdapter.createAccount({
    userId: created.id,
    accountId: created.id,
    providerId: "credential",
    password: hashed,
  });

  // TOTP pre-enrolled from the FIXED documented secret (Playwright computes
  // valid codes from the same value — spec 14 §2/§3).
  const encryptedSecret = await symmetricEncrypt({
    key: ctx.secretConfig ?? config.sessionSecret,
    data: user.totpSecret,
  });
  await ctx.adapter.create({
    model: "twoFactor",
    data: { userId: created.id, secret: encryptedSecret, backupCodes: "[]" },
  });
  await ctx.internalAdapter.updateUser(created.id, { twoFactorEnabled: true });

  // Same defaults the onboarding flow sets (spec 6).
  await db
    .insert(notificationSettings)
    .values(WORKFLOW_EVENTS.map((eventType) => ({ userId: created.id, eventType, enabled: true })))
    .onConflictDoNothing({
      target: [notificationSettings.userId, notificationSettings.eventType],
    });
  return { id: created.id, created: true };
}

// ---------------------------------------------------------------------------
// W-2 employees
// ---------------------------------------------------------------------------

interface W2Persona {
  key: "ada" | "bob" | "carol";
  legalName: string;
  state: string;
  hireDate: string;
  taxId: string;
  userId?: string;
}

const W2_PERSONAS: W2Persona[] = [
  {
    key: "ada",
    legalName: "Ada Testworth",
    state: "IL",
    hireDate: "2024-11-04",
    taxId: "000000001",
  },
  {
    key: "bob",
    legalName: "Bob Fakeley",
    state: "TX",
    hireDate: "2024-11-04",
    taxId: "000000002",
  },
  {
    key: "carol",
    legalName: "Carol Mockington",
    state: "WA",
    hireDate: "2024-11-04",
    taxId: "000000003",
  },
];

function fakeAddress(persona: W2Persona) {
  const cities: Record<string, { city: string; zip: string }> = {
    IL: { city: "Springfield", zip: "62704" },
    TX: { city: "Austin", zip: "73301" },
    WA: { city: "Seattle", zip: "98101" },
  };
  const c = cities[persona.state] ?? { city: "Nowhere", zip: "00000" };
  return {
    line1: `1${persona.taxId.slice(-2)} Fake Street`,
    city: c.city,
    state: persona.state,
    zip: c.zip,
    country: "US",
  };
}

async function ensureEmployee(
  deps: QaDeps,
  companyId: number,
  persona: W2Persona,
): Promise<number> {
  const { db, config } = deps;
  const existing = await db
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.legalName, persona.legalName))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const enc = (v: string) => encryptField(v, config.encryptionKey);
  const inserted = await db
    .insert(employees)
    .values({
      companyId,
      employmentType: "w2",
      legalName: persona.legalName,
      hireDate: persona.hireDate,
      status: "active",
      address: fakeAddress(persona),
      taxId: enc(persona.taxId),
      bankDetails: {
        routing: enc(`00000000${persona.taxId.slice(-1)}`),
        account: enc(`000000000${persona.taxId.slice(-1)}`),
        type: "checking",
      },
      ...(persona.userId ? { userId: persona.userId } : {}),
    })
    .returning({ id: employees.id });
  return one(inserted, "employee").id;
}

async function ensureCompensation(
  db: Db,
  employeeId: number,
  rows: { periodAmount: string; effectiveFrom: string; effectiveTo: string | null }[],
): Promise<void> {
  for (const row of rows) {
    const found = await db
      .select({ id: compensation.id })
      .from(compensation)
      .where(
        and(
          eq(compensation.employeeId, employeeId),
          eq(compensation.effectiveFrom, row.effectiveFrom),
        ),
      )
      .limit(1);
    if (found[0]) continue;
    await db.insert(compensation).values({ employeeId, frequency: "monthly", ...row });
  }
}

async function ensureW4(
  db: Db,
  employeeId: number,
  rows: {
    taxYear: number;
    federalExempt: boolean;
    effectiveFrom: string;
    filedDate: string;
    renewalDeadline: string | null;
  }[],
): Promise<void> {
  for (const row of rows) {
    const found = await db
      .select({ id: w4Elections.id })
      .from(w4Elections)
      .where(
        and(
          eq(w4Elections.employeeId, employeeId),
          eq(w4Elections.taxYear, row.taxYear),
          eq(w4Elections.effectiveFrom, row.effectiveFrom),
        ),
      )
      .limit(1);
    if (found[0]) continue;
    await db.insert(w4Elections).values({ employeeId, filingStatus: "single", ...row });
  }
}

export type W2Ids = Record<"ada" | "bob" | "carol", number>;

async function seedW2People(
  deps: QaDeps,
  companyId: number,
  employeeUserId: string,
  today: string,
): Promise<W2Ids> {
  const year = Number(today.slice(0, 4));
  const ids = {} as W2Ids;
  for (const persona of W2_PERSONAS) {
    const withLogin = persona.key === "carol" ? { ...persona, userId: employeeUserId } : persona;
    ids[persona.key] = await ensureEmployee(deps, companyId, withLogin);
  }

  await ensureCompensation(deps.db, ids.ada, [
    { periodAmount: "3500.00", effectiveFrom: "2024-11-01", effectiveTo: null },
  ]);
  // Bob: mid-year salary change — two compensation rows (spec 14 §2).
  await ensureCompensation(deps.db, ids.bob, [
    { periodAmount: "3800.00", effectiveFrom: "2024-11-01", effectiveTo: `${year}-07-01` },
    { periodAmount: "4200.00", effectiveFrom: `${year}-07-01`, effectiveTo: null },
  ]);
  await ensureCompensation(deps.db, ids.carol, [
    { periodAmount: "5000.00", effectiveFrom: "2024-11-01", effectiveTo: null },
  ]);

  // Ada: W-4 exempt — an election per history year, renewed annually with the
  // renewal deadline far enough out that the exemption never lapses
  // mid-history (resolveW4 honours renewal_deadline, IRC §3402(n)).
  const w4Rows = (federalExempt: boolean) => [
    {
      taxYear: year - 1,
      federalExempt,
      effectiveFrom: `${year - 1}-01-01`,
      filedDate: `${year - 2}-12-15`,
      renewalDeadline: federalExempt ? `${year}-02-15` : null,
    },
    {
      taxYear: year,
      federalExempt,
      effectiveFrom: `${year}-01-01`,
      filedDate: `${year - 1}-12-15`,
      renewalDeadline: federalExempt ? `${year + 1}-02-15` : null,
    },
  ];
  await ensureW4(deps.db, ids.ada, w4Rows(true));
  await ensureW4(deps.db, ids.bob, w4Rows(false));
  await ensureW4(deps.db, ids.carol, w4Rows(false));
  return ids;
}

// ---------------------------------------------------------------------------
// Payroll history — the REAL pipeline (draft → approve → issue), idempotent
// ---------------------------------------------------------------------------

async function findRun(db: Db, employeeId: number, periodStart: string) {
  const rows = await db
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.employeeId, employeeId),
        eq(payrollRuns.periodStart, periodStart),
        ne(payrollRuns.status, "void"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Advance a run to issued via the state machine; returns the final status. */
async function advanceToIssued(deps: QaDeps, publicId: string, status: string, actorId: string) {
  let current = status;
  if (current === "draft" || current === "awaiting_approval") {
    current = (await transitionRun(deps, { publicId, action: "approve", actorId })).status;
  }
  if (current === "approved") {
    current = (await transitionRun(deps, { publicId, action: "issue", actorId })).status;
  }
  return current;
}

async function ensureIssuedRun(
  deps: QaDeps,
  employeeId: number,
  period: Period,
  actorId: string,
): Promise<"issued" | "existing"> {
  const existing = await findRun(deps.db, employeeId, period.periodStart);
  if (existing) {
    await advanceToIssued(deps, existing.publicId, existing.status, actorId);
    return "existing";
  }
  const { run } = await generateDraft(deps, { employeeId, period, createdBy: actorId });
  await advanceToIssued(deps, run.publicId, run.status, actorId);
  return "issued";
}

async function seedPayrollHistory(
  deps: QaDeps,
  w2: W2Ids,
  adminId: string,
  today: string,
): Promise<{ issued: number; existing: number; draftCreated: boolean }> {
  let issued = 0;
  let existing = 0;
  for (const employeeId of [w2.ada, w2.bob, w2.carol]) {
    for (const { year, month } of historyMonths(today)) {
      const outcome = await ensureIssuedRun(
        deps,
        employeeId,
        monthlyPeriod(year, month, 15),
        adminId,
      );
      if (outcome === "issued") issued += 1;
      else existing += 1;
    }
  }

  // ONE draft run awaiting approval for the current period (spec 14 §2) — the
  // e2e scheduler spec asserts it in the admin approvals UI (read-only).
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const period = monthlyPeriod(year, month, 15);
  const found = await findRun(deps.db, w2.ada, period.periodStart);
  let draftCreated = false;
  if (!found) {
    await generateDraft(deps, { employeeId: w2.ada, period, createdBy: adminId });
    draftCreated = true;
  }
  return { issued, existing, draftCreated };
}

// ---------------------------------------------------------------------------
// Carol's pending change request + comment thread
// ---------------------------------------------------------------------------

export const QA_CHANGE_REQUEST_ADDRESS = {
  line1: "99 Pretend Avenue",
  city: "Portland",
  state: "OR",
  zip: "97201",
  country: "US",
} as const;

async function seedChangeRequestThread(
  deps: QaDeps,
  carolId: number,
  adminId: string,
  employeeUserId: string,
  today: string,
): Promise<boolean> {
  const { db } = deps;
  const existing = await db
    .select({ id: changeRequests.id })
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.employeeId, carolId),
        eq(changeRequests.requestType, "address"),
        eq(changeRequests.status, "pending"),
      ),
    )
    .limit(1);
  if (existing[0]) return false;

  const inserted = await db
    .insert(changeRequests)
    .values({
      employeeId: carolId,
      requestType: "address",
      payload: QA_CHANGE_REQUEST_ADDRESS,
      effectiveFrom: today,
      status: "pending",
    })
    .returning({ id: changeRequests.id });
  const requestId = one(inserted, "change request").id;
  await db.insert(changeRequestComments).values([
    {
      requestId,
      authorId: employeeUserId,
      body: "Moving next month — please update my address before the next run. (Synthetic QA comment.)",
    },
    {
      requestId,
      authorId: adminId,
      body: "Thanks — can you confirm the move date? (Synthetic QA comment.)",
    },
    {
      requestId,
      authorId: employeeUserId,
      body: "Confirmed: the 1st of next month. (Synthetic QA comment.)",
    },
  ]);
  return true;
}

// ---------------------------------------------------------------------------
// Contractors
// ---------------------------------------------------------------------------

interface ContractorPersona {
  key: "dave" | "erin" | "frida" | "gustav";
  legalName: string;
  hireDate: string;
  taxStatus: "us_person" | "nonresident";
  residenceCountry: string | null;
  tin: string;
  taxForm: "w9" | "w8ben";
  formCollectedAt: string;
  /** Manual override (Gustav's W-8 must expire inside the 30-day window). */
  formExpiresAt?: string;
  backupWithholding?: boolean;
  servicesLocation?: "foreign" | "us" | "mixed";
  usDaysLog?: { year: number; days: number; note?: string }[];
}

function contractorPersonas(today: string): ContractorPersona[] {
  const year = Number(today.slice(0, 4));
  return [
    {
      key: "dave",
      legalName: "Dave Placeholder",
      hireDate: "2025-01-06",
      taxStatus: "us_person",
      residenceCountry: null,
      tin: "000000011",
      taxForm: "w9",
      formCollectedAt: `${year - 1}-12-01`,
    },
    {
      key: "erin",
      legalName: "Erin Sampleton",
      hireDate: "2025-01-06",
      taxStatus: "us_person",
      residenceCountry: null,
      tin: "000000012",
      taxForm: "w9",
      formCollectedAt: `${year - 1}-12-01`,
      backupWithholding: true,
    },
    {
      key: "frida",
      legalName: "Frida Nullstadt",
      hireDate: "2025-01-06",
      taxStatus: "nonresident",
      residenceCountry: "DE",
      tin: "000000013",
      taxForm: "w8ben",
      // Clean W-8BEN: valid through (collected year + 3)-12-31, nowhere near
      // the 30-day renewal window.
      formCollectedAt: `${year - 1}-06-01`,
    },
    {
      key: "gustav",
      legalName: "Gustav Testenberg",
      hireDate: "2025-01-06",
      taxStatus: "nonresident",
      residenceCountry: "SE",
      tin: "000000014",
      taxForm: "w8ben",
      formCollectedAt: addDays(today, 20 - 3 * 365),
      // Expires 20 days after seeding — inside the 30-day renewal-notification
      // window (manual override of the collected+3y rule; the expiry sweep
      // reads form_expires_at as stored).
      formExpiresAt: addDays(today, 20),
      servicesLocation: "mixed",
      usDaysLog: [{ year, days: 12, note: "Client on-site visit (synthetic QA entry)" }],
    },
  ];
}

export type ContractorIds = Record<"dave" | "erin" | "frida" | "gustav", number>;

async function seedContractorPersonas(
  deps: QaDeps,
  companyId: number,
  today: string,
): Promise<ContractorIds> {
  const { db, config } = deps;
  const ids = {} as ContractorIds;
  for (const persona of contractorPersonas(today)) {
    const existing = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.legalName, persona.legalName))
      .limit(1);
    let employeeId = existing[0]?.id;
    if (!employeeId) {
      const inserted = await db
        .insert(employees)
        .values({
          companyId,
          employmentType: "1099",
          legalName: persona.legalName,
          hireDate: persona.hireDate,
          status: "active",
        })
        .returning({ id: employees.id });
      employeeId = one(inserted, "contractor employee").id;
    }
    ids[persona.key] = employeeId;

    const details = await db
      .select({ id: contractorDetails.id })
      .from(contractorDetails)
      .where(eq(contractorDetails.employeeId, employeeId))
      .limit(1);
    if (details[0]) continue;
    await db.insert(contractorDetails).values({
      employeeId,
      taxStatus: persona.taxStatus,
      entityType: "individual",
      residenceCountry: persona.residenceCountry,
      tin: encryptField(persona.tin, config.encryptionKey),
      taxForm: persona.taxForm,
      formCollectedAt: persona.formCollectedAt,
      formExpiresAt:
        persona.formExpiresAt ??
        (persona.taxForm === "w8ben"
          ? `${Number(persona.formCollectedAt.slice(0, 4)) + 3}-12-31`
          : null),
      backupWithholding: persona.backupWithholding ?? false,
      servicesLocation: persona.servicesLocation ?? "foreign",
      usDaysLog: persona.usDaysLog ?? [],
    });
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Contractor financials: invoices, payments, recurring templates
// ---------------------------------------------------------------------------

async function ensureInvoice(
  db: Db,
  values: {
    employeeId: number;
    description: string;
    amount: string;
    invoiceDate: string;
    status: "submitted" | "approved" | "paid";
    recurringTemplateId?: number;
    recurringPeriod?: string;
    reviewedBy?: string;
  },
): Promise<{ id: number; created: boolean }> {
  const existing = await db
    .select({ id: contractorInvoices.id })
    .from(contractorInvoices)
    .where(
      and(
        eq(contractorInvoices.employeeId, values.employeeId),
        eq(contractorInvoices.description, values.description),
        eq(contractorInvoices.invoiceDate, values.invoiceDate),
      ),
    )
    .limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };
  const inserted = await db
    .insert(contractorInvoices)
    .values({
      employeeId: values.employeeId,
      description: values.description,
      amount: values.amount,
      invoiceDate: values.invoiceDate,
      status: values.status,
      ...(values.recurringTemplateId !== undefined
        ? { recurringTemplateId: values.recurringTemplateId }
        : {}),
      ...(values.recurringPeriod !== undefined ? { recurringPeriod: values.recurringPeriod } : {}),
      ...(values.reviewedBy !== undefined
        ? { reviewedBy: values.reviewedBy, reviewedAt: new Date() }
        : {}),
    })
    .returning({ id: contractorInvoices.id });
  return { id: one(inserted, "invoice").id, created: true };
}

async function ensurePayment(
  db: Db,
  invoiceId: number,
  values: { payDate: string; amount: string; backupWithheld?: string },
): Promise<boolean> {
  const existing = await db
    .select({ id: contractorPayments.id })
    .from(contractorPayments)
    .where(eq(contractorPayments.invoiceId, invoiceId))
    .limit(1);
  if (existing[0]) return false;
  await db.insert(contractorPayments).values({
    invoiceId,
    payDate: values.payDate,
    amount: values.amount,
    method: "ach",
    backupWithheld: values.backupWithheld ?? "0",
    reference: `QA-FAKE-${invoiceId}`,
  });
  return true;
}

async function ensureTemplate(
  db: Db,
  values: {
    employeeId: number;
    description: string;
    amount: string;
    invoiceDay: "last_day" | "fixed";
    invoiceDayOfMonth: number | null;
    payDayOfMonth: number;
    startsOn: string;
    lastGeneratedPeriod?: string;
  },
): Promise<{ id: number; created: boolean }> {
  const existing = await db
    .select({ id: contractorRecurringInvoices.id })
    .from(contractorRecurringInvoices)
    .where(
      and(
        eq(contractorRecurringInvoices.employeeId, values.employeeId),
        eq(contractorRecurringInvoices.description, values.description),
      ),
    )
    .limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };
  const inserted = await db
    .insert(contractorRecurringInvoices)
    .values({
      employeeId: values.employeeId,
      description: values.description,
      amount: values.amount,
      invoiceDay: values.invoiceDay,
      invoiceDayOfMonth: values.invoiceDayOfMonth,
      payDayOfMonth: values.payDayOfMonth,
      startsOn: values.startsOn,
      ...(values.lastGeneratedPeriod !== undefined
        ? { lastGeneratedPeriod: values.lastGeneratedPeriod }
        : {}),
    })
    .returning({ id: contractorRecurringInvoices.id });
  return { id: one(inserted, "recurring template").id, created: true };
}

/** Dave: monthly paid invoices this year (YTD above the NEC threshold from March on). */
async function seedDaveFinancials(
  deps: QaDeps,
  daveId: number,
  adminId: string,
  today: string,
): Promise<void> {
  const { db } = deps;
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ] as const;

  for (let m = 1; m < month; m++) {
    const label = `Consulting retainer — ${monthNames[m - 1]} ${year}`;
    const invoice = await ensureInvoice(db, {
      employeeId: daveId,
      description: label,
      amount: "800.00",
      invoiceDate: `${year}-${pad2(m)}-28`,
      status: "paid",
      reviewedBy: adminId,
    });
    // Paid on the 5th of the following month (clamped to `today` so a seed run
    // early in the month never records a future-dated payment).
    const nominalPayDate = `${year}-${pad2(m + 1)}-05`;
    await ensurePayment(db, invoice.id, {
      payDate: nominalPayDate > today ? today : nominalPayDate,
      amount: "800.00",
    });
  }

  // Recurring template whose pay day is TODAY (≤28) + an approved-but-unpaid
  // generated invoice for the previous period — the payment-due reminder
  // sweep fires on it (spec 14 §2).
  const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const prevPeriod = `${prev.year}-${pad2(prev.month)}`;
  const template = await ensureTemplate(db, {
    employeeId: daveId,
    description: "Monthly retainer — {month}",
    amount: "800.00",
    invoiceDay: "last_day",
    invoiceDayOfMonth: null,
    payDayOfMonth: Math.min(Number(today.slice(8, 10)), 28),
    startsOn: `${year}-01-01`,
    lastGeneratedPeriod: prevPeriod,
  });
  const lastDay = new Date(Date.UTC(prev.year, prev.month, 0)).getUTCDate();
  await ensureInvoice(db, {
    employeeId: daveId,
    description: `Monthly retainer — ${monthNames[prev.month - 1]}`,
    amount: "800.00",
    invoiceDate: `${prevPeriod}-${pad2(lastDay)}`,
    status: "approved",
    recurringTemplateId: template.id,
    recurringPeriod: prevPeriod,
    reviewedBy: adminId,
  });
}

async function seedErinFinancials(deps: QaDeps, erinId: number, adminId: string, today: string) {
  const { db } = deps;
  const year = Number(today.slice(0, 4));
  // Below the NEC threshold + backup withholding on (24% of $400 = $96).
  const invoice = await ensureInvoice(db, {
    employeeId: erinId,
    description: `Design sprint — January ${year}`,
    amount: "400.00",
    invoiceDate: `${year}-01-28`,
    status: "paid",
    reviewedBy: adminId,
  });
  await ensurePayment(db, invoice.id, {
    payDate: `${year}-02-05`,
    amount: "400.00",
    backupWithheld: "96.00",
  });
  await ensureTemplate(db, {
    employeeId: erinId,
    description: "Design support — {month}",
    amount: "450.00",
    invoiceDay: "fixed",
    invoiceDayOfMonth: 25,
    payDayOfMonth: 10,
    startsOn: `${year}-01-01`,
  });
}

async function seedFridaTemplate(db: Db, fridaId: number, today: string) {
  const year = Number(today.slice(0, 4));
  await ensureTemplate(db, {
    employeeId: fridaId,
    description: "Localization retainer — {month}",
    amount: "1100.00",
    invoiceDay: "last_day",
    invoiceDayOfMonth: null,
    payDayOfMonth: 15,
    startsOn: `${year}-01-01`,
  });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface QaSeedSummary {
  users: {
    admin: { email: string; created: boolean };
    employee: { email: string; created: boolean };
  };
  w2: W2Ids;
  contractors: ContractorIds;
  payroll: { issued: number; existing: number; draftCreated: boolean };
  changeRequestCreated: boolean;
}

export interface QaSeedOptions {
  /** YYYY-MM-DD — fixed in tests; defaults to the real current date. */
  today?: string;
}

export async function seedQaDataset(
  deps: QaDeps,
  opts: QaSeedOptions = {},
): Promise<QaSeedSummary> {
  const today = opts.today ?? todayIso();
  // Reference data (company, tax tables, pay schedule) — idempotent.
  await seedDatabase(deps.db as unknown as SeedDb);

  const admin = await ensureQaUser(deps, QA_ADMIN);
  const employeeLogin = await ensureQaUser(deps, QA_EMPLOYEE_LOGIN);

  const companyRows = await deps.db.select({ id: company.id }).from(company).limit(1);
  const companyId = one(companyRows, "company").id;

  const w2 = await seedW2People(deps, companyId, employeeLogin.id, today);
  const payroll = await seedPayrollHistory(deps, w2, admin.id, today);
  const changeRequestCreated = await seedChangeRequestThread(
    deps,
    w2.carol,
    admin.id,
    employeeLogin.id,
    today,
  );
  const contractors = await seedContractorPersonas(deps, companyId, today);
  await seedDaveFinancials(deps, contractors.dave, admin.id, today);
  await seedErinFinancials(deps, contractors.erin, admin.id, today);
  await seedFridaTemplate(deps.db, contractors.frida, today);

  return {
    users: {
      admin: { email: QA_ADMIN.email, created: admin.created },
      employee: { email: QA_EMPLOYEE_LOGIN.email, created: employeeLogin.created },
    },
    w2,
    contractors,
    payroll,
    changeRequestCreated,
  };
}
