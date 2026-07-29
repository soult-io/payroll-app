# Spec 8 — Deployment & Operations

Status: `DRAFT — awaiting owner sign-off` · Depends on: D1, D4, D9

## Repository

New standalone repo (`payroll`), pnpm workspaces monorepo:

```
payroll/
  apps/server/        Fastify API + serves built SPA (Node 22 LTS)
  apps/web/           Vue 3 + Vite SPA
  packages/engine/    vendored payroll.ts + money.ts + tests (from stack-finance)
  packages/db/        Drizzle schema + migrations
  packages/shared/    Zod schemas, types shared by server+web
  docker-compose.yml  self-contained: app + postgres
  Dockerfile          multi-stage: build web → build server → runtime
  .github/workflows/  CI: test → build image → push ghcr → rewrite compose tag
```

No dependency on `stack-finance` code at runtime (engine is vendored, tests included) — D9.

## Containers (docker-compose.yml — self-contained, reusable)

| service | image | limits | notes |
|---|---|---|---|
| `app` | `ghcr.io/nsoult-agentic/payroll:sha-<n>` | 512m / 1.0 cpu | read-only rootfs, no-new-privileges, cap_drop ALL, tmpfs /tmp, healthcheck `/health` |
| `app-migrate` | same image | 512m | one-shot `drizzle-kit migrate` + seeds; `depends_on: service_completed_successfully` (migrate-before-boot gate, proven pattern from stack-finance) |
| `db` | `postgres:16-alpine` | 512m / 1.0 cpu | volume `pgdata`; healthcheck `pg_isready` |

Total worst-case footprint ≈ 1 GB — comfortable on the NUC alongside the existing fleet.

- **Secrets:** `/srv/payroll/secrets/` files mounted read-only (`db-password`, `smtp-password`,
  `encryption-key`, `session-secret`), never env values — established convention.
- **Networking:** loopback-only published port `127.0.0.1:8927:8927` (owner-assigned
  2026-07-28 as 8989; re-assigned to 8927 on 2026-07-29 — 8989 collided with sonarr on
  the NUC. One port number everywhere: container, host bind, NPM upstream). NPM proxies
  the public hostname (`payroll.stabpablo.eu`) to `payroll-app:8927` with TLS + HSTS.
- **Deploy flow (your infra):** push → CI builds/pushes ghcr image, rewrites compose tag →
  Portainer GitOps polls repo → redeploys → migrate one-shot runs → app boots.
- **Deploy flow (anyone else):** clone, `cp .env.example .env`, place secrets,
  `docker compose up -d` — same compose file, nothing Kimi/NUC-specific. First admin via
  `docker compose exec app pnpm create-admin <email>`.

## Backups

- Nightly `pg_dump` of the `payroll` database via a sidecar cron container (or the NUC's
  existing backup job — decide at deploy time), 30-day retention, plus pre-migration dump
  in CI deploys. Sessions live in the same DB — a restore means logged-out users, which is
  the accepted failure mode (auth research).
- Postgres upgrades: manual, pinned major version (`postgres:16-alpine`), dump-restore
  procedure documented in README.

## Observability

- Structured JSON logs (pino) to stdout → docker logs; healthcheck endpoint; pg-boss job
  stats surfaced on the admin settings page (no separate queue UI container in v1).
- Resource alerts: rely on the NUC's existing monitoring (no new stack).

## CI checks (gate every PR)

`tsc --noEmit`, Drizzle schema lint, engine unit tests + property tests + 2025/2026 golden
differential, API integration tests (testcontainers Postgres), web `vue-tsc` + build,
container build. Image pushed only from main.

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
