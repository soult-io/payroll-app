# Test-gap audit — money paths (PAY-92)

Date: 2026-09-26 · Base: `origin/main` c45c7b5 (v1.25.0) · Auditor: independent (did not write the code under test).

## Why this audit

PAY-91 shipped with ~82% line coverage and every buggy line executed. The tests covered each
feature's steady state (quarterly schedule created up front) but no transition (schedule loaded
after monthly rows already existed). This audit lists, per money path, the **scenarios** that
matter — derived from reading the source — and classifies each one against the test suite:

- **TESTED** — a test drives the scenario and asserts the money or date outcome.
- **PARTIAL** — a test runs the code path but does not assert the money/date outcome, or covers
  only a pure helper, or covers only half of the scenario.
- **UNTESTED** — no test drives the scenario. "(no code path)" marks behaviour the code does not
  implement at all, so there is nothing to test until it is built or ruled out of scope.

Money at risk: **H** = wrong tax paid/filed or wrong net pay for a real customer is plausible;
**M** = wrong figure shown or a missed obligation that a careful owner would likely catch;
**L** = cosmetic, conservative, or needs an unusual action to trigger.

Evidence is `file › describe › test name` (server tests under `apps/server/test/`, engine tests
under `packages/engine/test/`).

Method note: several server tests compute the "expected" figure by re-querying the DB with the
same rule as the code under test (`deposits.test.ts` `expectedAmount`, `filings.test.ts`
`exactLiability`, `qa-seed.test.ts` "entries equal its engine snapshot"). Those assert
consistency, not correctness; they were still counted as TESTED where the scenario itself is
driven. Hand-computed goldens exist only in the engine tests, `payroll-lifecycle` ($310.13),
`futa-credit`, `in-year-940`, `annual-forms` (940 lines) and `state-taxes`.

## Summary counts

| Path | Scenarios | TESTED | PARTIAL | UNTESTED | of which H |
|---|---:|---:|---:|---:|---:|
| Engine (`packages/engine`) | 14 | 12 | 0 | 2 | 2 |
| Payroll runs (`apps/server/src/payroll`) | 25 | 12 | 4 | 9 | 5 |
| Deposits (`apps/server/src/deposits`) | 31 | 15 | 3 | 13 | 6 |
| Filings (941, 940, W-2/W-3) | 27 | 15 | 2 | 10 | 5 |
| Contractors (invoices, recurring) | 16 | 9 | 3 | 4 | 0 |
| Calendar projections | 10 | 5 | 1 | 4 | 0 |
| **Total** | **123** | **68** | **13** | **42** | **18** |
| Timezone (cross-cutting, §7, not in total) | 4 | 0 | 0 | 4 | 0 |

By scenario class, the UNTESTED and PARTIAL rows cluster in (a) settings changing mid-period,
(f) recompute of deposited/overdue rows, (d) void/correction, (b) upgrade over old data, and (h)
timezone (no test sets `APP_TZ` or fake timers). Re-run/idempotency (c) is the best-covered class:
every sync and generator has a double-run test; only the missed-tick cases (D15, C14) are open.

---

## 1. Engine — `packages/engine`

