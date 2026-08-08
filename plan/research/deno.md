# Deno vs Node.js LTS — Supplementary Research (owner-requested check, verified July 2026)

**Verdict: No — stay on Node.js LTS.** Deno is genuinely more stable than Bun, but its risk
concentrates exactly where this stack lives, with no compensating win.

## Key findings

1. **Stability:** Deno is V8 + Rust (Tokio); no Bun-style memory-leak chorus. But the *npm-compat
   layer* regresses repeatedly — a `npm:pg` TLS-to-Postgres regression shipped in Deno 2.7.x
   (April 2026, [#33296](https://github.com/denoland/deno/issues/33296)), a repeat offender in the
   node-compat TLS-upgrade path. For an app whose lifeline is a Postgres connection, this is the
   exact wrong risk profile.
2. **This exact stack on Deno:**
   - Drizzle ORM ✅ officially supported
   - pdf-lib/pdfmake ✅ pure-JS, low risk
   - **pg-boss ⚠️** untested by its maintainer outside Node; inherits pg TLS risk + depends on
     faithful `node:events` semantics in a polling loop
   - **Better Auth CLI ❌** officially not compatible with Deno ([#8154](https://github.com/better-auth/better-auth/issues/8154))
     — schema/migration generation needs a Node sidecar
   - **Deno.cron ❌** still unstable in 2026 (`--unstable-cron`), and self-hosted it's a
     non-persistent in-process timer — no transactional enqueue, no retries. Cannot replace a
     Postgres-backed queue.
   - Fastify ⚠️ untested target; Hono is idiomatic on Deno — but Hono also runs on Node
3. **No compensating win:** memory footprint is a wash (both V8; mixed benchmarks, one long-standing
   report shows Deno RSS ~2× Node), Docker story comparable, money math identical.
4. **Longevity asymmetry:** Deno now has an LTS channel but lines live ~6–9 months vs Node's ~30;
   Deno Land's last public funding was 2022; Ryan Dahl's May 2025 post conceded the edge strategy
   missed and Deno KV is stuck in permanent beta. Node = 30-month LTS, OpenJS, boring dominance.
5. **Contributor funnel:** Deno narrows it — toolchain install + the project's own CLI tooling hits
   exactly Deno's broken corners.

## Revisit condition

Greenfield, stateless edge API (Hono + Drizzle + external managed queue): Deno is legitimate.
For this payroll app it solves nothing Node doesn't and adds three new risk surfaces (pg TLS compat,
untested job queue, unsupported auth CLI).

Sources: [The Register on Bun leaks](https://www.theregister.com/software/2026/04/21/bun-1113-out-with-memory-fixes-as-dev-complain-of-leaks/5221154) ·
[Deno node compat docs](https://docs.deno.com/runtime/fundamentals/node/) ·
[Deno stability & releases](https://docs.deno.com/runtime/fundamentals/stability_and_releases/) ·
[Dahl: Reports of Deno's demise](https://deno.com/blog/greatly-exaggerated) ·
[Deno cron announcement](https://deno.com/blog/cron)
