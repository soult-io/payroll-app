<script setup lang="ts">
/**
 * Admin contractor detail (spec 10 §6): classification & tax-form record with
 * expiry countdown and document status, US-days log, and the invoice queue
 * (create / approve / reject / record payment / void).
 */
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import DatePicker from "primevue/datepicker";
import Textarea from "primevue/textarea";
import ToggleSwitch from "primevue/toggleswitch";
import PageHeader from "../../components/PageHeader.vue";
import StatusChip from "../../components/StatusChip.vue";
import EmptyState from "../../components/EmptyState.vue";
import {
  adminContractorsApi,
  type ContractorDetail,
  type ContractorInvoiceRow,
  type InvoiceDay,
  type PaymentMethod,
  type RecurringTemplateRow,
  type TaxStatus,
  type UsDayEntry,
} from "../../lib/api";
import { useDates } from "../../composables/useDates";
import { useMoney } from "../../composables/useMoney";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const employeeId = Number(route.params.employeeId);
const { date, toIso, fromIso } = useDates();
const { money } = useMoney();
const notify = useNotify();

const loading = ref(true);
const data = ref<ContractorDetail | null>(null);

const form = ref({
  legalName: "",
  taxStatus: "us_person" as TaxStatus,
  entityType: "individual",
  residenceCountry: "",
  taxForm: "w9",
  formCollectedAt: null as Date | null,
  tin: "",
  backupWithholding: false,
  servicesLocation: "foreign",
});
const usDaysLog = ref<UsDayEntry[]>([]);
const saveBusy = ref(false);

const isNonresident = computed(() => form.value.taxStatus === "nonresident");

/** Days until the stored form expires; null when w9/no expiry. */
const expiryCountdown = computed(() => {
  const d = data.value?.contractor.details;
  if (!d?.formExpiresAt) return null;
  const ms =
    Date.parse(`${d.formExpiresAt}T00:00:00Z`) -
    Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
});

const documentStatus = computed(() => {
  const d = data.value?.contractor.details;
  if (!d) return null;
  const formLabel =
    { w9: "W-9", w8ben: "W-8BEN", w8ben_e: "W-8BEN-E", w8eci: "W-8ECI" }[d.taxForm] ?? d.taxForm;
  if (!d.formCollectedAt) {
    return { label: `${formLabel} outstanding — payments blocked`, status: "void" };
  }
  const days = expiryCountdown.value;
  if (days !== null && days < 0)
    return {
      label: `${formLabel} expired ${date(d.formExpiresAt)} — payments blocked`,
      status: "void",
    };
  if (days !== null && days <= 30)
    return {
      label: `${formLabel} expires in ${days} days (${date(d.formExpiresAt)})`,
      status: "awaiting_approval",
    };
  if (days !== null)
    return {
      label: `${formLabel} on file · expires in ${days} days (${date(d.formExpiresAt)})`,
      status: "issued",
    };
  return { label: `${formLabel} on file (no expiry)`, status: "issued" };
});

function applyDetail(detail: ContractorDetail) {
  data.value = detail;
  const c = detail.contractor;
  form.value = {
    legalName: c.legalName,
    taxStatus: c.details.taxStatus,
    entityType: c.details.entityType,
    residenceCountry: c.details.residenceCountry ?? "",
    taxForm: c.details.taxForm,
    formCollectedAt: fromIso(c.details.formCollectedAt),
    tin: "",
    backupWithholding: c.details.backupWithholding,
    servicesLocation: c.details.servicesLocation,
  };
  usDaysLog.value = c.details.usDaysLog.map((e) => ({ ...e }));
}