| # | Scenario | Status | Evidence | Risk | Why |
|---|---|---|---|---|---|
| E1 | Federal brackets 2025/2026, single + married-joint | TESTED | `payroll.test.ts › calculatePayroll — golden case`; `payroll-frequency-w4.test.ts › filing-status bracket selection: married_joint fixture` | L | Hand goldens. |
| E2 | W-4 steps 3, 4a, 4b, 4c | TESTED | `payroll-frequency-w4.test.ts › 2020+ W-4 fields …` (6 tests) | L | Each field has a golden. |
| E3 | (a) W-4 Step 2 "multiple jobs" checkbox | UNTESTED (no code path) | `calculatePayroll` never reads `multipleJobs`; the column is captured (`schema.ts` `multiple_jobs`, `W4RequestForm.vue`) and frozen in the snapshot | **H** | Employee who ticks Step 2 is under-withheld all year; Pub 15-T uses the Step 2 rate schedule. |
| E4 | W-4 exempt zeroes federal only | TESTED | `payroll.test.ts › W-4 exempt from federal withholding` (4 tests); `property.test.ts › exempt W-4 zeroes …` | L | |
| E5 | Weekly / biweekly / semimonthly periods | TESTED | `payroll-frequency-w4.test.ts › frequency generalization` | L | Engine only; server cannot run them (R22). |
| E6 | (e) SS wage base crossed inside a period, employee + employer | TESTED | `payroll.test.ts › Social Security wage cap › partial SS in the month earnings cross the cap`, `no SS once prior YTD already exceeds the cap`; `property.test.ts › Social Security: zero at/above the cap …` | L | |
| E7 | (e) Additional Medicare crossing $200k | TESTED | `payroll.test.ts › Additional Medicare › not applied at exactly the threshold`, `applied to the portion of YTD above the threshold`; `property.test.ts › additional Medicare only kicks in above the threshold` | L | |
| E8 | (e) FUTA $7,000 base straddled / exhausted | TESTED | `payroll.test.ts › FUTA wage base › partial FUTA when this month straddles the $7,000 base`, `zero once the wage base is exhausted` | L | |
| E9 | Rounding: half-cent up, net reconciles to gross | TESTED | `money.test.ts` (all); `property.test.ts › rounding invariants` | L | |
| E10 | State withholding, all 2026 states + DC | TESTED | `payroll-state-all.test.ts › 2026 per-state golden fixtures`; `payroll-state.test.ts` EDD/IDOR worked examples | L | |
| E11 | (a) State table year selection (2025 vs 2026 allowance) | TESTED | `payroll-state.test.ts › 2025 tables use the $2,850 allowance …` | L | |
| E12 | State exempt / none / sparse config | TESTED | `payroll-state.test.ts › sparse config robustness`, `TX (kind none)` | L | |
| E13 | effectiveFutaRate from SUTA credit | TESTED | `payroll.test.ts › effectiveFutaRate (PAY-18)` | L | |
| E14 | (b) `futa_rate` column and `suta_credit_rate` disagree | UNTESTED | Engine accrues with `taxConfig.futaRate` (`runs.ts` `futaRate: tax.config.futaRate`); the 940 uses `effectiveFutaRate(sutaCreditRate)` (`annual.ts` `federalCaps`) | **H** | Two sources for one rate; only PUT keeps them in step. See F20 for the upgrade path that splits them. |

## 2. Payroll runs — `apps/server/src/payroll`

