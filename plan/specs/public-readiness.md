# Spec 16 — Public readiness (open-source release)

Status: `EXECUTED 2026-08-09` — scrub verified (zero PII/infra hits in tracked sources), CI green, history archived, fresh-start root commit `bee59be` force-pushed to `main`. Remaining: owner repo-settings clicks (fork-PR guardrail, visibility flip). · Direction: owner 2026-08-08 ("draft the spec, with the fresh-start history" / "approve as written") · Independent of Specs 13–15; no code architecture changes

**Execution note (D37 deviation):** the history mirror was created by the owner at
`soult-io/payroll-app-history` (private) rather than `nsoult-agentic/payroll-app-history`.
Functionally equivalent (private, invisible to the public); all 135 pre-public commits +
all refs archived and verified at head `122a2a8`. Transfer to `nsoult-agentic` remains
possible later if the house convention is preferred.

Audit-driven plan to flip `soult-io/payroll-app` from private to public as a credible
open-source project. The spec-13 split already achieved the structural groundwork
(artifact-only repo, zero secrets, reference compose); this spec covers everything
between that and pressing the "make public" button.

## 1. What the 2026-08-08 audit found

Verified by direct inspection (not recollection):

- **No LICENSE file** — public without a license is "all rights reserved", not open source.
- **Real PII/financials in the tree** — `plan/specs/recurring-invoices.md` names a real
  contractor with real contract amounts; `plan/specs/migration.md` + `docs/cutover.md`
  document the real `legacy_accounting` cutover, `/srv` secret paths, and mailbox setup.
- **Internal infrastructure disclosure** — internal hostname references plus runner, server, and tooling mentions across `plan/`, `docs/`, `.github/workflows/`.
  `e2e-nightly.yml` hardcodes the live QA hostname.
- **Git history** — 127 commits from day one contain all of the above; scrubbing working
  files alone does not remove it.
- **Missing community files** — no CONTRIBUTING, SECURITY, CODE_OF_CONDUCT.
- **Insider-context docs** — README references private repos (engine provenance,
  legacy cutover); `docs/cutover.md` is purely internal ops.

Already good (no action): zero secrets in tree or history (passwords/keys have only
ever been `/srv` files), deliberately-fake QA credentials, reference
`compose.example.yml`, real CI + test suite, solid README skeleton.

## 2. Fresh-start history (owner pre-approved 2026-08-08)

