# Spec 4 — Change Requests (Employee → Admin)

Status: `DRAFT — awaiting owner sign-off` · Depends on: data-model, auth · Confirms: D7

## Scope

Four requestable field groups (D7): **address**, **W-4/withholding election**, **bank details**,
**legal name**. Tax ID is explicitly NOT requestable. All approvals are **effective-dated**;
denials carry a **full comment thread**.

## State machine

```
employee drafts request (payload + requested effective_from)
  → submitted (status='pending')            → notification: change_request_submitted → admins
  ⇄ comment thread (both parties, any state until decided)
  → admin approves (decided_by/at)          → applied effective-dated in one transaction
                                              (status='approved', applied_at)
                                            → notification: change_request_approved → employee
  → admin denies (reason required in thread) → notification: change_request_denied → employee
  → employee withdraws (pre-decision only, status='withdrawn')
```

## Application semantics (the correctness core)

- **address / bank_details / legal_name** → update `employees` fields directly, but record
  the previous value in the approval's `audit_events.before` (immutable history; the live
  table holds only current values).
- **w4** → INSERT a new `w4_elections` row with the approved payload and `effective_from`
  (never UPDATE an existing election — history is append-only). Effective-date rule mirrors
  current practice: applies to pay periods on/after `effective_from`, never retroactive.
  Validation: `effective_from` must be ≥ the first day of the next un-run pay period unless
  the admin explicitly overrides (override recorded in audit).
- Everything happens in **one transaction**: change_requests.status → target write →
  audit_events insert → email_outbox insert. A failure anywhere rolls all back.
- A pending request on the same field blocks a second pending request on that field
  (partial unique index: one `pending` per (employee_id, request_type)).

## API

```
POST   /api/change-requests                 employee: submit (validated payload per type)
GET    /api/change-requests?status=         employee: own; admin: all (+ filters)
GET    /api/change-requests/:id             participant or admin
POST   /api/change-requests/:id/comments    participant or admin
POST   /api/change-requests/:id/approve     admin (optional admin note)
POST   /api/change-requests/:id/deny        admin (reason required)
POST   /api/change-requests/:id/withdraw    employee, pre-decision
```

Payload validation per type is a shared Zod schema used by both the form and the API
(e.g., address = structured fields; w4 = the 2020+ W-4 shape; bank = routing checksum +
account mask; legal_name = non-empty + audit trail emphasized since it appears on payslips).

## UI (maps to frontend spec)

- Employee: "Request a change" wizard (per type), request list with status chips, thread view.
- Admin: pending-requests inbox (badge count), diff view (current vs proposed side-by-side),
  effective-date picker (default = request's date), approve/deny + thread.

## Sensitive-data handling

Bank details in payloads encrypted at rest like the target field; masked in UI
(••••1234) and in notifications (never emailed in clear).

## Owner sign-off

- [ ] Approved as written
- [ ] Approved with changes (list):