| # | Scenario | Status | Evidence | Risk | Why |
|---|---|---|---|---|---|
| R1 | Draft → approve → issue; illegal transitions 409 | TESTED | `payroll-lifecycle.test.ts › state machine › walks awaiting_approval → approved → issued …` | L | |
| R2 | Void pre-issued with reason; regenerate creates a new run | TESTED | `payroll-lifecycle.test.ts › state machine › voids a pre-issued run only with a reason …` | L | |
| R3 | Issued run immutable (snapshot + DB trigger) | TESTED | `payroll-lifecycle.test.ts › snapshot immutability (D5)` | L | |
| R4 | Void of an issued run refused by the app | TESTED | `payroll-lifecycle.test.ts › walks …` ("Void an issued run → 409") | L | |
| R5 | (d) Issued run voided at DB level (trigger permits issued→void) — downstream deposits/filings | UNTESTED | `0001_…immutability.sql` allows `NEW.status = 'void'`; no test | M | Needs a direct write today, but it is the only correction path the schema allows. |
| R6 | (d) Correction of an issued run (off-cycle / adjustment run, second run in the same period) | UNTESTED (no code path) | `generateDraft` returns the existing run for `(employee, period_start)`; no adjustment run type | **H** | An underpayment or wrong withholding on an issued run has no in-app fix; deposits/941 cannot reflect a correction. Feature decision for Neil, not only a test gap. |
| R7 | (c) Double generate → one run | TESTED | `payroll-lifecycle.test.ts › is idempotent: double-generate yields exactly one run` | L | |
| R8 | (a) Compensation change on a month boundary | TESTED | `payroll-lifecycle.test.ts › resolves compensation as-of the period date` | L | |
| R9 | (a) Compensation change effective mid-month | UNTESTED | `resolveCompensation(…, period.periodStart)` — whole month paid at the old rate, no proration | **H** | A raise effective the 15th pays nothing extra that month; wage-hour exposure. Test in R3 even writes a 2025-10-15 change but never generates October. |
| R10 | (a) W-4 exempt from its effective date, not retroactive | TESTED | `payroll-lifecycle.test.ts › applies effective-dated W-4 …` | L | |
| R11 | (a)(e) W-4 exempt lapses at `renewal_deadline` | UNTESTED | `resolveW4` flips `federalExempt` when `renewalDeadline <= periodStart`; tests set a deadline but never generate past it | **H** | Customer zero's own W-4 is exempt with renewal 2027-02-16 (`EMPLOYEE_W4`). A regression silently keeps withholding at $0. |
| R12 | (a) Non-exempt W-4 fields changed mid-year via change request → next run amount | PARTIAL | `change-requests.test.ts › W-4 append-only › approval INSERTs a new election …` asserts rows only | M | No run is generated after approval. |
| R13 | (a) Config edited between draft generation and issue (W-4, compensation, tax table, work state, state election via admin routes) | UNTESTED | `transitionRun` never recomputes; admin routes (`PUT …/work-state`, `PUT /api/admin/tax-config`) bypass the change-request "next un-run period" guard | **H** | The PAY-91 pattern for runs: a draft sitting in `awaiting_approval` issues with superseded inputs and no warning. |
| R14 | (a) Later period drafted before the earlier one issued (stale prior-YTD) | PARTIAL | `payroll-lifecycle.test.ts › chains prior YTD across ISSUED runs only` shows the stale Feb draft has `priorYtdGross 0`, then voids it by hand | **H** | Nothing stops approving/issuing the stale draft; SS base, FUTA base, Additional Medicare and snapshot YTD are then wrong. |
| R15 | Prior YTD chains across issued runs only | TESTED | same test as R14 | L | |
| R16 | (e) SS wage base crossed through the issued-run chain (server) | UNTESTED | Engine tests inject `priorYtdGross`; `annual-forms.test.ts` fixture comment "nobody here reaches it" | M | `resolvePriorYtdGross` feeding the cap is never exercised at the cap. |
| R17 | (e) Jan 1: YTD reset and new-year tax table | PARTIAL | `qa-seed.test.ts › payroll history › every issued run's entries equal its engine snapshot to the cent` spans Dec→Jan | M | Asserts entries = snapshot (self-consistent), not that January's prior YTD is 0 or that the new year's table was used. |
| R18 | (a) No federal `tax_config` for the new year | UNTESTED | `generateDraftsForPeriod` turns `no_tax_config` into `skipped`; scheduler ignores the return | M | On Jan 1 with unseeded tables, no drafts and no alert. |
| R19 | Work state without state config fails loudly | TESTED | `state-taxes.test.ts › work state without a config fails generation loudly` | L | Route path; scheduler path swallows it like R18. |
| R20 | (a)(g) Work state changes mid-year → next run uses the new state | PARTIAL | `state-taxes.test.ts › work state assignment › assigns, closes the previous window …` asserts date windows only | M | No run generated across the move. |
| R21 | (a) State election effective-dated | TESTED | `state-taxes.test.ts › IL election effective-dating: 2 allowances from June → $273.49` | L | |
| R22 | (a) Pay frequency change / compensation frequency ≠ monthly schedule | UNTESTED | `generateDraftsForPeriod` skips non-monthly schedules; a biweekly `compensation.frequency` on the monthly schedule pays one biweekly amount per month with 26-period withholding | M | |
| R23 | Terminated employee still drafted | UNTESTED | Scheduler tick selects all `employment_type = 'w2'` (no status filter); single-employee path has no status filter | M | Draft for a terminated employee; relies on the admin not issuing it. |
| R24 | FUTA annual cap guard (app + DB trigger) | TESTED | `futa-cap.test.ts` (5 tests) | L | |
| R25 | (b) Legacy data: YTD backfill, pay-date fix, legacy migration | TESTED | `ytd-backfill.test.ts`, `paydate-fix.test.ts`, `migrate-legacy.test.ts` (idempotent re-runs included) | L | |

(Timezone for runs is in the cross-cutting table below.)

## 3. Deposits — `apps/server/src/deposits/service.ts`