At flip time, the public repo gets a **new single root commit** ("public release
vX.Y.Z" — the then-current release), force-pushed over `main`. Rationale: 127 commits
of embedded internal refs make scrub-in-place (BFG/filter-repo) high-effort and still
leaky; a fresh start is total and cheap.

- **Full history is preserved privately**: before the force-push, push the complete
  repo to a new private mirror `nsoult-agentic/payroll-app-history` (and the existing
  local clones retain everything regardless). The public repo's "restarted" state is
  acknowledged in the public README ("developed privately; history opens from vX.Y.Z").
- **What survives the flip**: GitHub Issues/PRs/Actions/ Releases are repo metadata,
  not git history — they persist (dangling commit refs in old issues are acceptable;
  there will be few). ghcr images already published are untouched; the stack repo's
  pin-bot reads image tags, not git — no impact.
- **Day-2 workflow**: development continues on the now-public repo exactly as today.
  Internal-only notes simply don't get committed (they live in Plane / stack repos).

## 3. Content scrub (before the fresh-start commit)

Everything below happens on the CURRENT history, so the fresh-start commit captures
the scrubbed state:

1. **PII**: `recurring-invoices.md` — replace the real contractor name/amounts with a
   generic persona ("a contractor on a monthly retainer"); sweep all `plan/` +
   `docs/` for real names, amounts, addresses. Test fixtures with obviously-fake
   persona names stay.
2. **Internal runbooks move to the ops repo**: `docs/cutover.md` and the internal
   sections of `docs/qa.md` (the QA runner runbook) move to
   `nsoult-agentic/stack-payroll` — they describe OUR deployment, not the product.
   `docs/qa.md` keeps a public-generic QA description (APP_ENV, seed:qa, Mailpit,
   self-hosted runner pattern) without our hostnames.
3. **Domain genericization**: internal hostnames → `payroll.example.com`-style
   placeholders everywhere in the public tree (`docs/`, `compose.example.yml`,
   e2e config, workflows, spec files). legacy-source, internal-project, file-store, runner, server, and tooling references reworded to generic equivalents
   ("the legacy accounting database", "a self-hosted runner inside the QA network").
4. **README pass**: remove insider provenance, add License/Contributing/Security
   sections, keep the quickstart verifiable by an outsider (§6 verification).
5. **`plan/` stays public, scrubbed** — the decision/spec history is genuinely good
   design documentation and a selling point for contributors. Only personal/infra
   references are genericized; the engineering content is untouched.

## 4. Workflows & repo settings

- `e2e-nightly.yml`: QA base URL moves from a hardcoded hostname to a **repo
  variable** (`vars.QA_E2E_BASE_URL`) — non-secret config, keeps the private hostname
  out of the public tree. The job self-skips cleanly when the variable is unset
  (forks/contributors get green CI without our infra).
- **Fork-PR guardrail (before flip, hard requirement)**: repo Settings → Actions →
  "Require approval for all outside collaborators". The nightly is schedule-only and
  PR-triggered jobs run on GitHub-hosted runners, so the self-hosted QA
  runner is never reachable from fork code — this setting keeps it that way.
- Branch protection on `main` (PR + green CI), already the de facto workflow.
- ghcr package: link to repo, make the package public at flip (anonymous pulls);
  the stack repo's `UPSTREAM_READ_TOKEN` keeps working either way.

## 5. Community files

- `LICENSE` per D36 (full text, repo root — GitHub auto-detects).
- `CONTRIBUTING.md` — dev setup, test/lint commands, PR expectations, spec-process
  pointer (`plan/`).
- `SECURITY.md` — report via GitHub private vulnerability reporting; scope note
  (self-hosted app; the QA instance is not a target).
- `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1.
- Issue templates: bug report + feature request (lightweight).
- No per-file license headers (D38).

## 6. Verification before flip

- Grep sweep on the public tree: zero hits for internal hostnames, the legacy source name, internal project and tooling names, real names, real amounts.
- Fresh clone on a clean machine: `pnpm install` → unit tests green → biome 0
  errors → ephemeral e2e green.
- Outsider deploy test: follow only README + `compose.example.yml` on a throwaway
  host → app boots, seed runs, login works.
- GitHub's community profile checklist (repo Insights → Community) all green.

## 7. What stays private (forever)

- All `nsoult-agentic/*` stack repos (our deployments, pins, secrets references).
- `nsoult-agentic/payroll-app-history` (full pre-public git history mirror).
- Plane (internal planning). Public users file GitHub Issues; we mirror what we act
  on into Plane as we see fit. The public roadmap lives in GitHub (milestones/
  projects), not Plane.

## 8. Explicit non-goals

- No launch/marketing (no Show HN, no package registries beyond ghcr, no docs site).
- No code architecture changes; no new features.
- No relicensing of the vendored engine needed — it is owner-authored throughout.
- Stack repos are never made public by this spec.

## Decisions for owner verification

| # | Question | Proposal |
|---|---|---|
| D36 | License | **AGPL-3.0** — same as Embara; blocks hosted copycats if a paid product ever happens, dual-licensing stays possible since you own 100% of the code (no outside contributions before flip; CLA question deferred until the first external PR). Alternatives: MIT (max adoption, zero protection), Apache-2.0 (patent grant), BSL (source-available, not OSI-open) |
| D37 | Fresh-start history at flip; private mirror at `nsoult-agentic/payroll-app-history` | as written (pre-approved 2026-08-08) |
| D38 | `plan/` stays public (scrubbed); no per-file license headers | as written |
| D39 | Legacy `migrate/` CLI stays in the public tree (inert without the legacy source DB); internal cutover runbook moves to the stack repo | as written |
| D40 | Public issues/roadmap on GitHub; Plane stays internal-only | as written |

## Owner sign-off

- [x] Approved as written — 2026-08-08
- [ ] Approved with changes (list):
