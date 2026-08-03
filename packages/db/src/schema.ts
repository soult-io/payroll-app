/**
 * Payroll app schema — Drizzle ORM (Postgres 16).
 *
 * Implements EVERY app-owned table from plan/specs/data-model.md (spec 1).
 *
 * Auth-owned tables (`user`, `session`, `account`, `verification`, `twoFactor`)
 * are intentionally NOT here — they are created by the Better Auth CLI migration
 * in step 2 (spec 1: "Two table families"). App columns that reference Better
 * Auth's `user.id` are TEXT without a FK constraint until then (employees.user_id,
 * change_request_comments.author_id, notification_settings.user_id, etc.).
 *
 * Not representable in Drizzle's schema DSL, applied as a raw SQL migration step
 * (see drizzle/0001_compensation_exclusion.sql):
 *   - exclusion constraint on compensation daterange(effective_from, effective_to)
 *     for non-overlapping effective-dated pay (requires btree_gist).
 *   - trigger rejecting UPDATE on issued payroll_runs except void bookkeeping.
 */

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow();
/** Money is always NUMERIC(12,2) in the DB (spec 1 cross-cutting rules). */
const money = (name: string) => numeric(name, { precision: 12, scale: 2 });
/** Rates are NUMERIC(6,5). */
const rate = (name: string) => numeric(name, { precision: 6, scale: 5 });

// ---------------------------------------------------------------------------
// 1. Organization & people
// ---------------------------------------------------------------------------

export const company = pgTable("company", {
  id: serial("id").primaryKey(),
  legalName: text("legal_name").notNull(),
  /** Encrypted at rest (app-level AES-256-GCM via SECRETS_DIR key). */
  ein: text("ein"),
  /** {line1,line2,city,state,zip,country} */
  address: jsonb("address"),
  createdAt: createdAt(),
});

export const employees = pgTable(
  "employees",
  {
    id: serial("id").primaryKey(),
    /** FK → user.id (Better Auth, TEXT) — constraint added in step 2. NULL until invited. */
    userId: text("user_id").unique(),
    companyId: integer("company_id")
      .notNull()
      .references(() => company.id),
    employmentType: text("employment_type").notNull().default("w2"),
    legalName: text("legal_name").notNull(),
    preferredName: text("preferred_name"),
    dateOfBirth: date("date_of_birth"),
    /** SSN — encrypted at rest, never in logs/responses. */
    taxId: text("tax_id"),
    /** Current address; history lives in change_requests/audit_events. */
    address: jsonb("address"),
    /** {routing,account,type} — encrypted at rest. */
    bankDetails: jsonb("bank_details"),
    hireDate: date("hire_date").notNull(),
    terminationDate: date("termination_date"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("employees_employment_type_check", sql`${t.employmentType} IN ('w2','1099')`),
    check("employees_status_check", sql`${t.status} IN ('active','terminated')`),
  ],
);

// ---------------------------------------------------------------------------
// 2. Payroll configuration (effective-dated where life says so)
// ---------------------------------------------------------------------------

export const compensation = pgTable(
  "compensation",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    /** Amount per pay period. */
    periodAmount: money("period_amount").notNull(),
    frequency: text("frequency").notNull().default("monthly"),
    effectiveFrom: date("effective_from").notNull(),
    /** NULL = open-ended. */
    effectiveTo: date("effective_to"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("compensation_employee_effective_from_uniq").on(t.employeeId, t.effectiveFrom),
    check(
      "compensation_frequency_check",
      sql`${t.frequency} IN ('weekly','biweekly','semimonthly','monthly')`,
    ),
    // Non-overlap across rows is enforced by an exclusion constraint on
    // daterange(effective_from, effective_to) — raw SQL migration, see header.
  ],
);

export const w4Elections = pgTable(
  "w4_elections",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    taxYear: integer("tax_year").notNull(),
    filingStatus: text("filing_status").notNull().default("single"),
    federalExempt: boolean("federal_exempt").notNull().default(false),
    multipleJobs: boolean("multiple_jobs").notNull().default(false),
    dependentsAmount: money("dependents_amount").notNull().default("0"),
    otherIncome: money("other_income").notNull().default("0"),
    deductionsAmount: money("deductions_amount").notNull().default("0"),
    /** Per-period extra withholding. */
    extraWithholding: money("extra_withholding").notNull().default("0"),
    /** NOT retroactive — applies to pay periods on/after this date. */
    effectiveFrom: date("effective_from").notNull(),
    filedDate: date("filed_date").notNull(),
    /** Exempt W-4s expire (IRC §3402(n)). */
    renewalDeadline: date("renewal_deadline"),
    note: text("note").default(""),
    createdAt: createdAt(),
  },
  (t) => [
    unique("w4_elections_employee_year_effective_uniq").on(
      t.employeeId,
      t.taxYear,
      t.effectiveFrom,
    ),
    check(
      "w4_elections_filing_status_check",
      sql`${t.filingStatus} IN ('single','married_joint','married_separate','head_of_household')`,
    ),
  ],
);

