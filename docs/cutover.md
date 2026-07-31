# Cutover runbook — legacy `second_brain.accounting` → payroll app

One-time migration + cutover, per [plan/specs/migration.md](../plan/specs/migration.md)
(spec 9, D4 sole-writer). Written for execution **on the NUC** by the owner.
Everything here except the final checklists is idempotent — if in doubt, re-run
the step; the migration itself is a no-op on repeat.

> **Golden rule:** the migration validates every reconstructed snapshot against
> the stored legacy entries **to the cent before writing anything**. If it
> halts, it has written nothing. Do not force past a validation failure — the
> report means the legacy numbers and the engine disagree, and importing would
> freeze a wrong snapshot into payslips.

---

## 0. What moves (and what doesn't)

Moves: employees (1 row → company + employee), compensation (2 rows),
w4_elections (1 row), tax_config + tax_brackets (2025 + 2026), payroll_runs +
payroll_entries (all history, imported as `issued` with reconstructed
snapshots, `engineVersion='legacy-import'`, `pay_date` = the 15th of the
period month — owner-confirmed legacy payday, amended 2026-07-29 —
`issued_at` = source `created_at`).

> **Already migrated with the pre-amendment build?** The first import derived
> `pay_date` as the last day of the period month. Run the one-off fixer once
> (idempotent; patches the column, the snapshot, and the snapshot hash):
>
> ```sh
> docker exec payroll-app node dist/cli/fix-legacy-paydates.js
> ```

Does **not** move (stays as read-only history in `second_brain.accounting`):
`time_off`, `compliance_filings`, `deposits`, `pay_stub_path` (PDFs stay in
Nextcloud — D5, no file migration).

---

## 1. Prerequisites

- [ ] The payroll repo checked out on the NUC (or the GHCR image tagged for deploy).
- [ ] The source database is reachable: `second_brain` Postgres (the
      `second-brain-db` container on the stack network). You need its
      connection string: host `second-brain-db`, port `5432`, database
      `second_brain`, user `pai` (or `accounting`), password from the stack's
      `db-password` secret file.
- [ ] NPM (Nginx Proxy Manager) reachable for step 8.
- [ ] ~30 minutes. The migration itself takes seconds; the checklists are the work.

## 2. Secrets checklist — `/srv/payroll/secrets`

Create these four files **before** first boot. Ownership matters: compose
bind-mounts secret files preserving host ownership, and the app + migrate
containers run as the non-root `payroll` user (**uid/gid 10001**, fixed in the
Dockerfile) — so the files must be owned `10001:10001`, mode `0600` (the `db`
service reads its copy as root, so it works either way):

| File | Contents | Used for |
|---|---|---|
| `db-password` | new strong password | Postgres `payroll` role + app DB access |
| `smtp-password` | SMTP account password | notification email delivery |
| `encryption-key` | 32 random bytes, hex or base64 | AES-256-GCM for SSN/bank/EIN at rest |
| `session-secret` | ≥ 32 random chars | Better Auth session signing |
| `export-token` | 32 random bytes, hex | read-only export API (optional — see [export-api.md](export-api.md); without it the endpoint 503s but compose must not reference it) |

The SMTP password belongs to the dedicated `payroll@stabpablo.eu` mailbox on
the stack-ops docker-mailserver (`mail.stabpablo.eu`). Create it once (any
strong password — then store the same value in `smtp-password`):

```sh
docker exec -it mailserver setup email add payroll@stabpablo.eu '<strong-password>'
```

```sh
sudo install -d -m 700 /srv/payroll/secrets
openssl rand -hex 32 | sudo tee /srv/payroll/secrets/encryption-key
openssl rand -hex 32 | sudo tee /srv/payroll/secrets/session-secret
# db-password and smtp-password: write real values the same way (no trailing newline issues —
# the app trims; keep one line each).
sudo chmod 600 /srv/payroll/secrets/*
sudo chown 10001:10001 /srv/payroll/secrets/*   # container payroll user — REQUIRED
```

The `secrets:` blocks in `docker-compose.yml` are already wired (mounted from
`SECRETS_HOST_DIR`, default `/srv/payroll/secrets`) — no compose edits needed.

## 3. Deploy (order matters)

Non-secret deploy config (BASE_URL, SMTP_*, SECRETS_HOST_DIR) is committed in
the repo's `.env` — the mail values point at the stack-ops mailserver
(`mail.stabpablo.eu`). Portainer GitOps reads it from the repo; for a manual
deploy just:

```sh
cd /path/to/payroll
docker compose up -d --build
```

