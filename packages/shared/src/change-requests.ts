/**
 * Shared change-request payload schemas (spec 4).
 *
 * Used by BOTH the web form and the server API so a payload is validated
 * identically on both sides. Requestable field groups (D7 + spec 11): address,
 * mailing_address, w4, bank_details, legal_name, tax_id. The tax_id payload is encrypted at
 * rest inside change_requests.payload — the JSONB stores only ciphertext.
 */

import { z } from "zod";

/** ISO date string (YYYY-MM-DD), the wire/JSON format for DATE columns. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid date");

/** Money on the wire: string or number, ≥ 0, at most 2 decimals (NUMERIC(12,2)). */
export const moneyAmount = z.coerce
  .number()
  .nonnegative()
  .multipleOf(0.01, "money must be cent-precision")
  .max(9_999_999_999.99, "exceeds NUMERIC(12,2)");

/** address → employees.address (JSONB {line1,line2,city,state,zip,country}). */
export const addressPayload = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(100),
  zip: z.string().min(1).max(20),
  country: z.string().min(2).max(2), // ISO 3166-1 alpha-2
});
export type AddressPayload = z.infer<typeof addressPayload>;

/** w4 → INSERT into w4_elections (append-only history; never UPDATE). 2020+ W-4 shape. */
export const w4Payload = z.object({
  taxYear: z.number().int().min(2020).max(2100),
  filingStatus: z.enum(["single", "married_joint", "married_separate", "head_of_household"]),
  federalExempt: z.boolean().default(false),
  multipleJobs: z.boolean().default(false),
  dependentsAmount: moneyAmount.default(0),
  otherIncome: moneyAmount.default(0),
  deductionsAmount: moneyAmount.default(0),
  /** Per-period extra withholding. */
  extraWithholding: moneyAmount.default(0),
  /** NOT retroactive: applies to pay periods on/after this date. */
  effectiveFrom: isoDate,
  filedDate: isoDate,
  note: z.string().max(2000).default(""),
});
export type W4Payload = z.infer<typeof w4Payload>;

/**
 * ABA routing-number checksum (3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9)) ≡ 0 mod 10.
 */
function validRoutingChecksum(routing: string): boolean {
  const d = routing.split("").map(Number);
  if (d.length !== 9 || d.some((n) => Number.isNaN(n))) return false;
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

/**
 * bank_details → employees.bank_details (JSONB {routing,account,type}).
 * Encrypted at rest; masked (••••1234) in UI/notifications — never emailed clear.
 */
export const bankDetailsPayload = z.object({
  routing: z
    .string()
    .regex(/^\d{9}$/, "routing number must be 9 digits")
    .refine(validRoutingChecksum, "routing number fails ABA checksum"),
  /** Full account number — stored encrypted; only the last 4 are ever displayed. */
  account: z.string().regex(/^\d{4,17}$/, "account number must be 4–17 digits"),
  type: z.enum(["checking", "savings"]),
});
export type BankDetailsPayload = z.infer<typeof bankDetailsPayload>;

/**
 * legal_name → employees.legal_name. Appears on payslips, so the audit trail is
 * emphasized: a reason is required and the previous value is recorded in
 * audit_events.before on approval.
 */
export const legalNamePayload = z.object({
  legalName: z.string().trim().min(1, "legal name must be non-empty").max(200),
  reason: z.string().trim().min(1, "a reason is required for a legal-name change").max(2000),
});
export type LegalNamePayload = z.infer<typeof legalNamePayload>;

/**
 * tax_id → employees.tax_id (spec 11, D20b). The 9-digit TIN is encrypted at
 * rest inside the payload column (only ciphertext in the JSONB), masked
 * (••••1234) in every API response, and applied encrypted on approval.
 */
export const taxIdPayload = z.object({
  taxId: z.string().regex(/^\d{9}$/, "tax id must be 9 digits"),
});
export type TaxIdPayload = z.infer<typeof taxIdPayload>;

export const changeRequestPayloads = {
  address: addressPayload,
  mailing_address: addressPayload,
  w4: w4Payload,
  bank_details: bankDetailsPayload,
  legal_name: legalNamePayload,
  tax_id: taxIdPayload,
} as const;

export const changeRequestType = z.enum([
  "address",
  "mailing_address",
  "w4",
  "bank_details",
  "legal_name",
  "tax_id",
]);
export type ChangeRequestType = z.infer<typeof changeRequestType>;
