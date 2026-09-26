# Spec 22 — Brand name from one setting ("Wagon Payroll")

PAY-66, child of PAY-60 (rebrand epic). Owner decision 2026-09-24: the product
name is **Wagon Payroll**.

## Why

The app calls itself "Payroll" in the tab title, the header, the TOTP issuer,
and every email. The rename must land in one place, and must stay changeable
by an operator without a rebuild, so a later white-label item stays possible.

## Scope

In: every user-facing product-name string in the SPA, emails, TOTP enrollment,
the pay-verify page title, and the docs.

Out: the `@payroll/*` package scope, the repo name, GHCR image names,
container/DB names in compose, hostnames (PAY-70 open), favicon/logo assets
(brand-identity ticket pending; no asset change here), the Better Auth
`cookiePrefix: "payroll"` (changing it signs every user out), and the feature
word "Payroll" where it names a feature (nav item `admin-payroll`,
"Payroll runs", "Payroll drafts awaiting approval").

## Decisions

**D1 — One setting: `BRAND_NAME` env, default in `@payroll/shared`.**
`packages/shared/src/brand.ts` exports `DEFAULT_BRAND_NAME = "Wagon Payroll"`
and `parseBrandName(raw: string | undefined): string`. `loadConfig()` gains
`brandName: parseBrandName(process.env.BRAND_NAME)`. No server or SPA code
spells the product name except through this module; the only literals left are
the static pre-JS `<title>` (D2), the pay-verify page (D8), and prose docs.

Validation (boot fails on an invalid value, same as a missing secret): trim;
unset or empty → default; 1–60 characters; reject C0 controls
(U+0000–U+001F), DEL (U+007F), C1 controls (U+0080–U+009F), zero-width and
directional marks (U+200B–U+200F), line/paragraph separators (U+2028,
U+2029), bidi embeddings and overrides (U+202A–U+202E), the word joiner
(U+2060), bidi isolates (U+2066–U+2069), and the zero-width no-break space
(U+FEFF). The name goes into an email `Subject:` header and an
`otpauth://` URI; CR/LF would be header injection, and bidi/zero-width
characters let a name render as different text than it is. One function
(`parseDisplayName`) validates both `BRAND_NAME` and `TOTP_ISSUER`.

**D2 — The SPA learns the name from the existing `GET /api/runtime-config`.**
Options weighed:

| Option | One image for QA + prod | Env override | Login page | Cost |
|---|---|---|---|---|
| A. Vite build-time constant | yes, but override needs a rebuild | no | yes | lowest |
| B. Add `brandName` to `/api/runtime-config` | yes | yes | yes | one field |
| C. Server rewrites `index.html` at serve time | yes | yes | yes | templating + cache rules on the deploy-detection file |

Chosen: **B**. The endpoint already exists (spec 14), is unauthenticated by
design, is already fetched on every page including login, and today returns
only `{ appEnv }`. It becomes `{ appEnv, brandName }` and nothing else;
`brandName` is operator-set, non-secret display text. A test pins the exact
key set. The SPA uses `DEFAULT_BRAND_NAME` until the fetch resolves (and if it
fails), so a default deployment shows no flash of a different name.
`apps/web/index.html` ships `<title>Wagon Payroll</title>` for the pre-JS
paint.

**D3 — TOTP issuer follows the brand.** `totpIssuer` =
an explicit `totpIssuer` config override, else `TOTP_ISSUER` if set and
non-empty (validated like `BRAND_NAME`; invalid fails boot), else the final
`brandName` (after config overrides are merged). `TOTP_ISSUER` stays as an
override for existing deployments. Neither stack-payroll compose sets it, so
QA and prod new enrollments show "Wagon Payroll". Authenticator entries already
enrolled keep the label "Payroll": the label lives in the user's app, codes are
unaffected, no re-enrollment. Better Auth `appName` (fed from `totpIssuer`)
is used in 1.6.30 only for the TOTP URI (checked in the installed dist).

**D4 — Email copy.** `TemplateContext` gains `brandName`. Product name and
company name stop being glued together ("Acme Payroll"):

The employer's name leads; the brand appears only as the tool that sent the
message (a vendor name in the subject reads as bulk mail or phishing).
Wording from `product-ux-designer` (2026-09-26); HTML and plain-text bodies
carry the same words:

- Subject: `${companyName} — ${subject}`
- Footer: `Sent by ${brandName} on behalf of ${companyName}. This is an automated message — please don't reply. Questions? Contact ${companyName} directly.`
- Invite: `${companyName} has invited you to view your pay and tax documents in ${brandName}, the payroll system ${companyName} uses.` The rest of the paragraph (setup link, 24 hours) is unchanged.
- Password reset: `Someone asked to reset the password for your ${companyName} account in ${brandName}.` Rest unchanged except "contact your administrator" → `contact ${companyName}`.
- New-device sign-in: `Your ${companyName} account in ${brandName} was just signed in to from a device we haven't seen before:` then the device/IP/time list, then `If this wasn't you, contact ${companyName} right away.`
- Test email: `This is a test email from ${brandName} settings for ${companyName}, requested by ${by}. Email delivery is working.` (plain text: "Email delivery is working" replaces "SMTP delivery is working").
- The `<h2>` heading stays `${companyName}`.

`brandName` is HTML-escaped like `companyName`. The tests pin these strings.
Emails are rendered at enqueue, so rows already queued at deploy send with the
old copy. The From display name stays whatever the operator puts in
`SMTP_FROM`; not touched.

