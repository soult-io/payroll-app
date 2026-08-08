# Spec 1 — Data Model

Status: `DRAFT — awaiting owner sign-off` · Depends on: D1–D12 · Feeds: all other specs

Database: dedicated Postgres 16+ instance, database `payroll`, least-privilege role `payroll`
(owns all app tables). Migrations: Drizzle Kit, run as a one-shot container before app boot
(same migrate-then-boot pattern as the internal accounting project).

Two table families:
- **Auth-owned** (managed by Better Auth migrations): `user`, `session`, `account`,
  `verification`, `twoFactor`. Touched only through Better Auth APIs. App tables reference
  `user.id` (TEXT in Better Auth, not SERIAL).
- **App-owned** (Drizzle migrations): everything below.

## 1. Organization & people

```sql
company (                       -- single row in v1; enables multi-company later
  id            SERIAL PRIMARY KEY,
  legal_name    TEXT NOT NULL,           -- 'Example Corp'
  ein           TEXT,                    -- encrypted at rest (app-level)
  address       JSONB,                   -- {line1,line2,city,state,zip,country}
  created_at    TIMESTAMPTZ DEFAULT now()
)

employees (
  id               SERIAL PRIMARY KEY,
  user_id          TEXT UNIQUE,          -- FK → user.id (Better Auth); NULL until invited
  company_id       INTEGER NOT NULL REFERENCES company(id),
  employment_type  TEXT NOT NULL DEFAULT 'w2'
                   CHECK (employment_type IN ('w2','1099')),   -- 1099 = future (D10)
  legal_name       TEXT NOT NULL,
  preferred_name   TEXT,
  date_of_birth    DATE,
  tax_id           TEXT,                 -- SSN; encrypted at rest, never in logs/responses
  address          JSONB,                -- current address; history via change_requests
  bank_details     JSONB,                -- {routing,account,type}; encrypted at rest
  hire_date        DATE NOT NULL,
  termination_date DATE,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','terminated')),
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
)
```

## 2. Payroll configuration (all effective-dated where life says so)

```sql
compensation (                  -- effective-dated pay; frequency-aware (D6)
  id              SERIAL PRIMARY KEY,
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  period_amount   NUMERIC(12,2) NOT NULL,      -- amount per pay period
  frequency       TEXT NOT NULL DEFAULT 'monthly'
                  CHECK (frequency IN ('weekly','biweekly','semimonthly','monthly')),
  effective_from  DATE NOT NULL,
  effective_to    DATE,                        -- NULL = open-ended
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, effective_from)
  -- non-overlap enforced by exclusion constraint on daterange(effective_from, effective_to)
)

w4_elections (                  -- 2020+ W-4 fields; multiple filings per year allowed
  id                 SERIAL PRIMARY KEY,
  employee_id        INTEGER NOT NULL REFERENCES employees(id),
  tax_year           INTEGER NOT NULL,
  filing_status      TEXT NOT NULL DEFAULT 'single'
                     CHECK (filing_status IN ('single','married_joint','married_separate','head_of_household')),
  federal_exempt     BOOLEAN NOT NULL DEFAULT false,
  multiple_jobs      BOOLEAN NOT NULL DEFAULT false,
  dependents_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_income       NUMERIC(12,2) NOT NULL DEFAULT 0,
  deductions_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  extra_withholding  NUMERIC(12,2) NOT NULL DEFAULT 0,   -- per-period extra
  effective_from     DATE NOT NULL,                      -- NOT retroactive (existing behavior)
  filed_date         DATE NOT NULL,
  renewal_deadline   DATE,                               -- exempt W-4s expire (IRC §3402(n))
  note               TEXT DEFAULT '',
  created_at         TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, tax_year, effective_from)
)

tax_config (                    -- versioned statutory scalars, one row per year per jurisdiction
  id                             SERIAL PRIMARY KEY,
  jurisdiction                   TEXT NOT NULL DEFAULT 'federal',
  tax_year                       INTEGER NOT NULL,
  standard_deduction             NUMERIC(12,2) NOT NULL,
  social_security_rate           NUMERIC(6,5) NOT NULL,
  social_security_wage_cap       NUMERIC(12,2) NOT NULL,
  medicare_rate                  NUMERIC(6,5) NOT NULL,
  medicare_additional_rate       NUMERIC(6,5) NOT NULL,
  medicare_additional_threshold  NUMERIC(12,2) NOT NULL,
  state_withholding_rate         NUMERIC(6,5) NOT NULL DEFAULT 0,
  employer_social_security_rate  NUMERIC(6,5) NOT NULL,
  employer_medicare_rate         NUMERIC(6,5) NOT NULL,
  futa_rate                      NUMERIC(6,5) NOT NULL,
  futa_wage_cap                  NUMERIC(12,2) NOT NULL,
  UNIQUE(jurisdiction, tax_year)
)

tax_brackets (
  id          SERIAL PRIMARY KEY,
  jurisdiction TEXT NOT NULL DEFAULT 'federal',
  tax_year    INTEGER NOT NULL,
  ordinal     INTEGER NOT NULL,
  min_amount  NUMERIC(12,2) NOT NULL,
  max_amount  NUMERIC(12,2),               -- NULL = open top bracket
  rate        NUMERIC(6,5) NOT NULL,
  UNIQUE(jurisdiction, tax_year, ordinal)
)

pay_schedules (                 -- admin-configurable draft schedule (D6); default 15th monthly
  id                 SERIAL PRIMARY KEY,
  employee_id        INTEGER REFERENCES employees(id),  -- NULL = company-wide default
  frequency          TEXT NOT NULL DEFAULT 'monthly'
                     CHECK (frequency IN ('weekly','biweekly','semimonthly','monthly')),
  draft_day_of_month INTEGER NOT NULL DEFAULT 15 CHECK (draft_day_of_month BETWEEN 1 AND 28),
  pay_day_of_month   INTEGER NOT NULL DEFAULT 15 CHECK (pay_day_of_month BETWEEN 1 AND 28),
  auto_draft         BOOLEAN NOT NULL DEFAULT true,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
)
```

