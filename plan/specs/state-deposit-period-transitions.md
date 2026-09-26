# Spec 23 — State deposit period transitions (monthly ↔ quarterly)

Status: `DRAFT 2026-09-26 — awaiting owner sign-off` · Ticket: PAY-91 · Depends on:
PAY-47 (state deposit rows), PAY-48 (per-state schedules, migration 0021), Spec 1
(data model) · Gates: `state-local-payroll-sme` + `payroll-calc-auditor` (owner decision
2026-09-26, brain #3871), `security-privacy-reviewer` (light: no new PII)

## 1. Problem

`tax_deposits` has one row per `(jurisdiction, period_start)`. PAY-48 made quarterly
states (CA, NC, MD, NY) key their deposit on the first day of the quarter. That date is
also the key of the month-1 row written before the schedule existed (v1.24 wrote every
state row monthly; the schedule table arrives empty in 0021 and is filled by the hand-run
seed). When a schedule turns a state quarterly:

- `syncStateDepositsForPeriod` finds the month-1 row and reuses it as the quarter row.
  The month-2 and month-3 rows stay live next to it. **Double count.**
- If month 1 is already `deposited` (or `overdue`), the quarter amount is never written,
  because only `pending` rows are recomputed. **Understatement.**
- `periodKind` is derived at read time from today's schedule, so the list, detail view and
  reminders relabel old monthly rows as quarters.

The reverse move (quarterly → monthly) has no handling at all.

Verified on `origin/main` c45c7b5: `apps/server/src/deposits/service.ts`
(`syncDeposits`, `syncStateDepositsForPeriod`, `statePeriodStartFor`, `stateDueDateFor`,
`periodKindForDeposit`, `sendDepositReminders`, `getDepositDetail`, `listDeposits`,
`markDeposited`), `packages/db/src/schema.ts` (`taxDeposits`, `stateDepositSchedules`),
`apps/server/src/calendar/service.ts` (`depositEvents`), `apps/server/src/filings/service.ts`
(941 line 13 reads federal `deposited` rows only), `apps/server/src/deposits/attachments.ts`.
`routes/export.ts` does not read `tax_deposits`.

Prod is pinned to v1.24.0 in `nsoult-agentic/stack-payroll` `prod/docker-compose.yml`, and
seeds run by hand. The bug fires only once `state_deposit_schedules` has rows. See §11 Q1.

## 2. Domain rules (state-local-payroll-sme, 2026; requirements, not proposals)

- **R1** Quarterly = one row per state per quarter covering 3 months, due on the schedule's
  date. The schedule and the quarter are taken from the **pay date** (the date wages are
  paid), not the pay period: a Dec 20–31 period paid Jan 5 belongs to January of the next
  year (state SME, 2026-09-26). Quarters never cross a year; December never merges with
  the next January. Test: a period that crosses the year and is paid in January.
- **R2 (Case A)** All monthly rows in the quarter are pending/overdue → merge into one
  quarter row. The amount is **recomputed from the quarter's issued runs**, not by adding
  up the old rows. Due date comes from the schedule; status comes from the new due date.
  The replaced rows are kept for audit and are never counted.
- **R3 (Case B)** Some monthly rows are deposited → never change or delete a deposited row.
  Quarter row amount = quarter liability − deposited amounts for that state and quarter,
  floored at 0.00. Flag an overpayment when deposits exceed the liability. The UI lists the
  credited payments and a note to confirm with the state that the monthly payments were
  applied to the quarter.
- **R4 (Case C)** A quarter row exists and the schedule becomes monthly. A pending/overdue
  quarter row is replaced by per-month rows with monthly due dates; each month keeps its own
  date even if past (→ overdue; show it, no penalty maths). A deposited quarter row is kept
  and applied to the months earliest-first; month rows are created only for the remainder.
- **R5** IL (monthly) needs no merging. No negative amounts, ever.

## 3. Decisions

### D1 — Data model: stored `period_kind` + `superseded` status. No `period_end`, no FK.

| Option | For | Against |
|---|---|---|
| (a) `period_kind` + `period_end` + `superseded` + `superseded_by` FK | fully explicit | `period_end` is derivable from start + kind; `superseded_by` cannot express Case C (one quarter row → up to three month rows) |
| **(b) `period_kind` + `superseded` status + `superseded_at`** | smallest; covers A, B, C; replacement is derivable (the live rows of the same state and quarter); the audit event records ids | replacement link is a query, not a column |
| (c) delete replaced rows | simplest | breaks R2 (keep for audit); loses reminder and attachment history |
| (d) store credit/overpayment columns on the row | row is self-describing | Case C overpayment has no receiving row (all months covered); two stored copies of one derived figure; more to migrate |

**Chosen: (b).** Credits and overpayment are **derived**, by the same pure planner the
sync uses (D3), so the sync and the API can never disagree.

"Live row" = `status <> 'superseded'`. Every reader in §5 uses this.

### D2 — Unique key: partial unique index on live rows, kind included.

`UNIQUE (jurisdiction, period_start, period_kind) WHERE status <> 'superseded'`.
- `period_kind` is in the key because Case B keeps a live deposited July month row and a
  live Q3 quarter row, both starting 2026-07-01.
- The `WHERE` clause lets any number of superseded rows share a key (a state that flips
  quarterly → monthly → quarterly).
- "No live month row overlaps a live pending quarter row" cannot be a plain unique index
  (it needs `btree_gist` and an exclusion constraint, and creating that extension needs a
  superuser, which breaks `compose.example.yml` installs under D9). It is an application
  invariant instead: the planner guarantees it, and every scenario test asserts it (§8, INV).

### D3 — One pure planner per (state, year, quarter) unit.

`apps/server/src/deposits/transition.ts` exports `planStateQuarter(input): QuarterPlan`. It is
pure (no DB, no clock: `today` is an input) and works in **integer cents**.
`syncDeposits` loads inputs, calls it, and applies the plan in one transaction. The detail
API calls it read-only to get credits and overpayment. PAY-93 mutation testing targets this
file.

### D4 — Recompute state rows that are pending **and overdue**; federal unchanged.

Today only `pending` rows are recomputed, so a late run or a void never reaches an overdue
row. For **state** rows the planner recomputes amount, due date and status for every live
row that is not deposited. Federal behaviour stays as it is (out of scope; see §10).

### D5 — Zero-amount live rows mean "nothing left to pay".

Case B can produce a quarter row of 0.00, and so can a void. Such a row stays `pending`,
never flips to `overdue`, gets no reminder, and cannot be marked deposited (409). This
applies to federal rows too; a 0.00 federal row has nothing to pay either.

### D6 — Allocation of deposits (credits), used in Case B and Case C.

Per unit, in cents, with `L[m]` the liability of month m (from issued runs), `own[m]` the
sum of live **deposited month rows** for m, and `Q` the live **deposited quarter row** amount
(0 if none):
1. Each deposited month row pays its own month first: `need[m] = max(0, L[m] − own[m])`,
   `excess[m] = max(0, own[m] − L[m])`.
2. Pool = `Q + Σ excess[m]`. Apply the pool to `need[m]` in month order (earliest-first):
   `applied[m] = min(pool, need[m])`, `pool −= applied[m]`, `rem[m] = need[m] − applied[m]`.
3. `overpaid = pool` left after month 3 (≥ 0).
Step 1 matters for v1.25 data: a row v1.25 wrote as a quarter row is backfilled as
`month` (D7); if its amount covers the whole quarter, the excess must reach months 2–3,
or Case C would ask for the money a second time (scenario T19).

Quarterly total: `amount = max(0, ΣL − ΣD)` where `ΣD` = all live deposited rows in the
unit. This is the same figure as `Σ rem[m]` (proof by the allocation), and
`overpaid = max(0, ΣD − ΣL)`.

### D7 — Backfill: every existing row becomes `period_kind = 'month'`, amounts untouched.

`ADD COLUMN ... DEFAULT 'month' NOT NULL` does this with no row rewrite (PG 11+ fast
default; prod runs postgres 16.15). Rows that v1.25 wrote at a quarter start with a
quarter amount are therefore labelled as their first month. Money stays correct through D6
step 1. The only visible effect is the label ("July 2026" instead of "Q3 2026") on such a
row. Prod never ran v1.25, so prod has no such rows; QA and self-hosted installs may.

## 4. Data model — migration `0022_<drizzle-generated>.sql`

Schema (`packages/db/src/schema.ts`, `taxDeposits`):

```ts
periodKind: text("period_kind").notNull().default("month"),       // 'month' | 'quarter'
supersededAt: timestamp("superseded_at", { withTimezone: true }), // set iff status='superseded'
// constraints:
uniqueIndex("tax_deposits_live_period_uniq")
  .on(t.jurisdiction, t.periodStart, t.periodKind)
  .where(sql`${t.status} <> 'superseded'`),
check("tax_deposits_status_check",
  sql`${t.status} IN ('pending','deposited','overdue','superseded')`),
check("tax_deposits_period_kind_check", sql`${t.periodKind} IN ('month','quarter')`),
check("tax_deposits_quarter_start_check",
  sql`${t.periodKind} = 'month' OR extract(month from ${t.periodStart}) IN (1,4,7,10)`),
check("tax_deposits_federal_month_check",
  sql`${t.jurisdiction} <> 'federal' OR ${t.periodKind} = 'month'`),
check("tax_deposits_superseded_check",
  sql`(${t.status} = 'superseded') = (${t.supersededAt} IS NOT NULL)
      AND (${t.status} <> 'superseded' OR ${t.depositedOn} IS NULL)`),
check("tax_deposits_amount_nonneg_check", sql`${t.amount} >= 0`),
```

The existing `unique("tax_deposits_jurisdiction_period_uniq")` is dropped. Generated SQL,
hand-reviewed (drizzle-kit ~0.31.4 emits partial unique indexes, as
`payroll_runs_employee_period_start_uniq` already shows):

```sql
ALTER TABLE "tax_deposits" ADD COLUMN "period_kind" text DEFAULT 'month' NOT NULL;
ALTER TABLE "tax_deposits" ADD COLUMN "superseded_at" timestamp with time zone;
ALTER TABLE "tax_deposits" DROP CONSTRAINT "tax_deposits_status_check";
ALTER TABLE "tax_deposits" ADD CONSTRAINT "tax_deposits_status_check" CHECK (...);  -- 4 values
ALTER TABLE "tax_deposits" ADD CONSTRAINT ... period_kind / quarter_start / federal_month /
  superseded / amount_nonneg checks;
ALTER TABLE "tax_deposits" DROP CONSTRAINT "tax_deposits_jurisdiction_period_uniq";
CREATE UNIQUE INDEX "tax_deposits_live_period_uniq" ON "tax_deposits"
  ("jurisdiction","period_start","period_kind") WHERE "status" <> 'superseded';
```

**Safety on live prod data.** Additive, and no existing value changes. Every existing row
satisfies every new check: all rows are `month` after the default, none is superseded, and
the new index is wider than the old unique constraint. `amount_nonneg` fails the migration
(the migration runs in one transaction, so nothing changes and the old image keeps serving)
if a negative amount exists. Preflight, read-only, run by infra before the deploy:
`SELECT count(*) FROM tax_deposits WHERE amount < 0;` → expect 0. The table is small; the
`ACCESS EXCLUSIVE` lock is held for milliseconds.

**Old code on the new schema.** v1.24/v1.25 use select-then-insert, not `ON CONFLICT` on
the dropped constraint name, so they keep working during the migrate → app handover.

## 5. What every reader must do with superseded rows

| Reader (file → function) | Today | Required |
|---|---|---|
| `deposits/service.ts` `syncFederalDeposit` lookup | `(federal, period_start)` | add `period_kind='month' AND status<>'superseded'` (defensive; federal is never superseded) |
| state sync | `(state, period_start)` `limit(1)` | replaced by the planner over **live** rows of the unit |
| overdue flip in `syncDeposits` | `status='pending' AND due<today` | add `AND amount > 0` (superseded is already excluded by `status='pending'`) |
| `listDeposits` (`GET /api/admin/tax-deposits`) | all rows | always `status<>'superseded'`; `periodKind` from the column. Status filter enum unchanged |
| `getDepositDetail` (`GET /:id`) | kind from schedule | kind from the column; a superseded row is returned (audit) with `replacedBy` (§7) |
| `markDeposited` | rejects `deposited` | also rejects `superseded` and `amount = 0` → 409 `invalid_transition` |
| `sendDepositReminders` | `status <> 'deposited'` | `status IN ('pending','overdue') AND amount > 0`; label from the column |
| `calendar/service.ts` deposit due events | all rows by `due_date` | `status<>'superseded'`; label fix (§7) |
| calendar deposit made events | `deposited_on IS NOT NULL` | unchanged (the check constraint keeps superseded rows' `deposited_on` NULL) |
| `filings/service.ts` 941 line 13 | `federal AND deposited` | unchanged; regression test T28 |
| `deposits/attachments.ts` add | any row | reject upload on a superseded row (409); list and read unchanged |
| `periodKindForDeposit` | derives kind from today's schedule | deleted; callers read `period_kind`. Its unit test (deposits.test.ts "returns 'month' for federal, 'quarter' for quarterly schedules…") moves to the planner |

Export one SQL fragment `liveDeposit = sql\`${taxDeposits.status} <> 'superseded'\`` from
`deposits/service.ts`. Any future total or sum over `tax_deposits` must use it (code-review
checklist item for this area).

## 6. Sync algorithm

```
syncDeposits(deps, { today }):
  federal loop: unchanged, plus the §5 lookup filter
  BEGIN; SELECT pg_advisory_xact_lock(hashtext('tax_deposits_state_sync'))
  schedules := load all state_deposit_schedules keyed "STATE:YEAR"
  units := DISTINCT (state, year, quarter) FROM
             issued runs with state_withholding entries, workState = runSnapshot.inputs.state.workState,
               year/quarter of pay_date
           ∪ live state rows (period_start → year, quarter)
  for each unit (state S, year Y, quarter q):            -- q never crosses Y (R1)
     input := {
       schedule: schedules["S:Y"] ?? null,                -- lookup by pay-date year (R1)
       L[1..3]:  cents of issued-run state_withholding for S per month of q (0 if none),
       live:     live rows of S with period_start in q (id, kind, start, cents, status, due),
       today }
     plan := planStateQuarter(input)
     apply plan: UPDATE ... SET status='superseded', superseded_at=now()
                   WHERE id IN plan.supersede AND status IN ('pending','overdue')   -- guard: never a deposited row
                 then UPDATE changed live rows; INSERT new rows (created_by='scheduler')
     if plan.supersede ≠ ∅: INSERT audit_events(action='tax_deposit.period_transition',
         entity='tax_deposit', entity_id="S:Y-Qq", actor 'scheduler',
         before={rows}, after={rows, liabilityCents, creditsCents, overpaidCents})
  COMMIT
  global overdue flip (pending, amount>0, due<today)

planStateQuarter({ schedule, L, live, today }):
  months := [first..first+2] of q; ΣL := L1+L2+L3
  dep     := live rows with status='deposited'                    -- never touched
  open    := live rows with status in (pending, overdue)
  alloc   := allocate(L, dep)                                     -- D6: rem[m], credits, overpaid
  statusOf(due, cents) := cents = 0 ? 'pending' : (due < today ? 'overdue' : 'pending')

  if schedule?.frequency = 'quarterly':
     supersede := open rows with kind='month'
     if dep has a kind='quarter' row:                             -- quarter already paid
        supersede ∪= open kind='quarter' rows (cannot exist under the index; defensive)
        target := none                                            -- top-up after a quarter deposit: §10
     else if ΣL = 0 and dep = ∅ and open = ∅: nothing
     else:
        cents := max(0, ΣL − Σ dep.cents)                          -- = Σ rem[m]
        due   := stateDueDateFor(schedule, Y, quarterStart)
        target quarter row: reuse the open kind='quarter' row if any, else insert;
        set (cents, due, statusOf(due, cents)) — write only if a field differs
  else:                                                            -- monthly, or no schedule (fallback)
     supersede := open rows with kind='quarter'
     for m in months:
        cents := alloc.rem[m]
        row   := open kind='month' row for m
        due   := stateDueDateFor(schedule, Y, monthStart(m))      -- null → federal convention
        if row: set (cents, due, statusOf(due, cents)) — write only if a field differs
        else if cents > 0 and (no deposited month row for m): insert month row
  return { supersede, updates, inserts, liabilityCents: ΣL, credits: alloc.credits, overpaidCents: alloc.overpaid }
```

**Idempotency.** After one apply: quarterly units hold exactly one live non-deposited
quarter row with the planned values, and no open month rows; monthly units hold no open
quarter rows and month rows with the planned values. The planner's output for that state is
the empty plan, and "write only if a field differs" means zero UPDATEs. The advisory lock
serialises the daily tick, `seed-qa` and `e2e/serve` calls. The partial unique index is the
second guard. `SyncResult` gains `superseded: number`; the scheduler log line includes it.

**Money.** Numbers from `NUMERIC(12,2)` are parsed to cents by exact string parsing
(`parseCents("123.45") → 12345`, rejects anything else), and written back with
`formatCents`. Both go in `@payroll/shared/money` with unit tests. No floats on this path.

**Unchanged for monthly states.** An IL unit with no quarter rows plans exactly today's
rows: the same amounts, and due dates on the 15th with a weekend roll. T20 and T29 prove it.

## 7. API and UI (minimal)

`TaxDepositRow` (server and `apps/web/src/lib/api.ts`): `status` gains `'superseded'`;
`periodKind` now comes from the column; adds `supersededAt: string | null`.

`GET /api/admin/tax-deposits/:id` adds (all money as `"0.00"` strings, like today):
```ts
liability: string;            // the unit's liability for this row's period (month or quarter)
credits: { depositId: number; periodStart: string; periodKind: "month"|"quarter";
           depositedOn: string; amount: string; applied: string }[];   // deposited rows counted against this row
overpaid: string;             // unit overpayment (D6); "0.00" normally
replacedBy: { id: number; periodStart: string; periodKind: "month"|"quarter" }[]; // superseded rows only
```
For a live pending/overdue row: `amount = max(0, liability − Σ applied)`. The detail view's
Breakdown total stays the liability; the header shows the amount left to pay.

List view: a 0.00 live row shows the chip "Nothing left to pay" instead of Pending, and
has no "Mark as deposited" action. A row with `overpaid > 0` shows an "Overpaid" chip.

Calendar (`calendar/service.ts`): state rows are labelled `"{STATE} deposit due — {label}"`
and `"{STATE} deposit made — {label}"`, with `{label}` built from `period_kind` (`Q3 2026` or
`July 2026`). Federal keeps `941 deposit due — …`. Today state rows are wrongly labelled
"941".

**Copy for `product-ux-designer`** (customer-facing, plain and friendly; the designer owns
the final wording; no tax advice):
1. Credited payments card title: "Payments already made for this quarter"
2. Card line: "{Month Year} payment on {date}: {amount}"; footer "Left to pay: {amount}"
3. Note, Case B: "{State} now takes one payment per quarter. Check with {State} that your
   monthly payments were applied to {Q3 2026}."
4. Overpaid chip: "Overpaid"; note: "You have paid {amount} more than {period}'s
   withholding. Ask {State} how they want to handle the extra amount."
5. Zero row chip: "Nothing left to pay"
6. Superseded row banner, to quarterly: "Replaced. {State} changed to quarterly payments,
   so this month is now part of the {Q3 2026} deposit." Link: "View {Q3 2026} deposit"
7. Superseded row banner, to monthly: "Replaced. {State} changed to monthly payments, so
   this quarter is now split into monthly deposits."
8. Month row credited by a quarter payment (Case C): "Counted toward this month: {amount}."
   Note, Case C: "{State} now takes monthly payments. Check with {State} how your {Q3 2026}
   payment was applied to each month."
9. 409 on marking a superseded or 0.00 row: "This deposit has nothing left to record."

## 8. Scenario test matrix (GUARDRAILS "Scenario coverage", classes a–g)

The expected values were computed by hand from R1–R5 and D6, not by running the code. The
weekdays were checked against the calendar (2026-08-15 Sat, 2026-10-31 Sat, 2026-09-20 Sun,
2027-01-31 Sun). Due dates roll weekends only; holidays do not roll (V1, PAY-48 convention).

**Fixture F (CA, synthetic).** Employee "Ada Test", work state CA. Issued runs:
R-Jul (pay 2026-07-15) SWH 12,345¢; R-Aug (2026-08-14) 12,345¢; R-Sep (2026-09-15)
13,000¢. Monthly due dates (fallback, or monthly with dueDay 15): Jul → 2026-08-17,
Aug → 2026-09-15, Sep → 2026-10-15. CA-2026 quarterly (dueDay null) → Q3 due
**2026-11-02** (Oct 31 is a Saturday). "Seed" means inserting the 2026 schedule rows the way
`seedStateTaxes` does. Amounts are in cents; M = month row, Q = quarter row, SUP = superseded.

**INV** (asserted after every row below): no negative amount; at most one live
non-deposited row per unit under a quarterly schedule; no live open month row overlaps a
live open quarter row; superseded rows keep their amount; deposited rows are byte-identical
to their pre-sync state; Σ live amounts per unit = max(ΣL, ΣD).

| # | Class | Setup | Action | Expected rows (kind period · amount · due · status) |
|---|---|---|---|---|
| T01 | a,f | F with R-Jul, R-Aug only. Rows M Jul 12,345 due 08-17 overdue; M Aug 12,345 due 09-15 pending. Seed CA quarterly | sync today 2026-09-10 | M Jul 12,345 SUP; M Aug 12,345 SUP; **Q 2026-07-01 24,690 · 2026-11-02 · pending**. Live Σ 24,690 |
| T02 | a | T01 end + R-Sep issued | sync 2026-10-05 | Q3 37,690 · 11-02 · pending; no M Sep row. Live Σ 37,690 |
| T03 | a,f (B, m1 deposited) | F all runs. M Jul 12,345 **deposited** 2026-08-14; M Aug 12,345 overdue; M Sep 13,000 pending. Seed | sync 2026-10-01 | M Jul 12,345 deposited (unchanged); M Aug, M Sep SUP; **Q3 25,345 · 11-02 · pending**; credits [Jul 12,345 applied 12,345]; overpaid 0. Live Σ 37,690 |
| T04 | a,d,f (B, m1–2 deposited, overpaid) | F R-Jul, R-Aug. M Jul 12,345 deposited 08-14; M Aug 12,345 deposited 09-14. Then R-Aug set to void (DB; the immutability trigger allows issued→void) and R-Aug2 (pay 2026-08-28) issued SWH 2,000. Seed | sync 2026-09-20 | M Jul, M Aug deposited unchanged; **Q3 0 · 11-02 · pending** ("Nothing left to pay"); ΣL 14,345; credits Jul 12,345, Aug 12,345; **overpaid 10,345**. Live Σ 24,690 |
| T05 | d | T04 end + R-Sep 13,000 issued | sync 2026-10-01 | Q3 **2,655** · 11-02 · pending; overpaid 0 (ΣL 27,345 − 24,690) |
| T06 | f (B exact) | F R-Jul, R-Aug. M Jul, M Aug both deposited 12,345. Seed | sync 2026-09-20 | Q3 0 · 11-02 · pending; overpaid 0; no reminder on 10-28 or 11-02; mark-deposited → 409 |
| T07 | a,f (C pending) | F all runs, CA quarterly. Q3 37,690 · 11-02 · pending. Change CA-2026 to monthly dueDay 15 | sync 2026-10-05 | Q3 37,690 SUP; M Jul 12,345 · 2026-08-17 · **overdue**; M Aug 12,345 · 2026-09-15 · **overdue**; M Sep 13,000 · 2026-10-15 · pending. Live Σ 37,690 |
| T08 | a,d,f (C deposited, earliest-first) | CA quarterly, R-Jul, R-Aug; sync 09-01 → Q3 24,690; mark deposited 2026-09-05. Then off-cycle R-Aug-b (pay 2026-08-31) SWH 2,655 (Aug L = 15,000) and R-Sep 13,000 issued. Change CA to monthly dueDay 15 | sync 2026-10-05 | Q3 24,690 deposited (kept); no M Jul (covered); **M Aug 2,655 · 09-15 · overdue** (credit 12,345 applied); **M Sep 13,000 · 10-15 · pending**. Live Σ 40,345 = ΣL |
| T09 | d (C overpaid) | CA quarterly Q3 24,690 deposited (Jul+Aug). R-Aug voided; no Sep run. Change CA to monthly | sync 2026-10-05 | Q3 deposited kept; no month rows; detail of Q3: liability 12,345, **overpaid 12,345** |
| T10 | c | End state of each of T01–T09 | sync again, same `today`; and again with today+1 day | SyncResult all 0; rows deep-equal including `updated_at`; audit_events count unchanged; no email_outbox rows |
| T11 | c | T01 setup | two `syncDeposits` in parallel | exactly 1 live Q3 24,690, 2 SUP, no error |
| T12 | e | 4 employees, work states CA, NC, MD, NY; runs pay 2026-10-15, 11-13, 12-15, SWH 10,000 each per state. Seed 2026 schedules | sync 2026-12-20; then sync 2027-01-16 | Q 2026-10-01 30,000 per state: CA due **2027-02-01**, NC **2027-02-01**, MD **2027-01-15**, NY **2027-02-01** (Jan 31 is a Sunday); all pending. On 01-16: MD **overdue**, others pending. Variant: M Oct/Nov/Dec CA pending pre-exist → SUP, same Q4 row |
| T13 | e,g | T12 end + CA run pay 2027-01-15 SWH 10,000; **no CA-2027 schedule** | sync 2027-01-20 | CA Q4-2026 unchanged; **M 2027-01-01 10,000 · 2027-02-15 · pending** (fallback; Presidents' Day not rolled, V1). December not merged with January |
| T14 | e,a | T13 end + seed CA-2027 quarterly dueDay null | sync 2027-02-01 | M 2027-01 SUP; **Q 2027-01-01 10,000 · 2027-04-30 · pending**; Q4-2026 unchanged |
| T15 | e | CA quarterly; runs pay 2026-06-30 SWH 5,000 and 2026-07-01 SWH 7,000 | sync 2026-07-10 | Q 2026-04-01 5,000 · 2026-07-31 · pending; Q 2026-07-01 7,000 · 2026-11-02 · pending |
| T16 | b (v1.24 data) | DB migrated to 0021 only. Insert as v1.24 wrote: federal M Jul/Aug/Sep 57,376 deposited; CA M Jul 12,345 deposited 08-14 conf "SYN-0001"; M Aug 12,345 overdue; M Sep 13,000 pending; IL M Jul 5,000 pending due 08-17 | run migration 0022 | row count unchanged; every row `period_kind='month'`, `superseded_at` NULL; amount, status, due, deposited_on, confirmation, reminders_sent byte-identical; old constraint gone; partial index present |
| T17 | b | T16 end + runs for all fixture rows + seed 2026 schedules | sync 2026-10-01 | CA = T03 result (Q3 25,345 · 11-02); IL M Jul 5,000 · 08-17 · **overdue** (status recomputed); federal rows identical |
| T18 | b (v1.25 bug data) | Migrated to 0021, CA quarterly seeded. Rows as v1.25 left them: CA M Jul **37,690** · 08-17 · overdue (quarter amount written into the month-1 row); M Aug 12,345 · 09-15 · overdue; M Sep 13,000 · 10-15 · pending; F all runs | migrate 0022; sync 2026-10-01 | 3 × SUP (37,690 / 12,345 / 13,000 kept); **Q3 37,690 · 11-02 · pending**. Live Σ 37,690 (main shows 63,035) |
| T19 | b,a (v1.25 quarter-shaped row, then C) | NY quarterly; runs Bob (NY) SWH 8,000 in each of Jul/Aug/Sep. v1.25 wrote NY row start 2026-07-01, 24,000, due 11-02, **deposited** 2026-10-20 | migrate 0022 (→ kind month); sync 2026-10-25; then set NY-2026 monthly (dueDay null) and sync | After sync 1: M Jul 24,000 deposited kept; Q3 0 · 11-02 · pending; overpaid 0. After sync 2: Q3 0 SUP; **no Aug/Sep rows** (Jul excess 16,000 covers them, D6 step 1); overpaid 0 |
| T20 | g | Ada IL 5,000/mo, Bob NY 8,000/mo, Cy TX (no SWH), Jul–Sep runs (Sep pay 09-15). v1.24 rows: IL M Jul/Aug/Sep, NY M Jul/Aug/Sep pending; federal rows. Seed | sync 2026-09-20 | IL M Jul 5,000 · 08-17 · overdue; M Aug 5,000 · 09-15 · overdue; M Sep 5,000 · 10-15 · pending (no merge); NY 3 × SUP + **Q3 24,000 · 11-02 · pending**; no TX rows; federal identical |
| T21 | g,a | GA employee (no schedule) SWH 3,000 Jul; NY Q3 24,000 · 11-02 · pending (3 runs × 8,000). Delete the NY-2026 schedule row | sync 2026-10-01 | GA M Jul 3,000 · 08-17 · overdue; NY Q3 SUP; NY M Jul 8,000 · 08-17 · overdue; M Aug 8,000 · 09-15 · overdue; M Sep 8,000 · 10-15 · pending |
| T22 | d | T02 end (Q3 37,690 pending). Void R-Aug (DB), issue R-Aug2 SWH 11,000. Variant on T03 end | sync 2026-10-05 | Q3 **36,345**. Variant: Q3 **24,000** (36,345 − 12,345) |
| T23 | d,f | T02 end; void all three runs | sync 2026-11-03 | Q3 **0 · 11-02 · pending** (not overdue although the due date has passed); reminders on 11-02 → 0 sent |
| T24 | a | IL monthly dueDay 15; IL M Jul 5,000 deposited (due 08-17); M Aug 5,000 pending (due 09-15). Change IL-2026 dueDay to 20 | sync 2026-09-10 | M Jul unchanged 08-17; M Aug due **2026-09-21** (Sep 20 is a Sunday), pending |
| T25 | f | T03 end; offsets [5,0]; 1 admin | `sendDepositReminders` on 2026-10-10, 10-15, 10-28, 11-02; T06 end on 10-28 | 0, 0, 1 (subject has "Q3 2026", amount $253.45), 1; T06: 0 |
| T26 | f | T03 end | calendar Oct, Nov, Aug 2026 | Oct: no CA due event (SUP Sep row due 10-15 absent); Nov: "CA deposit due — Q3 2026" on 11-02 "$253.45 · pending"; Aug: "CA deposit made — July 2026" on 08-14 |
| T27 | f | T03 end | API: list; detail of SUP M Aug; POST deposit on SUP; POST deposit on T06 zero row; attachment upload on SUP | list excludes SUP (live rows only); detail 200 `status:'superseded'`, `replacedBy:[Q3]`; 409; 409; 409 |
| T28 | b | T16 federal rows + T18 CA rows, migrated + synced | 941 Q3 2026 worksheet | line 13 = 1,721.28 (3 × 573.76), same as before migration |
| T29 | b,g | `seed-qa` on an empty DB | existing qa-seed test | 20 federal + 20 IL rows, all `month`, amounts unchanged from main |

29 scenarios. T01–T09, T12–T15, T19, T21, T23 and T24 also run as **pure planner unit
tests** (inputs as literals, `today` injected). All run as integration tests in
`apps/server/test/deposit-transitions.test.ts` (T16–T18 use a
migrate-to-0021 → insert → migrate-0022 harness, extending `migrate-fixture.ts`). All data
is synthetic.

**Must fail first on main c45c7b5:** T01 (the overdue Jul row is not rewritten, so there
is no Q3 row at 24,690), T03 (the quarter amount is never written), T07, T08, T18
(double count), T19, T25 (reminder for a replaced row), T26 (the "941" label). T16, T28 and
T29 are guards that pass before and after.

## 9. PR decomposition (in order, each through the code-pipeline)

1. **PAY-91 PR-1 — schema + readers.** Migration 0022, schema, `parseCents`/`formatCents`,
   every §5 reader switched to stored `period_kind` and `liveDeposit`, `amount > 0` guards,
   `periodKindForDeposit` removed. Tests: T16, T25–T29, using superseded rows inserted
   directly. No change to sync behaviour.
2. **PAY-91 PR-2 — pure planner.** `deposits/transition.ts` (`planStateQuarter`, `allocate`)
   and the unit matrix. Gates: state-local-payroll-sme and payroll-calc-auditor (the
   auditor recomputes §8 independently).
3. **PAY-91 PR-3 — sync wiring.** `syncDeposits` over units, advisory lock, apply,
   `tax_deposit.period_transition` audit event, `SyncResult.superseded`. The full integration
   matrix. Same two SME gates.
4. **PAY-91 PR-4 — API + UI.** Detail fields (§7), list chips, calendar labels, copy from
   product-ux-designer, one e2e: seed monthly rows → seed schedule → the quarter row shows
   credited payments.

## 10. Migration, rollback, out of scope

**Deploy order.** Infra preflight (§4) → migrate → app. QA first; prod only as part of a
release the owner approves.

**Rollback.** Forward-only schema; the new columns and index are never dropped.
- *Before the new sync has run* (for example, the deploy fails at app start): re-pin the
  previous image. No row is superseded or `quarter`, so old code sees an equivalent table.
- *After the new sync has run:* roll forward with a fix. Re-pinning v1.25 or older is
  unsafe once superseded rows exist: old code shows them and emails reminders for them
  (`status <> 'deposited'`). If an image rollback is still required and **no quarter row is
  deposited**, run `packages/db/scripts/pay-91-revert.sql` first. In one transaction it
  deletes live, non-deposited, attachment-free `quarter` rows with `created_by='scheduler'`,
  then restores superseded rows to `CASE WHEN due_date < current_date THEN 'overdue' ELSE
  'pending' END` and sets `superseded_at` to NULL. PR-3 ships that script with a test on
  T03/T07 end states. This brings back the pre-fix double count and is a stopgap only. If a
  quarter row is deposited, the only paths are roll-forward or a restore from backup.

**Out of scope** (follow-up tickets for the product lead):
- A run issued after its period's row is `deposited` is not captured ("top-up" row). This
  gap already exists for federal and monthly rows; it becomes visible in quarterly mode.
- Recomputing `overdue` federal rows (D4 is state-only).
- Holiday roll of due dates (weekends only, V1).
- 2027 `state_deposit_schedules` seed files. Without them, 2027 quarterly states fall back
  to monthly rows until they are seeded (T13/T14 show the transition is correct when that
  happens). They must be seeded before the first 2027 pay date.
- State quarterly return worksheets (DE 9, NC-5, MW508, NYS-45), and penalty or interest
  maths.
- Issued-run void through the app (the app voids pre-issued runs only; tests use the
  DB-level path the immutability trigger allows).

## 11. Questions for the owner

- **Q1.** Prod runs v1.24 and its schedule table is empty (seeds are run by hand). The
  double count starts the moment the 2026 schedules are seeded on a v1.25 database.
  Recommendation: v1.25 may go to prod, but **do not run the seed on prod until PAY-91
  ships**. Until then, state rows stay monthly (the v1.24 behaviour).

## Owner sign-off

- [ ] Spec 23 approved as written / with amendments