| # | Scenario | Status | Evidence | Risk | Why |
|---|---|---|---|---|---|
| D1 | Federal amount = 5 categories over issued runs in the pay month | TESTED | `deposits.test.ts › computeDepositAmount › sums the five deposit categories …` | L | Expected value re-derived from DB (method note). |
| D2 | Draft, void and `employer_futa` excluded | TESTED | `deposits.test.ts › computeDepositAmount › excludes draft and void runs, and employer_futa` | L | |
| D3 | (e) Due date: 15th next month, weekend roll, Dec→Jan | TESTED | `deposits.test.ts › dueDateFor (PAY-9 domain rules)` | L | |
| D4 | (e) Federal-holiday roll | UNTESTED (no code path) | `dueDateFor` rolls weekends only | L | Shown date is earlier than the legal one — conservative. |
| D5 | (c) Re-run sync: no duplicate rows | TESTED | `deposits.test.ts › syncDeposits › upserts pending rows … idempotently`; `PAY-13 state deposits › is idempotent …` | L | |
| D6 | (f) Late run into a PENDING month recomputes | TESTED | `deposits.test.ts › syncDeposits › recomputes the amount of a pending row when a late run issues` | L | |
| D7 | (f) Late run into an OVERDUE month | UNTESTED | `syncFederalDeposit`/`syncStateDepositsForPeriod` only update `status === "pending"` | **H** | Overdue row keeps the old amount; the owner pays the stale figure and under-deposits. |
| D8 | (f) Late run into a DEPOSITED month: row not rewritten | TESTED | `deposits.test.ts › PAY-14 current-month rows › never rewrites a deposited current-month row …` | L | |
| D9 | (f) Late run into a DEPOSITED month: the shortfall is surfaced | UNTESTED (no code path) | Same test asserts `recomputed 0`; nothing records liability − deposited | **H** | The extra liability is invisible until the 941 line 14 balance due. |
| D10 | (f) Pending → overdue flip | TESTED | `deposits.test.ts › syncDeposits › flips pending rows to overdue once the due date passes` | L | |
| D11 | (f) Overdue → deposited | PARTIAL | `deposits.test.ts › admin deposit routes › rejects an invalid confirmation and a double deposit` marks the overdue March row; asserts HTTP 200/409 only | L | |
| D12 | Mark-deposited validation + audit | TESTED | `deposits.test.ts › admin deposit routes › marks a deposit as deposited …` | L | |
| D13 | Current-month row created on first issued run | TESTED | `deposits.test.ts › PAY-14 current-month rows › creates the row mid-month …` | L | |
| D14 | (c) Reminders: each offset once, custom offsets, never for deposited | TESTED | `deposits.test.ts › sendDepositReminders` (4 tests) | L | |
| D15 | (c) Tick missed on a reminder day | UNTESTED | `processDepositReminders` fires only when `due − offset === today` | M | One outage day drops that reminder permanently. |
| D16 | Row created after its reminder fire date | UNTESTED | same equality rule | L | Offset 0 still fires. |
| D17 | Quarterly reminder label "Q1 2026" | UNTESTED | `periodLabel(…, "quarterly")` | L | |
| D18 | (g) State row per (state, month) | TESTED | `deposits.test.ts › PAY-13 state deposits › creates a state deposit row …` | L | |
| D19 | (g) Two states in one month; federal unaffected | TESTED | `… › creates separate rows for two work states …` | L | |
| D20 | (b) Runs with no snapshot state → no state row | TESTED | `… › creates NO state row when runs have no snapshot state` | L | |
| D21 | (g) `kind='none'` state (TX) → no row | UNTESTED | zero-amount filter in `computeStateDepositAmounts` | L | |
| D22 | (g) Quarterly state: one row per quarter, recomputed while pending | TESTED | `… › quarterly state (NY): one row per quarter …` | L | Schedule present before the first run — steady state only. |
| D23 | (a)(b) Quarterly schedule loaded AFTER monthly state rows exist (PAY-91) | UNTESTED | `statePeriodKey` maps the quarter onto the first month's key: the Jan/Jul row is overwritten with the quarter total while Feb/Mar (Aug/Sep) monthly rows stay pending | **H** | The shipped bug. Double-counts two months and keeps a monthly due date. |
| D24 | (a) Schedule or `due_day` changes after rows exist — due date recomputed | UNTESTED | `dueDate` is written on insert only; the pending-update branch sets `amount` only | **H** | Overdue flip and reminders then key off the old date. |
| D25 | (a)(e) Schedule year rollover (only `*-2026.json` seeds; 2025/2027 fall back to monthly) | UNTESTED | `scheduleMap.get(\`${state}:${year}\`)`; no 2027 seed | **H** | CA/NY/MD/NC become "monthly, 15th" on 2027-01-01 without warning. |
| D26 | (g) State with no schedule in the sync (federal fallback) | PARTIAL | `deposits.test.ts › state Due Date Tests › GA (no schedule) uses federal fallback` — pure function only | M | |
| D27 | (e) Quarterly state Q4 due in January next year, through the sync | PARTIAL | `… › NC quarterly last day: Q4 (Jan 31 Sunday) → Feb 1 Monday` — pure function only | M | |
| D28 | (a)(g) Employee moves states mid-quarter under a quarterly schedule | UNTESTED | | M | Two partial-quarter rows; never exercised. |
| D29 | (d) Pending row whose issued runs are later voided | UNTESTED | Sync iterates months that still have issued runs; an emptied month is never revisited | M | Needs R5's DB void today. |
| D30 | (a) Federal depositor schedule: semiweekly (lookback > $50k), $100k next-day, $2,500 quarterly | UNTESTED (no code path) | Federal is hard-coded monthly | **H** | 20 employees at ~$5k/mo exceed the $50k lookback; the app then shows wrong due dates. Scope decision for Neil. |
| D31 | Deposit detail breakdown (federal, state, quarterly) | TESTED | `deposits.test.ts › admin deposit detail endpoint (PAY-36)`; `PAY-13 … › GET /api/admin/tax-deposits/:id for a state row …` | L | |