Boot order is enforced by compose: `db` (healthy) → `app-migrate` (one-shot
drizzle migrations, incl. `0007` creating `legacy_migration_map`) → `app`.

Verify:

```sh
docker compose ps                      # app healthy, app-migrate exited 0
curl -s http://127.0.0.1:8927/health   # {"ok":true}
```

Seed reference data (company row, 2025+2026 federal tax tables, default pay
schedule). Idempotent — the migration adopts these rows rather than
duplicating them:

```sh
docker exec payroll-app node dist/cli/seed.js
```

## 4. Dry-run the migration (analysis + validation, ZERO writes)

The migration must reach **both** databases. On the NUC the payroll-app
container resolves the in-stack `db` service already; the legacy DB is
`second-brain-db` on the external `second-brain` network — attach it
temporarily (disconnect after the write step):

```sh
docker network connect second-brain payroll-app
```

The legacy schema is owned by the least-privilege `accounting` role (password
in `/srv/mcp-accounting/secrets/db-password` — same file mcp-accounting uses):

```sh
docker exec \
  -e SOURCE_DATABASE_URL="postgres://accounting:$(sudo cat /srv/mcp-accounting/secrets/db-password)@second-brain-db:5432/second_brain" \
  -e DATABASE_URL="postgres://payroll:$(sudo cat /srv/payroll/secrets/db-password)@db:5432/payroll" \
  payroll-app node dist/migrate/cli.js --dry-run --verbose
```

(From a repo checkout with network access to both DBs, the equivalent is
`SOURCE_DATABASE_URL=… pnpm migrate:legacy --dry-run --verbose` — the target
then comes from the standard `DB_*` env + `SECRETS_DIR/db-password`, or
`DATABASE_URL` if set.)

Expected output: source row counts, `NOT migrated` lines for
time_off/compliance_filings/deposits/pay_stub_path, one `validated YYYY-MM`
line per run, `phase A: N run(s) reconstructed and validated to the cent`, and
the dry-run plan. **Exit code 0 required.** Exit code 2 = validation or
structural halt — read the report, fix the source data understanding, do NOT
proceed.

Two owner-approved legacy deviations are EXPECTED and must not be treated as
failures (confirmed 2026-07-29 against the issued stubs + filed Q1-2026 Form
941; coded as overrides in `apps/server/src/migrate/migrate.ts`):

- **2026-01 / 2026-02** reconstruct against the **2025** tax tables — they
  were issued before the 2026 config existed in the legacy routine
  ($250.13/mo federal). Their snapshots carry a `legacyNotes` annotation.
- **2026-03** validates with the stored ISSUED amounts for
  `federal_withholding` ($472.73 = $324.33 March + $74.20 ×2 Jan/Feb
  corrections) and `net_pay` ($2,759.52) instead of the recomputed
  $238.33 / $2,993.92 — the true-up that reconciles the stubs with the
  941 filed 2026-03-17. The verbose line reads
  `(legacy deviation: stored issued amounts kept)` and the snapshot records
  the divergence in `legacyDeviations`. Every other run and category still
  validates to the cent.

## 5. Write the migration

```sh
docker exec \
  -e SOURCE_DATABASE_URL="postgres://accounting:$(sudo cat /srv/mcp-accounting/secrets/db-password)@second-brain-db:5432/second_brain" \
  -e DATABASE_URL="postgres://payroll:$(sudo cat /srv/payroll/secrets/db-password)@db:5432/payroll" \
  payroll-app node dist/migrate/cli.js --write --verbose
```

Then re-run the exact same command once: the second run must report
`0 inserted` for every entity (idempotency proof via `legacy_migration_map`).

Finally, remove the temporary network attach (D4 — the app has no business
reaching the legacy DB after cutover):

```sh
docker network disconnect second-brain payroll-app
```

## 6. Verification checklist

Row counts (target DB):

```sh
docker compose exec db psql -U payroll -d payroll -c "
  SELECT 'company' t, count(*) FROM company UNION ALL
  SELECT 'employees', count(*) FROM employees UNION ALL
  SELECT 'compensation', count(*) FROM compensation UNION ALL
  SELECT 'w4_elections', count(*) FROM w4_elections UNION ALL
  SELECT 'payroll_runs', count(*) FROM payroll_runs UNION ALL
  SELECT 'payroll_entries', count(*) FROM payroll_entries UNION ALL
  SELECT 'legacy_migration_map', count(*) FROM legacy_migration_map;"
```

