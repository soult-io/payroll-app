<script setup lang="ts">
/**
 * Admin configuration (frontend spec): tax tables (scalars + bracket grid),
 * company pay schedule (+ manual draft generation), company profile.
 *
 * Rates are shown to the admin as percents (6.2) and stored as decimals
 * (0.062) — the server contract is 0–1 numbers.
 */
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import InputText from "primevue/inputtext";
import InputNumber from "primevue/inputnumber";
import ToggleSwitch from "primevue/toggleswitch";
import Skeleton from "primevue/skeleton";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import PageHeader from "../../components/PageHeader.vue";
import {
  adminPayrollApi,
  adminSettingsApi,
  type Address,
  type CompanyProfile,
  type PaySchedule,
} from "../../lib/api";
import { useNotify } from "../../composables/useNotify";

const notify = useNotify();

// ------------------------------------------------------------------ tax tab
interface ScalarField {
  key: string;
  label: string;
  kind: "money" | "rate";
}
const SCALAR_FIELDS: ScalarField[] = [
  { key: "standardDeduction", label: "Standard deduction", kind: "money" },
  { key: "socialSecurityRate", label: "Social Security rate (EE)", kind: "rate" },
  { key: "socialSecurityWageCap", label: "Social Security wage cap", kind: "money" },
  { key: "medicareRate", label: "Medicare rate (EE)", kind: "rate" },
  { key: "medicareAdditionalRate", label: "Additional Medicare rate", kind: "rate" },
  { key: "medicareAdditionalThreshold", label: "Additional Medicare threshold", kind: "money" },
  { key: "stateWithholdingRate", label: "State withholding rate", kind: "rate" },
  { key: "employerSocialSecurityRate", label: "Social Security rate (ER)", kind: "rate" },
  { key: "employerMedicareRate", label: "Medicare rate (ER)", kind: "rate" },
  { key: "futaRate", label: "FUTA rate", kind: "rate" },
  { key: "futaWageCap", label: "FUTA wage cap", kind: "money" },
];

interface BracketEdit {
  minAmount: number | null;
  maxAmount: number | null; // null = no cap (top bracket)
  rate: number | null; // percent in the UI
  top: boolean;
}

const taxLoading = ref(true);
const taxSaving = ref(false);
const availableYears = ref<number[]>([]);
const taxYear = ref<number>(new Date().getFullYear());
const scalars = ref<Record<string, number | null>>({});
const brackets = ref<BracketEdit[]>([]);
/** Cache of loaded rows per year so "new year" can copy the previous one. */
const rawByYear = ref<
  Map<
    number,
    {
      config: Record<string, string>;
      brackets: { minAmount: string; maxAmount: string | null; rate: string }[];
    }
  >
>(new Map());

const yearOptions = computed(() => {
  const current = new Date().getFullYear();
  const years = new Set<number>([...availableYears.value, current, current + 1]);
  return [...years].sort((a, b) => b - a).map((y) => ({ label: String(y), value: y }));
});

function fillTaxForm(year: number) {
  const raw = rawByYear.value.get(year) ?? rawByYear.value.get(year - 1); // new year: start from previous year's values
  const next: Record<string, number | null> = {};
  for (const f of SCALAR_FIELDS) {
    const v = raw?.config[f.key];
    const n = v === undefined ? null : Number(v);
    next[f.key] = n === null || Number.isNaN(n) ? null : f.kind === "rate" ? n * 100 : n;
  }
  scalars.value = next;
  brackets.value = (raw?.brackets ?? []).map((b) => ({
    minAmount: Number(b.minAmount),
    maxAmount: b.maxAmount === null ? null : Number(b.maxAmount),
    rate: Number(b.rate) * 100,
    top: b.maxAmount === null,
  }));
  if (brackets.value.length === 0) {
    brackets.value = [{ minAmount: 0, maxAmount: null, rate: null, top: true }];
  }
}