## 3. Payroll runs (immutable once issued — D5)

```sql
payroll_runs (
  id             SERIAL PRIMARY KEY,
  employee_id    INTEGER NOT NULL REFERENCES employees(id),
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  pay_date       DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','awaiting_approval','approved','issued','void')),
  run_snapshot   JSONB NOT NULL,    -- frozen inputs+outputs: wage, tax config, brackets,
                                    -- W-4 election, prior-YTD, computed result. Payslip PDFs
                                    -- render from THIS, never from live config (D5).
  created_by     TEXT,              -- 'scheduler' or user.id
  approved_by    TEXT, approved_at TIMESTAMPTZ,
  issued_at      TIMESTAMPTZ,
  voided_at      TIMESTAMPTZ, void_reason TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, period_start) -- idempotent monthly generation
)
-- status transitions enforced in app: draft→awaiting_approval→approved→issued; any→void (pre-issue only)
-- issued rows are immutable: trigger rejects UPDATE on issued runs except void bookkeeping

payroll_entries (
  id         SERIAL PRIMARY KEY,
  run_id     INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  category   TEXT NOT NULL CHECK (category IN (
               'gross_pay','federal_withholding','social_security','medicare',
               'state_withholding','net_pay','employer_social_security',
               'employer_medicare','employer_futa')),
  amount     NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(run_id, category)
)
```

## 4. Change requests (D7)

```sql
change_requests (
  id            SERIAL PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  request_type  TEXT NOT NULL CHECK (request_type IN ('address','w4','bank_details','legal_name')),
  payload       JSONB NOT NULL,        -- proposed values, same shape as target field
  effective_from DATE NOT NULL,        -- requested effective date (D7: effective-dated)
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','denied','withdrawn')),
  submitted_at  TIMESTAMPTZ DEFAULT now(),
  decided_by    TEXT, decided_at TIMESTAMPTZ,
  applied_at    TIMESTAMPTZ,           -- set when the change lands on the target table
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
)

change_request_comments (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL,           -- user.id
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
)
```

## 5. Notifications (D8)

```sql
notification_settings (
  user_id    TEXT NOT NULL,            -- FK → user.id
  event_type TEXT NOT NULL,            -- see notifications spec catalog
  enabled    BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, event_type)
)

email_outbox (                         -- outbox pattern; pg-boss worker drains it
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  sent_at     TIMESTAMPTZ DEFAULT now() -- set on success
)
```

## 6. Audit (payroll-grade, from day one)

```sql
auth_events (                          -- per auth spec
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT,
  event      TEXT NOT NULL,            -- login_success, login_failure, mfa_pass, mfa_fail,
                                       -- password_change, invite_created, session_revoked, ...
  ip         INET, user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
)

audit_events (                         -- admin mutations to payroll-critical config
  id         BIGSERIAL PRIMARY KEY,
  actor_id   TEXT NOT NULL,
  action     TEXT NOT NULL,            -- e.g. compensation.update, tax_config.upsert, run.approve
  entity     TEXT NOT NULL, entity_id TEXT NOT NULL,
  before     JSONB, after JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
)
```

## 7. Future-designed (D10): schema only, no UI in v1

```sql
time_off (                             -- as existing accounting.time_off
  id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id),
  date DATE NOT NULL, type TEXT NOT NULL CHECK (type IN ('sick','vacation','holiday','other')),
  note TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, date)
)
```

## Cross-cutting rules

- **Money:** always `NUMERIC(12,2)` in DB; integer cents or decimal.js in TS; rounding mode
  (half-up) defined once in the engine package. Rates `NUMERIC(6,5)`.
- **Encryption at rest (app-level):** `tax_id`, `bank_details`, `company.ein` via a
  `SECRETS_DIR`-mounted key (AES-256-GCM). Never logged, never returned by list endpoints.
- **IDs:** app tables SERIAL (internal); anything exposed in URLs uses a separate UUID column
  where enumeration matters (change_requests, payroll_runs get `public_id UUID DEFAULT gen_random_uuid()`).
- **Timestamps:** all `TIMESTAMPTZ`, app TZ `Europe/Madrid` for display only.
- **Seeds:** company row, 2025+2026 `tax_config`/`tax_brackets` (from existing
  `TAX_CONFIG_2025`/`TAX_CONFIG`), default `pay_schedules` row (15th), admin invite via CLI.

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
