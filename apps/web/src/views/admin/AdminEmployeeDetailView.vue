<script setup lang="ts">
/**
 * Admin employee detail (frontend spec): profile, compensation history
 * editor (effective-dated), W-4 history + add, invite/resend, disable.
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import InputMask from "primevue/inputmask";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import Checkbox from "primevue/checkbox";
import DatePicker from "primevue/datepicker";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import { useConfirm } from "primevue/useconfirm";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import {
  adminEmployeesApi,
  adminPayrollApi,
  ApiError,
  type AdminEmployeeDetail,
  type CompensationRow,
  type W4ElectionRow,
} from "../../lib/api";
import { filingStatusLabel } from "../../composables/useRequestTypes";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const router = useRouter();
const confirm = useConfirm();
const { money } = useMoney();
const { date, toIso } = useDates();
const notify = useNotify();

const employeeId = Number(route.params.employeeId);
const loading = ref(true);
const notFound = ref(false);
const employee = ref<AdminEmployeeDetail | null>(null);
const compensation = ref<CompensationRow[]>([]);
const w4History = ref<W4ElectionRow[]>([]);

const inviteDialog = ref(false);
const inviteEmail = ref("");
const inviteBusy = ref(false);
const setupLink = ref("");

// Spec 11 (D20a): admin direct-set of the employee TIN (backfill/corrections).
const tinDialog = ref(false);
const tinBusy = ref(false);
const tinValue = ref("");

const compDialog = ref(false);
const compBusy = ref(false);
const compForm = ref({
  periodAmount: 0,
  frequency: "monthly",
  effectiveFrom: new Date(),
  effectiveTo: null as Date | null,
});

const w4Dialog = ref(false);
const w4Busy = ref(false);
const w4Form = ref({
  taxYear: new Date().getFullYear(),
  filingStatus: "single",
  federalExempt: false,
  multipleJobs: false,
  dependentsAmount: 0,
  otherIncome: 0,
  deductionsAmount: 0,
  extraWithholding: 0,
  effectiveFrom: new Date(),
  filedDate: new Date(),
  note: "",
});

const isTerminated = computed(() => employee.value?.status === "terminated");
const accountState = computed(() => {
  const u = employee.value?.user;
  if (!u) return { label: "Not invited", canInvite: true, canResend: false };
  if (u.banned && u.banReason === "pending_enrollment")
    return { label: "Invite pending", canInvite: false, canResend: true };
  if (u.banned)
    return { label: `Disabled (${u.banReason ?? "banned"})`, canInvite: false, canResend: false };
  return { label: "Active", canInvite: false, canResend: false };
});

async function load() {
  loading.value = true;
  try {
    const [detail, comp, w4] = await Promise.all([
      adminEmployeesApi.detail(employeeId),
      adminPayrollApi.compensation(employeeId),
      adminPayrollApi.w4(employeeId),
    ]);
    employee.value = detail.employee;
    compensation.value = comp.compensation;
    w4History.value = w4.w4Elections;
  } catch (err) {
    notFound.value = true;
    notify.error(err, "Could not load employee");
  } finally {
    loading.value = false;
  }
}

async function sendInvite(resend: boolean) {
  inviteBusy.value = true;
  setupLink.value = "";
  try {
    const result = await adminEmployeesApi.invite(
      employeeId,
      resend ? {} : { email: inviteEmail.value.trim() },
    );
    setupLink.value = result.setupLink;
    inviteDialog.value = false;
    inviteEmail.value = "";
    notify.success(
      resend ? "Invite resent" : "Invite sent",
      result.smtpMissing
        ? "SMTP is not configured — copy the setup link below."
        : "Setup email queued.",
    );
    if (result.smtpMissing) {
      // surfaced via setupLink under the header
    }
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.code === "email_exists") {
      notify.error(new Error("A user with that email already exists."), "Could not invite");
    } else {
      notify.error(err, "Could not invite");
    }
  } finally {
    inviteBusy.value = false;
  }
}

function toggleStatus() {
  const disabling = !isTerminated.value;
  confirm.require({
    message: disabling
      ? `Disable ${employee.value?.legalName}? Their account loses access immediately and their sessions are revoked.`
      : `Re-enable ${employee.value?.legalName}?`,
    header: disabling ? "Disable employee" : "Re-enable employee",
    icon: "pi pi-exclamation-triangle",
    rejectProps: { label: "Cancel", severity: "secondary", text: true },
    acceptProps: {
      label: disabling ? "Disable" : "Re-enable",
      severity: disabling ? "danger" : "success",
    },
    accept: async () => {
      try {
        await adminEmployeesApi.setStatus(employeeId, {
          status: disabling ? "terminated" : "active",
        });
        notify.success(disabling ? "Employee disabled" : "Employee re-enabled");
        await load();
      } catch (err) {
        notify.error(err, "Could not update status");
      }
    },
  });
}

async function saveTaxId() {
  const taxId = tinValue.value.trim();
  if (!/^\d{9}$/.test(taxId)) {
    notify.info("Invalid tax ID", "Enter the 9-digit TIN/SSN.");
    return;
  }
  tinBusy.value = true;
  try {
    await adminEmployeesApi.setTaxId(employeeId, { taxId });
    notify.success("Tax ID saved", "Stored encrypted; only the masked form is ever shown.");
    tinDialog.value = false;
    tinValue.value = "";
    await load();
  } catch (err) {
    notify.error(err, "Could not save the tax ID");
  } finally {
    tinBusy.value = false;
  }
}

async function addCompensation() {
  compBusy.value = true;
  try {
    const effectiveFrom = toIso(compForm.value.effectiveFrom);
    if (!effectiveFrom) return;
    await adminPayrollApi.addCompensation(employeeId, {
      periodAmount: compForm.value.periodAmount,
      frequency: compForm.value.frequency,
      effectiveFrom,
      effectiveTo: compForm.value.effectiveTo ? (toIso(compForm.value.effectiveTo) ?? null) : null,
    });
    notify.success("Compensation added");
    compDialog.value = false;
    const { compensation: rows } = await adminPayrollApi.compensation(employeeId);
    compensation.value = rows;
  } catch (err) {
    notify.error(err, "Could not add compensation");
  } finally {
    compBusy.value = false;
  }
}

async function addW4() {
  w4Busy.value = true;
  try {
    const effectiveFrom = toIso(w4Form.value.effectiveFrom);
    const filedDate = toIso(w4Form.value.filedDate);
    if (!effectiveFrom || !filedDate) return;
    await adminPayrollApi.addW4(employeeId, { ...w4Form.value, effectiveFrom, filedDate });
    notify.success("W-4 election recorded");
    w4Dialog.value = false;
    const { w4Elections } = await adminPayrollApi.w4(employeeId);
    w4History.value = w4Elections;
  } catch (err) {
    notify.error(err, "Could not add W-4");
  } finally {
    w4Busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page stack">
    <PageHeader :title="employee?.legalName ?? 'Employee'">
      <Button label="Back to employees" text icon="pi pi-arrow-left" @click="router.push({ name: 'admin-employees' })" />
      <template v-if="employee">
        <Button v-if="accountState.canInvite" label="Invite" icon="pi pi-envelope" @click="inviteDialog = true" />
        <Button v-if="accountState.canResend" label="Resend invite" icon="pi pi-refresh" severity="secondary" :loading="inviteBusy" @click="sendInvite(true)" />
        <Button
          :label="isTerminated ? 'Re-enable' : 'Disable'"
          :severity="isTerminated ? 'success' : 'danger'"
          outlined
          :icon="isTerminated ? 'pi pi-check' : 'pi pi-ban'"
          @click="toggleStatus"
        />
      </template>
    </PageHeader>

    <div v-if="setupLink" class="card">
      <h3>Setup link (copy manually)</h3>
      <code class="mono" style="word-break: break-all">{{ setupLink }}</code>
    </div>

    <Skeleton v-if="loading" height="22rem" />
    <EmptyState v-else-if="notFound || !employee" icon="pi pi-exclamation-circle" title="Employee not found" />

    <Tabs v-else value="profile">
      <TabList>
        <Tab value="profile">Profile</Tab>
        <Tab value="compensation">Compensation</Tab>
        <Tab value="w4">W-4 history</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="profile">
          <section class="card" style="margin-top: 1rem">
            <div class="row" style="justify-content: space-between; margin-bottom: 0.75rem">
              <h3 style="margin: 0">Details</h3>
              <StatusChip :status="employee.status" />
            </div>
            <dl class="kv">
              <dt>Legal name</dt>
              <dd>{{ employee.legalName }}</dd>
              <dt>Preferred name</dt>
              <dd>{{ employee.preferredName ?? "—" }}</dd>
              <dt>Employment type</dt>
              <dd>{{ employee.employmentType }}</dd>
              <dt>Hire date</dt>
              <dd>{{ date(employee.hireDate) }}</dd>
              <dt v-if="employee.terminationDate">Termination</dt>
              <dd v-if="employee.terminationDate">{{ date(employee.terminationDate) }}</dd>
              <dt>Address</dt>
              <dd>
                <template v-if="employee.address">
                  {{ employee.address.line1 }}<template v-if="employee.address.line2">, {{ employee.address.line2 }}</template>,
                  {{ employee.address.city }}, {{ employee.address.state }} {{ employee.address.zip }},
                  {{ employee.address.country }}
                </template>
                <span v-else>—</span>
              </dd>
              <dt>Account</dt>
              <dd>
                <template v-if="employee.user">{{ employee.user.email }} · {{ accountState.label }}</template>
                <span v-else>Not invited</span>
              </dd>
              <dt>Tax ID</dt>
              <dd>
                {{ employee.hasTaxId ? "On file (masked — not shown)" : "Not on file" }}
                <Button
                  :label="employee.hasTaxId ? 'Correct' : 'Set'"
                  text
                  size="small"
                  icon="pi pi-lock"
                  @click="tinDialog = true"
                />
              </dd>
            </dl>
          </section>
        </TabPanel>

        <TabPanel value="compensation">
          <section class="card" style="margin-top: 1rem">
            <div class="row" style="justify-content: space-between">
              <h3 style="margin: 0">Compensation history</h3>
              <Button label="Add" size="small" icon="pi pi-plus" @click="compDialog = true" />
            </div>
            <div class="table-scroll">
              <DataTable :value="compensation" striped-rows>
                <template #empty><EmptyState title="No compensation rows" body="Add the first salary before generating drafts." /></template>
                <Column header="Period amount">
                  <template #body="{ data }">{{ money(data.periodAmount) }} / {{ data.frequency }}</template>
                </Column>
                <Column header="Effective from">
                  <template #body="{ data }">{{ date(data.effectiveFrom) }}</template>
                </Column>
                <Column header="Effective to">
                  <template #body="{ data }">{{ data.effectiveTo ? date(data.effectiveTo) : "current" }}</template>
                </Column>
              </DataTable>
            </div>
          </section>
        </TabPanel>

        <TabPanel value="w4">
          <section class="card" style="margin-top: 1rem">
            <div class="row" style="justify-content: space-between">
              <h3 style="margin: 0">W-4 elections (append-only)</h3>
              <Button label="Add" size="small" icon="pi pi-plus" @click="w4Dialog = true" />
            </div>
            <div class="table-scroll">
              <DataTable :value="w4History" striped-rows>
                <template #empty><EmptyState title="No W-4 elections" body="The default (single) withholding applies until one is filed." /></template>
                <Column field="taxYear" header="Year" />
                <Column header="Filing status">
                  <template #body="{ data }">{{ filingStatusLabel(data.filingStatus) }}</template>
                </Column>
                <Column header="Exempt">
                  <template #body="{ data }">{{ data.federalExempt ? "Yes" : "No" }}</template>
                </Column>
                <Column header="Extra withholding">
                  <template #body="{ data }">{{ money(data.extraWithholding) }}</template>
                </Column>
                <Column header="Effective from">
                  <template #body="{ data }">{{ date(data.effectiveFrom) }}</template>
                </Column>
                <Column header="Filed">
                  <template #body="{ data }">{{ date(data.filedDate) }}</template>
                </Column>
              </DataTable>
            </div>
          </section>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <Dialog v-model:visible="inviteDialog" modal header="Invite employee" :style="{ width: '28rem' }">
      <p class="muted small">
        They receive a single-use setup link (24h) to choose a password and enroll an authenticator app.
      </p>
      <div class="field">
        <label for="inviteEmail">Email</label>
        <InputText id="inviteEmail" v-model="inviteEmail" type="email" required />
      </div>
      <div class="row" style="justify-content: flex-end">
        <Button label="Cancel" text severity="secondary" @click="inviteDialog = false" />
        <Button label="Send invite" :loading="inviteBusy" :disabled="!inviteEmail.includes('@')" @click="sendInvite(false)" />
      </div>
    </Dialog>

    <Dialog v-model:visible="tinDialog" modal header="Set employee tax ID" :style="{ width: '26rem' }">
      <form class="stack" @submit.prevent="saveTaxId">
        <p class="muted small">
          The TIN/SSN is encrypted at rest, write-only in every API response, and the change is
          audit-logged with masked values only. Employees can also submit their own via a
          change request.
        </p>
        <div class="field">
          <label for="tinInput">Tax ID / SSN (9 digits)</label>
          <InputMask id="tinInput" v-model="tinValue" mask="999999999" autocomplete="off" required />
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="tinDialog = false" />
          <Button type="submit" label="Save" icon="pi pi-save" :loading="tinBusy" />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="compDialog" modal header="Add compensation" :style="{ width: '30rem' }">
      <form class="stack" @submit.prevent="addCompensation">
        <div class="form-grid">
          <div class="field">
            <label for="periodAmount">Period amount</label>
            <InputNumber id="periodAmount" v-model="compForm.periodAmount" mode="currency" currency="USD" required />
          </div>
          <div class="field">
            <label for="frequency">Frequency</label>
            <Select id="frequency" v-model="compForm.frequency" :options="['monthly', 'semimonthly', 'biweekly', 'weekly']" />
          </div>
          <div class="field">
            <label for="compFrom">Effective from</label>
            <DatePicker id="compFrom" v-model="compForm.effectiveFrom" date-format="yy-mm-dd" required />
          </div>
          <div class="field">
            <label for="compTo">Effective to (optional)</label>
            <DatePicker id="compTo" v-model="compForm.effectiveTo" date-format="yy-mm-dd" />
          </div>
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="compDialog = false" />
          <Button type="submit" label="Add" :loading="compBusy" :disabled="compForm.periodAmount <= 0" />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="w4Dialog" modal header="Add W-4 election" :style="{ width: '34rem' }">
      <form class="stack" @submit.prevent="addW4">
        <div class="form-grid">
          <div class="field">
            <label for="w4Year">Tax year</label>
            <InputNumber id="w4Year" v-model="w4Form.taxYear" :min="2020" :max="2100" :use-grouping="false" />
          </div>
          <div class="field">
            <label for="w4Status">Filing status</label>
            <Select id="w4Status" v-model="w4Form.filingStatus" :options="[
              { label: 'Single', value: 'single' },
              { label: 'Married filing jointly', value: 'married_joint' },
              { label: 'Married filing separately', value: 'married_separate' },
              { label: 'Head of household', value: 'head_of_household' },
            ]" option-label="label" option-value="value" />
          </div>
          <div class="field">
            <label for="w4Dep">Dependents (annual)</label>
            <InputNumber id="w4Dep" v-model="w4Form.dependentsAmount" mode="currency" currency="USD" />
          </div>
          <div class="field">
            <label for="w4Other">Other income (annual)</label>
            <InputNumber id="w4Other" v-model="w4Form.otherIncome" mode="currency" currency="USD" />
          </div>
          <div class="field">
            <label for="w4Ded">Deductions (annual)</label>
            <InputNumber id="w4Ded" v-model="w4Form.deductionsAmount" mode="currency" currency="USD" />
          </div>
          <div class="field">
            <label for="w4Extra">Extra withholding (per period)</label>
            <InputNumber id="w4Extra" v-model="w4Form.extraWithholding" mode="currency" currency="USD" />
          </div>
          <div class="field">
            <label for="w4From">Effective from</label>
            <DatePicker id="w4From" v-model="w4Form.effectiveFrom" date-format="yy-mm-dd" />
          </div>
          <div class="field">
            <label for="w4Filed">Date filed</label>
            <DatePicker id="w4Filed" v-model="w4Form.filedDate" date-format="yy-mm-dd" />
          </div>
        </div>
        <div class="row">
          <span class="row"><Checkbox v-model="w4Form.federalExempt" binary input-id="w4Exempt" /><label for="w4Exempt">Federal exempt</label></span>
          <span class="row"><Checkbox v-model="w4Form.multipleJobs" binary input-id="w4Multi" /><label for="w4Multi">Multiple jobs</label></span>
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="w4Dialog = false" />
          <Button type="submit" label="Add" :loading="w4Busy" />
        </div>
      </form>
    </Dialog>
  </div>
</template>
