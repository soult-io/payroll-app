<script setup lang="ts">
/**
 * Admin tax deposits (PAY-9): the computed monthly federal deposit schedule —
 * amount from issued payroll runs, due date (15th of the following month,
 * weekend-rolled), status chip (overdue highlighted) — plus the record-only
 * "mark as deposited" dialog (EFTPS date + confirmation number) and the
 * admin-editable reminder schedule (D1). The app never pays; deposits happen
 * on eftps.gov and are recorded here.
 */
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import DatePicker from "primevue/datepicker";
import Skeleton from "primevue/skeleton";
import Message from "primevue/message";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import { adminDepositsApi, type TaxDepositRow } from "../../lib/api";
import { useDates } from "../../composables/useDates";
import { useMoney } from "../../composables/useMoney";
import { useNotify } from "../../composables/useNotify";

const { date, toIso } = useDates();
const { money } = useMoney();
const notify = useNotify();

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

function periodLabel(periodStart: string): string {
  const month = Number(periodStart.slice(5, 7));
  return `${MONTH_NAMES[month - 1] ?? periodStart} ${periodStart.slice(0, 4)}`;
}

// -------------------------------------------------------------------- deposits
const loading = ref(true);
const rows = ref<TaxDepositRow[]>([]);

async function load() {
  loading.value = true;
  try {
    const { deposits } = await adminDepositsApi.list();
    rows.value = deposits;
  } catch (err) {
    notify.error(err, "Could not load tax deposits");
  } finally {
    loading.value = false;
  }
}

const today = new Date().toISOString().slice(0, 10);
function isOverdue(row: TaxDepositRow): boolean {
  return row.status === "overdue" || (row.status === "pending" && row.dueDate < today);
}

function rowClass(row: TaxDepositRow): string {
  return isOverdue(row) ? "row-overdue" : "";
}

// -------------------------------------------------------- mark as deposited
const depositDialog = ref(false);
const depositBusy = ref(false);
const depositTarget = ref<TaxDepositRow | null>(null);
const depositedOn = ref<Date | null>(new Date());
const eftpsConfirmation = ref("");

function openDepositDialog(row: TaxDepositRow) {
  depositTarget.value = row;
  depositedOn.value = new Date();
  eftpsConfirmation.value = "";
  depositDialog.value = true;
}

async function submitDeposit() {
  const target = depositTarget.value;
  const iso = toIso(depositedOn.value);
  if (!target || !iso) return;
  depositBusy.value = true;
  try {
    await adminDepositsApi.markDeposited(target.id, {
      depositedOn: iso,
      eftpsConfirmation: eftpsConfirmation.value.trim(),
    });
    notify.success("Deposit recorded", `${periodLabel(target.periodStart)} marked as deposited.`);
    depositDialog.value = false;
    await load();
  } catch (err) {
    notify.error(err, "Could not record the deposit");
  } finally {
    depositBusy.value = false;
  }
}

// ---------------------------------------------------------- reminder schedule
const scheduleLoading = ref(true);
const scheduleBusy = ref(false);
const offsetsText = ref("");
const defaultOffsets = ref<number[]>([]);

async function loadSchedule() {
  scheduleLoading.value = true;
  try {
    const res = await adminDepositsApi.reminderSchedule();
    offsetsText.value = res.offsets.join(", ");
    defaultOffsets.value = res.defaultOffsets;
  } catch (err) {
    notify.error(err, "Could not load the reminder schedule");
  } finally {
    scheduleLoading.value = false;
  }
}

/** "5, 0" → [5, 0]; null when the input is not a valid offset list. */
function parseOffsets(text: string): number[] | null {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0 || parts.length > 10) return null;
  const offsets = parts.map(Number);
  if (offsets.some((n) => !Number.isInteger(n) || n < 0 || n > 30)) return null;
  return offsets;
}

const parsedOffsets = computed(() => parseOffsets(offsetsText.value));

async function saveSchedule() {
  const offsets = parsedOffsets.value;
  if (!offsets) return;
  scheduleBusy.value = true;
  try {
    const res = await adminDepositsApi.putReminderSchedule(offsets);
    offsetsText.value = res.offsets.join(", ");
    notify.success(
      "Reminder schedule saved",
      `Reminders fire ${res.offsets.join(", ")} days before the due date.`,
    );
  } catch (err) {
    notify.error(err, "Could not save the reminder schedule");
  } finally {
    scheduleBusy.value = false;
  }
}