- [ ] `company` 1 · `employees` 1 · `compensation` 2 · `w4_elections` 1
- [ ] `payroll_runs` == legacy `SELECT count(*) FROM accounting.payroll_runs`
- [ ] `payroll_entries` == runs × 9 (and == legacy entries count)
- [ ] `legacy_migration_map` == 1+1+2+1+(tax years)+(brackets)+runs

Golden differential (the numbers that must never move):

- [ ] 2025-01 federal_withholding = **250.13** (the issued-2025-stub value)
- [ ] 2026-03 federal_withholding = **472.73**, net_pay = **2759.52**,
      gross 3500.00 (last pre-raise month + the Q1-2026 941 true-up — see
      the deviation note in section 4; `run_snapshot.legacyDeviations`
      records the divergence from the recomputed 238.33 / 2993.92)
- [ ] 2026-04 federal_withholding = 0.00, gross 3750.00 (W-4 exempt + raise)
- [ ] 2025 and 2026 Jan–Mar snapshots have `inputs.w4 = null`; 2026-04+ have
      `federalExempt: true, effectiveFrom: '2026-04-01'`

```sh
docker compose exec db psql -U payroll -d payroll -c "
  SELECT r.period_start, e.category, e.amount
  FROM payroll_runs r JOIN payroll_entries e ON e.run_id = r.id
  WHERE r.period_start IN ('2025-01-01','2026-03-01','2026-04-01')
    AND e.category IN ('gross_pay','federal_withholding')
  ORDER BY r.period_start, e.category;"
```

Visual PDF diff (one historical payslip, spec 9 step 2):

- [ ] Open the Nextcloud original for 2026-03 (the run that carried
      `pay_stub_path`) and the same period's PDF from the app
      (`/admin/payroll` → run → payslip, or employee view). Figures, period,
      and layout content match; only the template may differ.

## 7. Users

```sh
# Admin (you) — prints a single-use setup link; also queued in email_outbox
docker exec payroll-app node dist/cli/create-admin.js you@example.com --name "Admin"
```

- [ ] Open the setup link → set password → enroll TOTP → save backup codes.
- [ ] In the app: **Employees → Neilson Soult → Invite** with the employee
      email. Employee enrolls (password + TOTP + backup codes).
- [ ] **Settings → Email → Send test email**; confirm delivery (or outbox row
      in log mode).

## 8. Go public

- [ ] NPM: proxy host **payroll.stabpablo.eu → payroll-app:8927**, scheme http,
      websockets off, TLS cert + Force SSL + HSTS. (NPM resolves the container
      by name over the shared `mcp_network`; the host loopback bind on 8927 is
      only for host-side debugging.)
- [ ] `BASE_URL=https://payroll.stabpablo.eu` — already set in the committed
      `.env`; no action unless the hostname changes (setup links and auth
      trusted origins depend on it).
- [ ] From outside: `https://payroll.stabpablo.eu` loads; sign in as admin.

## 9. Sole-writer declaration (D4)

**From this point the payroll app is the ONLY writer for payroll data.**

- [ ] The legacy `accounting` payroll tables stay as read-only history.
      mcp-accounting's `accounting-payroll-calculate` / paystub tools remain
      functional against that history but are no longer used for new periods.
- [ ] Retire the claude-code monthly payroll routine: its final action is
      generating **nothing** — the app's scheduler takes over from the next
      period (first live draft on the next 15th, or immediately via
      **Config → Pay schedule → Generate drafts now**).
- [ ] Update the accountant agent docs (AGENTS.md / STATE.md) to name the app
      as the payroll source of truth.

## 10. 30-day rollback plan

Nothing legacy is deleted or modified by this cutover, so rollback is cheap
for one full payroll cycle:

- [ ] Day 0–30: legacy routine and Nextcloud archive remain intact but idle.
- [ ] If the app fails to produce a correct run for a period: generate that
      month with the old MCP flow, archive its PDF in Nextcloud as before, and
      mark the corresponding app run `void` (with reason) so the unique
      (employee, period) slot is consistent when the app comes back.
- [ ] After 30 days (one full cycle + the post-cutover checklist below all
      green): rollback window closes; legacy stays as immutable history.

## 11. Post-cutover v1 checklist (spec 9)

- [ ] First scheduler-generated draft appears on the configured day (default 15th)
- [ ] Admin approves → issues; employee receives email; PDF downloads correctly
- [ ] Change request round-trip (submit → comment → approve → effective-dated apply)
- [ ] Old Nextcloud archive untouched; agent routine confirmed silent
