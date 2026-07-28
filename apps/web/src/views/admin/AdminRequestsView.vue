<script setup lang="ts">
/**
 * Admin requests inbox (frontend spec): every change request, default
 * filter = pending; row → review page (current-vs-proposed diff).
 */
import { onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Select from "primevue/select";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import { changeRequestsApi, type ChangeRequest, type RequestStatus } from "../../lib/api";
import { requestTypeLabel } from "../../composables/useRequestTypes";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const router = useRouter();
const { date } = useDates();
const notify = useNotify();

const loading = ref(true);
const requests = ref<ChangeRequest[]>([]);

const statusFilter = ref<RequestStatus | null>("pending");
const statusOptions = [
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
  { label: "Denied", value: "denied" },
  { label: "Withdrawn", value: "withdrawn" },
  { label: "All", value: null },
];

async function load() {
  loading.value = true;
  try {
    const filter: { status?: RequestStatus } = {};
    if (statusFilter.value) filter.status = statusFilter.value;
    const { requests: rows } = await changeRequestsApi.list(filter);
    requests.value = rows;
  } catch (err) {
    notify.error(err, "Could not load requests");
  } finally {
    loading.value = false;
  }
}

function open(event: { data: ChangeRequest }) {
  void router.push({ name: "admin-request-detail", params: { publicId: event.data.publicId } });
}

watch(statusFilter, load);
onMounted(load);
</script>

<template>
  <div class="page stack">
    <PageHeader title="Change requests" subtitle="Review employee-submitted profile changes.">
      <Select v-model="statusFilter" :options="statusOptions" option-label="label" option-value="value" size="small" />
    </PageHeader>

    <div class="card table-scroll">
      <DataTable :value="requests" :loading="loading" data-key="publicId" striped-rows row-hover @row-click="open">
        <template #empty>
          <EmptyState
            icon="pi pi-inbox"
            title="Nothing here"
            body="No requests match this filter. Pending requests appear here as employees submit them."
          />
        </template>
        <Column header="Employee">
          <template #body="{ data }">{{ data.employeeName ?? `#${data.employeeId}` }}</template>
        </Column>
        <Column header="Type">
          <template #body="{ data }">{{ requestTypeLabel(data.requestType) }}</template>
        </Column>
        <Column header="Effective from">
          <template #body="{ data }">{{ date(data.effectiveFrom) }}</template>
        </Column>
        <Column header="Submitted">
          <template #body="{ data }">{{ date(data.submittedAt) }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }"><StatusChip :status="data.status" /></template>
        </Column>
      </DataTable>
    </div>
  </div>
</template>