async function loadTax() {
  taxLoading.value = true;
  try {
    const { taxConfig, taxBrackets } = await adminPayrollApi.taxConfig({ jurisdiction: "federal" });
    const map = new Map<
      number,
      {
        config: Record<string, string>;
        brackets: { minAmount: string; maxAmount: string | null; rate: string }[];
      }
    >();
    for (const c of taxConfig) {
      map.set(c.taxYear, { config: { ...c } as unknown as Record<string, string>, brackets: [] });
    }
    for (const b of taxBrackets) {
      map
        .get(b.taxYear)
        ?.brackets.push({ minAmount: b.minAmount, maxAmount: b.maxAmount, rate: b.rate });
    }
    rawByYear.value = map;
    availableYears.value = [...map.keys()];
    fillTaxForm(taxYear.value);
  } catch (err) {
    notify.error(err, "Could not load tax tables");
  } finally {
    taxLoading.value = false;
  }
}

function addBracket() {
  brackets.value.push({ minAmount: null, maxAmount: null, rate: null, top: false });
}

function removeBracket(index: number) {
  brackets.value.splice(index, 1);
}

async function saveTax() {
  const config: Record<string, number> = {};
  for (const f of SCALAR_FIELDS) {
    const v = scalars.value[f.key];
    if (v === null || v === undefined || Number.isNaN(v)) {
      notify.info("Missing value", `Fill in “${f.label}” before saving.`);
      return;
    }
    config[f.key] = f.kind === "rate" ? v / 100 : v;
  }
  const rows = brackets.value
    .map((b, i) => ({
      ordinal: i + 1,
      minAmount: b.minAmount,
      maxAmount: b.top ? null : b.maxAmount,
      rate: b.rate === null ? null : b.rate / 100,
    }))
    .filter((b) => b.minAmount !== null && b.rate !== null) as {
    ordinal: number;
    minAmount: number;
    maxAmount: number | null;
    rate: number;
  }[];
  if (rows.length === 0) {
    notify.info("Brackets required", "Add at least one complete bracket row.");
    return;
  }
  taxSaving.value = true;
  try {
    await adminPayrollApi.putTaxConfig({
      jurisdiction: "federal",
      taxYear: taxYear.value,
      config,
      brackets: rows,
    });
    notify.success("Tax tables saved", `Federal ${taxYear.value} rates and brackets updated.`);
    await loadTax();
  } catch (err) {
    notify.error(err, "Could not save tax tables");
  } finally {
    taxSaving.value = false;
  }
}

watch(taxYear, (y) => fillTaxForm(y));

// ------------------------------------------------------------- schedule tab
const scheduleLoading = ref(true);
const scheduleSaving = ref(false);
const schedule = ref<PaySchedule | null>(null);
const schedForm = ref({ draftDayOfMonth: 15, payDayOfMonth: 28, autoDraft: true, active: true });

const genYear = ref<number>(new Date().getFullYear());
const genMonth = ref<number>(new Date().getMonth() + 1);
const generating = ref(false);
const monthOptions = Array.from({ length: 12 }, (_, i) => ({
  label: new Date(2000, i, 1).toLocaleString("en", { month: "long" }),
  value: i + 1,
}));

async function loadSchedule() {
  scheduleLoading.value = true;
  try {
    const { schedules } = await adminPayrollApi.schedules();
    const company = schedules.find((s) => s.employeeId === null) ?? schedules[0] ?? null;
    schedule.value = company;
    if (company) {
      schedForm.value = {
        draftDayOfMonth: company.draftDayOfMonth,
        payDayOfMonth: company.payDayOfMonth,
        autoDraft: company.autoDraft,
        active: company.active,
      };
    }
  } catch (err) {
    notify.error(err, "Could not load pay schedule");
  } finally {
    scheduleLoading.value = false;
  }
}

async function saveSchedule() {
  scheduleSaving.value = true;
  try {
    const { schedule: saved } = await adminPayrollApi.putSchedule({ ...schedForm.value });
    schedule.value = saved;
    notify.success("Pay schedule saved");
  } catch (err) {
    notify.error(err, "Could not save pay schedule");
  } finally {
    scheduleSaving.value = false;
  }
}

async function generateNow() {
  generating.value = true;
  try {
    const { generated, skipped } = await adminPayrollApi.generate({
      year: genYear.value,
      month: genMonth.value,
    });
    notify.success(
      `Drafts generated: ${generated.length}`,
      skipped.length
        ? `Skipped ${skipped.length}: ${skipped.map((s) => `#${s.employeeId} ${s.reason}`).join("; ")}`
        : undefined,
    );
  } catch (err) {
    notify.error(err, "Could not generate drafts");
  } finally {
    generating.value = false;
  }
}

