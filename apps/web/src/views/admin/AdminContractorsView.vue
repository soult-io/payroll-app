<script setup lang="ts">
/**
 * Admin contractors (spec 10 §6): list + create dialog, and the year-end tab —
 * per-contractor totals with the dated threshold, form-required / 1042-S
 * review flags, on-demand 1099-NEC downloads, and the admin-editable
 * reporting threshold config.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import DatePicker from "primevue/datepicker";
import ToggleSwitch from "primevue/toggleswitch";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import {
  adminContractorsApi,
  type ContractorListRow,
  type ReportingConfigRow,
  type TaxStatus,
  type YearEndRow,
} from "../../lib/api";
import { useDates } from "../../composables/useDates";
import { useMoney } from "../../composables/useMoney";
import { useNotify } from "../../composables/useNotify";

const router = useRouter();
const { date, toIso } = useDates();
const { money } = useMoney();
const notify = useNotify();

// ------------------------------------------------------------- list + create

const loading = ref(true);
const rows = ref<ContractorListRow[]>([]);

const createDialog = ref(false);
const createBusy = ref(false);
const form = ref({
  legalName: "",
  hireDate: new Date(),
  taxStatus: "us_person" as TaxStatus,
  entityType: "individual",
  residenceCountry: "",
  taxForm: "w9",
  formCollectedAt: null as Date | null,
  tin: "",
  backupWithholding: false,
  servicesLocation: "foreign",
});

const isNonresident = computed(() => form.value.taxStatus === "nonresident");
watch(isNonresident, (nr) => {
  // Sensible defaults: nonresidents file W-8s, US persons file W-9.
  if (nr && form.value.taxForm === "w9") form.value.taxForm = "w8ben";
  if (!nr && form.value.taxForm.startsWith("w8")) form.value.taxForm = "w9";
});

async function load() {
  loading.value = true;
  try {
    const { contractors } = await adminContractorsApi.list();
    rows.value = contractors;
  } catch (err) {
    notify.error(err, "Could not load contractors");
  } finally {
    loading.value = false;
  }
}

function open(event: { data: ContractorListRow }) {
  void router.push({
    name: "admin-contractor-detail",
    params: { employeeId: event.data.employeeId },
  });
}

function formLabel(taxForm: string): string {
  return { w9: "W-9", w8ben: "W-8BEN", w8ben_e: "W-8BEN-E", w8eci: "W-8ECI" }[taxForm] ?? taxForm;
}

function formStatus(row: ContractorListRow): { label: string; status: string } {
  if (!row.formCollectedAt)
    return { label: `${formLabel(row.taxForm)} outstanding`, status: "awaiting_approval" };
  if (row.formExpiresAt && row.formExpiresAt <= new Date().toISOString().slice(0, 10)) {
    return {
      label: `${formLabel(row.taxForm)} expired ${date(row.formExpiresAt)}`,
      status: "void",
    };
  }
  if (row.formExpiresAt)
    return {
      label: `${formLabel(row.taxForm)} on file · expires ${date(row.formExpiresAt)}`,
      status: "issued",
    };
  return { label: `${formLabel(row.taxForm)} on file`, status: "issued" };
}

async function create() {
  createBusy.value = true;
  try {
    const hireDate = toIso(form.value.hireDate);
    if (!hireDate) return;
    const { employeeId } = await adminContractorsApi.create({
      legalName: form.value.legalName.trim(),
      hireDate,
      taxStatus: form.value.taxStatus,
      entityType: form.value.entityType as "individual" | "entity",
      ...(isNonresident.value
        ? { residenceCountry: form.value.residenceCountry.trim().toUpperCase() }
        : {}),
      taxForm: form.value.taxForm as "w9" | "w8ben" | "w8ben_e" | "w8eci",
      ...(form.value.formCollectedAt
        ? { formCollectedAt: toIso(form.value.formCollectedAt)! }
        : {}),
      ...(form.value.tin.trim() ? { tin: form.value.tin.trim() } : {}),
      backupWithholding: form.value.backupWithholding,
      servicesLocation: form.value.servicesLocation as "foreign" | "us" | "mixed",
    });
    notify.success("Contractor created", "Complete the classification on the detail page.");
    createDialog.value = false;
    void router.push({ name: "admin-contractor-detail", params: { employeeId } });
  } catch (err) {
    notify.error(err, "Could not create contractor");
  } finally {
    createBusy.value = false;
  }
}

// ------------------------------------------------------------------ year-end

const currentYear = new Date().getFullYear();
const yearFilter = ref(currentYear);
const yearOptions = [currentYear + 1, currentYear, currentYear - 1, currentYear - 2].map((y) => ({
  label: String(y),
  value: y,
}));
const yearEndLoading = ref(false);
const yearEndRows = ref<YearEndRow[]>([]);
const yearEndThreshold = ref<string | null>(null);
const configRows = ref<ReportingConfigRow[]>([]);

function yearEndStatus(row: YearEndRow): { label: string; status: string } {
  if (row.review1042) return { label: "1042-S review required", status: "awaiting_approval" };
  if (row.formRequired) return { label: "1099-NEC required", status: "approved" };
  if (row.taxStatus !== "us_person") return { label: "W-8 on file · no 1099", status: "draft" };
  return { label: "no form required (below threshold)", status: "draft" };
}

async function loadYearEnd() {
  yearEndLoading.value = true;
  try {
    const [{ rows: yRows, threshold }, { config }] = await Promise.all([
      adminContractorsApi.yearEnd(yearFilter.value),
      adminContractorsApi.reportingConfig(),
    ]);
    yearEndRows.value = yRows;
    yearEndThreshold.value = threshold;
    configRows.value = config;
  } catch (err) {
    notify.error(err, "Could not load year-end totals");
  } finally {
    yearEndLoading.value = false;
  }
}

watch(yearFilter, loadYearEnd);

const thresholdDialog = ref(false);
const thresholdBusy = ref(false);
const thresholdForm = ref({ taxYear: currentYear + 1, necThreshold: 2000, note: "" });

async function saveThreshold() {
  thresholdBusy.value = true;
  try {
    await adminContractorsApi.putReportingConfig({
      taxYear: thresholdForm.value.taxYear,
      necThreshold: thresholdForm.value.necThreshold,
      note: thresholdForm.value.note.trim(),
    });
    notify.success("Threshold saved", `Tax year ${thresholdForm.value.taxYear} updated.`);
    thresholdDialog.value = false;
    await loadYearEnd();
  } catch (err) {
    notify.error(err, "Could not save threshold");
  } finally {
    thresholdBusy.value = false;
  }
}

onMounted(async () => {
  await load();
  await loadYearEnd();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Contractors" subtitle="1099 workers — classification, invoices, and year-end reporting.">
      <Button label="New contractor" icon="pi pi-plus" size="small" @click="createDialog = true" />
    </PageHeader>

    <Tabs value="list">
      <TabList>
        <Tab value="list">Contractors</Tab>
        <Tab value="year-end">Year-end</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="list">
          <div class="card table-scroll">
            <DataTable :value="rows" :loading="loading" striped-rows row-hover @row-click="open">
              <template #empty>
                <EmptyState
                  icon="pi pi-briefcase"
                  title="No contractors yet"
                  body="Create the first contractor record — classification and tax form details come next."
                >
                  <Button label="New contractor" size="small" @click="createDialog = true" />
                </EmptyState>
              </template>
              <Column field="legalName" header="Name" />
              <Column header="Status">
                <template #body="{ data }">
                  <span class="small">{{ data.taxStatus === "us_person" ? "US person" : "Nonresident" }}</span>
                  <span class="muted small"> · {{ data.entityType }}</span>
                </template>
              </Column>
              <Column header="Tax form">
                <template #body="{ data }">
                  <StatusChip :status="formStatus(data).status" :label="formStatus(data).label" />
                </template>
              </Column>
              <Column header="Services">
                <template #body="{ data }"><span class="small">{{ data.servicesLocation }}</span></template>
              </Column>
              <Column header="Backup w/h">
                <template #body="{ data }">
                  <span v-if="data.backupWithholding" class="small">24%</span>
                  <span v-else class="muted small">—</span>
                </template>
              </Column>
            </DataTable>
          </div>
        </TabPanel>

        <TabPanel value="year-end">
          <div class="stack" style="margin-top: 0.75rem">
            <div class="row" style="align-items: center; gap: 0.75rem">
              <Select v-model="yearFilter" :options="yearOptions" option-label="label" option-value="value" size="small" />
              <span class="muted small">Federal 1099-NEC threshold for {{ yearFilter }}: {{ money(yearEndThreshold) }}</span>
              <Button label="Edit thresholds" icon="pi pi-pencil" size="small" text @click="thresholdDialog = true" />
            </div>

            <div class="card table-scroll">
              <DataTable :value="yearEndRows" :loading="yearEndLoading" striped-rows>
                <template #empty>
                  <EmptyState
                    icon="pi pi-calendar"
                    title="No contractors"
                    body="Contractors with payments in the year appear here with their totals."
                  />
                </template>
                <Column header="Contractor">
                  <template #body="{ data }">
                    <RouterLink :to="{ name: 'admin-contractor-detail', params: { employeeId: data.employeeId } }">
                      {{ data.legalName }}
                    </RouterLink>
                    <div class="muted small">{{ data.taxStatus === "us_person" ? "US person" : "Nonresident" }}</div>
                  </template>
                </Column>
                <Column header="Reportable">
                  <template #body="{ data }">
                    {{ money(data.reportableTotal) }}
                    <div class="muted small">gross {{ money(data.grossTotal) }}</div>
                  </template>
                </Column>
                <Column header="Backup withheld (945)">
                  <template #body="{ data }">{{ money(data.backupWithheldTotal) }}</template>
                </Column>
                <Column header="Determination">
                  <template #body="{ data }">
                    <StatusChip :status="yearEndStatus(data).status" :label="yearEndStatus(data).label" />
                  </template>
                </Column>
                <Column header="Form">
                  <template #body="{ data }">
                    <Button
                      v-if="data.formRequired"
                      label="1099-NEC PDF"
                      icon="pi pi-file-pdf"
                      size="small"
                      text
                      tag="a"
                      :href="adminContractorsApi.nec1099Url(data.employeeId, yearFilter)"
                      target="_blank"
                    />
                    <span v-else class="muted small">—</span>
                  </template>
                </Column>
              </DataTable>
            </div>

            <p class="muted small">
              Reportable totals exclude card / third-party-network payments (the processor files
              1099-K). Federal form only — some states still report at $600 (Spec 10 §3).
            </p>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <Dialog v-model:visible="createDialog" modal header="New contractor" :style="{ width: '34rem' }">
      <form class="stack" @submit.prevent="create">
        <div class="form-grid">
          <div class="field">
            <label for="c-legalName">Legal name</label>
            <InputText id="c-legalName" v-model="form.legalName" required />
          </div>
          <div class="field">
            <label for="c-hireDate">Start date</label>
            <DatePicker id="c-hireDate" v-model="form.hireDate" date-format="yy-mm-dd" required />
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="c-taxStatus">Tax status</label>
            <Select
              id="c-taxStatus"
              v-model="form.taxStatus"
              :options="[
                { label: 'US person', value: 'us_person' },
                { label: 'Nonresident', value: 'nonresident' },
              ]"
              option-label="label"
              option-value="value"
            />
          </div>
          <div class="field">
            <label for="c-entityType">Entity type</label>
            <Select id="c-entityType" v-model="form.entityType" :options="['individual', 'entity']" />
          </div>
        </div>
        <div v-if="isNonresident" class="field">
          <label for="c-residence">Residence country (ISO, required for nonresidents)</label>
          <InputText id="c-residence" v-model="form.residenceCountry" maxlength="2" placeholder="PT" required />
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="c-taxForm">Tax form</label>
            <Select id="c-taxForm" v-model="form.taxForm" :options="['w9', 'w8ben', 'w8ben_e', 'w8eci']" />
          </div>
          <div class="field">
            <label for="c-collected">Form collected (leave empty if outstanding)</label>
            <DatePicker id="c-collected" v-model="form.formCollectedAt" date-format="yy-mm-dd" />
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="c-tin">TIN (optional — encrypted at rest)</label>
            <InputText id="c-tin" v-model="form.tin" autocomplete="off" />
          </div>
          <div class="field">
            <label for="c-services">Services location</label>
            <Select id="c-services" v-model="form.servicesLocation" :options="['foreign', 'us', 'mixed']" />
          </div>
        </div>
        <div class="field row" style="align-items: center; gap: 0.5rem">
          <ToggleSwitch v-model="form.backupWithholding" input-id="c-backup" />
          <label for="c-backup">Backup withholding (24% — missing/incorrect TIN or IRS notice)</label>
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="createDialog = false" />
          <Button
            type="submit"
            label="Create"
            :loading="createBusy"
            :disabled="!form.legalName.trim() || (isNonresident && !form.residenceCountry.trim())"
          />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="thresholdDialog" modal header="Reporting thresholds" :style="{ width: '30rem' }">
      <div class="stack">
        <DataTable :value="configRows" size="small">
          <Column field="taxYear" header="Year" />
          <Column header="Threshold">
            <template #body="{ data }">{{ money(data.necThreshold) }}</template>
          </Column>
          <Column field="note" header="Note" />
        </DataTable>
        <form class="stack" @submit.prevent="saveThreshold">
          <div class="form-grid">
            <div class="field">
              <label for="t-year">Tax year</label>
              <InputNumber id="t-year" v-model="thresholdForm.taxYear" :min="2020" :max="2100" :use-grouping="false" />
            </div>
            <div class="field">
              <label for="t-threshold">1099-NEC threshold</label>
              <InputNumber id="t-threshold" v-model="thresholdForm.necThreshold" :min="0" mode="currency" currency="USD" />
            </div>
          </div>
          <div class="field">
            <label for="t-note">Note</label>
            <InputText id="t-note" v-model="thresholdForm.note" placeholder="e.g. inflation-indexed figure for 2027" />
          </div>
          <div class="row" style="justify-content: flex-end">
            <Button label="Cancel" text severity="secondary" type="button" @click="thresholdDialog = false" />
            <Button type="submit" label="Save" :loading="thresholdBusy" />
          </div>
        </form>
      </div>
    </Dialog>
  </div>
</template>