export const taxConfig = pgTable(
  "tax_config",
  {
    id: serial("id").primaryKey(),
    jurisdiction: text("jurisdiction").notNull().default("federal"),
    taxYear: integer("tax_year").notNull(),
    standardDeduction: money("standard_deduction").notNull(),
    socialSecurityRate: rate("social_security_rate").notNull(),
    socialSecurityWageCap: money("social_security_wage_cap").notNull(),
    medicareRate: rate("medicare_rate").notNull(),
    medicareAdditionalRate: rate("medicare_additional_rate").notNull(),
    medicareAdditionalThreshold: money("medicare_additional_threshold").notNull(),
    stateWithholdingRate: rate("state_withholding_rate").notNull().default("0"),
    employerSocialSecurityRate: rate("employer_social_security_rate").notNull(),
    employerMedicareRate: rate("employer_medicare_rate").notNull(),
    futaRate: rate("futa_rate").notNull(),
    futaWageCap: money("futa_wage_cap").notNull(),
  },
  (t) => [unique("tax_config_jurisdiction_year_uniq").on(t.jurisdiction, t.taxYear)],
);

export const taxBrackets = pgTable(
  "tax_brackets",
  {
    id: serial("id").primaryKey(),
    jurisdiction: text("jurisdiction").notNull().default("federal"),
    taxYear: integer("tax_year").notNull(),
    ordinal: integer("ordinal").notNull(),
    minAmount: money("min_amount").notNull(),
    /** NULL = open top bracket. */
    maxAmount: money("max_amount"),
    rate: rate("rate").notNull(),
  },
  (t) => [
    unique("tax_brackets_jurisdiction_year_ordinal_uniq").on(t.jurisdiction, t.taxYear, t.ordinal),
  ],
);

export const paySchedules = pgTable(
  "pay_schedules",
  {
    id: serial("id").primaryKey(),
    /** NULL = company-wide default. */
    employeeId: integer("employee_id").references(() => employees.id),
    frequency: text("frequency").notNull().default("monthly"),
    draftDayOfMonth: integer("draft_day_of_month").notNull().default(15),
    payDayOfMonth: integer("pay_day_of_month").notNull().default(15),
    autoDraft: boolean("auto_draft").notNull().default(true),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "pay_schedules_frequency_check",
      sql`${t.frequency} IN ('weekly','biweekly','semimonthly','monthly')`,
    ),
    check("pay_schedules_draft_day_check", sql`${t.draftDayOfMonth} BETWEEN 1 AND 28`),
    check("pay_schedules_pay_day_check", sql`${t.payDayOfMonth} BETWEEN 1 AND 28`),
  ],
);

// ---------------------------------------------------------------------------
// 3. Payroll runs (immutable once issued — D5)
// ---------------------------------------------------------------------------

export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: serial("id").primaryKey(),
    /** URL-safe, non-enumerable external id (spec 1 cross-cutting rules). */
    publicId: uuid("public_id").notNull().defaultRandom().unique(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    payDate: date("pay_date").notNull(),
    status: text("status").notNull().default("draft"),
    /**
     * Frozen inputs+outputs: wage, tax config, brackets, W-4 election, prior-YTD,
     * computed result, engineVersion. Payslip PDFs render from THIS, never from
     * live config (D5).
     */
    runSnapshot: jsonb("run_snapshot").notNull(),
    /** SHA-256 of the canonical snapshot JSON (spec documents determinism check). */
    snapshotHash: text("snapshot_hash"),
    /** 'scheduler' or user.id. */
    createdBy: text("created_by"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * Idempotent monthly generation — partial: void runs release the slot so
     * regenerating after a void creates a NEW run row (spec payroll-engine).
     */
    uniqueIndex("payroll_runs_employee_period_start_uniq")
      .on(t.employeeId, t.periodStart)
      .where(sql`${t.status} <> 'void'`),
    check(
      "payroll_runs_status_check",
      sql`${t.status} IN ('draft','awaiting_approval','approved','issued','void')`,
    ),
    // Issued-row immutability trigger: raw SQL migration, see header.
  ],
);

