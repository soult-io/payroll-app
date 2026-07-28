# Backend Technology Decision Matrix — Payroll Webapp (2025–2026 ecosystem verified)

## Executive summary

**Recommendation: Go (chi or Gin + pgx + River), with Node.js LTS + TypeScript (Fastify + Drizzle) as the close second.** Go wins on the two heaviest criteria (payroll-grade correctness + NUC footprint) and has a uniquely fitting Postgres-backed job queue (River) that eliminates a Redis container. Node/TS loses the matrix but has one project-specific trump card — the existing tested TypeScript payroll math — which can flip the decision if rewrite risk dominates.

---

## 1. Decision matrix (scores 1–5, weights from criterion order: 6/5/4/3/2/1, max 105)

| Criterion (weight) | Bun+TS (Hono/Elysia) | Node LTS+TS (Fastify) | Go (chi/Gin) | Rust (Axum) | Python (FastAPI) | C# ASP.NET Core | Elixir/Phoenix |
|---|---|---|---|---|---|---|---|
| **1. Reliability/correctness for payroll (×6)** | 3 — JS `number` is float64; needs decimal.js + Zod discipline; types are compile-time only, erased at runtime | 3 — same float hazard, but mature patterns (Prisma `Decimal`, Drizzle numeric-as-string + mapping) | 4 — `shopspring/decimal` or int64-cents is standard practice (Stripe-style); pgx transactions/sqlc compile-checked SQL | 5 — `rust_decimal` + sqlx compile-time-verified queries; strongest type enforcement | 3 — `decimal.Decimal` + Pydantic `condecimal` + SQLAlchemy `Numeric` is great at runtime, zero compile-time enforcement | 5 — `decimal` is a first-class 128-bit keyword type; best language-level money story | 4 — Decimal hex package + Ecto changesets/multi are excellent, but dynamically typed |
| **2. NUC footprint (×5)** | 3 — JSC is light (~40–60 MB idle), but documented intermittent memory leaks and a "72h+ long-running process" caveat are red flags for an always-on payroll service | 3 — Fastify idles ~50–90 MB; fine in 256–512 MB limits, but BullMQ would add a Redis container (~10–30 MB) | 5 — real-world baselines: Gin ~18 MB, Echo ~22 MB idle; leaves huge headroom | 5 — Axum idles ~5 MB RSS, no GC pauses; best-in-class | 3 — FastAPI ~48 MB bare, realistically 100–250 MB with uvicorn workers (GIL ⇒ multi-process) | 3 — Native AOT gets ~19–21 MB working set, but EF Core is not AOT-compatible; realistic JIT deployment is ~50–150 MB and needs container-GC tuning | 3 — BEAM idles ~60–120 MB; respectable, not tiny |
| **3. Throughput headroom (×4)** | 5 — fastest JS runtime in 2025–26 benchmarks | 4 — more than enough; DB is the real bottleneck | 5 — ~80–95k rps framework class; irrelevant headroom here | 5 — ~2× Go in synthetic API tests | 2 — weakest; fine for this load but no headroom story | 5 — Kestrel is top-tier on TechEmpower-class benchmarks | 4 — elite concurrency (websockets), modest raw throughput |
| **4. Ecosystem for YOUR needs (×3)** | 3 — Drizzle/Bun.sql Postgres good; PDF (pdf-lib) fine; jobs = node-cron or BullMQ+Redis; auth via Better Auth; ~98% npm compat with native-addon gaps | 5 — everything boring-mature: Drizzle/Prisma, **pg-boss** (Postgres queue — skip Redis!) or BullMQ, node-cron, pdf-lib/pdfmake, nodemailer, Better Auth | 4 — **River** (Postgres-backed, transactional enqueue, cron/periodic jobs, Web UI) is a perfect fit; pgx/sqlc/goose; gomail; weak spot: PDF (see risks) | 3 — sqlx great; jobs = apalis (maturing, Postgres-backed) or croner; lettre SMTP good; PDF thin (printpdf/genpdf immature; HTML→PDF needs headless Chromium) | 4 — best PDF story (WeasyPrint/ReportLab/fpdf2); APScheduler/Alembic mature; Postgres queues (procrastinate) niche | 5 — EF Core + Npgsql + migrations; **Hangfire** (Postgres cron jobs, River/Oban were inspired by it); **QuestPDF** excellent (⚠ Community license free only <$1M revenue); MailKit; ASP.NET Identity | 4 — **Oban** is best-in-class (Postgres, cron plugin, unique jobs, transactional insert); Swoosh SMTP; PDF weak |
| **5. Maintainability + OSS contributor pool (×2)** | 3 — young, fast-moving; smaller pool | 5 — largest pool on earth; the payroll math is *already TS with tests* — zero rewrite risk on the most correctness-critical code | 4 — huge pool, simple language, great docs; math port required (mechanical, tests port too) | 2 — steep learning curve, slow compiles, thin contributor pool for a small-business OSS product | 4 — enormous pool, highly readable; math port required | 3 — big enterprise pool, less indie-OSS culture; math port required | 1 — smallest pool; choosing it for an OSS product caps contributions |
| **6. Deployment (×1)** | 4 — small image, `bun build --compile` single binary | 3 — slim images ~100–150 MB; no clean single-binary | 5 — single static binary, scratch/distroless ~10–20 MB, trivial observability | 5 — single static binary, smallest images | 2 — fat images, multi-process, no binary | 3 — AOT binary possible but constrained; JIT images ~100–220 MB | 4 — OTP releases are clean single artifacts |
| **Weighted total** | **72** | **77** | **94** | **93** | **63** | **89** | **73** |