onMounted(() => {
  void load();
  void loadSchedule();
});
</script>

<template>
  <div class="page stack">
    <PageHeader
      title="Tax deposits"
      subtitle="Monthly federal payroll tax deposits — computed from issued payroll runs, due the 15th of the following month. Record-only: pay on eftps.gov, then record the confirmation here."
    />

    <section class="card table-scroll">
      <Skeleton v-if="loading" height="10rem" />
      <DataTable v-else :value="rows" data-key="id" striped-rows :row-class="rowClass">
        <template #empty>
          <EmptyState
            icon="pi pi-calendar"
            title="No deposits yet"
            body="Deposit rows appear once a month with issued payroll runs completes — the daily scheduler syncs the schedule."
          />
        </template>
        <Column header="Period" style="width: 10rem">
          <template #body="{ data }">{{ periodLabel(data.periodStart) }}</template>
        </Column>
        <Column field="jurisdiction" header="Jurisdiction" style="width: 8rem" />
        <Column header="Amount" style="width: 9rem">
          <template #body="{ data }">{{ money(data.amount) }}</template>
        </Column>
        <Column header="Due date" style="width: 9rem">
          <template #body="{ data }">
            <span :class="{ 'overdue-text': isOverdue(data) }">{{ date(data.dueDate) }}</span>
          </template>
        </Column>
        <Column header="Status" style="width: 8rem">
          <template #body="{ data }">
            <StatusChip :status="isOverdue(data) ? 'overdue' : data.status" />
          </template>
        </Column>
        <Column header="Deposited">
          <template #body="{ data }">
            <template v-if="data.status === 'deposited'">
              {{ date(data.depositedOn) }} · EFTPS {{ data.eftpsConfirmation }}
            </template>
            <span v-else class="muted">—</span>
          </template>
        </Column>
        <Column header="Actions" style="width: 11rem">
          <template #body="{ data }">
            <Button
              v-if="data.status !== 'deposited'"
              label="Mark as deposited"
              size="small"
              text
              @click="openDepositDialog(data)"
            />
          </template>
        </Column>
      </DataTable>
    </section>

    <section class="card stack">
      <h3>Reminder schedule</h3>
      <Skeleton v-if="scheduleLoading" height="4rem" />
      <template v-else>
        <p class="muted small">
          Days before the due date when admins get an email reminder — comma-separated, each
          between 0 and 30. Default: {{ defaultOffsets.join(", ") }}.
        </p>
        <form class="row" @submit.prevent="saveSchedule">
          <InputText
            v-model="offsetsText"
            aria-label="Reminder offsets in days"
            placeholder="e.g. 5, 0"
            :invalid="parsedOffsets === null"
          />
          <Button
            type="submit"
            label="Save"
            icon="pi pi-check"
            :loading="scheduleBusy"
            :disabled="parsedOffsets === null"
          />
        </form>
        <Message v-if="parsedOffsets === null" severity="error" :closable="false">
          Enter 1–10 whole numbers between 0 and 30, comma-separated.
        </Message>
      </template>
    </section>

    <Dialog
      v-model:visible="depositDialog"
      modal
      header="Mark as deposited"
      :style="{ width: '26rem' }"
    >
      <div v-if="depositTarget" class="stack">
        <p class="muted small">
          {{ periodLabel(depositTarget.periodStart) }} — {{ money(depositTarget.amount) }},
          due {{ date(depositTarget.dueDate) }}. Pay on eftps.gov first; this records the deposit.
        </p>
        <div class="field">
          <label for="depositedOn">Deposit date</label>
          <DatePicker id="depositedOn" v-model="depositedOn" date-format="yy-mm-dd" show-icon />
        </div>
        <div class="field">
          <label for="eftpsConfirmation">EFTPS confirmation number</label>
          <InputText id="eftpsConfirmation" v-model="eftpsConfirmation" required maxlength="100" />
        </div>
        <div class="row dialog-actions">
          <Button label="Cancel" text severity="secondary" @click="depositDialog = false" />
          <Button
            label="Record deposit"
            icon="pi pi-check"
            :loading="depositBusy"
            :disabled="!depositedOn || !eftpsConfirmation.trim()"
            @click="submitDeposit"
          />
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.row-overdue {
  background: var(--p-red-50, #fef2f2);
}
.overdue-text {
  color: var(--p-red-700, #b91c1c);
  font-weight: 600;
}
.dialog-actions {
  justify-content: flex-end;
}
</style>
