<script setup lang="ts">
/**
 * Payslip list (frontend spec): DataTable of issued payslips (period, gross,
 * net, YTD) → row navigates to detail.
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import { payslipsApi, type PayslipSummary } from "../../lib/api";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const router = useRouter();
const { money } = useMoney();
const { date } = useDates();
const notify = useNotify();

const loading = ref(true);
const payslips = ref<PayslipSummary[]>([]);

const ytdGross = computed(() => payslips.value.reduce((sum, p) => sum + p.grossPay, 0));
const ytdNet = computed(() => payslips.value.reduce((sum, p) => sum + p.netPay, 0));

function open(event: { data: PayslipSummary }) {
  void router.push({ name: "my-payslip-detail", params: { publicId: event.data.publicId } });
}

onMounted(async () => {
  try {
    const { payslips: rows } = await payslipsApi.list();
    payslips.value = rows;
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

    <div class="card table-scroll">
      <DataTable :value="payslips" :loading="loading" striped-rows row-hover @row-click="open">
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

    <p v-if="payslips.length > 0" class="muted small">
      Year to date across {{ payslips.length }} payslip(s): gross {{ money(ytdGross) }} · net
      {{ money(ytdNet) }}
    </p>
  </div>
</template>
