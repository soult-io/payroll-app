# Contributing

Thanks for your interest in contributing! This document covers the dev setup,
the checks every PR must pass, and what to expect in review.

## Dev setup

Prereqs: Node ≥ 22, pnpm 11 (`npm install -g pnpm`), Docker (for Postgres).

```sh
pnpm install

# Postgres for dev (the example compose db service works standalone)
mkdir -p secrets && echo payroll > secrets/db-password
docker compose -f compose.example.yml up -d db

# Migrations
DATABASE_URL=postgres://payroll:payroll@localhost:5432/payroll pnpm db:migrate

# Dev servers — API on :8927, web on :5173 (proxying /api → :8927)
pnpm dev
```

## Checks (all must be green before merge)

```sh
pnpm biome check        # lint/format — CI gates on 0 errors (complexity ≤ 15)
pnpm -r run typecheck   # tsc / vue-tsc across all packages
pnpm test               # unit tests across the workspace (vitest)
```

Run tests for a single package while iterating:

```sh
pnpm --filter @payroll/server test
pnpm --filter @payroll/engine test
```

End-to-end tests use an **ephemeral** stack (in-memory PGlite, no external
services) and must also pass:

```sh
pnpm --filter @payroll/e2e e2e
```

(The nightly e2e against a live QA deployment requires our self-hosted runner
and is not expected to run on forks — it skips cleanly there.)

## PR expectations

- Green CI is required: Biome 0 errors, typecheck clean, unit tests and
  ephemeral e2e passing.
- Keep changes focused; one logical change per PR.
- **Big changes start as a spec.** The `plan/` directory holds the approved
  design history (`plan/decisions.md` + `plan/specs/`). If your change alters
  behavior, data model, or architecture, open an issue first to discuss, and
  be ready to write a short spec in that style.
- Don't commit secrets, real personal data, or environment-specific
  configuration — the repo is deliberately deployable by anyone.
- Money handling rules are strict (NUMERIC to the cent, rounding defined once
  in `packages/engine`) — follow the existing patterns.

## License

By contributing, you agree that your contributions are licensed under the
project's [AGPL-3.0 license](LICENSE).