---

## 2. What the research changed vs. common assumptions

- **Bun is genuinely production-viable in 2026** (1.3 shipped builtin Postgres/MySQL/Redis clients; ~98% npm compat) — but the recurring caveat from production case studies is *intermittent memory leaks and long-running-process stability vs. V8*. For a payroll service that must run unattended for months on a NUC, that's disqualifying at the margin, not the speed.
- **Go's PDF ecosystem is its one real gap**: `jung-kurt/gofpdf` was archived in 2021 (the `phpdave11/gofpdf` fork and Maroto v2 carry on), and HTML→PDF means headless Chromium (Rod/chromedp) — a 300–500 MB spike you don't want on a NUC. For *tabular payslips generated on demand*, canvas-style generation is actually fine.
- **.NET is the dark horse**: first-class `decimal`, Hangfire, QuestPDF — it scored 89 despite footprint. If the app ever moves off the NUC to a real VPS, it becomes arguably the best payroll stack.
- **Postgres-backed job queues matured everywhere** (River for Go, Oban for Elixir, pg-boss for Node, Hangfire for .NET) — no Redis needed for the cron-like payroll schedule on any stack. This removes Node's main NUC disadvantage.

## 3. Top-2 recommendation and deciding arguments

### #1: Go — chi (or Gin) + pgx + River + shopspring/decimal + goose migrations

1. **Wins the two heaviest-weighted criteria simultaneously.** ~15–25 MB idle and a single 10–20 MB static binary is the best possible fit for a 256–512 MB container budget; typed structs + pgx transactions + decimal give compile-time payroll correctness Python/TS can't.
2. **River is the exact right job system**: jobs enqueue *inside the DB transaction* (no lost/phantom payroll runs), supports periodic/cron jobs and unique jobs (idempotent monthly payroll generation), has a Web UI — all backed by the Postgres already running. No Redis.
3. **Correctness-critical math is a contained port.** A pure TS math module with unit tests ports to Go mechanically; the tests port alongside and give a differential-test oracle against the TS original.
4. **Open-source small-business friendliness**: huge Go pool, dead-simple `docker run` single-binary install for self-hosters — the same reason tools like Gitea/PhotoPrism/Vikunja dominate self-hosted OSS.

### #2: Node.js LTS + TypeScript — Fastify + Drizzle + pg-boss + pdf-lib

1. **Zero rewrite of the payroll math.** The single strongest correctness argument in the whole analysis: the most dangerous code to port is the payroll math, and Node ships the *already unit-tested* TS module untouched.
2. **Best OSS contributor funnel** — if the project is open-sourced or sold, TS maximizes drive-by PRs and integrators.
3. **Every v1 feature has a boring, mature library**, and pg-boss (Postgres-backed) covers the cron schedule without Redis, keeping it to a two-container deploy (app + Postgres).
4. Accept the tax: enforce money as integer cents or decimal.js at the domain boundary, Zod-validate all inputs (types vanish at runtime), and budget ~100–150 MB RAM.

