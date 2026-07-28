/**
 * Change-request type presentation (labels, icons, per-field formatting)
 * shared by employee + admin screens. Server emails use the same labels.
 */

import type { ChangeRequestType } from "../lib/api";

export const REQUEST_TYPES: { value: ChangeRequestType; label: string; icon: string; blurb: string }[] = [
  { value: "address", label: "Address", icon: "pi pi-home", blurb: "Update your home address" },
  { value: "w4", label: "Withholding (W-4)", icon: "pi pi-file", blurb: "File a new federal W-4 election" },
  { value: "bank_details", label: "Bank details", icon: "pi pi-credit-card", blurb: "Change your direct-deposit account" },
  { value: "legal_name", label: "Legal name", icon: "pi pi-id-card", blurb: "Correct the name on your payslips" },
];

export function requestTypeLabel(type: string): string {
  return REQUEST_TYPES.find((t) => t.value === type)?.label ?? type;
}

/** Filing-status enum → readable label. */
export function filingStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    single: "Single",
    married_joint: "Married filing jointly",
    married_separate: "Married filing separately",
    head_of_household: "Head of household",
  };
  return labels[status] ?? status;
}
