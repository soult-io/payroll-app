# Spec 15 — Plane (project management) deployment

Status: `DRAFT — awaiting owner sign-off` · Owner direction 2026-08-03 ("ok let's go with plane") · Independent of Specs 13–14; moves to `nsoult-agentic/stack-plane` when created

Self-hosted Plane Community Edition for project/feature tracking — the web UI for the
owner, programmatic access for the agent. Follows the house convention: private gitops
stack repo in `nsoult-agentic`, official published images, NPM proxy host.

## 1. Stack

New repo `nsoult-agentic/stack-plane` (private) with a compose adapted from Plane's
official self-host file, images **pinned by version** (no `:latest`):

- `plane-web`, `plane-api`, `plane-worker`, `plane-beat` (official makeplane images)
- `plane-db` (postgres:16-alpine, own volume), `plane-redis` (valkey or redis, own volume)
- Data + uploads on `/srv/plane/`; secrets in `/srv/plane/secrets` (db password,
  secret key) — filesystem only, never committed
- Resource budget: ~2 CPU / 4 GB — well within NUC headroom

## 2. Access & exposure

- `plane.stabpablo.eu` via NPM proxy (TLS as usual). Plane CE self-hosted has **no
  OIDC/SSO** — plain email/password accounts; acceptable at this scale (documented
  limitation, not a blocker).
- Owner admin account + one **agent service account** (API key / PAT) used for
  programmatic access. The agent reads/writes via the REST API directly (issues,
  cycles, modules, comments) and optionally the official `plane-mcp-server` if we later
  wire it into the MCP fleet.
- No public signup; invites only.

## 3. Usage conventions (documented in the stack README)

- One Plane project per software project (`payroll-app` first); modules = feature
  areas; cycles = monthly cadence, or ad-hoc.
- Specs remain canonical in each repo's `plan/specs/*.md`; Plane work items **link** to
  spec files/commits — Plane is the tracker, git is the truth.
- GitHub integration (bidirectional issue sync) is available in CE — enable for
  `soult-io/payroll-app` so bugs filed on GitHub appear on the board.
- Backup: DB + uploads covered by the same backup routine as other `/srv` stacks
  (verify the existing NUC backup covers `/srv/plane`; add if not).

## 4. Non-goals

- No migration of existing data (nothing to migrate — GitHub issues stay where they
  are; sync going forward only).
- No paid tier features (time tracking, workflows/approvals are Pro/Business).
- No agent automation beyond read/write via API (no auto-triaging bots in v1).

## Decisions for owner verification

| # | Question | Proposal |
|---|---|---|
| D33 | `nsoult-agentic/stack-plane`, official images version-pinned, `/srv/plane` data | as above |
| D34 | `plane.stabpablo.eu` via NPM; no SSO (CE limitation); invite-only accounts | as above |
| D35 | Agent access via service-account API key (REST first; optional MCP server later) | as above |

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
