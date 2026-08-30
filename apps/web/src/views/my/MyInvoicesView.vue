<script setup lang="ts">
/**
 * Contractor invoice list (PAY-7): the contractor analogue of My Payslips.
 * Shows only approved + paid invoices (D1 — nothing appears until the admin
 * approves), separated BY YEAR like the payslips page. Each row has a
 * download button for the on-demand invoice PDF (D2); paid rows show the
 * pay date. Per-year summary: total paid vs. awaiting payment.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import SelectButton from "primevue/selectbutton";
import Button from "primevue/button";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import { myInvoicesApi, type MyInvoice } from "../../lib/api";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const router = useRouter();
const { money } = useMoney();
const { date } = useDates();
const notify = useNotify();

const loading = ref(true);
const invoices = ref<MyInvoice[]>([]);
// PAY-17: the selected year is mirrored to ?year= so the list state is
// bookmarkable. The default (no param) is the newest year with data.
const selectedYear = ref<string>(typeof route.query.year === "string" ? route.query.year : "");

/** Distinct years present, newest first (keyed on the invoice date). */
const years = computed(() =>
  [...new Set(invoices.value.map((i) => i.invoiceDate.slice(0, 4)))].sort().reverse(),
);

const yearInvoices = computed(() =>
  invoices.value.filter((i) => i.invoiceDate.startsWith(selectedYear.value)),
);

const totalPaid = computed(() =>
  yearInvoices.value
    .filter((i) => i.status === "paid")
    .reduce((sum, i) => sum + (i.payment?.amount ?? i.amount), 0),
);
const totalPending = computed(() =>
  yearInvoices.value.filter((i) => i.status === "approved").reduce((sum, i) => sum + i.amount, 0),
);

watch(selectedYear, (year) => {
  const query = { ...route.query };
  if (!year || year === years.value[0]) delete query.year;
  else query.year = year;
  void router.replace({ query });
});

onMounted(async () => {
  try {
    const { invoices: rows } = await myInvoicesApi.list();
    invoices.value = rows;
    // A ?year= with no invoices falls back to the newest year with data.
    if (!years.value.includes(selectedYear.value)) {
      selectedYear.value = years.value[0] ?? "";
    }
  } catch (err) {
    notify.error(err, "Could not load invoices");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Invoices" subtitle="Your approved invoices and payments, newest first." />

    <SelectButton
      v-if="years.length > 1"
      v-model="selectedYear"
      :options="years"
      :allow-empty="false"
      aria-label="Invoice year"
    />

    <div class="card table-scroll">
      <DataTable :value="yearInvoices" :loading="loading" striped-rows row-hover>
        <template #empty>
          <EmptyState
            icon="pi pi-file"
            title="No invoices yet"
            body="Approved invoices will appear here. If you bill on a recurring schedule, a new invoice is generated each period and appears once approved."
          />
        </template>
        <Column header="Invoice date">
          <template #body="{ data }">{{ date(data.invoiceDate) }}</template>
        </Column>
        <Column header="Description">
          <template #body="{ data }">{{ data.description }}</template>
        </Column>
        <Column header="Amount" class="num">
          <template #body="{ data }"><strong>{{ money(data.amount) }}</strong></template>
        </Column>
        <Column header="Status">
          <template #body="{ data }"><StatusChip :status="data.status" /></template>
        </Column>
        <Column header="Pay date">
          <template #body="{ data }">
            {{ data.payment ? date(data.payment.payDate) : "—" }}
          </template>
        </Column>
        <Column header="">
          <template #body="{ data }">
            <a :href="myInvoicesApi.pdfUrl(data.id)" target="_blank" rel="noopener">
              <Button icon="pi pi-download" text rounded aria-label="Download PDF" />
            </a>
          </template>
        </Column>
      </DataTable>
    </div>

    <p v-if="yearInvoices.length > 0" class="muted small">
      {{ selectedYear }} totals across {{ yearInvoices.length }} invoice(s): paid
      {{ money(totalPaid) }}<template v-if="totalPending > 0"> · awaiting payment {{ money(totalPending) }}</template>
    </p>
  </div>
</template>