**Flip condition:** if "don't touch the math" outweighs "optimal NUC residency," take Node and never look back.

**Why not Rust despite scoring 93:** footprint/correctness scores are stellar, but contributor pool, iteration speed for a solo dev building features like approval workflows and comment threads, and the weak PDF/job-scheduling ecosystem make it the wrong tool for a CRUD-and-workflow product.

## 4. Risks of the Go choice & mitigations

| Risk | Mitigation |
|---|---|
| **PDF generation is the weakest ecosystem link** (gofpdf archived; Chromium too heavy for NUC) | Payslips are fixed-layout tables — use `phpdave11/gofpdf` or **Maroto v2** (actively maintained). Alternative: shell out to the **Typst** single binary (~30 MB) for templated PDFs — a clean escape hatch. |
| **Porting payroll math introduces transcription bugs** | Port the unit tests first (they're the spec); add property-based tests (`pgregory.net/rapid`) for withholding/bracket edge cases; run differential tests TS-vs-Go during migration. |
| **`shopspring/decimal` vs Postgres `NUMERIC` impedance** | Store everything as `NUMERIC(19,4)`; scan via pgx into `decimal.Decimal`; define rounding mode centrally (half-up, per IRS Pub 15 conventions) in one package — never inline. |
| **River adds tables + a polling worker to Postgres** | In-process (same binary); set conservative `MaxWorkers`, unique jobs keyed by pay-period for idempotent monthly generation, enable the pruner. |
| **Effective-dated config correctness is app logic, not framework** | Whichever stack: temporal tables with `valid_from/valid_to`, non-overlap via exclusion constraints, resolve config *as of pay date* inside the payroll transaction. |
| **Internet exposure of a home-hosted payroll app** | Framework-independent: TLS terminator, rate limiting, Argon2id/bcrypt auth, invite-only registration. |

## 5. Sources

- Bun state 2025–26: [Bun 1.3 release blog](https://bun.com/blog/bun-v1.3) · [devclass on Bun 1.2/Postgres client](https://www.devclass.com/development/2025/01/17/bun-update-brings-chrome-debugging-and-controversial-s3-api-postgresql-client-coming-soon/1622342) · [Bun+Postgres guide (OneUptime)](https://oneuptime.com/blog/post/2026-01-31-bun-postgresql/view)
- Go jobs/frameworks/money: [River homepage](https://riverqueue.com/) · [Brandur on transactional job queues](https://brandur.org/river) · [memory baselines (appetizers.io)](https://appetizers.io/en/blog/go-web-frameworks-production-performance-comparison/) · [shopspring/decimal docs](https://pkg.go.dev/github.com/shopspring/decimal) · [Go PDF landscape (DocRaptor)](https://docraptor.com/go-pdf-generation)
- Node/TS: [BullMQ vs Trigger.dev feature matrix](https://trigger.dev/vs/bullmq) · [Drizzle vs Prisma 2026 (MakerKit)](https://makerkit.dev/blog/tutorials/drizzle-vs-prisma)
- Rust: [Axum production guide 2026 (rustify)](https://rustify.rs/articles/rust-backend-development-axum-2026) · [idle RSS: Axum ~5 MB vs FastAPI ~48 MB](https://rustlang.com.br/blog/rust-vs-python-2026/)
- .NET: [ASP.NET Core Native AOT docs (Microsoft)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0) · [container GC memory tuning](https://blog.markvincze.com/troubleshooting-high-memory-usage-with-asp-net-core-on-kubernetes/?ref=blog.steadycoding.com)
- Python: [Decimal handling (SQLModel/FastAPI docs)](https://sqlmodel.tiangolo.com/advanced/decimal/) · [Python PDF library landscape 2026](https://www.nutrient.io/blog/top-10-ways-to-generate-pdfs-in-python/)
- Elixir: [Oban guide with cron/unique/transactional jobs (OneUptime)](https://oneuptime.com/blog/post/2026-01-26-elixir-oban-background-jobs/view)
