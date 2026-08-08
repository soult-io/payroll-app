# Spec 13 — Repo/stack split & release model

Status: `APPROVED 2026-08-03 — implemented (app-repo side)` · Owner direction 2026-08-03 · Depends on: nothing (unblocks Spec 14 QA env and Plane)

Treat payroll-app like an open-source project: the app repo is **only** the app and a
published container; all personal operations live in a private stack repo, matching the
house convention (every self-hosted service has `nsoult-agentic/stack-<name>` — payroll is
currently the lone exception, with its app repo doubling as its own deployment repo).

## 1. App repo (`soult-io/payroll-app`) — artifact only

- **Remove** the production `docker-compose.yml` and the `[skip ci]` self-pinning bot.
  The app repo must be runnable by a stranger and contain zero personal config.
- **Add** `compose.example.yml` (app + postgres + migrate one-shot, env placeholders),
  `docs/deployment.md` (full env-var reference, SECRETS_DIR contract, migrate-then-boot
  explanation), and a README quickstart.
- **CI publishes images** to `ghcr.io/soult-io/payroll-app`:
  - every green merge to `main` → `sha-<full-sha>` tag (as today)
  - every release tag `vX.Y.Z` → `vX.Y.Z` + `vX.Y` + `latest` tags
- Repo and ghcr package stay **private for now**; flipping to public is a separate
  future decision (license choice — AGPL vs BSL vs MIT — deferred to that moment,
  recorded as an open decision).

## 2. New private stack repo (`nsoult-agentic/stack-payroll`)

```
stack-payroll/
├── prod/docker-compose.yml   # payroll-app (pinned image), payroll-db, migrate one-shot
├── qa/docker-compose.yml     # Spec 14 — payroll-qa app+db, Mailpit, seed:qa
└── README.md                 # runbook: redeploy, seed, secrets layout, rollback
```

- Secrets stay on the home server filesystem exactly as today (`/srv/payroll/secrets`,
  `/srv/payroll-qa/secrets`) — referenced by compose `secrets:`, never committed.
- **GitOps deployer**: two gitops stacks pointing at the same repo, different compose paths —
  prod (`prod/`, replaces the current stack 169 git URL) and QA (`qa/`, Spec 14).
  Reverse-proxy hosts unchanged for prod (`payroll.example.com`); QA gets its own host.

## 3. Release model — two gates, prod moves only on releases

**Amended 2026-08-03 (owner: "the stack repo should be responsible for releasing our
production / qa builds" — the original push model coupled the app repo to our ops repo,
backwards for an OSS-style artifact). The dependency now points the right way: the app
repo only publishes artifacts; the stack repo PULLS updates to its own pins.**

- **App repo is pure**: merges to `main` → `sha-*` images; release tag `vX.Y.Z` →
  `vX.Y.Z` + `vX.Y` + `latest` images + GitHub release. It has no knowledge of any
  deployment repo and holds no cross-repo credential. (Release PR — CHANGELOG +
  version bump — is still proposed by agent/CI and owner-merged; gate 1.)
- **Stack repo owns its deployment lifecycle** via a scheduled workflow *in the stack
  repo* (`pin-update.yml`), using its own same-repo `GITHUB_TOKEN`:
  - **QA auto-follows `main`**: polls for the latest green `sha-*` image tag → bumps
    `qa/docker-compose.yml` pin, commits `[skip ci]` → the GitOps deployment redeploys QA
    automatically. QA breakage is free.
  - **Prod follows tagged releases only**: polls for the newest `v*` release → opens a
    **prod-pin PR** (gate 2) → owner merges → the GitOps deployment redeploys prod (migrate
    one-shot runs first, as today).
- The stack repo holds one **read-only upstream credential** (`UPSTREAM_READ_TOKEN`:
  packages+contents read on `soult-io/payroll-app`) because the package/repo are
  private — the same consumer-reads-upstream relationship the home server already has pulling
  images from ghcr. Nothing upstream holds any credential for the stack repo.
- Nothing in prod can move without a release PR merge and a prod-pin PR merge — two
  explicit owner approvals, both now on the correct side of the boundary.
- `docs/cutover.md` and `plan/specs/deployment.md` updated to describe the new flow.

## 4. Migration steps (ordered, zero downtime)

1. Create `nsoult-agentic/stack-payroll` (private) with prod compose extracted verbatim
   from the app repo (current pinned image) + README.
2. Re-point GitOps stack 169 (`soult-io-payroll-app`) git URL to the new repo,
   path `prod/`. Verify a no-op redeploy.
3. App repo: delete compose + self-pin bot, add example/docs, merge. (CI's pin-bot
   target switches to the stack repo in the same PR; QA pin lands with Spec 14.)
4. Confirm prod unaffected; archive the old compose from git history knowledge.

## Decisions for owner verification

| # | Question | Proposal |
|---|---|---|
| D26 | Stack repo `nsoult-agentic/stack-payroll`, prod/qa compose paths, two gitops stacks | confirmed by owner 2026-08-03 |
| D27 | QA follows main (auto pin-bot), prod follows tagged releases only | as above |
| D28 | Release mechanics: agent/CI proposes release PR → owner merges → tag workflow → prod-pin PR → owner merges (two gates) | as above |
| D29 | Repo + ghcr package private now; public flip + license choice is a future explicit decision | as above |

## Owner sign-off

- [x] Approved as written — 2026-08-03
- [ ] Approved with changes (list):
