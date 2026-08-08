# Spec 8 — Deployment & Operations

Status: `DRAFT — awaiting owner sign-off` · Depends on: D1, D4, D9

## Repository

New standalone repo (`payroll`), pnpm workspaces monorepo:

```
payroll/
  apps/server/        Fastify API + serves built SPA (Node 22 LTS)
  apps/web/           Vue 3 + Vite SPA
  packages/engine/    vendored payroll.ts + money.ts + tests (from an internal accounting codebase)
  packages/db/        Drizzle schema + migrations
  packages/shared/    Zod schemas, types shared by server+web
  compose.example.yml reference deployment: app + migrate one-shot + postgres
  Dockerfile          multi-stage: build web → build server → runtime
  .github/workflows/  ci.yml: test → build image → push ghcr (sha tags, main);
                      release.yml: v*.*.* tags → release images + GitHub release
```

No dependency on the internal accounting project code at runtime (engine is vendored, tests included) — D9.

**Repo/stack split (spec 13, D26–D29, 2026-08-03):** this repo is **artifact-only** —
app source + published container image, runnable by a stranger, zero personal config.
Production deployment lives in the private stack repo `nsoult-agentic/stack-payroll`
(`prod/docker-compose.yml`), deployed by GitOps automation. **Prod moves only via tagged
releases** (D28 amended 2026-08-03 — consumer pulls): release PR → owner merge →
`vX.Y.Z` tag → release workflow publishes the image + GitHub release → the stack repo's
own scheduled workflow opens a prod-pin PR → owner merges → the GitOps deployment redeploys.
The old self-pinning `[skip ci]` bot in this repo is removed.

## Containers (compose.example.yml — self-contained, reusable)

| service | image | limits | notes |
|---|---|---|---|
| `app` | `ghcr.io/soult-io/payroll-app:vX.Y.Z` (release-pinned) | 512m / 1.0 cpu | read-only rootfs, no-new-privileges, cap_drop ALL, tmpfs /tmp, healthcheck `/health` |
| `app-migrate` | same image | 512m | one-shot `drizzle-kit migrate` + seeds; `depends_on: service_completed_successfully` (migrate-before-boot gate, proven pattern from the internal accounting project) |
| `db` | `postgres:16-alpine` | 512m / 1.0 cpu | volume `pgdata`; healthcheck `pg_isready` |

Total worst-case footprint ≈ 1 GB — comfortable on the home server alongside the existing fleet.

- **Secrets:** secret files mounted read-only (`db-password`, `smtp-password`,
  `encryption-key`, `session-secret`, optional `export-token`), never env values —
  established convention. In the stack repo: `/srv/payroll/secrets`; for anyone else:
  `SECRETS_HOST_DIR` (default `./secrets`) — see docs/deployment.md.
- **Networking:** loopback-only published port `127.0.0.1:8927:8927` (owner-assigned
  2026-07-28 as 8989; re-assigned to 8927 on 2026-07-29 — 8989 collided with another service on the home server. One port number everywhere: container, host bind, reverse-proxy upstream). The reverse proxy proxies
  the public hostname (`payroll.example.com`) to `payroll-app:8927` with TLS + HSTS —
  that proxy config lives with the stack repo, not here.
- **Deploy flow (your infra):** release PR → owner merge → tag `vX.Y.Z` → release
  workflow publishes the image + GitHub release → `nsoult-agentic/stack-payroll`'s
  scheduled pin-update workflow opens a prod-pin PR itself → owner merges → the GitOps deployment redeploys → migrate one-shot runs → app boots.
- **Deploy flow (anyone else):** clone, `cp .env.example .env`, place secrets,
  `docker compose -f compose.example.yml up -d` — nothing environment-specific. First admin
  via `docker exec payroll-app node dist/cli/create-admin.js <email>`.

## Backups

- Nightly `pg_dump` of the `payroll` database via a sidecar cron container (or the home server's
  existing backup job — decide at deploy time), 30-day retention, plus pre-migration dump
  in CI deploys. Sessions live in the same DB — a restore means logged-out users, which is
  the accepted failure mode (auth research).
- Postgres upgrades: manual, pinned major version (`postgres:16-alpine`), dump-restore
  procedure documented in README.

## Observability

- Structured JSON logs (pino) to stdout → docker logs; healthcheck endpoint; pg-boss job
  stats surfaced on the admin settings page (no separate queue UI container in v1).
- Resource alerts: rely on the home server's existing monitoring (no new stack).

## CI checks (gate every PR)

`tsc --noEmit`, Drizzle schema lint, engine unit tests + property tests + 2025/2026 golden
differential, API integration tests (testcontainers Postgres), web `vue-tsc` + build,
container build. Image pushed only from main.

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