## 4. Filings — 941, 940, W-2/W-3

| # | Scenario | Status | Evidence | Risk | Why |
|---|---|---|---|---|---|
| F1 | (e) 941 due dates incl. Q4 → Jan 31 next year | TESTED | `filings.test.ts › filingDueDate (PAY-10 domain rules)` | L | |
| F2 | 941 lines from issued runs; line 12 = liability | TESTED | `filings.test.ts › computeWorksheet › computes all lines …` | L | Expected via `exactLiability` (method note). |
| F3 | (d) 941 excludes draft and void runs | PARTIAL | `filings.test.ts › computeWorksheet › draft/void runs never count` — no void run is created | L | Same `status = 'issued'` filter as deposits. |
| F4 | (c) 941 sync idempotent; unfiled worksheet refreshes on a late run | TESTED | `filings.test.ts › syncFilings › is idempotent and refreshes the worksheet when more runs issue` | L | |
| F5 | (e) Q4 941 row created by the January sync of the next year | UNTESTED | Only Q1 is synced in tests | M | |
| F6 | Filed 941 never rewritten by sync | TESTED | `filings.test.ts › admin filing routes › marks a filing filed …` (final block) | L | Asserts with no new run added. |
| F7 | (d)(f) Filed 941 + late-issued run into that quarter → divergence surfaced | UNTESTED | `filing-recompute.test.ts` tampers the stored worksheet instead of issuing a run | **H** | Correct figure needs a 941-X; nothing flags it. |
| F8 | Filed worksheet recompute: preview, correct, audit, re-run | TESTED | `filing-recompute.test.ts` (all) | L | |
| F9 | (f) Line 13 counts only `deposited` federal rows; pending/overdue excluded | PARTIAL | `filings.test.ts › adds an adjustment; its payment feeds worksheet line 13` inserts deposited rows only | M | Status filter never tested against pending/overdue rows in the quarter. |
| F10 | Adjustments feed line 13; update/delete re-render | TESTED | `filings.test.ts › adds an adjustment …`, `updates and deletes adjustments …` | L | |
| F11 | Line 7 admin override survives refresh | TESTED | `filings.test.ts › sets line 7 fractions-of-cents …` | L | |
| F12 | (e) Additional Medicare on line 5d | UNTESTED | `const line5d = 0; // … zero at current salaries`; line 5c wages = Medicare tax ÷ 2.9% then overstates wages | **H** | Any employee over $200k YTD makes lines 5c/5d wrong on a filed form. |
| F13 | (e) Line 5a SS wages when an employee crosses the SS base | UNTESTED | | M | |
| F14 | Line 1 headcount on the pay period including the 12th of the quarter's LAST month | UNTESTED | Code uses the 12th of the FIRST month (`periodKeyDay = firstDay…12`); Form 941 line 1 asks for Mar/Jun/Sep/Dec 12 | M | Fixtures have constant headcount, so the wrong month is invisible. |
| F15 | Line 16 monthly split + de minimis flag | TESTED | `filings.test.ts › computeWorksheet › computes all lines …` | L | Prior-quarter de minimis rule not modeled (L). |
| F16 | (c) Filing reminders: offsets, dedupe, none once filed | TESTED | `filings.test.ts › sendFilingReminders`; `in-year-940.test.ts › reminders key off due-date proximity …` | L | |
| F17 | 940 lines, $7,000 cap, rounding delta, $500 crossing incl. Q4 → next year | TESTED | `annual-forms.test.ts › compute940Worksheet › computes all lines …`; `in-year-940.test.ts › deposit section … a Q4 crossing lands in the following year` | L | |
| F18 | 940 credit per year (0 / 5.1% / 5.4%) | TESTED | `futa-credit.test.ts › 940 worksheet — configured SUTA credit` (4 tests) | L | |
| F19 | (a) FUTA credit changed mid-year after runs issued | UNTESTED | `futa-credit.test.ts › W-2 figures and the export payload are identical across a credit change` flips and restores before asserting | **H** | Line 8 applies the year-end rate to all wages; `balanceDue` = entries at the old rate. |
| F20 | (b) Upgrade: `suta_credit_rate` added with DEFAULT 0.054 over rows whose `futa_rate` is 0.06 | UNTESTED | `0015_strange_wendigo.sql`; no backfill from `futa_rate` | **H** | 940 at 0.6% while entries accrued at 6% (the SOULT IO shape); cross-ref E14. |
| F21 | (e) In-year 940 `not_started` → `ready` on Jan 1; filed untouched | TESTED | `in-year-940.test.ts › transitions not_started → ready on Jan 1 …` | L | |
| F22 | (c) Annual sync idempotent; late run refreshes; filed frozen | TESTED | `annual-forms.test.ts › syncAnnualFilings` (3 tests) | L | |
| F23 | W-2 six boxes = entries; contractors excluded | TESTED | `annual-forms.test.ts › W-2 figures and the W-3 worksheet › computes the six boxes …` | L | |
| F24 | (e) W-2 boxes 3/4 when an employee crosses the SS base | UNTESTED | fixture comment "nobody here reaches it" | M | |
| F25 | (g) W-2 state boxes 15–17 for state-withheld employees | UNTESTED (no code path) | `w2.ts` "blank boxes stay blank (D5: boxes 7–14, state/local)"; state withholding exists since PAY-13 | **H** | W-2 omits state wages/tax that was withheld. Decision D5 predates PAY-13. |
| F26 | W-2 availability gate + one notice per year | TESTED | `annual-forms.test.ts › enforces the availability gate …`, `sendW2AvailableNotices` | L | |
| F27 | (a) Employee's `employment_type` changes after W-2 wages were paid | UNTESTED | `perEmployeeSums` joins on the current type | L | |

