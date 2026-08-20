/**
 * CLI: create a recurring contractor invoice template (spec 12) without a
 * UI session — wraps the same createTemplate service the admin route uses,
 * so validation + audit trail are identical.
 *
 * Idempotent: if the contractor already has an active template with the
 * same amount/payDayOfMonth/startsOn, the CLI reports it and exits 0
 * without creating a duplicate.
 *
 * Usage:
 *   pnpm create-contractor-template --employee 2 --amount 2000 \
 *     --description "Monthly social-media retainer — {month} {year}" \
 *     --invoice-day last_day --pay-day 11 --starts-on 2026-08-01
 *
 *   docker exec payroll-app node dist/cli/create-contractor-template.js \
 *     --employee 2 --amount 2000 --description "..." \
 *     --invoice-day last_day --pay-day 11 --starts-on 2026-08-01
 *
 * Flags:
 *   --employee <id>            contractor employee id (required)
 *   --amount <number>          monthly amount (required)
 *   --description <text>       invoice description; {month}/{year} interpolate (required)
 *   --pay-day <1-28>           day of the following month the payment is due (required)
 *   --starts-on <YYYY-MM-DD>   first eligible invoice date (required)
 *   --invoice-day <last_day|fixed>  invoice generation day (default: last_day)
 *   --invoice-day-of-month <1-28>   required when --invoice-day fixed
 *   --currency <ISO>           default USD
 *   --ends-on <YYYY-MM-DD>     optional contract end (template retires itself)
 */

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createTemplate, listTemplates, type InvoiceDay } from "../contractors/recurring.js";

interface Args {
  employee?: string;
  amount?: string;
  description?: string;
  payDay?: string;
  startsOn?: string;
  invoiceDay?: string;
  invoiceDayOfMonth?: string;
  currency?: string;
  endsOn?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`bad argument pair at ${key ?? "<end>"} — flags are --key value`);
    }
    (args as Record<string, string>)[key.slice(2)] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const missing = (["employee", "amount", "description", "payDay", "startsOn"] as const).filter(
  (k) => args[k] === undefined,
);
if (missing.length > 0) {
  console.error(`missing required flag(s): ${missing.map((k) => `--${k}`).join(", ")}`);
  console.error("see the usage block at the top of src/cli/create-contractor-template.ts");
  process.exit(1);
}

// The missing-flag guard above exits first, so these are present.
const description = args.description as string;
const startsOn = args.startsOn as string;

const employeeId = Number(args.employee);
const amount = Number(args.amount);
const payDayOfMonth = Number(args.payDay);
const invoiceDay = (args.invoiceDay ?? "last_day") as InvoiceDay;
const invoiceDayOfMonth =
  args.invoiceDayOfMonth !== undefined ? Number(args.invoiceDayOfMonth) : null;

if (!Number.isInteger(employeeId) || employeeId < 1) {
  console.error("--employee must be a positive integer");
  process.exit(1);
}
if (!Number.isFinite(amount) || amount <= 0) {
  console.error("--amount must be a positive number");
  process.exit(1);
}
if (invoiceDay !== "last_day" && invoiceDay !== "fixed") {
  console.error("--invoice-day must be last_day or fixed");
  process.exit(1);
}

const config = loadConfig();
const { db, close } = createDb(config, process.env.DATABASE_URL);

try {
  const existing = await listTemplates({ db, config }, employeeId);
  const dupe = existing.find(
    (t) =>
      t.active &&
      Number(t.amount) === amount &&
      t.payDayOfMonth === payDayOfMonth &&
      t.startsOn === args.startsOn,
  );
  if (dupe) {
    console.log(
      `template already exists (id ${dupe.id}) — same amount/payDay/startsOn; nothing created`,
    );
    process.exit(0);
  }

  const template = await createTemplate(
    { db, config },
    employeeId,
    {
      description,
      amount,
      currency: args.currency ?? "USD",
      invoiceDay,
      invoiceDayOfMonth,
      payDayOfMonth,
      startsOn,
      endsOn: args.endsOn ?? null,
    },
    "cli",
  );
  console.log(
    `created recurring template id ${template.id}: contractor ${template.employeeId}, ` +
      `${template.amount} ${template.currency}, invoice ${template.invoiceDay}` +
      (template.invoiceDayOfMonth ? ` day ${template.invoiceDayOfMonth}` : "") +
      `, pay day ${template.payDayOfMonth}, starts ${template.startsOn}` +
      (template.endsOn ? `, ends ${template.endsOn}` : ""),
  );
} finally {
  await close();
}