// -------------------------------------------------------------- company tab
const companyLoading = ref(true);
const companySaving = ref(false);
const company = ref<CompanyProfile | null>(null);
const companyForm = ref({
  legalName: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  zip: "",
  country: "ES",
});

async function loadCompany() {
  companyLoading.value = true;
  try {
    const { company: c } = await adminSettingsApi.company();
    company.value = c;
    companyForm.value = {
      legalName: c.legalName,
      line1: c.address?.line1 ?? "",
      line2: c.address?.line2 ?? "",
      city: c.address?.city ?? "",
      state: c.address?.state ?? "",
      zip: c.address?.zip ?? "",
      country: c.address?.country ?? "ES",
    };
  } catch (err) {
    notify.error(err, "Could not load company profile");
  } finally {
    companyLoading.value = false;
  }
}

async function saveCompany() {
  if (!companyForm.value.legalName.trim()) {
    notify.info("Legal name required");
    return;
  }
  companySaving.value = true;
  try {
    const address: Address = {
      line1: companyForm.value.line1.trim(),
      city: companyForm.value.city.trim(),
      state: companyForm.value.state.trim(),
      zip: companyForm.value.zip.trim(),
      country: companyForm.value.country.trim().toUpperCase(),
      ...(companyForm.value.line2.trim() ? { line2: companyForm.value.line2.trim() } : {}),
    };
    const { company: saved } = await adminSettingsApi.putCompany({
      legalName: companyForm.value.legalName.trim(),
      address,
    });
    company.value = saved;
    notify.success("Company profile saved");
  } catch (err) {
    notify.error(err, "Could not save company profile");
  } finally {
    companySaving.value = false;
  }
}

