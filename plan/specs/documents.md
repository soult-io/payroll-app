# Spec 5 — Documents (Payslips)

Status: `DRAFT — awaiting owner sign-off` · Depends on: data-model, payroll-engine · Confirms: D5

## Core decision (D5)

**Data is the source of truth; PDFs are generated on demand and never stored.** No PDF files
on disk, no blobs, no external file store. The app is the complete archive because it holds every
issued run's frozen `run_snapshot`.

## Immutability guarantee

- Payslips render **exclusively from `payroll_runs.run_snapshot`** — the frozen inputs,
  computed results, and `engineVersion` captured at run creation. Live config (current
  salary, current tax tables, current address) is never consulted for an issued payslip.
- Issued runs are immutable at the DB level (update-rejecting trigger; void bookkeeping
  excepted). Editing salary or tax tables can never rewrite history.
- Display fields that change over time (employee legal name, company address) are copied
  INTO the snapshot at issuance, so a re-rendered 2026 payslip shows exactly what the
  original showed.
- Determinism check: rendering is a pure function of snapshot + template version; a
  SHA-256 of the canonical snapshot JSON is stored on the run (`snapshot_hash`) so any
  drift would be detectable. Template version is recorded on the run at issuance.

## Renderer

- **pdfmake** (D1 stack), porting the existing renderer from
  the internal accounting project's `src/pdf/` renderer — same document definition, adapted to read the
  snapshot shape instead of tool args. Company logo bundled in the repo (not fetched from an external file store — removes that dependency).
- Render time is trivial (<100 ms); caching is unnecessary. Generated in-memory, streamed
  to the response, discarded.

## API

```
GET /api/payslips                       employee: own issued runs (list w/ period, net, status)
GET /api/payslips/:publicId             employee (own) or admin: payslip detail (from snapshot)
GET /api/payslips/:publicId/pdf         employee (own) or admin: application/pdf, Content-Disposition
GET /api/admin/payroll-runs             admin: all runs incl. drafts/awaiting approval
```

- Authorization: employee routes filter by `employees.user_id = session.user.id` — an
  employee can never enumerate or fetch another's payslip, even by guessing `publicId`
  (UUID + ownership check both required).
- File name: `payslip-YYYY-MM.pdf` (deterministic; matches current convention).

## Historical payslips

The migration spec imports 2025–2026 payroll history as issued runs with reconstructed
snapshots, so every payslip ever issued is downloadable from the app on day one.
The old file store's `/Shared/Payroll/` archive remains — untouched, but no longer canonical.

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
