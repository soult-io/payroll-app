# Spec 7 — Frontend

Status: `DRAFT — awaiting owner sign-off` · Depends on: D2, all backend specs

## Stack & structure

- **Vue 3 + Vite SPA** (no SSR — everything behind login), TypeScript strict, Pinia for
  session/user state, Vue Router with role guards, **PrimeVue 4.x pinned** with the
  **Material preset** as the day-one theme (polish pass = token/preset swap).
- API client: generated from the backend's OpenAPI spec (`openapi-typescript` + a thin
  fetch wrapper) — end-to-end types from DB to template. Forms: VeeValidate + the same
  Zod schemas the API uses (shared package), so validation can never drift.
- Business logic lives in composables, not templates (keeps any future component-library
  migration cheap; mitigates the PrimeVue a11y risk).

## Route & screen inventory

**Public (unauthenticated)**
- `/login` — password → TOTP challenge (two-step screen)
- `/accept-invite/:token` — set password + forced TOTP enrollment + backup codes (onboarding wizard, PrimeVue Steps)
- `/reset-password/:token` — same flow minus enrollment

**Employee (`/my/*`, role: employee)**
- `/my/dashboard` — latest payslip summary card, pending request statuses, quick links
- `/my/payslips` — DataTable of issued payslips (period, gross, net, YTD) + row → detail
- `/my/payslips/:id` — payslip detail (earnings/deductions/employer-cost breakdown, YTD) + "Download PDF" button
- `/my/profile` — read-only current info (address, W-4 summary, bank masked, legal name) + per-section "Request change"
- `/my/requests` — my change requests with status chips + thread view (Timeline component)
- `/my/requests/new` — type picker → type-specific form (address fields / W-4 fields / bank / legal name) with effective-date picker
- `/my/settings` — notification toggles, password change, TOTP management, active sessions list

**Admin (`/admin/*`, role: admin; admins also get `/my/*`)**
- `/admin/dashboard` — pending approvals (payroll drafts + change requests) inbox-style, outbox health card
- `/admin/payroll` — runs DataTable (all statuses, filterable); row-expansion shows entries breakdown
- `/admin/payroll/:id` — run review: computed figures from snapshot, inputs used, approve / issue / void actions (ConfirmDialog + audit note)
- `/admin/employees` — employee list; detail page: profile, compensation history editor (effective-dated table), W-4 history, invite/resend-invite, disable
- `/admin/requests` — pending change requests inbox (badge count in nav); detail: side-by-side current-vs-proposed diff, effective-date picker, thread, approve/deny
- `/admin/config` — payroll configuration editors:
  - tax tables: per-year `tax_config` scalars + bracket grid editor (add/edit years)
  - pay schedules: draft day (default 15), pay day, auto-draft toggle, manual "generate draft now"
  - company profile (name, EIN masked, address)
- `/admin/settings` — SMTP status + test email, notification outbox viewer, audit log viewer (auth_events + audit_events DataTables), user management

## UX conventions

- Money always formatted `$1,234.56` via a single composable; inputs use PrimeVue
  `InputNumber` (currency mode) / `InputMask` (SSN, routing).
- All mutating actions: ConfirmDialog + Toast feedback; destructive/irreversible actions
  (issue payslip, void run, disable user) get explicit type-to-confirm or second-step dialogs.
- Status as colored chips matching the state machines (draft/awaiting/approved/issued/void;
  pending/approved/denied/withdrawn).
- Responsive: tables collapse to cards on mobile; the whole app is usable on a phone
  (employee self-service is the mobile-first surface).
- Empty states everywhere (a fresh install with one employee must not look broken).
- a11y: keyboard-navigable flows, labeled inputs, focus management on dialogs; formal audit
  deferred to the polish pass (known PrimeVue weakness).

## Build

Vite static build served by the Fastify process itself (single container, one port, same
origin → no CORS). Dev: Vite dev server proxies `/api` to the local backend.

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
