<script setup lang="ts">
/**
 * Read-only rendering of a change-request payload, per type. Used in detail
 * views and in the admin current-vs-proposed diff (bank values arrive masked
 * from the API — this component never sees clear account data).
 */
import { computed } from "vue";
import { filingStatusLabel } from "../composables/useRequestTypes";
import { useMoney } from "../composables/useMoney";
import { useDates } from "../composables/useDates";

const props = defineProps<{ requestType: string; payload: Record<string, unknown> }>();

const { money } = useMoney();
const { date } = useDates();

const str = (v: unknown): string =>
  typeof v === "string" ? v : v === null || v === undefined ? "—" : String(v);

const rows = computed<{ label: string; value: string }[]>(() => {
  const p = props.payload;
  switch (props.requestType) {
    case "address":
    case "mailing_address":
      return [
        {
          label: "Street",
          value: [str(p.line1), str(p.line2)].filter((s) => s !== "—").join(", "),
        },
        { label: "City", value: str(p.city) },
        { label: "State/Province", value: str(p.state) },
        { label: "ZIP/Postal code", value: str(p.zip) },
        { label: "Country", value: str(p.country) },
      ];
    case "w4":
      return [
        { label: "Tax year", value: str(p.taxYear) },
        { label: "Filing status", value: filingStatusLabel(str(p.filingStatus)) },
        { label: "Federal exempt", value: p.federalExempt ? "Yes" : "No" },
        { label: "Multiple jobs", value: p.multipleJobs ? "Yes" : "No" },
        { label: "Dependents amount", value: money(p.dependentsAmount as number) },
        { label: "Other income", value: money(p.otherIncome as number) },
        { label: "Deductions", value: money(p.deductionsAmount as number) },
        { label: "Extra withholding", value: money(p.extraWithholding as number) },
        { label: "Filed date", value: date(str(p.filedDate)) },
        ...(p.note ? [{ label: "Note", value: str(p.note) }] : []),
      ];
    case "bank_details":
      return [
        { label: "Account type", value: str(p.type) },
        { label: "Routing number", value: str(p.routing) },
        { label: "Account number", value: str(p.account) },
      ];
    case "legal_name":
      return [
        { label: "New legal name", value: str(p.legalName) },
        { label: "Reason", value: str(p.reason) },
      ];
    case "tax_id": {
      // API payloads arrive masked; the local review step masks the just-typed
      // value the same way — the clear TIN is only ever visible while typing.
      const raw = str(p.taxId);
      const masked = raw === "—" || raw.startsWith("••••") ? raw : `••••${raw.slice(-4)}`;
      return [{ label: "Tax ID", value: masked }];
    }
    default:
      return Object.entries(p).map(([k, v]) => ({ label: k, value: str(v) }));
  }
});
</script>

<template>
  <dl class="kv">
    <template v-for="row in rows" :key="row.label">
      <dt>{{ row.label }}</dt>
      <dd>{{ row.value }}</dd>
    </template>
  </dl>
</template>
