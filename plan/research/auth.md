# Authentication Options for a Self-Hosted Payroll Webapp — Research Report (verified 2025–2026)

## Ecosystem state, verified

- **Lucia is dead as a library.** Deprecated March 2025; lucia-auth.com is now a learning resource; maintained primitives are **Oslo** (crypto/session) and **Arctic** (OAuth). "Lucia-style" = copy the patterns, own the code. ([announcement](https://github.com/lucia-auth/lucia/discussions/1714))
- **Auth.js (NextAuth) is in maintenance mode.** September 2025 stewardship handed to the Better Auth team; security patches only; official guidance is new projects should use Better Auth. Never a good fit outside Next.js anyway. ([announcement](https://github.com/nextauthjs/next-auth/discussions/13252))
- **Better Auth is now the de facto TS auth library.** Framework-agnostic (plain Node/Hono/Express API + Vue SPA), plugin-based: first-party `twoFactor()` (TOTP + backup codes), `passkey()`, `admin()`, `organization()`; ~3 releases/week. Caveats: young, no built-in admin dashboard, advanced session hardening (token rotation, anti-CSRF) needs manual attention. ([better-auth.com](https://www.better-auth.com/docs/introduction))
- **Keycloak does not fit the NUC.** Official sizing: **~1000–1250 MB RAM base per pod**, JVM, plus its own Postgres. ([Keycloak sizing docs](https://www.keycloak.org/high-availability/single-cluster/concepts-memory-and-cpu-sizing))
- **Authentik is borderline.** 4 containers, idles ~500–700 MB combined, Python worker spikes hard. Great IdP for homelab SSO of many apps; oversized as auth for one app.
- **Zitadel is the only full IdP that fits the constraints.** Go binary, **~512 MB RAM, <1 vCPU**, Postgres-backed. Caveats: vendor discourages docker-compose for prod; IdP down = login down.
- **ASP.NET Core Identity improved materially.** .NET 10 (Nov 2025, LTS) added **built-in passkey support**; long-standing TOTP. SPA wiring is DIY.
- **Session guidance is settled.** OWASP recommends against `localStorage` for tokens; recommended SPA+API pattern is **HttpOnly + Secure + SameSite cookies**; same-domain SPA+API with server-side sessions satisfies this with the least machinery.

## Decision matrix (1–5; criteria weighted in priority order)

| Option | 1. Security | 2. NUC footprint | 3. Ops simplicity | 4. Invite+RBAC+email | 5. Product reuse | 6. Language flex |
|---|---|---|---|---|---|---|
| **Better Auth (TS)** | 4 — strong defaults, TOTP/passkey/admin plugins; young; CSRF partly on you | 5 — in-process | 4 — upgrade churn, pin versions | 5 — admin plugin, `signUp: disabled`, email flows built in | 5 — auth ships inside the app, one container | 1 — TypeScript only |
| **ASP.NET Core Identity (.NET 10)** | 4 — battle-tested; passkeys built in, TOTP mature | 4 — in-process | 4 — boring, stable, LTS | 4 — more hand-assembly | 5 | 1 — .NET only |
| **Go: scs + argon2id (+ pquerna/otp)** | 3 — correct primitives but you assemble MFA, resets, lockout | 5 — tiny | 4 — you own every flow forever | 3 — everything hand-built | 4 — maintaining an auth product inside your product | 1 — Go only |
| **Roll-your-own (Lucia patterns/Oslo)** | 3 — excellent patterns; your implementation risk | 5 | 3 — you are the maintainer | 3 | 4 | 2 — TS-centric |
| **Zitadel (self-hosted)** | 5 — dedicated IdP, MFA/WebAuthn, audit events | 3 — ~512MB + Postgres; eats budget | 3 — IdP down = app down | 5 | 3 — self-hosters must run 2 services + Postgres | 5 — OIDC, any backend |
| **Authentik** | 5 | 2 — 500–700MB idle, spiky | 3 | 5 | 2 | 5 |
| **Keycloak** | 5 | 1 — ~1–1.25GB base, JVM | 2 | 5 | 2 | 5 |
| **PocketBase / Supabase Auth / Logto** | 3–4 | 3 | 3 | 3–4 | 2–3 | 4 |
| **Hosted (Clerk/Auth0/WorkOS/Cognito)** | 5 | 5 | 5 | 5 | 1 — kills the self-hosted product story; PII leaves the box | 5 |

## Recommendation

**#1 — Embedded, library-integrated auth in whatever backend is chosen, with Better Auth as the reference implementation.** Deciding argument: product reuse + NUC footprint. A small business self-hosting the product gets `app container + Postgres` — nothing else to run, patch, or back up, and no "IdP down, payroll down" failure mode. Since all three candidate backends have a strong embedded option, **auth does not constrain the language choice** — but if the backend race is otherwise tied, Better Auth is the single best auth library in the field, a point in TypeScript's column.

**#2 — Zitadel, if and only if the product direction shifts toward customers with existing identity stacks** (SSO/OIDC/SAML demands). Treat as a possible v2 pivot, not a v1 need. A thin `getSession()`/identity abstraction now makes that pivot cheap later.

## Recommended v1 architecture (concrete)

- **Session type:** Server-side sessions, opaque session ID in an `HttpOnly; Secure; SameSite=Lax` cookie, session table in Postgres. Same domain through Nginx Proxy Manager → no CORS surface. Instant revocation matters for payroll ("disable this employee *now*"). Avoid JWTs.
- **MFA: required at v1.** TOTP enrollment enforced at first login for **all** users. Internet-exposed payroll PII justifies it; costs one plugin call. Backup codes at enrollment. Passkeys fast-follow.
- **Invite flow:** self-registration disabled at code level. Admin creates user with email → single-use, expiring (≤24h), hashed-at-rest setup token → email via SMTP → user sets password + enrolls TOTP in one forced onboarding flow. Same token machinery for password resets. First admin seeded via CLI command or env var at install.
- **Password hashing:** Argon2id, OWASP parameters (m=19 MiB, t=2, p=1). (Better Auth defaults to scrypt — acceptable, configurable; ASP.NET Identity uses PBKDF2 — tune iterations up.)
- **RBAC:** `role` column (`admin`/`employee`) enforced server-side in middleware on every request; modeled so roles can become a join table later. Never trust client role claims.
- **Audit trail:** append-only `auth_events` table from day one: login success/failure, MFA challenge pass/fail, password change/reset, invite created/accepted, session revoked, role change — actor, IP, user-agent, timestamp.
- **Edge hardening:** rate-limit login/reset endpoints, `SameSite=Lax` + origin checking for CSRF, strict CSP on the SPA, session rotation on privilege change.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Better Auth youth/churn | Pin exact versions, upgrade monthly, hide auth behind a thin internal interface; add explicit CSRF/origin middleware |
| Solo-dev burnout owning auth in Go (every flow hand-built) | If Go is picked, budget real time for MFA/reset/lockout — or let auth tilt the backend decision toward TS/.NET |
| Email deliverability breaks invites/resets | Admin-side manual reset-link copy as fallback; monitor SMTP; 24h token validity |
| Session theft via XSS in the SPA | HttpOnly cookies, strict CSP, Vue auto-escaping discipline — main residual attack surface |
| Future product needs SSO for customers | Keep identity behind an interface; adopt Zitadel/OIDC then, not now |
| Postgres is single point of failure (sessions + events + payroll) | Include session/event tables in backups; failure mode on restore = logged-out users |

## Sources

- Lucia deprecation: https://github.com/lucia-auth/lucia/discussions/1714
- Auth.js → Better Auth handoff: https://github.com/nextauthjs/next-auth/discussions/13252 · https://www.better-auth.com/blog/authjs-joins-better-auth
- Better Auth state/plugins: https://www.better-auth.com/docs/introduction · https://supertokens.com/blog/better-auth
- Keycloak sizing: https://www.keycloak.org/high-availability/single-cluster/concepts-memory-and-cpu-sizing
- Authentik footprint: https://github.com/goauthentik/authentik/issues/21413
- Zitadel footprint: https://zitadel.com/docs/self-hosting/deploy/overview
- .NET 10 Identity passkeys: https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0
- Cookie vs token storage: https://www.pivotpointsecurity.com/local-storage-versus-cookies-which-to-use-to-securely-store-session-tokens/ · https://curity.io/resources/learn/spa-best-practices/