async function load() {
  loading.value = true;
  try {
    const [detail, recurring] = await Promise.all([
      adminContractorsApi.detail(employeeId),
      adminContractorsApi.recurringList(employeeId),
    ]);
    applyDetail(detail);
    templates.value = recurring.templates;
  } catch (err) {
    notify.error(err, "Could not load contractor");
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------- recurring (spec 12)

const templates = ref<RecurringTemplateRow[]>([]);
const templateDialog = ref(false);
const templateBusy = ref(false);
const editingTemplate = ref<RecurringTemplateRow | null>(null);
const templateForm = ref({
  description: "",
  amount: null as number | null,
  invoiceDay: "last_day" as InvoiceDay,
  invoiceDayOfMonth: null as number | null,
  payDayOfMonth: null as number | null,
  startsOn: new Date(),
  endsOn: null as Date | null,
});
const endTarget = ref<RecurringTemplateRow | null>(null);
const endDate = ref<Date | null>(null);
const endBusy = ref(false);

/** "Last day of month · pays on the 11th" — the schedule column. */
function scheduleSummary(t: RecurringTemplateRow): string {
  const invoice =
    t.invoiceDay === "fixed" ? `Invoice day ${t.invoiceDayOfMonth}` : "Invoice last day of month";
  return `${invoice} · pays on the ${t.payDayOfMonth}th of the next month`;
}

function openTemplateDialog(t?: RecurringTemplateRow) {
  editingTemplate.value = t ?? null;
  templateForm.value = {
    description: t?.description ?? "",
    amount: t ? Number(t.amount) : null,
    invoiceDay: t?.invoiceDay ?? "last_day",
    invoiceDayOfMonth: t?.invoiceDayOfMonth ?? null,
    payDayOfMonth: t?.payDayOfMonth ?? null,
    startsOn: t ? fromIso(t.startsOn)! : new Date(),
    endsOn: fromIso(t?.endsOn ?? null),
  };
  templateDialog.value = true;
}

async function saveTemplate() {
  templateBusy.value = true;
  try {
    const startsOn = toIso(templateForm.value.startsOn);
    if (!startsOn || !templateForm.value.amount || !templateForm.value.payDayOfMonth) return;
    const input = {
      description: templateForm.value.description.trim(),
      amount: templateForm.value.amount,
      invoiceDay: templateForm.value.invoiceDay,
      invoiceDayOfMonth:
        templateForm.value.invoiceDay === "fixed" ? templateForm.value.invoiceDayOfMonth : null,
      payDayOfMonth: templateForm.value.payDayOfMonth,
      startsOn,
      endsOn: templateForm.value.endsOn ? toIso(templateForm.value.endsOn)! : null,
    };
    if (editingTemplate.value) {
      await adminContractorsApi.recurringUpdate(editingTemplate.value.id, input);
      notify.success("Template updated — future generations only");
    } else {
      await adminContractorsApi.recurringCreate(employeeId, input);
      notify.success("Recurring template created");
    }
    templateDialog.value = false;
    await load();
  } catch (err) {
    notify.error(err, "Could not save template");
  } finally {
    templateBusy.value = false;
  }
}

async function toggleTemplate(t: RecurringTemplateRow) {
  try {
    await adminContractorsApi.recurringUpdate(t.id, { active: !t.active });
    notify.success(t.active ? "Template paused" : "Template resumed");
    await load();
  } catch (err) {
    notify.error(err, "Could not update template");
  }
}

function openEnd(t: RecurringTemplateRow) {
  endTarget.value = t;
  endDate.value = fromIso(t.endsOn);
}

async function saveEnd() {
  if (!endTarget.value || !endDate.value) return;
  endBusy.value = true;
  try {
    await adminContractorsApi.recurringUpdate(endTarget.value.id, {
      endsOn: toIso(endDate.value)!,
    });
    notify.success("Template end date set — it retires after the last period");
    endTarget.value = null;
    await load();
  } catch (err) {
    notify.error(err, "Could not end template");
  } finally {
    endBusy.value = false;
  }
}

async function removeTemplate(t: RecurringTemplateRow) {
  try {
    await adminContractorsApi.recurringDelete(t.id);
    notify.success("Template deleted");
    await load();
  } catch (err) {
    // D25: delete is blocked after the first generation — server names it.
    notify.error(err, "Could not delete template");
  }
}

async function saveClassification() {
  saveBusy.value = true;
  try {
    await adminContractorsApi.update(employeeId, {
      legalName: form.value.legalName.trim(),
      taxStatus: form.value.taxStatus,
      entityType: form.value.entityType as "individual" | "entity",
      residenceCountry: isNonresident.value
        ? form.value.residenceCountry.trim().toUpperCase()
        : null,
      taxForm: form.value.taxForm as "w9" | "w8ben" | "w8ben_e" | "w8eci",
      formCollectedAt: form.value.formCollectedAt ? toIso(form.value.formCollectedAt)! : null,
      ...(form.value.tin.trim() ? { tin: form.value.tin.trim() } : {}),
      backupWithholding: form.value.backupWithholding,
      servicesLocation: form.value.servicesLocation as "foreign" | "us" | "mixed",
      usDaysLog: usDaysLog.value,
    });
    notify.success("Classification saved");
    await load();
  } catch (err) {
    notify.error(err, "Could not save classification");
  } finally {
    saveBusy.value = false;
  }
}

function addUsDays() {
  usDaysLog.value.push({ year: new Date().getFullYear(), days: 1, note: "" });
}

// ---------------------------------------------------------------- invoices

const invoiceDialog = ref(false);
const invoiceBusy = ref(false);
const invoiceForm = ref({
  invoiceRef: "",
  description: "",
  amount: null as number | null,
  invoiceDate: new Date(),
});

const payDialog = ref(false);
const payBusy = ref(false);
const payTarget = ref<ContractorInvoiceRow | null>(null);
const payForm = ref({
  payDate: new Date(),
  amount: null as number | null,
  method: "ach" as PaymentMethod,
  reference: "",
});

const noteDialog = ref<{ kind: "reject" | "void"; invoice: ContractorInvoiceRow } | null>(null);
const noteText = ref("");
const noteBusy = ref(false);

const methodOptions = [
  { label: "ACH", value: "ach" },
  { label: "Check", value: "check" },
  { label: "Wire", value: "wire" },
  { label: "Card (1099-K, excluded)", value: "card" },
  { label: "Third-party network (1099-K, excluded)", value: "third_party_network" },
];

async function createInvoice() {
  invoiceBusy.value = true;
  try {
    const invoiceDate = toIso(invoiceForm.value.invoiceDate);
    if (!invoiceDate || !invoiceForm.value.amount) return;
    await adminContractorsApi.addInvoice(employeeId, {
      ...(invoiceForm.value.invoiceRef.trim()
        ? { invoiceRef: invoiceForm.value.invoiceRef.trim() }
        : {}),
      description: invoiceForm.value.description.trim(),
      amount: invoiceForm.value.amount,
      invoiceDate,
    });
    notify.success("Invoice recorded");
    invoiceDialog.value = false;
    invoiceForm.value = { invoiceRef: "", description: "", amount: null, invoiceDate: new Date() };
    await load();
  } catch (err) {
    notify.error(err, "Could not record invoice");
  } finally {
    invoiceBusy.value = false;
  }
}

async function approveInvoice(invoice: ContractorInvoiceRow) {
  try {
    await adminContractorsApi.approve(invoice.id);
    notify.success("Invoice approved");
    await load();
  } catch (err) {
    notify.error(err, "Could not approve invoice");
  }
}

function openPay(invoice: ContractorInvoiceRow) {
  payTarget.value = invoice;
  payForm.value = {
    payDate: new Date(),
    amount: Number(invoice.amount),
    method: "ach",
    reference: "",
  };
  payDialog.value = true;
}

async function recordPayment() {
  if (!payTarget.value) return;
  payBusy.value = true;
  try {
    const payDate = toIso(payForm.value.payDate);
    if (!payDate || !payForm.value.amount) return;
    await adminContractorsApi.pay(payTarget.value.id, {
      payDate,
      amount: payForm.value.amount,
      method: payForm.value.method,
      ...(payForm.value.reference.trim() ? { reference: payForm.value.reference.trim() } : {}),
    });
    notify.success("Payment recorded");
    payDialog.value = false;
    await load();
  } catch (err) {
    // The payment gate names the missing/expired form — surface it verbatim.
    notify.error(err, "Payment blocked");
  } finally {
    payBusy.value = false;
  }
}

async function submitNote() {
  if (!noteDialog.value) return;
  noteBusy.value = true;
  try {
    const { kind, invoice } = noteDialog.value;
    if (kind === "reject") {
      await adminContractorsApi.reject(invoice.id, noteText.value.trim());
      notify.success("Invoice rejected");
    } else {
      await adminContractorsApi.void(invoice.id, noteText.value.trim());
      notify.success("Invoice voided");
    }
    noteDialog.value = null;
    noteText.value = "";
    await load();
  } catch (err) {
    notify.error(err, "Could not update invoice");
  } finally {
    noteBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page stack">
    <PageHeader :title="data?.contractor.legalName ?? 'Contractor'" subtitle="1099 contractor — classification, documents, invoices.">
      <RouterLink :to="{ name: 'admin-contractors' }">
        <Button label="Back" icon="pi pi-arrow-left" size="small" text />
      </RouterLink>
    </PageHeader>

    <div v-if="documentStatus" class="card">
      <StatusChip :status="documentStatus.status" :label="documentStatus.label" />
      <span v-if="data?.contractor.details.backupWithholding" class="muted small" style="margin-left: 0.75rem">
        Backup withholding active — 24% withheld at payment.
      </span>
      <span v-if="data?.contractor.details.tinMasked" class="muted small" style="margin-left: 0.75rem">
        TIN {{ data.contractor.details.tinMasked }}
      </span>
    </div>

    <div class="card">
      <h3>Classification &amp; tax form</h3>
      <form class="stack" @submit.prevent="saveClassification">
        <div class="form-grid">
          <div class="field">
            <label for="d-legalName">Legal name</label>
            <InputText id="d-legalName" v-model="form.legalName" required />
          </div>
          <div class="field">
            <label for="d-taxStatus">Tax status</label>
            <Select
              id="d-taxStatus"
              v-model="form.taxStatus"
              :options="[
                { label: 'US person', value: 'us_person' },
                { label: 'Nonresident', value: 'nonresident' },
              ]"
              option-label="label"
              option-value="value"
            />
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="d-entityType">Entity type</label>
            <Select id="d-entityType" v-model="form.entityType" :options="['individual', 'entity']" />
          </div>
          <div v-if="isNonresident" class="field">
            <label for="d-residence">Residence country (ISO)</label>
            <InputText id="d-residence" v-model="form.residenceCountry" maxlength="2" required />
          </div>
          <div v-else class="field">
            <label for="d-services">Services location</label>
            <Select id="d-services" v-model="form.servicesLocation" :options="['foreign', 'us', 'mixed']" />
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="d-taxForm">Tax form</label>
            <Select id="d-taxForm" v-model="form.taxForm" :options="['w9', 'w8ben', 'w8ben_e', 'w8eci']" />
          </div>
          <div class="field">
            <label for="d-collected">Form collected</label>
            <DatePicker id="d-collected" v-model="form.formCollectedAt" date-format="yy-mm-dd" show-button-bar />
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="d-tin">TIN (write-only — encrypted at rest; leave blank to keep)</label>
            <InputText id="d-tin" v-model="form.tin" autocomplete="off" :placeholder="data?.contractor.details.tinMasked ?? 'not set'" />
          </div>
          <div class="field row" style="align-items: flex-end; gap: 0.5rem; padding-bottom: 0.4rem">
            <ToggleSwitch v-model="form.backupWithholding" input-id="d-backup" />
            <label for="d-backup">Backup withholding (24%)</label>
          </div>
        </div>

        <div class="field">
          <div class="row" style="justify-content: space-between; align-items: center">
            <label>US days log <span class="muted small">(any entry triggers 1042-S review at year-end)</span></label>
            <Button label="Add year" icon="pi pi-plus" size="small" text type="button" @click="addUsDays" />
          </div>
          <div v-for="(entry, i) in usDaysLog" :key="i" class="row" style="gap: 0.5rem; align-items: center">
            <InputNumber v-model="entry.year" :min="2000" :max="2100" :use-grouping="false" style="width: 7rem" />
            <InputNumber v-model="entry.days" :min="1" :max="366" style="width: 6rem" placeholder="days" />
            <InputText v-model="entry.note" placeholder="note" style="flex: 1" />
            <Button icon="pi pi-times" size="small" text severity="danger" type="button" @click="usDaysLog.splice(i, 1)" />
          </div>
        </div>

        <div class="row" style="justify-content: flex-end">
          <Button type="submit" label="Save classification" :loading="saveBusy" :disabled="isNonresident && !form.residenceCountry.trim()" />
        </div>
      </form>
    </div>

    <div class="card">
      <div class="row" style="justify-content: space-between; align-items: center">
        <h3 style="margin: 0">Recurring</h3>
        <Button label="New template" icon="pi pi-plus" size="small" @click="openTemplateDialog()" />
      </div>
      <DataTable :value="templates" :loading="loading" striped-rows>
        <template #empty>
          <EmptyState
            icon="pi pi-replay"
            title="No recurring templates"
            body="A template generates an invoice each period into the normal approval queue."
          />
        </template>
        <Column header="Template">
          <template #body="{ data }">
            {{ data.description }}
            <div class="muted small">since {{ date(data.startsOn) }}<template v-if="data.endsOn"> · ends {{ date(data.endsOn) }}</template></div>
          </template>
        </Column>
        <Column header="Amount">
          <template #body="{ data }">{{ money(data.amount) }} {{ data.currency }}</template>
        </Column>
        <Column header="Schedule">
          <template #body="{ data }">
            {{ scheduleSummary(data) }}
            <div class="muted small">
              <template v-if="data.nextGenerationOn">next invoice {{ date(data.nextGenerationOn) }}</template>
              <template v-else>no upcoming invoice</template>
            </div>
          </template>
        </Column>
        <Column header="State">
          <template #body="{ data }">
            <StatusChip :status="data.active ? 'active' : 'void'" :label="data.active ? 'Active' : 'Paused'" />
            <div v-if="data.lastGeneratedPeriod" class="muted small">last generated {{ data.lastGeneratedPeriod }}</div>
          </template>
        </Column>
        <Column header="Actions" style="width: 15rem">
          <template #body="{ data }">
            <div class="row" style="gap: 0.25rem">
              <Button label="Edit" size="small" text @click="openTemplateDialog(data)" />
              <Button
                :label="data.active ? 'Pause' : 'Resume'"
                size="small"
                text
                severity="secondary"
                @click="toggleTemplate(data)"
              />
              <Button label="End…" size="small" text severity="secondary" @click="openEnd(data)" />
              <Button
                v-if="!data.lastGeneratedPeriod"
                label="Delete"
                size="small"
                text
                severity="danger"
                @click="removeTemplate(data)"
              />
            </div>
          </template>
        </Column>
      </DataTable>
    </div>

    <div class="card">
      <div class="row" style="justify-content: space-between; align-items: center">
        <h3 style="margin: 0">Invoices</h3>
        <Button label="Record invoice" icon="pi pi-plus" size="small" @click="invoiceDialog = true" />
      </div>
      <DataTable :value="data?.invoices ?? []" :loading="loading" striped-rows>
        <template #empty>
          <EmptyState icon="pi pi-receipt" title="No invoices" body="Record the contractor's first invoice to start the approve → pay flow." />
        </template>
        <Column header="Invoice">
          <template #body="{ data }">
            {{ data.description }}
            <div class="muted small">
              {{ data.invoiceRef ? `#${data.invoiceRef} · ` : "" }}{{ date(data.invoiceDate) }}<template v-if="data.recurringTemplateId"> · ↻ recurring</template>
            </div>
          </template>
        </Column>
        <Column header="Amount">
          <template #body="{ data }">{{ money(data.amount) }} {{ data.currency }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <StatusChip :status="data.status" />
            <div v-if="data.reviewNote" class="muted small">{{ data.reviewNote }}</div>
          </template>
        </Column>
        <Column header="Payment">
          <template #body="{ data }">
            <template v-if="data.payment">
              {{ date(data.payment.payDate) }} · {{ data.payment.method }}
              <div class="muted small">
                {{ money(data.payment.amount) }}
                <template v-if="Number(data.payment.backupWithheld) > 0">
                  · withheld {{ money(data.payment.backupWithheld) }}
                </template>
                {{ data.payment.reference ? `· ${data.payment.reference}` : "" }}
              </div>
            </template>
            <span v-else class="muted small">—</span>
          </template>
        </Column>
        <Column header="Actions" style="width: 16rem">
          <template #body="{ data }">
            <div class="row" style="gap: 0.25rem">
              <template v-if="data.status === 'submitted'">
                <Button label="Approve" size="small" text @click="approveInvoice(data)" />
                <Button label="Reject" size="small" text severity="danger" @click="noteDialog = { kind: 'reject', invoice: data }" />
              </template>
              <Button v-if="data.status === 'approved'" label="Record payment" size="small" text @click="openPay(data)" />
              <Button
                v-if="data.status !== 'void'"
                label="Void"
                size="small"
                text
                severity="secondary"
                @click="noteDialog = { kind: 'void', invoice: data }"
              />
            </div>
          </template>
        </Column>
      </DataTable>
    </div>

    <Dialog v-model:visible="invoiceDialog" modal header="Record invoice" :style="{ width: '30rem' }">
      <form class="stack" @submit.prevent="createInvoice">
        <div class="form-grid">
          <div class="field">
            <label for="i-ref">Contractor reference (optional)</label>
            <InputText id="i-ref" v-model="invoiceForm.invoiceRef" />
          </div>
          <div class="field">
            <label for="i-date">Invoice date</label>
            <DatePicker id="i-date" v-model="invoiceForm.invoiceDate" date-format="yy-mm-dd" required />
          </div>
        </div>
        <div class="field">
          <label for="i-desc">Description</label>
          <InputText id="i-desc" v-model="invoiceForm.description" required />
        </div>
        <div class="field">
          <label for="i-amount">Amount (USD)</label>
          <InputNumber id="i-amount" v-model="invoiceForm.amount" mode="currency" currency="USD" :min="0.01" required />
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="invoiceDialog = false" />
          <Button type="submit" label="Record" :loading="invoiceBusy" :disabled="!invoiceForm.description.trim() || !invoiceForm.amount" />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="payDialog" modal header="Record payment" :style="{ width: '30rem' }">
      <form class="stack" @submit.prevent="recordPayment">
        <p class="muted small" style="margin: 0">
          Payments require a valid tax form on file — the server blocks payment when the form is
          outstanding or expired.
        </p>
        <div class="form-grid">
          <div class="field">
            <label for="p-date">Pay date</label>
            <DatePicker id="p-date" v-model="payForm.payDate" date-format="yy-mm-dd" required />
          </div>
          <div class="field">
            <label for="p-amount">Amount paid (USD)</label>
            <InputNumber id="p-amount" v-model="payForm.amount" mode="currency" currency="USD" :min="0.01" required />
          </div>
        </div>
        <div class="field">
          <label for="p-method">Method</label>
          <Select id="p-method" v-model="payForm.method" :options="methodOptions" option-label="label" option-value="value" />
        </div>
        <div class="field">
          <label for="p-ref">Reference (check #, wire ref — optional)</label>
          <InputText id="p-ref" v-model="payForm.reference" />
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="payDialog = false" />
          <Button type="submit" label="Record payment" :loading="payBusy" :disabled="!payForm.amount" />
        </div>
      </form>
    </Dialog>

    <Dialog
      v-model:visible="templateDialog"
      modal
      :header="editingTemplate ? 'Edit recurring template' : 'New recurring template'"
      :style="{ width: '32rem' }"
    >
      <form class="stack" @submit.prevent="saveTemplate">
        <p class="muted small" style="margin: 0">
          Generates one invoice per period into the approval queue (status submitted). Use
          <code>{month}</code> / <code>{year}</code> in the description — they are interpolated
          at generation. Edits apply to future generations only.
        </p>
        <div class="field">
          <label for="t-desc">Description</label>
          <InputText id="t-desc" v-model="templateForm.description" required placeholder="Monthly retainer — {month} {year}" />
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="t-amount">Amount (USD)</label>
            <InputNumber id="t-amount" v-model="templateForm.amount" mode="currency" currency="USD" :min="0.01" required />
          </div>
          <div class="field">
            <label for="t-payday">Payment due day (next month, 1–28)</label>
            <InputNumber id="t-payday" v-model="templateForm.payDayOfMonth" :min="1" :max="28" required />
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="t-invday">Invoice date rule</label>
            <Select
              id="t-invday"
              v-model="templateForm.invoiceDay"
              :options="[
                { label: 'Last day of month', value: 'last_day' },
                { label: 'Fixed day of month', value: 'fixed' },
              ]"
              option-label="label"
              option-value="value"
            />
          </div>
          <div v-if="templateForm.invoiceDay === 'fixed'" class="field">
            <label for="t-invdaynum">Fixed day (1–28)</label>
            <InputNumber id="t-invdaynum" v-model="templateForm.invoiceDayOfMonth" :min="1" :max="28" required />
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="t-starts">Starts on</label>
            <DatePicker id="t-starts" v-model="templateForm.startsOn" date-format="yy-mm-dd" required />
          </div>
          <div class="field">
            <label for="t-ends">Ends on (optional)</label>
            <DatePicker id="t-ends" v-model="templateForm.endsOn" date-format="yy-mm-dd" show-button-bar />
          </div>
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="templateDialog = false" />
          <Button
            type="submit"
            :label="editingTemplate ? 'Save' : 'Create'"
            :loading="templateBusy"
            :disabled="
              !templateForm.description.trim() ||
              !templateForm.amount ||
              !templateForm.payDayOfMonth ||
              (templateForm.invoiceDay === 'fixed' && !templateForm.invoiceDayOfMonth)
            "
          />
        </div>
      </form>
    </Dialog>

    <Dialog
      :visible="!!endTarget"
      modal
      header="End recurring template"
      :style="{ width: '26rem' }"
      @update:visible="endTarget = null"
    >
      <form class="stack" @submit.prevent="saveEnd">
        <p class="muted small" style="margin: 0">
          The last period on or before the end date is generated; then the template retires
          itself. History is kept.
        </p>
        <div class="field">
          <label for="e-date">End date</label>
          <DatePicker id="e-date" v-model="endDate" date-format="yy-mm-dd" required />
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="endTarget = null" />
          <Button type="submit" label="Set end date" :loading="endBusy" :disabled="!endDate" />
        </div>
      </form>
    </Dialog>

    <Dialog
      :visible="!!noteDialog"
      modal
      :header="noteDialog?.kind === 'reject' ? 'Reject invoice' : 'Void invoice'"
      :style="{ width: '26rem' }"
      @update:visible="noteDialog = null"
    >
      <form class="stack" @submit.prevent="submitNote">
        <div class="field">
          <label for="n-note">Note (required)</label>
          <Textarea id="n-note" v-model="noteText" rows="3" required />
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="noteDialog = null" />
          <Button type="submit" :label="noteDialog?.kind === 'reject' ? 'Reject' : 'Void'" :loading="noteBusy" :disabled="!noteText.trim()" />
        </div>
      </form>
    </Dialog>
  </div>
</template>
