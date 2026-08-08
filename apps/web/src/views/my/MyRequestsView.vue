<script setup lang="ts">
/**
 * My change requests (frontend spec): status chips + filters, row → thread
 * view. "Request a change" CTA always visible.
 */
import { onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
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
const { date, dateTime } = useDates();
const notify = useNotify();

const loading = ref(true);
const requests = ref<ChangeRequest[]>([]);
const statusFilter = ref<RequestStatus | null>(null);
const statusOptions = [
  { label: "All statuses", value: null },
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
  { label: "Denied", value: "denied" },
  { label: "Withdrawn", value: "withdrawn" },
];

async function load() {
  loading.value = true;
  try {
    const { requests: rows } = await changeRequestsApi.list(
      statusFilter.value ? { status: statusFilter.value } : {},
    );
    requests.value = rows;
  } catch (err) {
    notify.error(err, "Could not load requests");
  } finally {
    loading.value = false;
  }
}

function open(event: { data: ChangeRequest }) {
  void router.push({ name: "my-request-detail", params: { publicId: event.data.publicId } });
}

watch(statusFilter, load);
onMounted(load);
</script>

<template>
  <div class="page stack">
    <PageHeader title="My change requests">
      <Select
        v-model="statusFilter"
        :options="statusOptions"
        option-label="label"
        option-value="value"
        size="small"
      />
      <RouterLink :to="{ name: 'my-request-new' }">
        <Button label="Request a change" icon="pi pi-plus" size="small" />
      </RouterLink>
    </PageHeader>

    <div class="card table-scroll">
      <DataTable :value="requests" :loading="loading" striped-rows row-hover @row-click="open">
        <template #empty>
          <EmptyState
            icon="pi pi-inbox"
            title="No requests"
            body="When you request a change to your address, W-4, bank details, or legal name it will show up here."
          >
            <RouterLink :to="{ name: 'my-request-new' }">
              <Button label="Request a change" size="small" />
            </RouterLink>
          </EmptyState>
        </template>
        <Column header="Type">
          <template #body="{ data }">{{ requestTypeLabel(data.requestType) }}</template>
        </Column>
        <Column header="Effective from">
          <template #body="{ data }">{{ date(data.effectiveFrom) }}</template>
        </Column>
        <Column header="Submitted">
          <template #body="{ data }">{{ dateTime(data.submittedAt) }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }"><StatusChip :status="data.status" /></template>
        </Column>
      </DataTable>
    </div>
  </div>
</template>