## 5. Contractors — invoices and recurring templates

| # | Scenario | Status | Evidence | Risk | Why |
|---|---|---|---|---|---|
| C1 | Invoice submitted → approved → paid; server transitions | TESTED | `contractors.test.ts › invoice workflow` (2 tests) | L | |
| C2 | Backup withholding exactly 24% | TESTED | `contractors.test.ts › withholds exactly 24% when backup_withholding is set` | L | |
| C3 | (e) Payment gate: missing form, expired at pay date | TESTED | `contractors.test.ts › payment gate (D17)` | L | |
| C4 | (a) W-8 expiry recomputes when form/date changes | TESTED | `contractors.test.ts › w9 has no expiry; expiry recomputes …` | L | |
| C5 | (a) Dated 1099 threshold ($600/$2,000) + 1099-K carve-out | TESTED | `contractors.test.ts › year-end reporting › applies the dated threshold …` | L | |
| C6 | (e) Year attribution of a Dec 31 / Jan 1 payment | PARTIAL | `qa-seed.test.ts › January boundary › still gives Dave a paid invoice …` (seed persona) | L | |
| C7 | (d) Void a PAID invoice → excluded from 1099 and 945 totals | UNTESTED | `voidInvoice` keeps the payment; `yearEndSummary` filters `status <> 'void'`; the void test never reads year-end | M | |
| C8 | (a) Backup-withholding flag toggled mid-year | UNTESTED | | L | Per-payment calc; totals mix. |
| C9 | Non-USD invoice/payment summed into 1099 totals | UNTESTED | `yearEndSummary` sums `amount`, ignores `exchangeRate`/`currency` | M | Foreign-currency payments misstate reportable totals. |
| C10 | 1099-NEC PDF figures (box 1, box 4) | PARTIAL | `contractors.test.ts › generates the 1099-NEC PDF on demand …` asserts `%PDF-` header only | M | |
| C11 | (c) W-8 expiry notices idempotent | TESTED | `contractors.test.ts › W-8 expiry notifications` | L | |
| C12 | Contractor can never produce a payroll run | TESTED | `contractors.test.ts › payroll generator isolation` | L | |
| C13 | (c)(a) Recurring: last_day/fixed, double tick, starts_on, ends_on, pause/resume, edits affect future only | TESTED | `recurring-invoices.test.ts › generation tick`, `D25 lifecycle`, `template CRUD` | L | |
| C14 | (c) Tick missed on the invoice day → no catch-up | UNTESTED | `generateRecurringInvoices` requires `invoiceDateFor(…) === today` | M | Contractor invoice silently never created for that month. |
| C15 | (a) Pause spanning the invoice date, then resume | PARTIAL | `recurring-invoices.test.ts › pause stops generation; resume restarts it` | L | Does not assert the skipped period stays skipped. |
| C16 | (c) Payment-due sweep once per day; not for paid/submitted | TESTED | `recurring-invoices.test.ts › payment-due sweep (spec 12 §3)` | L | December → January period lookup not exercised (L). |

