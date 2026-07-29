<script setup lang="ts">
/**
 * Admin employees (frontend spec): list → detail page. "New employee" dialog
 * creates the record (invite happens on the detail page).
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import InputMask from "primevue/inputmask";
import Select from "primevue/select";
import DatePicker from "primevue/datepicker";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import { adminEmployeesApi, type AdminEmployeeListRow } from "../../lib/api";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const router = useRouter();
const { date, toIso } = useDates();
const notify = useNotify();

const loading = ref(true);
const rows = ref<AdminEmployeeListRow[]>([]);

const createDialog = ref(false);
const createBusy = ref(false);
const form = ref({
  legalName: "",
  preferredName: "",
  employmentType: "w2",
  hireDate: new Date(),
  taxId: "",
});

async function load() {
  loading.value = true;
  try {
    const { employees } = await adminEmployeesApi.list();
    rows.value = employees;
  } catch (err) {
    notify.error(err, "Could not load employees");
  } finally {
    loading.value = false;
  }
}

function open(event: { data: AdminEmployeeListRow }) {
  void router.push({ name: "admin-employee-detail", params: { employeeId: event.data.id } });
}

function accountStatus(row: AdminEmployeeListRow): string {
  if (!row.userId) return "not invited";
  if (row.userBanned) return "disabled";
  return "active";
}

async function create() {
  createBusy.value = true;
  try {
    const hireDate = toIso(form.value.hireDate);
    if (!hireDate) return;
    const taxId = form.value.taxId.replaceAll("-", "").replaceAll("_", "");
    const { employee } = await adminEmployeesApi.create({
      legalName: form.value.legalName.trim(),
      ...(form.value.preferredName.trim()
        ? { preferredName: form.value.preferredName.trim() }
        : {}),
      employmentType: form.value.employmentType,
      hireDate,
      ...(taxId.length === 9 ? { taxId } : {}),
    });
    notify.success("Employee created", "Invite them from the detail page.");
    createDialog.value = false;
    void router.push({ name: "admin-employee-detail", params: { employeeId: employee.id } });
  } catch (err) {
    notify.error(err, "Could not create employee");
  } finally {
    createBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page stack">
    <PageHeader title="Employees">
      <Button label="New employee" icon="pi pi-plus" size="small" @click="createDialog = true" />
    </PageHeader>

    <div class="card table-scroll">
      <DataTable :value="rows" :loading="loading" striped-rows row-hover @row-click="open">
        <template #empty>
          <EmptyState
            icon="pi pi-users"
            title="No employees yet"
            body="Create the first employee record, then invite them to set up their account."
          >
            <Button label="New employee" size="small" @click="createDialog = true" />
          </EmptyState>
        </template>
        <Column field="legalName" header="Name" />
        <Column field="employmentType" header="Type" />
        <Column header="Hire date">
          <template #body="{ data }">{{ date(data.hireDate) }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }"><StatusChip :status="data.status" /></template>
        </Column>
        <Column header="Account">
          <template #body="{ data }">
            <span class="small">{{ data.userEmail ?? "—" }}</span>
            <span class="muted small"> · {{ accountStatus(data) }}</span>
          </template>
        </Column>
      </DataTable>
    </div>

    <Dialog v-model:visible="createDialog" modal header="New employee" :style="{ width: '30rem' }">
      <form class="stack" @submit.prevent="create">
        <div class="field">
          <label for="legalName">Legal name</label>
          <InputText id="legalName" v-model="form.legalName" required />
        </div>
        <div class="field">
          <label for="preferredName">Preferred name (optional)</label>
          <InputText id="preferredName" v-model="form.preferredName" />
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="employmentType">Employment type</label>
            <Select id="employmentType" v-model="form.employmentType" :options="['w2', '1099']" />
          </div>
          <div class="field">
            <label for="hireDate">Hire date</label>
            <DatePicker id="hireDate" v-model="form.hireDate" date-format="yy-mm-dd" required />
          </div>
        </div>
        <div class="field">
          <label for="taxId">SSN (optional — encrypted at rest)</label>
          <InputMask id="taxId" v-model="form.taxId" mask="999-99-9999" placeholder="123-45-6789" />
        </div>
        <div class="row" style="justify-content: flex-end">
          <Button label="Cancel" text severity="secondary" type="button" @click="createDialog = false" />
          <Button type="submit" label="Create" :loading="createBusy" :disabled="!form.legalName.trim()" />
        </div>
      </form>
    </Dialog>
  </div>
</template>