**D5 — The `?? "Payroll"` fallbacks are company-name placeholders, not the
product name.** The eight lookups (`notify/outbox.ts`, `deposits/service.ts`,
`filings/service.ts`, `filings/annual.ts`, `payroll/runs.ts`,
`routes/my-invoices.ts`, `contractors/service.ts`, `contractors/recurring.ts`)
all read `company.legalName` and fill it when no company row exists. They are
collapsed onto the one existing helper `companyName()` in `notify/outbox.ts`,
whose fallback becomes `"Your company"`. In `my-invoices.ts` the value is the
payer name on a PDF; putting the product name there would be wrong. A deployment
that has completed company setup never reaches the fallback, so no real email
or document changes from this item.

**D6 — PDFs unchanged.** Payslip and invoice templates carry no product name
today ("Generated from immutable run snapshot · engine … · template …",
"Generated on demand from the payroll system of record"). No template or
template version changes, so no issued payslip renders differently (D5,
GUARDRAILS). Adding the brand to documents is a separate item with a template
version bump.

**D7 — Admin setting: defer.** A DB-backed setting needs a migration, an admin
screen, audit rows, and a rule for which value wins over env. Per-customer
branding only matters with multiple companies, which D12 excludes from v1.
The env setting keeps white-label open; the admin setting belongs to the
multi-company options paper.

**D8 — pay-verify page.** `packages/verify-site` `<title>` becomes
"Wagon Payroll QA verification" and both `<h1>`s "Wagon Payroll — QA
verification" (literal; it is this project's own QA site, built in CI, not a
runtime surface). The meta description keeps the repo name
`payroll-app`, which is a repo reference.

## Surfaces

| Surface | Change |
|---|---|
| `apps/web/index.html` | `<title>Wagon Payroll</title>` |
| `apps/web` runtime config | Move the fetch out of `App.vue` into one composable (`useRuntimeConfig`) shared by `App.vue` and `LoginView.vue`; set `document.title = brandName` |
| `App.vue` header | `.brand` link text = `brandName`; nav item "Payroll" unchanged |
| `LoginView.vue` | Brand name shown above "Sign in" as non-heading text (the "Sign in" heading stays the card's heading; `mobile-login.spec.ts` relies on it) |
| `apps/server/src/config.ts` | `brandName`; `totpIssuer` per D3 |
| `apps/server/src/app.ts` | runtime-config returns `{ appEnv, brandName }` |
| `packages/notifications` | D4 |
| eight fallback sites | D5 |
| `packages/verify-site/src/lib.ts` | D8 |
| `README.md`, `package.json` description, `docs/export-api.md` title, `.env.example` header | "Wagon Payroll" |
| `.env.example`, `compose.example.yml` | add commented `BRAND_NAME` (optional); `.env.example` `TOTP_ISSUER=Payroll` becomes a commented override |
| `docs/deployment.md` | env table: `BRAND_NAME` row; `TOTP_ISSUER` default = brand name |
| `docs/qa.md` | runtime-config returns `{ appEnv, brandName }` |
| `CHANGELOG.md` | `### Changed` entry |

`compose.example.yml` keeps working with no new variable set (D9).
stack-payroll needs no change.

## Tests that must fail first

Server (vitest):
1. `parseBrandName`: unset / `""` / whitespace → `"Wagon Payroll"`; `" Acme "` →
   `"Acme"`; 61 chars, `"A\r\nBcc: x"`, `"A\u0000"`, LRO U+202D, RLO U+202E,
   U+2028 → throw.
2. `loadConfig`: no env → `brandName` and `totpIssuer` both `"Wagon Payroll"`;
   `BRAND_NAME=Acme` → both `"Acme"`; `TOTP_ISSUER=Old` → issuer `"Old"`,
   brand unchanged; `loadConfig({ brandName: "X" })` → issuer `"X"`; invalid
   `TOTP_ISSUER` → throw.
3. `qa-runtime.test.ts`: body `toEqual({ appEnv: "production", brandName: "Wagon Payroll" })`
   (exact key set), and the override case.
4. Onboarding TOTP setup: returned `totpURI` has `issuer=Wagon%20Payroll`.
5. Notification templates: subject/footer/invite text match D4 exactly;
   `brandName` containing `<b>` is escaped; no output contains
   `"<companyName> Payroll"`.
6. `companyName()` with no company row → `"Your company"`.

E2E (Playwright, against the default deployment):
7. Login page: `toHaveTitle("Wagon Payroll")`; brand text visible in the card;
   "Sign in" heading still found by role.
8. After sign-in: header brand link reads "Wagon Payroll"; nav item "Payroll"
   still present and routes to `admin-payroll`.

verify-site:
9. Rendered HTML has `<title>Wagon Payroll QA verification</title>` and the
   D8 `<h1>`.

## Migration and rollback

No schema change, no data change, no migration. Rollback = redeploy the
previous image tag through the normal release/pin path. What a rollback does
not undo: TOTP entries enrolled while this version ran keep the label
"Wagon Payroll" (cosmetic; codes stay valid), and emails already sent keep
their copy.

## PR plan

One PR is small enough; if split, in this order:

1. Server: `@payroll/shared` brand module, config, runtime-config, TOTP issuer,
   notifications copy, fallback consolidation, docs/env/compose/CHANGELOG.
   Tests 1–6.
2. Web + pay-verify: composable, title, header, login card, verify-site title,
   README. Tests 7–9.

Gates: `code-qa`; `product-ux-designer` on D4 copy and the login card;
`security-privacy-reviewer` on the runtime-config response change (D2) and
D1 validation.

## Out of scope

Everything listed under Scope/Out; a DB/admin brand setting (D7); brand on
PDFs (D6); per-company branding; logo and colour tokens.
