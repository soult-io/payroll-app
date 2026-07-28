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
  bigint,
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
    unique("tax_brackets_jurisdiction_year_ordinal_uniq").on(
      t.jurisdiction,
      t.taxYear,
      t.ordinal,
    ),
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
    check(
      "pay_schedules_draft_day_check",
      sql`${t.draftDayOfMonth} BETWEEN 1 AND 28`,
    ),
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
    /** Idempotent monthly generation. */
    unique("payroll_runs_employee_period_start_uniq").on(t.employeeId, t.periodStart),
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
      sql`${t.requestType} IN ('address','w4','bank_details','legal_name')`,
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
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    /** Set on success. */
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    check("email_outbox_status_check", sql`${t.status} IN ('pending','sent','failed')`),
    index("email_outbox_status_idx").on(t.status),
  ],
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