onMounted(() => {
  void loadTax();
  void loadSchedule();
  void loadCompany();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Configuration" subtitle="Tax tables, the company pay schedule, and the company profile." />

    <Tabs value="tax">
      <TabList>
        <Tab value="tax">Tax tables</Tab>
        <Tab value="schedule">Pay schedule</Tab>
        <Tab value="company">Company</Tab>
      </TabList>
      <TabPanels>
        <!-- ------------------------------------------------------------ tax -->
        <TabPanel value="tax">
          <section class="card stack">
            <div class="row">
              <div class="field">
                <label for="taxYear">Tax year</label>
                <Select v-model="taxYear" input-id="taxYear" :options="yearOptions" option-label="label" option-value="value" />
              </div>
              <p class="muted small">Jurisdiction: federal · picking a new year pre-fills from the previous one.</p>
            </div>

            <Skeleton v-if="taxLoading" height="16rem" />
            <template v-else>
              <div class="form-grid">
                <div v-for="f in SCALAR_FIELDS" :key="f.key" class="field">
                  <label :for="`sc-${f.key}`">{{ f.label }}</label>
                  <InputNumber
                    v-model="scalars[f.key]"
                    :input-id="`sc-${f.key}`"
                    v-bind="f.kind === 'money'
                      ? { mode: 'currency' as const, currency: 'USD', locale: 'en-US' }
                      : { suffix: ' %', minFractionDigits: 1, maxFractionDigits: 3, max: 100 }"
                  />
                </div>
              </div>

              <h3>Withholding brackets</h3>
              <div class="table-scroll">
                <table class="bracket-grid">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>From</th>
                      <th>To (blank = no cap)</th>
                      <th>Rate</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(b, i) in brackets" :key="i">
                      <td>{{ i + 1 }}</td>
                      <td>
                        <InputNumber v-model="b.minAmount" mode="currency" currency="USD" locale="en-US" />
                      </td>
                      <td>
                        <div class="row">
                          <InputNumber v-model="b.maxAmount" mode="currency" currency="USD" locale="en-US" :disabled="b.top" />
                          <ToggleSwitch v-model="b.top" title="No cap (top bracket)" />
                        </div>
                      </td>
                      <td>
                        <InputNumber v-model="b.rate" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="3" :max="100" />
                      </td>
                      <td>
                        <Button icon="pi pi-trash" text severity="danger" :disabled="brackets.length <= 1" @click="removeBracket(i)" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="row">
                <Button label="Add bracket" icon="pi pi-plus" text @click="addBracket" />
                <Button label="Save tax tables" icon="pi pi-save" :loading="taxSaving" @click="saveTax" />
              </div>
            </template>
          </section>
        </TabPanel>

        <!-- -------------------------------------------------------- schedule -->
        <TabPanel value="schedule">
          <div class="grid-2">
            <section class="card stack">
              <h3>Company pay schedule</h3>
              <Skeleton v-if="scheduleLoading" height="10rem" />
              <template v-else>
                <div class="form-grid">
                  <div class="field">
                    <label for="draftDay">Draft day of month</label>
                    <InputNumber v-model="schedForm.draftDayOfMonth" input-id="draftDay" :min="1" :max="28" />
                  </div>
                  <div class="field">
                    <label for="payDay">Pay day of month</label>
                    <InputNumber v-model="schedForm.payDayOfMonth" input-id="payDay" :min="1" :max="28" />
                  </div>
                  <div class="field">
                    <label for="autoDraft">Auto-draft monthly</label>
                    <ToggleSwitch v-model="schedForm.autoDraft" input-id="autoDraft" />
                  </div>
                  <div class="field">
                    <label for="schedActive">Schedule active</label>
                    <ToggleSwitch v-model="schedForm.active" input-id="schedActive" />
                  </div>
                </div>
                <div class="row">
                  <Button label="Save schedule" icon="pi pi-save" :loading="scheduleSaving" @click="saveSchedule" />
                </div>
              </template>
            </section>

            <section class="card stack">
              <h3>Generate drafts now</h3>
              <p class="muted small">
                Creates draft runs for every active employee with compensation, for the chosen month. Runs that
                already exist or lack data are skipped.
              </p>
              <div class="form-grid">
                <div class="field">
                  <label for="genYear">Year</label>
                  <InputNumber v-model="genYear" input-id="genYear" :use-grouping="false" :min="2020" :max="2100" />
                </div>
                <div class="field">
                  <label for="genMonth">Month</label>
                  <Select v-model="genMonth" input-id="genMonth" :options="monthOptions" option-label="label" option-value="value" />
                </div>
              </div>
              <div class="row">
                <Button label="Generate" icon="pi pi-bolt" :loading="generating" @click="generateNow" />
              </div>
            </section>
          </div>
        </TabPanel>

        <!-- --------------------------------------------------------- company -->
        <TabPanel value="company">
          <section class="card stack">
            <h3>Company profile</h3>
            <Skeleton v-if="companyLoading" height="10rem" />
            <template v-else>
              <dl class="kv">
                <dt>EIN</dt>
                <dd>{{ company?.einMasked ?? "—" }} <span class="muted small">(change requires a config update, not the UI)</span></dd>
              </dl>
              <div class="form-grid">
                <div class="field">
                  <label for="legalName">Legal name</label>
                  <InputText id="legalName" v-model="companyForm.legalName" />
                </div>
                <div class="field">
                  <label for="cLine1">Address line 1</label>
                  <InputText id="cLine1" v-model="companyForm.line1" />
                </div>
                <div class="field">
                  <label for="cLine2">Address line 2</label>
                  <InputText id="cLine2" v-model="companyForm.line2" />
                </div>
                <div class="field">
                  <label for="cCity">City</label>
                  <InputText id="cCity" v-model="companyForm.city" />
                </div>
                <div class="field">
                  <label for="cState">State/Province</label>
                  <InputText id="cState" v-model="companyForm.state" />
                </div>
                <div class="field">
                  <label for="cZip">ZIP/Postal code</label>
                  <InputText id="cZip" v-model="companyForm.zip" />
                </div>
                <div class="field">
                  <label for="cCountry">Country</label>
                  <InputText id="cCountry" v-model="companyForm.country" maxlength="2" />
                </div>
              </div>
              <div class="row">
                <Button label="Save company profile" icon="pi pi-save" :loading="companySaving" @click="saveCompany" />
              </div>
            </template>
          </section>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<style scoped>
.bracket-grid {
  width: 100%;
  border-collapse: collapse;
}
.bracket-grid th,
.bracket-grid td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  vertical-align: middle;
}
.bracket-grid th {
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #6b7280);
}
</style>
