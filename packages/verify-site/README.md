# @payroll/verify-site (pay-verify dashboard) — spec 17 chunk B / PAY-44

A static, PII-free QA-verification dashboard for payroll-app, modelled on
`ta-verify` for Teacher Assistant. It **renders**, it does not test: the input is
the `verify-summary` history produced by chunk A (PAY-43).

## What it shows
- Latest overall status (pass/fail), timestamp, commit, source.
- Per-suite breakdown (engine / server / e2e) with counts + durations.
- Recent-runs history with per-run pass rate.
- A link to the full Playwright html report.

Rich per-journey and tax-worksheet correctness cards are chunk C (PAY-45).

## Generate locally
```sh
pnpm --filter @payroll/verify-site build
node packages/verify-site/dist/generate.js --history <dir-of-summary.json> --out dist/site --report-href report/
```
(The generated site goes to `dist/site`; the compiled generator JS stays at `dist/` root and is never served.)
An absent/empty history dir renders the "awaiting first run" page. Every summary
is validated against the `@payroll/verify-summary` schema and re-checked
PII-free before it is rendered.

## Serving
`Dockerfile` builds `ghcr.io/soult-io/wagon-payroll-verify` (also pushed as the
legacy `ghcr.io/soult-io/payroll-app-verify` until the PAY-68 cutover ends) — an unprivileged
nginx (uid 101, port 8080) that serves the pre-generated `dist/`. No build stage:
the `pay-verify-site` workflow generates `dist/` and hands it to the image. TLS +
the LAN/VPN access gate are the BCN NPM's job (chunk D / PAY-46).

## History
The `pay-verify-site` workflow keeps recent summaries on the orphan
`pay-verify-data` branch (append + prune), checks it out as the `--history` dir,
generates, then builds + pushes the image.
