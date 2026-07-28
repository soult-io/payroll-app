# Payroll

Stable, deterministic, authoritative payroll webapp for small business.
**Feature-complete v1** — auth + TOTP onboarding, monthly payroll lifecycle
(draft → approve → issue/void) with immutable snapshots and payslip PDFs,
employee self-service (payslips, profile, change requests with threaded
review), notification outbox with SMTP, admin configuration (tax tables, pay
schedule, company, users, audit viewers), and one-time legacy migration
tooling for the cutover from `second_brain.accounting`.

## Architecture (one paragraph)

A Vue 3 + PrimeVue SPA (`apps/web`) talks to a Fastify API (`apps/server`,
Node 22) that owns a dedicated Postgres 16 database via Drizzle migrations
(`packages/db`). All withholding math lives in `packages/engine` — a verbatim
vendored copy of the battle-tested `payroll.ts`/`money.ts` from `stack-finance`,
pure and deterministic, with its original unit tests as the regression oracle.
Shared Zod schemas live in `packages/shared`. Deployment is a single
self-contained `docker-compose.yml` (app + one-shot migrate + postgres); the
full design — twelve locked decisions (D1–D12) and nine signed-off specs —
lives in [plan/](plan/README.md).

## Quickstart

Prereqs: Node ≥ 22, pnpm 11 (`npm install -g pnpm`), Docker for the database.

```sh
# 1. Install dependencies
pnpm install

# 2. Start Postgres (the compose db service works standalone for dev)
docker compose up -d db

# 3. Run migrations (needs DATABASE_URL; matches the dev compose defaults)
DATABASE_URL=postgres://payroll:payroll@localhost:5432/payroll pnpm db:migrate

# 4. Dev servers — API on :8989, web on :5173 (proxying /api → :8989)
pnpm dev

# Or individually:
pnpm --filter @payroll/server dev
pnpm --filter @payroll/web dev
```

Useful checks:

```sh
pnpm -r run typecheck              # tsc / vue-tsc across all packages
pnpm test                          # ALL tests: engine 54 + server 72 (vitest)
pnpm -r run build                  # build everything
pnpm db:generate                   # regenerate SQL migrations from the schema
```

Environment variables are documented in [.env.example](.env.example); secrets
are read as **files** from `SECRETS_DIR`, never as env values (spec 8).

## Legacy migration & cutover

One-time import of payroll history from `second_brain.accounting`
(mcp-accounting), with snapshot reconstruction validated to the cent before
any write. Dry-run by default; `--write` is idempotent (ledger table
`legacy_migration_map`):

```sh
SOURCE_DATABASE_URL=postgres://…@second-brain-db:5432/second_brain \
  pnpm migrate:legacy --dry-run --verbose   # analysis only, zero writes
SOURCE_DATABASE_URL=postgres://…@second-brain-db:5432/second_brain \
  pnpm migrate:legacy --write               # perform (re-run = no-op)
```

The full owner-side procedure (secrets, deploy order, verification, rollback)
is in [docs/cutover.md](docs/cutover.md).

## Full container deployment

```sh
cp .env.example .env   # fill in SMTP_*, set POSTGRES_PASSWORD
docker compose up -d --build
```

Boots `db` (postgres:16-alpine) → `app-migrate` (one-shot `drizzle-kit
migrate`) → `app` on `127.0.0.1:8989`. Production secrets wiring (mounted
files under `/srv/payroll/secrets/`) is commented in
[docker-compose.yml](docker-compose.yml).

## Repo layout

```
apps/server/        Fastify API + serves built SPA (Node 22 LTS)
  src/migrate/      legacy cutover tooling (pnpm migrate:legacy)
apps/web/           Vue 3 + Vite SPA (PrimeVue 4.x, Material preset)
packages/engine/    vendored payroll.ts + money.ts + tests (from stack-finance)
packages/db/        Drizzle schema + migrations
packages/shared/    Zod schemas, types shared by server+web
plan/               approved plan: decisions.md + specs/ (docs, not code)
docs/               operations docs (cutover runbook)
Dockerfile          multi-stage: build web → build server → runtime
docker-compose.yml  self-contained: app + postgres
.github/workflows/  CI: test → build image → push ghcr (main only)
```

## Database notes

- Money is always `NUMERIC(12,2)`; rates `NUMERIC(6,5)`; rounding half-up,
  defined once in `packages/engine` (spec 1).
- Better Auth's own tables (`user`, `session`, …) are created by the Better
  Auth CLI in step 2 — they are deliberately absent from `packages/db`.
- The compensation non-overlap exclusion constraint and issued-run immutability
  trigger are raw SQL migration steps (`packages/db/drizzle/`), not Drizzle DSL.

## Postgres upgrades

Major version is pinned (`postgres:16-alpine`). Upgrades are manual:
`pg_dump` from the old container, bring up the new pinned image on an empty
volume, restore, then point the app at it. Nightly backups: `pg_dump` sidecar
or host backup job, 30-day retention (spec 8).
