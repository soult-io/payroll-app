# Frontend Technology Decision Report — Payroll Webapp

*Verified against current sources, npm registry, and GitHub API as of late July 2026.*

## 0. Verified ecosystem state (2025–2026)

- **Vue**: 3.5.x is the stable line (3.5.40, Jul 2026); **Vue 3.6 at RC** bringing Vapor Mode (no-VDOM compilation). Core team publicly committed to "fewer painful upgrades."
- **React**: 19.x stable. The library itself is calm; the *ecosystem* remains fractured over Server Components/Next.js — none of that touches a Vite SPA.
- **Svelte**: 5.x very active, runes stable, SvelteKit 2.x still evolving quickly.
- **Solid**: 1.9.x stable but **Solid 2.0 in active beta right now** — a churn moment.
- **Vuetify**: Very healthy. Monthly releases; **Vuetify 4.0 shipped Feb 2026** with 3.x maintained in parallel; 18-month LTS policy; 455 open issues.
- **PrimeVue**: 4.x mature (design-token theming with **Aura, Material, Lara, Nora presets**); **PrimeVue 5.0.0 released Jul 15, 2026 — days old**. Commercially backed (PrimeTek); 872 open issues.
- **Naive UI**: Effectively slow maintenance — ~2 releases in the last 10 months, 677 open issues, single maintainer.
- **Quasar**: Still releasing, but a March 2026 community discussion documents real stagnation concerns.
- **React design systems**: MUI on **v9**; Mantine on **v9.5** with 53 open issues; shadcn/ui most-starred (~120k) but copy-you-own-it model.
- **HTMX**: 2.x stable, but wants HTML fragments from the server — architecturally at odds with a separate JSON API.

## 1. Framework decision matrix

| Criterion (weighted) | Vue 3 + Vite SPA | React 19 + Vite SPA | Svelte 5 / SvelteKit | SolidJS / SolidStart | Nuxt (SSR) | HTMX + Alpine |
|---|---|---|---|---|---|---|
| 1. Solo-dev productivity (form/table-heavy) | **5** — SFC templates excel at forms; owner already leans Vue; Pinia/Router boring-stable | 4 — more boilerplate per form; hooks footguns | 4 — least boilerplate; smaller pool | 3 — fine-grained reactivity easy to get wrong | 4 — SSR machinery is overhead here | 3 — CRUD fast; comment threads/approval flows awkward |
| 2. Bundle/runtime weight | 4 — ~34–45 KB gzip runtime | 3 — ~45 KB react+react-dom | **5** — ~10 KB runtime | **5** — ~8 KB, fastest | 3 — hydration + Node server on the home server | **5** — ~14 KB total |
| 3. Maturity / 10-yr longevity | **5** — Vue 3 stable since 2020; explicit stability commitment | 4 — library solid; ecosystem churn avoidable via plain Vite | 3 — Svelte 5 only ~21 months old | 2 — **Solid 2.0 in beta right now** | 4 — another moving layer | 4 — frozen API, but niche |
| 4. Design-system quality available | 4 — Vuetify/PrimeVue strong | **5** — MUI, Mantine, shadcn, AntD | 2 — thin; weak data tables | 1–2 — no complete admin suite | 4 — same as Vue | 1 — you build everything |
| 5. OSS-product friendliness | 4 — big global community, all-MIT | **5** — largest contributor pool | 3 — passionate but small | 2 — small | 4 | 3 — unconventional for a sellable product |
| 6. TypeScript end-to-end | 4 — vue-tsc/Volar good | **5** — gold standard | 4 | **5** | 4 | 2 |
| **Weighted total** | **≈ 4.4** | ≈ 4.2 | ≈ 3.3 | ≈ 2.8 | ≈ 3.7 | ≈ 3.0 |

### On SSR: not needed
Every v1 screen sits **behind a login**. No SEO surface, no public first-paint problem, and small scale doesn't justify a Node SSR process on a home server. A Vite SPA served as static files is simpler, lighter, and backend-agnostic. **Verdict: plain SPA** — this also decouples the frontend from the backend decision entirely.

### On HTMX: wrong constraint
Fine for CRUD admin UIs and lightest by far — but requires the server to return **HTML fragments**, conflicting with the JSON/OpenAPI backend decision. Rejected on architecture, not quality.

## 2. Design-system decision matrix

