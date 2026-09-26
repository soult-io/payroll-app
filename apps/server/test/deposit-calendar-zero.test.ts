/**
 * PAY-91 final UX round: a 0.00 state row's calendar event says "Nothing left
 * to pay", never "$0.00 · pending"; a row with an amount keeps "$x · status".
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDatabase, type SeedDb } from "@payroll/db";
import { monthCalendar } from "../src/calendar/service.js";
import { createTestApp, type TestContext } from "./helpers.js";

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
  await seedDatabase(t.db as unknown as SeedDb);
  await t.pglite.exec(`TRUNCATE tax_deposits RESTART IDENTITY CASCADE;
    INSERT INTO tax_deposits (jurisdiction, period_start, period_kind, amount, due_date, status, created_by)
    VALUES ('CA', '2026-07-01', 'quarter', '0.00', '2026-11-02', 'pending', 'scheduler'),
           ('NY', '2026-07-01', 'quarter', '240.00', '2026-11-02', 'pending', 'scheduler');`);
}, 180_000);
afterAll(async () => {
  await t.close();
});

describe("calendar deposit detail", () => {
  it("0.00 row -> Nothing left to pay; amount row -> $amount · status", async () => {
    const nov = await monthCalendar(t.db, 2026, 11);
    const due = nov
      .filter((e) => e.kind === "deposit_due")
      .map((e) => [e.label, e.detail])
      .sort();
    expect(due).toEqual([
      ["California deposit due — Q3 2026", "Nothing left to pay"],
      ["New York deposit due — Q3 2026", "$240.00 · pending"],
    ]);
  });
});
