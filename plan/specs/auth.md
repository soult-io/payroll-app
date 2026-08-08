# Spec 3 — Authentication & Authorization

Status: `DRAFT — awaiting owner sign-off` · Depends on: D3, data-model · Research: ../research/auth.md

## Library & shape

**Better Auth** (Node/TS, framework-agnostic) mounted in Fastify at `/api/auth/*`, with plugins:
`twoFactor()` (TOTP + backup codes), `admin()` (user management, ban/disable, impersonation OFF),
`passkey()` deferred to fast-follow. Auth-owned tables (`user`, `session`, `account`,
`verification`, `twoFactor`) managed by Better Auth's CLI migrations.

## Session model (D3)

- Server-side sessions in Postgres; opaque ID in `HttpOnly; Secure; SameSite=Lax` cookie.
- SPA + API on one domain (a reverse proxy) → no CORS surface; CSRF via SameSite + explicit
  Origin/Referer check middleware on mutating routes.
- Absolute lifetime 7 days, idle 12 hours, rotation on privilege change; instant revocation
  (disable user → all sessions killed in the same transaction).
- No JWTs, no tokens in `localStorage` (OWASP).

## MFA (mandatory at v1, D3)

- TOTP enrollment is **forced at first login for every user** (admin and employee): the
  invite/onboarding flow cannot complete without it. 10 single-use backup codes issued at
  enrollment, shown once, hashed at rest.
- Every login: password → TOTP challenge → session. Recovery = backup code, else admin-initiated
  reset (new setup token + re-enrollment).
- Passkeys: fast-follow release after v1 stabilizes (`passkey()` plugin; additive, no schema
  redesign needed).

## Invite-only registration (D3)

- Self-registration **disabled at code level** (`signUp: disabled`); no public registration route exists.
- Flow: admin creates user (name + email) → app generates single-use setup token (random 32B,
  SHA-256 stored, ≤24h expiry) → email via SMTP → user opens link, sets password (zxcvbn
  strength bar, min 12 chars), enrolls TOTP, receives backup codes → status invited → active.
- Same token machinery reused for password resets. Admin can copy a setup/reset link manually
  as an SMTP-failure fallback.
- First admin: seeded via CLI (`pnpm create-admin <email>`) at install time.

## Passwords

Argon2id, OWASP parameters (m=19 MiB, t=2, p=1). (Better Auth defaults to scrypt — acceptable;
configured to Argon2id via custom `password.hash`/`verify` hooks.)

## RBAC (D11)

- `role` on `user`: `admin` | `employee`. Checked **server-side in Fastify middleware on every
  route**; never trusted from the client.
- Route classes: `public` (invite/reset accept), `authenticated`, `employee-self`
  (own payslips/requests only — enforced by comparing `employees.user_id` to session user),
  `admin-only`.
- Roles modeled to become a join table later without API change.

## Audit (from day one)

Append-only `auth_events`: login_success/failure, mfa_pass/fail, password_change/reset,
invite_created/accepted, session_revoked, role_change, user_disabled — with actor, IP,
user-agent, timestamp. Written in the same transaction as the action where applicable.

## Edge hardening

- Rate limits: 10/min per IP on login + reset + invite-accept (app-level; `@fastify/rate-limit`),
  plus account-level lockout after 10 consecutive failures (admin unlock or timed backoff).
- Strict CSP on the SPA (no inline scripts), `X-Content-Type-Options`, `Refer-Policy`,
  HSTS at the proxy.
- Session secrets and SMTP creds via `/secrets/` files, never env values.

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