## 6. Calendar projections — `apps/server/src/calendar/service.ts`

| # | Scenario | Status | Evidence | Risk | Why |
|---|---|---|---|---|---|
| K1 | Scheduled paydays (company + per-employee override) | TESTED | `calendar.test.ts › projects the current pay schedules …` | L | |
| K2 | Run paydays, void excluded | TESTED | `calendar.test.ts › aggregates March 2026 across every source …` | L | |
| K3 | Deposit due / made events | TESTED | same test | L | |
| K4 | (g) State and quarterly deposit rows labelled "941 deposit due — <Month>" | UNTESTED | `depositEvents` label is fixed | L | |
| K5 | Upcoming deposits not yet synced are not projected | UNTESTED (no code path) | only existing `tax_deposits` rows | M | Next month's obligation is absent until a run issues. |
| K6 | Projected 941 generates/due (future, past, with row) | TESTED | `calendar.test.ts › projected filing events` (4 tests) | L | |
| K7 | (e) Projected Q4 941 due in January of the next year | UNTESTED | | L | |
| K8 | Projected W-2/W-3 and 940 | TESTED | `calendar.test.ts › Year with issued runs and no w2_w3 row …`, `… no 940 row …` | L | |
| K9 | (h) Projection uses wall-clock UTC `today`, not injectable | PARTIAL | tests derive `year` from `new Date()` | L | Suite behaviour depends on the run date. |
| K10 | Contractor invoice/payment projection across Dec → Jan | UNTESTED | `contractorEvents` prevMonth branch | L | |

## 7. Cross-cutting — timezone (h)

Not counted above (one finding per module would repeat).

| # | Scenario | Status | Evidence | Risk | Why |
|---|---|---|---|---|---|
| T1 | Deposit/filing `today` = UTC date while cron runs in `APP_TZ` (default Europe/Madrid) | UNTESTED | `todayIso()` in `deposits/service.ts`, `filings/shared.ts`, `contractors/*.ts` | L | Safe at the 07:41 tick; a retry after local midnight vs UTC flips a day early/late. |
| T2 | Draft tick month from container-local `new Date().getMonth()` | UNTESTED | `scheduler.ts` `currentPeriod()` | L | |
| T3 | Admin default `effectiveFrom` = UTC today | UNTESTED | `admin-employees.ts` | L | Evening US-time edits date tomorrow. |
| T4 | `nextUnrunPeriodStart` with no runs uses UTC month | UNTESTED | `change-requests/service.ts` | L | |

No test in the repo sets `APP_TZ`, `TZ`, or fake timers.

---

## Top 20 gaps (ranked)

Ranked by money at risk × likelihood for a live customer (customer zero first).