| Criterion | **PrimeVue** (Vue) | **Vuetify** (Vue) | Naive UI (Vue) | Quasar (Vue) | **Mantine** (React) | MUI (React) | shadcn/ui (React) |
|---|---|---|---|---|---|---|---|
| Completeness (tables, forms, dates, dialogs, steppers) | **5** — best free DataTable in Vue; InputNumber/InputMask (money!), Steps, FileUpload | 4 — VDataTable mature; VDateInput/VNumberInput arrived 2025 | 4 — 90+ components | **5** — huge set | **5** — 100+ components | **5** — deepest, **but advanced Data Grid is MUI X Pro (paid)** | 3 — assemble it yourself |
| Accessibility | 3 — weakest axis | 4 | 3 | 3 | 4 | 4 | 4 (Radix/Base UI primitives) |
| Theming / dark mode | 4 — design tokens; **Material preset**, Aura default | **5** — true Material Design 3, first-class dark mode | 4 | 3 — dated look | 4 | **5** — canonical Material | 4 |
| Bundle weight | 3 | 2 — heaviest Vue option | 3 | 3 | 3 | 2 | 4 |
| Maintenance health (verified) | 4 — very active, commercial backing; **v5.0.0 days old**; 872 issues | **5** — monthly releases, v4 + 3.x LTS, 455 issues | **2** — single maintainer, stalled | 3 — documented stagnation concern | **5** — 53 issues, rapid cadence | 4 — 1,491 issues; corporate | 4 — you own copied code |
| License / sell-as-product fit | MIT, all free | MIT | MIT | MIT | MIT | Core MIT; **MUI X Pro commercial — flag** | MIT |
| Mobile responsive | 4 | 4 | 3 | **5** | 4 | 4 | 3 — DIY |

**Eliminations:** Naive UI fails the 10-year longevity test. Quasar fails trajectory. shadcn/ui + Tailwind makes you the design-system maintainer. Ant Design heavy and dated. **Tailwind alone** rejected for v1: no tables/pickers/steppers — exactly the components this app is made of.

## 3. Recommendation

### Primary: **Vue 3 + Vite (SPA) + PrimeVue 4.x (Material preset now, Aura/custom tokens at polish pass)**

1. **Productivity (top weight):** PrimeVue has the most complete free component set for this app's anatomy — dense DataTables with filtering/row-expansion for payroll runs, `InputNumber`/`InputMask` for currency and SSN-like fields, date pickers, steppers for the review/approve flow, confirm dialogs, toasts.
2. **Owner lean + weight:** Vue survives scrutiny on merits (weighted ≈4.4 vs React ≈4.2). Runtime is light; Vapor Mode (Vue 3.6 RC) is upside, not a dependency.
3. **Longevity:** Vue 3 API stable since 2020; PrimeVue commercially backed by PrimeTek — a business, not a hobbyist (precisely what Naive UI lacks).
4. **Design bar:** built-in **Material preset** satisfies "established design system" on day one; later polish is a preset swap, not a rewrite.
5. **Product-friendly:** MIT across the board, no paid-component traps (unlike MUI X Pro).
6. **Backend freedom:** SPA + `openapi-typescript` codegen gives end-to-end type safety against a TS, Go, or .NET OpenAPI backend with zero framework constraint.

**Version guidance:** pin **PrimeVue 4.x** — 5.0.0 shipped July 15, 2026; let it bake a quarter.

### Alternative: **React 19 + Vite + Mantine 9** — strongest framework-agnostic combo.
### If Vue + strict Material: **Vue 3 + Vuetify** — true MD3, better a11y; accept weaker money/table ergonomics.

## 4. Risks of the recommendation

- **PrimeVue accessibility is its weakest axis** — budget an a11y audit at polish pass; keep business logic in composables, not templates, to ease any future migration.
- **PrimeVue 5.0.0 is brand new** — staying on 4.x defers; v3→v4 was a full theming rewrite, expect a non-trivial major.
- **872 open issues** — expect to hit 1–2 component bugs during development.
- **Vue 3.6/Vapor Mode at RC** — don't adopt 3.6 on release day; let PrimeVue compatibility confirm first.
- **Home-server constraint is a non-issue for all SPA options** — don't let bundle size override productivity.

## 5. Key sources

- [Vue.js 2025 in Review / 2026 peek — Vue School](https://vueschool.io/articles/news/vue-js-2025-in-review-and-a-peek-into-2026/) · [devclass on Vue's stability pledge](https://www.devclass.com/development/2025/04/03/what-next-for-vuejs-official-report-promises-fewer-painful-upgrades-and-describes-challenges-with-forthcoming-vapor-mode/1631077)
- [The State of React and the Community in 2025 — Mark Erikson](https://blog.isquaredsoftware.com/2025/06/react-community-2025/)
- [Quasar Project Status discussion #18211 (Mar 2026)](https://github.com/quasarframework/quasar/discussions/18211)
- [PrimeVue v4 theming architecture & presets](https://primevue.org/theming/styled/) · [v3→v4 migration notes](https://primevue.org/guides/migration/v4/)
- [Vuetify LTS policy](https://vuetifyjs.com/introduction/long-term-support/) · [Vuetify roadmap](https://vuetifyjs.com/vuetify/roadmap)
- [Material UI v7 announcement](https://mui.com/blog/material-ui-v7-is-here/) · [MUI Base UI 1.0 — InfoQ](https://www.infoq.com/news/2026/02/baseui-v1-accessible/)
- npm registry & GitHub API queried directly (2026-07-28) for version/cadence/star/issue figures.
