<script setup lang="ts">
/**
 * Payslip list (frontend spec): issued payslips separated BY YEAR (owner
 * request 2026-08-01) — a year switcher filters the table and scopes the
 * totals line, since YTD figures are meaningless across calendar years.
 * Row navigates to detail.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import SelectButton from "primevue/selectbutton";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import { payslipsApi, type PayslipSummary } from "../../lib/api";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const router = useRouter();
const { money } = useMoney();
const { date } = useDates();
const notify = useNotify();

const loading = ref(true);
const payslips = ref<PayslipSummary[]>([]);
// PAY-17: the selected year is mirrored to ?year= so it survives detail → back
// and browser-back. The default (no param) is the newest year with data.
const selectedYear = ref<string>(typeof route.query.year === "string" ? route.query.year : "");

/** Distinct years present, newest first (keyed on the period, not pay date). */
const years = computed(() =>
  [...new Set(payslips.value.map((p) => p.periodStart.slice(0, 4)))].sort().reverse(),
);

const yearPayslips = computed(() =>
  payslips.value.filter((p) => p.periodStart.startsWith(selectedYear.value)),
);

const ytdGross = computed(() => yearPayslips.value.reduce((sum, p) => sum + p.grossPay, 0));
const ytdNet = computed(() => yearPayslips.value.reduce((sum, p) => sum + p.netPay, 0));

function open(event: { data: PayslipSummary }) {
  // Carry the year query onto the detail URL so its back button can restore it.
  void router.push({
    name: "my-payslip-detail",
    params: { publicId: event.data.publicId },
    query: route.query,
  });
}

watch(selectedYear, (year) => {
  const query = { ...route.query };
  if (!year || year === years.value[0]) delete query.year;
  else query.year = year;
  void router.replace({ query });
});

onMounted(async () => {
  try {
    const { payslips: rows } = await payslipsApi.list();
    payslips.value = rows;
    // A ?year= with no payslips falls back to the newest year with data.
    if (!years.value.includes(selectedYear.value)) {
      selectedYear.value = years.value[0] ?? "";
    }
  } catch (err) {
    notify.error(err, "Could not load payslips");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Payslips" subtitle="Your issued payslips, newest first." />

    <SelectButton
      v-if="years.length > 1"
      v-model="selectedYear"
      :options="years"
      :allow-empty="false"
      aria-label="Payslip year"
    />

    <div class="card table-scroll">
      <DataTable :value="yearPayslips" :loading="loading" striped-rows row-hover @row-click="open">
        <template #empty>
          <EmptyState
            icon="pi pi-file"
            title="No payslips yet"
            body="Issued payslips will appear here after your first payroll run."
          />
        </template>
        <Column header="Period">
          <template #body="{ data }">{{ date(data.periodStart) }} – {{ date(data.periodEnd) }}</template>
        </Column>
        <Column header="Pay date">
          <template #body="{ data }">{{ date(data.payDate) }}</template>
        </Column>
        <Column header="Gross" class="num">
          <template #body="{ data }">{{ money(data.grossPay) }}</template>
        </Column>
        <Column header="Net pay" class="num">
          <template #body="{ data }"><strong>{{ money(data.netPay) }}</strong></template>
        </Column>
      </DataTable>
    </div>

    <p v-if="yearPayslips.length > 0" class="muted small">
      {{ selectedYear }} totals across {{ yearPayslips.length }} payslip(s): gross
      {{ money(ytdGross) }} · net {{ money(ytdNet) }}
    </p>
  </div>
</template>