1. **D23 schedule loaded after monthly rows (PAY-91 class)** — Test: issue CA Jul+Aug runs with no schedule, sync, seed the quarterly CA schedule, sync again → expect exactly one CA 2026-07-01 row = Jul+Aug(+Sep) sum, due 2026-11-02, and no pending Aug row.
2. **D24 due date not recomputed after schedule change** — Test: create a pending IL monthly row, change IL `due_day`/frequency, sync → expect `due_date` updated and the overdue flip keyed to the new date.
3. **D25 schedule year rollover** — Test: CA quarterly in 2026, issue a Jan 2027 CA run with no 2027 schedule row → expect a loud error or the prior year's schedule carried forward, never a silent monthly row.
4. **R11 W-4 exempt lapse** — Test: exempt W-4 with `renewalDeadline 2027-02-16`, generate Feb and Mar 2027 → expect Feb $0 federal, Mar withheld per brackets.
5. **R13 stale draft after a config change** — Test: generate a draft, then PUT a new work state / compensation / tax table effective that period, approve + issue → expect issue refused or the draft regenerated with the new inputs.
6. **D7 late run into an overdue month** — Test: flip March overdue, issue a late March run, sync → expect the overdue row's amount (or a new additional-due row) to include the late run.
7. **D9 deposited-month shortfall** — Test: mark July deposited, issue another July run, sync → expect a visible shortfall (new row or flag) equal to the new run's five categories.
8. **R14 stale prior-YTD draft issuable** — Test: draft Feb before Jan issues, issue Jan, then try to approve/issue the stale Feb draft → expect 409 (or auto-regeneration) and correct SS/FUTA bases.
9. **F19 FUTA credit changed mid-year** — Test: issue Jan–Mar at 0 credit, PUT credit 5.4%, issue Apr → expect 940 line 8 and `balanceDue` to reconcile with entries (or the change refused once runs exist).
10. **F7 filed 941 + late run** — Test: file Q1, issue a late March run, sync → expect the filing flagged as diverged (recompute preview non-empty) and the deposit row updated.
11. **F12 941 Additional Medicare** — Test: one employee crossing $200k in the quarter → expect line 5d = 0.9% × excess wages and line 5c wages = Medicare wages, not tax ÷ 2.9%.
12. **F20 upgrade default SUTA credit** — Test: migrate a `tax_config` row with `futa_rate 0.06` through 0015 → expect `suta_credit_rate 0` (backfilled from `futa_rate`) and 940 line 8 = entries.
13. **E3 W-4 Step 2 checkbox** — Test: $5,000/mo single with `multipleJobs=true` → expect the Pub 15-T Step 2 withholding figure, not the standard one.
14. **F25 W-2 state boxes** — Test: IL-withheld employee's W-2 → expect boxes 15–17 (IL, state wages, IL tax = sum of `state_withholding` entries).
15. **R9 mid-month compensation change** — Test: $4,000 → $6,000 effective the 15th, generate that month → expect the prorated gross (or the change rejected until the next period start).
16. **D30 federal semiweekly depositor** — Test: lookback liability > $50k → expect semiweekly due dates (Wed/Fri rule), or a documented refusal to track.
17. **F9 line 13 status filter** — Test: Q1 with one deposited, one pending and one overdue federal row → expect line 13 = deposited only.
18. **F14 941 line 1 month** — Test: employee hired in March of Q1 → expect line 1 counts them (Mar 12 period); employee terminated in January → not counted.
19. **R18 missing new-year tax tables** — Test: scheduler path for January with no `tax_config` for the year → expect an admin notification, not a silent `skipped`.
20. **C7 void of a paid contractor invoice** — Test: pay then void an invoice → expect year-end reportable, gross and backup-withholding totals to drop by that payment.

Also worth a ticket, outside the top 20: D15 missed reminder day (catch-up rule), C14 missed recurring tick
(catch-up rule), R16/F13/F24 SS base crossed through issued runs into 941/W-2, C9 non-USD 1099 totals.

## Items that are decisions, not only tests (for Neil)

- R6 correction/adjustment runs for issued payroll (no code path).
- D30 federal semiweekly / next-day depositor rules (not modeled).
- F25 W-2 state boxes (D5 leaves them blank; state withholding has existed since PAY-13).
- R9 proration on mid-month compensation changes.
