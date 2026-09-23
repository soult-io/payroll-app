<script setup lang="ts">
/**
 * Admin deposit detail (PAY-36): the reference details for a single tax deposit,
 * including the EFTPS values needed to enter the deposit on eftps.gov, breakdown
 * by category, contributing runs, and attachments.
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Skeleton from "primevue/skeleton";
import PageHeader from "../../components/PageHeader.vue";
import BackButton from "../../components/BackButton.vue";
import StatusChip from "../../components/StatusChip.vue";
import {
  adminDepositsApi,
  type DepositBreakdownRow,
  type DepositRunRow,
  type TaxDepositRow,
} from "../../lib/api";
import { useDates } from "../../composables/useDates";
import { useMoney } from "../../composables/useMoney";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const router = useRouter();
const { date, toIso } = useDates();
const { money } = useMoney();
const notify = useNotify();

const depositId = Number(route.params.id);

const loading = ref(true);
const deposit = ref<TaxDepositRow | null>(null);
const breakdown = ref<DepositBreakdownRow[]>([]);
const runs = ref<DepositRunRow[]>([]);
const attachments = ref<{ id: number; filename: string; sizeBytes: number; uploadedAt: string }[]>(
  [],
);

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? `Month ${month}`;
}

function periodLabel(periodStart: string, periodKind?: "month" | "quarter"): string {
  if (periodKind === "quarter") {
    const year = Number(periodStart.slice(0, 4));
    const quarter = Math.ceil(Number(periodStart.slice(5, 7)) / 3);
    return `Q${quarter} ${year}`;
  }
  const month = Number(periodStart.slice(5, 7));
  return `${monthName(month)} ${periodStart.slice(0, 4)}`;
}

function jurisdictionLabel(jurisdiction: string): string {
  return jurisdiction === "federal" ? "Federal" : jurisdiction;
}

const isOverdue = computed(() => {
  if (!deposit.value) return false;
  const today = new Date().toISOString().slice(0, 10);
  return (
    deposit.value.status === "overdue" ||
    (deposit.value.status === "pending" && deposit.value.dueDate < today)
  );
});

const categoryLabels: Record<string, string> = {
  federal_withholding: "Federal income tax withheld",
  social_security: "Social security — employee",
  medicare: "Medicare — employee",
  employer_social_security: "Social security — employer",
  employer_medicare: "Medicare — employer",
};

const totalAmount = computed(() => {
  if (!breakdown.value) return "0.00";
  return breakdown.value.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(2);
});

async function load() {
  loading.value = true;
  try {
    const { deposit: dep, breakdown: bk, runs: rs } = await adminDepositsApi.detail(depositId);
    deposit.value = dep;
    breakdown.value = bk;
    runs.value = rs;
    attachments.value = (await adminDepositsApi.listAttachments(depositId)).attachments.map(
      (a) => ({
        id: a.id,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        uploadedAt: a.createdAt,
      }),
    );
  } catch (err) {
    notify.error(err, "Could not load the deposit detail");
    router.push({ name: "admin-deposits" });
  } finally {
    loading.value = false;
  }
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function handleClickRun(event: { data: DepositRunRow }) {
  router.push({ name: "admin-payroll-run", params: { id: event.data.publicId } });
}

onMounted(async () => {
  await load();
});
</script>

<template>
  <div class="page stack">
    <Skeleton v-if="loading" height="16rem" />
    <template v-else-if="deposit">
<PageHeader
   :title="`${periodLabel(deposit.periodStart, deposit.periodKind)} ${jurisdictionLabel(deposit.jurisdiction)} deposit`"
  :subtitle="`Due ${date(deposit.dueDate)} · Amount ${money(deposit.amount)}`"
>
        <BackButton to="admin-deposits" label="Back to deposits" />
        <StatusChip :status="isOverdue ? 'overdue' : deposit.status" style="margin-left: 0.5rem" />
      </PageHeader>

      <section class="card stack">
        <h3>EFTPS reference</h3>
        <p class="muted small">
          When depositing to eftps.gov, use these exact values:
        </p>
        <div class="stack">
          <div class="row">
            <div class="col">
              <p class="muted small" style="margin: 0">Tax period</p>
               <p class="bold">{{ periodLabel(deposit.periodStart, deposit.periodKind) }}</p>
            </div>
            <div class="col">
              <p class="muted small" style="margin: 0">Amount</p>
              <p class="bold">{{ money(deposit.amount) }}</p>
            </div>
            <div class="col">
              <p class="muted small" style="margin: 0">Due date</p>
              <p class="bold">{{ date(deposit.dueDate) }}</p>
            </div>
            <div class="col">
              <p class="muted small" style="margin: 0">Jurisdiction</p>
              <p class="bold">{{ jurisdictionLabel(deposit.jurisdiction) }}</p>
            </div>
          </div>
          <div class="row" v-if="deposit.status !== 'deposited'">
            <p class="muted small">
              <strong>Hint:</strong> Pay on eftps.gov first, then return here to record the deposit confirmation.
            </p>
          </div>
          <div class="row" v-else>
            <p class="muted small">
              <strong>Deposited:</strong> {{ date(deposit.depositedOn) }} · EFTPS {{ deposit.eftpsConfirmation }}
            </p>
          </div>
        </div>
      </section>

      <section class="card stack">
        <h3>Breakdown</h3>
        <DataTable :value="breakdown" data-key="category" striped-rows>
          <Column field="category" header="Category">
            <template #body="{ data }">
              {{ categoryLabels[data.category] || data.category }}
            </template>
          </Column>
          <Column header="Amount" style="width: 12rem; text-align: right">
            <template #body="{ data }">
              {{ money(data.amount) }}
            </template>
          </Column>
        </DataTable>
        <div class="row" style="justify-content: flex-end; padding-top: 0.5rem">
          <div class="col" style="text-align: right">
            <p class="bold" style="margin: 0">Total: {{ money(totalAmount) }}</p>
          </div>
        </div>
      </section>

      <section class="card stack">
        <h3>Contributing runs</h3>
        <p class="muted small" style="margin: 0">
          Runs that contributed to this deposit ({{ runs.length }} total).
        </p>
        <DataTable v-if="runs.length" :value="runs" data-key="publicId" striped-rows @row-click="handleClickRun">
          <Column header="Pay date" style="width: 10rem">
            <template #body="{ data }">
              {{ date(data.payDate) }}
            </template>
          </Column>
          <Column header="Employee" style="width: 12rem">
            <template #body="{ data }">
              {{ data.employeeName }}
            </template>
          </Column>
          <Column header="Amount" style="width: 10rem; text-align: right">
            <template #body="{ data }">
              {{ money(data.amount) }}
            </template>
          </Column>
        </DataTable>
        <p v-else class="muted" style="margin: 0.5rem 0">
          No issued runs in this period.
        </p>
      </section>

      <section class="card stack">
        <h3>Attachments</h3>
        <p class="muted small" style="margin: 0">
          EFTPS confirmation attachments uploaded for this deposit.
        </p>
        <DataTable v-if="attachments.length" :value="attachments" data-key="id" striped-rows>
          <Column field="filename" header="File" />
          <Column header="Size" style="width: 8rem; text-align: right">
            <template #body="{ data }">{{ fileSize(data.sizeBytes) }}</template>
          </Column>
          <Column header="Uploaded" style="width: 10rem">
            <template #body="{ data }">{{ date(data.uploadedAt) }}</template>
          </Column>
          <Column header="" style="width: 8rem">
            <template #body="{ data }">
              <a
                :href="adminDepositsApi.attachmentDownloadUrl(depositId, data.id)"
                target="_blank"
                rel="noopener"
              >
                <Button label="View" icon="pi pi-download" size="small" text />
              </a>
            </template>
          </Column>
        </DataTable>
        <p v-else class="muted" style="margin: 0.5rem 0">
          No attachments uploaded yet.
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.col {
  flex: 1;
  min-width: 12rem;
}
</style>