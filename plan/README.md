# Payroll Webapp — Master Plan

**Status: APPROVED by owner 2026-07-28 — all twelve decisions (D1–D12) and all nine specs
signed off. Port amended twice: 8989 (2026-07-28) → 8927 (2026-07-29, 8989 collided with
sonarr on the NUC; single port everywhere, no host:container mapping). Build is authorized.**

## Project goal (from owner interview, 2026-07-28)

Replace the agent-driven monthly payroll routine with a **stable, deterministic, authoritative
webapp** that works outside the agentic sphere. Today it serves one company with one W-2
employee (two logins: admin + employee); the architecture is built for multiple employees and
a future life as an open-source/commercial product for small businesses. Success = a solid,
bug-free UX that meets the owner's needs and could serve other small businesses.

## Locked decisions

| # | Decision | Outcome |
|---|---|---|
| D1 | Backend | Node.js LTS + Fastify + Drizzle + pg-boss + Better Auth + pdfmake (Deno/Bun checked, rejected) |
| D2 | Frontend | Vue 3 + Vite SPA + PrimeVue 4.x (Material preset), no SSR |
| D3 | Auth | Embedded, cookie sessions in Postgres, TOTP mandatory v1, invite-only, Argon2id, audit events |
| D4 | Database | Dedicated Postgres container; one-time data copy; app is sole writer after cutover |
| D5 | Payslips | Generated on-demand from frozen run snapshots; never stored; no Nextcloud |
| D6 | Payroll workflow | Draft → approve → issue; configurable schedule, default 15th monthly; calc+payslip only |
| D7 | Change requests | Address, W-4, bank, legal name; effective-dated; comment threads |
| D8 | Notifications | SMTP, per-event, per-user toggles; no infra hardcoding |
| D9 | Deployment | New repo, Portainer GitOps + NPM proxy; also deployable anywhere via compose |
| D10 | Futures | Time-off + 1099 designed into schema; bookkeeping export maybe later |
| D11 | Roles | One app, admin/employee RBAC |
| D12 | v1 exclusions | Payments, bookkeeping, mobile, 3rd-party API, multi-currency, time-off UI, invoicing |

Full rationale: [decisions.md](decisions.md) · Research: [research/](research/)

## The nine specs (each needs explicit sign-off)

1. [specs/data-model.md](specs/data-model.md) — full schema, money/encryption/ID rules
2. [specs/payroll-engine.md](specs/payroll-engine.md) — vendored tested engine, run lifecycle, idempotency
3. [specs/auth.md](specs/auth.md) — Better Auth, sessions, MFA, invites, RBAC, audit
4. [specs/change-requests.md](specs/change-requests.md) — state machine, transactional apply
5. [specs/documents.md](specs/documents.md) — on-demand payslip PDFs, immutability guarantees
6. [specs/notifications.md](specs/notifications.md) — outbox, event catalog, templates
7. [specs/frontend.md](specs/frontend.md) — routes, screens, PrimeVue conventions
8. [specs/deployment.md](specs/deployment.md) — repo layout, containers, CI, backups
9. [specs/migration.md](specs/migration.md) — data copy, snapshot reconstruction, cutover, rollback

## Build order (after sign-off — proposed)

1. Repo skeleton + CI + DB schema + engine vendoring (specs 8, 1, 2)
2. Auth + RBAC (spec 3)
3. Payroll run lifecycle + scheduler (spec 2) + documents (spec 5)
4. Change requests (spec 4) + notifications (spec 6)
5. Frontend screens (spec 7)
6. Migration + cutover (spec 9)