export const payrollEntries = pgTable(
  "payroll_entries",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    amount: money("amount").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("payroll_entries_run_category_uniq").on(t.runId, t.category),
    check(
      "payroll_entries_category_check",
      sql`${t.category} IN ('gross_pay','federal_withholding','social_security','medicare','state_withholding','net_pay','employer_social_security','employer_medicare','employer_futa')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 4. Change requests (D7)
// ---------------------------------------------------------------------------

export const changeRequests = pgTable(
  "change_requests",
  {
    id: serial("id").primaryKey(),
    /** URL-safe, non-enumerable external id. */
    publicId: uuid("public_id").notNull().defaultRandom().unique(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    requestType: text("request_type").notNull(),
    /** Proposed values, same shape as the target field. */
    payload: jsonb("payload").notNull(),
    /** Requested effective date (D7: effective-dated). */
    effectiveFrom: date("effective_from").notNull(),
    status: text("status").notNull().default("pending"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Set when the change lands on the target table. */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "change_requests_type_check",
      sql`${t.requestType} IN ('address','w4','bank_details','legal_name','tax_id')`,
    ),
    check(
      "change_requests_status_check",
      sql`${t.status} IN ('pending','approved','denied','withdrawn')`,
    ),
    /** One pending request per (employee, field) — partial unique index (spec 4). */
    uniqueIndex("change_requests_one_pending_per_field")
      .on(t.employeeId, t.requestType)
      .where(sql`status = 'pending'`),
  ],
);

export const changeRequestComments = pgTable("change_request_comments", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id")
    .notNull()
    .references(() => changeRequests.id, { onDelete: "cascade" }),
  /** user.id (Better Auth) — FK added in step 2. */
  authorId: text("author_id").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// 5. Notifications (D8)
// ---------------------------------------------------------------------------

export const notificationSettings = pgTable(
  "notification_settings",
  {
    /** FK → user.id — constraint added in step 2. */
    userId: text("user_id").notNull(),
    /** See notifications spec event catalog. */
    eventType: text("event_type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventType] })],
);

/** Outbox pattern; a pg-boss worker drains it. */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    eventType: text("event_type").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    /** 'suppressed' = user opted out via notification_settings (workflow events). */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Last send attempt — drives exponential backoff in the drain worker. */
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: createdAt(),
    /** Set on success. */
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    check(
      "email_outbox_status_check",
      sql`${t.status} IN ('pending','sent','failed','suppressed')`,
    ),
    index("email_outbox_status_idx").on(t.status),
  ],
);

/** Device fingerprints seen at login — drives security_login_new_device (spec 6). */
export const userDevices = pgTable(
  "user_devices",
  {
    userId: text("user_id").notNull(),
    /** SHA-256 of (user-agent + IP /24). */
    fingerprint: text("fingerprint").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.fingerprint] })],
);

// ---------------------------------------------------------------------------
// 6. Audit (payroll-grade, from day one)
// ---------------------------------------------------------------------------

export const authEvents = pgTable("auth_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  userId: text("user_id"),
  /** login_success, login_failure, mfa_pass, mfa_fail, password_change, invite_created, session_revoked, ... */
  event: text("event").notNull(),
  ip: inet("ip"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
});

/** Admin mutations to payroll-critical config. */
export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  actorId: text("actor_id").notNull(),
  /** e.g. compensation.update, tax_config.upsert, run.approve */
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// 7. Future-designed (D10): schema only, no UI in v1
// ---------------------------------------------------------------------------

export const timeOff = pgTable(
  "time_off",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    date: date("date").notNull(),
    type: text("type").notNull(),
    note: text("note").default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("time_off_employee_date_uniq").on(t.employeeId, t.date),
    check("time_off_type_check", sql`${t.type} IN ('sick','vacation','holiday','other')`),
  ],
);

// ---------------------------------------------------------------------------
// 8. Spec 10 — 1099 contractors (classification & tax-forms layer)
// ---------------------------------------------------------------------------

/**
 * 1:1 with employees where employment_type='1099' (spec 10 §1). tax_status is
 * STATUS, not location: a US citizen abroad is still 'us_person'. tin is
 * encrypted at rest like employees.tax_id. form_expires_at for w8ben/w8ben_e
 * is computed app-side (collected + 3 calendar years); w9 has no expiry.
 */
export const contractorDetails = pgTable(
  "contractor_details",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    taxStatus: text("tax_status").notNull(),
    entityType: text("entity_type").notNull(),
    /** ISO-3166; required app-side when tax_status='nonresident'. */
    residenceCountry: text("residence_country"),
    /** SSN/EIN/foreign TIN — encrypted at rest (app-level AES-256-GCM). */
    tin: text("tin"),
    taxForm: text("tax_form").notNull(),
    /** NULL = form outstanding (blocks payment, spec 10 §4). */
    formCollectedAt: date("form_collected_at"),
    formExpiresAt: date("form_expires_at"),
    /** TRUE → withhold 24% (missing/incorrect TIN, IRS notice). */
    backupWithholding: boolean("backup_withholding").notNull().default(false),
    /** Contractor's assertion of where work is physically performed. */
    servicesLocation: text("services_location").notNull().default("foreign"),
    /** [{year, days, note}] — sourcing documentation; presence of US days triggers 1042-S review. */
    usDaysLog: jsonb("us_days_log").notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("contractor_details_employee_uniq").on(t.employeeId),
    check(
      "contractor_details_tax_status_check",
      sql`${t.taxStatus} IN ('us_person','nonresident')`,
    ),
    check("contractor_details_entity_type_check", sql`${t.entityType} IN ('individual','entity')`),
    check(
      "contractor_details_tax_form_check",
      sql`${t.taxForm} IN ('w9','w8ben','w8ben_e','w8eci')`,
    ),
    check(
      "contractor_details_services_location_check",
      sql`${t.servicesLocation} IN ('foreign','us','mixed')`,
    ),
  ],
);

/**
 * Spec 12 §1 — recurring invoice templates (1099 only, enforced app-side).
 * invoice_day: 'last_day' = invoice dated the last day of the month;
 * 'fixed' = dated invoice_day_of_month (≤28, no February edge cases).
 * pay_day_of_month is the day of the FOLLOWING month the payment is due.
 * last_generated_period ("YYYY-MM") is the generation guard column (spec §2);
 * the unique partial index on contractor_invoices is the hard belt.
 */
export const contractorRecurringInvoices = pgTable(
  "contractor_recurring_invoices",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    /** e.g. 'Monthly retainer — {month}' ({month}/{year} interpolated at generation). */
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("USD"),
    invoiceDay: text("invoice_day").notNull().default("last_day"),
    /** Required when invoice_day='fixed'; NULL otherwise (app-side). */
    invoiceDayOfMonth: integer("invoice_day_of_month"),
    payDayOfMonth: integer("pay_day_of_month").notNull(),
    active: boolean("active").notNull().default(true),
    /** First period to generate for. */
    startsOn: date("starts_on").notNull(),
    /** Contract end; NULL = open-ended. Last period generated, then retires. */
    endsOn: date("ends_on"),
    /** "YYYY-MM" of the last period generated — idempotency guard. */
    lastGeneratedPeriod: text("last_generated_period"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("contractor_recurring_invoices_amount_check", sql`${t.amount} > 0`),
    check(
      "contractor_recurring_invoices_invoice_day_check",
      sql`${t.invoiceDay} IN ('last_day','fixed')`,
    ),
    check(
      "contractor_recurring_invoices_invoice_day_of_month_check",
      sql`${t.invoiceDayOfMonth} BETWEEN 1 AND 28`,
    ),
    check(
      "contractor_recurring_invoices_pay_day_of_month_check",
      sql`${t.payDayOfMonth} BETWEEN 1 AND 28`,
    ),
  ],
);

/**
 * Contractors are paid against INVOICES, not periods (spec 10 §2) — separate
 * from payroll_runs: no snapshot, no engine, no payslip. Status transitions
 * are guarded app-side: submitted→approved|rejected, approved→paid, any→void
 * (void requires a note; paid is otherwise terminal).
 *
 * Spec 12 §4: nullable recurring_template_id (+ recurring_period "YYYY-MM")
 * marks scheduler-generated invoices; manual invoices leave both NULL. The
 * partial unique index guarantees one generated invoice per template per
 * period — the idempotency belt under re-runs and double ticks.
 */
export const contractorInvoices = pgTable(
  "contractor_invoices",
  {
    id: serial("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    /** Contractor's own reference/number. */
    invoiceRef: text("invoice_ref"),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    /** v1: recorded as USD at payment. */
    currency: text("currency").notNull().default("USD"),
    invoiceDate: date("invoice_date").notNull(),
    status: text("status").notNull().default("submitted"),
    /** user.id if contractor self-submits (D16 deferred); NULL = admin-entered. */
    submittedBy: text("submitted_by"),
    /** review_* doubles as void bookkeeping (who/when/note). */
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    /** Spec 12: set when generated by a recurring template; NULL = manual. */
    recurringTemplateId: integer("recurring_template_id").references(
      () => contractorRecurringInvoices.id,
    ),
    /** Spec 12: "YYYY-MM" the invoice was generated for. */
    recurringPeriod: text("recurring_period"),
    createdAt: createdAt(),
  },
  (t) => [
    check("contractor_invoices_amount_check", sql`${t.amount} > 0`),
    check(
      "contractor_invoices_status_check",
      sql`${t.status} IN ('submitted','approved','rejected','paid','void')`,
    ),
    uniqueIndex("contractor_invoices_recurring_period_uniq")
      .on(t.recurringTemplateId, t.recurringPeriod)
      .where(sql`${t.recurringTemplateId} IS NOT NULL`),
  ],
);

/**
 * 1:1 with contractor_invoices in v1 (one payment settles one invoice).
 * method drives the 1099-NEC carve-out: card/third_party_network payments are
 * EXCLUDED from the payer's 1099-NEC (the processor files 1099-K).
 */
export const contractorPayments = pgTable(
  "contractor_payments",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => contractorInvoices.id),
    payDate: date("pay_date").notNull(),
    /** USD actually paid. */
    amount: money("amount").notNull(),
    /** NULL if the invoice was already USD. */
    exchangeRate: numeric("exchange_rate", { precision: 12, scale: 6 }),
    method: text("method").notNull(),
    /** 24% of amount when contractor_details.backup_withholding. */
    backupWithheld: money("backup_withheld").notNull().default("0"),
    /** Check #, wire ref, transaction id. */
    reference: text("reference"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("contractor_payments_invoice_uniq").on(t.invoiceId),
    check(
      "contractor_payments_method_check",
      sql`${t.method} IN ('ach','check','wire','card','third_party_network')`,
    ),
  ],
);

/**
 * Dated 1099-NEC reporting thresholds (spec 10 §3) — same versioned-config
 * pattern as tax_config, never a hardcoded constant. Seeded $600 through
 * 2025, $2,000 for 2026 (OBBBA, inflation-indexed annually from 2027);
 * admin-editable per year. Lookup: exact year, else latest earlier row.
 */
export const contractorReportingConfig = pgTable(
  "contractor_reporting_config",
  {
    id: serial("id").primaryKey(),
    taxYear: integer("tax_year").notNull(),
    necThreshold: money("nec_threshold").notNull(),
    /** e.g. statutory source / indexing note. */
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("contractor_reporting_config_year_uniq").on(t.taxYear)],
);

// ---------------------------------------------------------------------------
// 9. Step-2: setup tokens (spec 3 — invite/reset machinery)
// ---------------------------------------------------------------------------

/**
 * Single-use setup tokens for invites and admin-initiated password resets.
 * Only the SHA-256 hash of the plaintext token is stored; tokens expire ≤ 24h.
 * userId references Better Auth's user.id (FK appended in migration 0003, since
 * auth-owned tables are invisible to drizzle-kit generate).
 */
export const setupTokens = pgTable(
  "setup_tokens",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** SHA-256 hex of the plaintext token. */
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("setup_tokens_token_hash_uniq").on(t.tokenHash),
    check("setup_tokens_purpose_check", sql`${t.purpose} IN ('invite','reset')`),
    index("setup_tokens_user_id_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// 10. Step-6: legacy migration ledger (spec 9 — migration & cutover)
// ---------------------------------------------------------------------------

/**
 * Idempotency ledger for the one-time legacy import from
 * `second_brain.accounting` (mcp-accounting). Every migrated row is recorded
 * as (entity, source_id) → target_id so re-running `pnpm migrate:legacy` is a
 * no-op, and so migrated rows stay distinguishable from app-created rows for
 * audit/rollback. The table is app-owned but written ONLY by the migration
 * CLI — never by the runtime.
 */
export const legacyMigrationMap = pgTable(
  "legacy_migration_map",
  {
    id: serial("id").primaryKey(),
    /** 'company' | 'employee' | 'compensation' | 'w4' | 'tax_config' | 'tax_brackets' | 'run' */
    entity: text("entity").notNull(),
    /** Source primary key as text (e.g. accounting.payroll_runs.id). */
    sourceId: text("source_id").notNull(),
    /** Target primary key as text (run: payroll_runs.id). */
    targetId: text("target_id").notNull(),
    migratedAt: timestamp("migrated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [unique("legacy_migration_map_entity_source_uniq").on(t.entity, t.sourceId)],
);
