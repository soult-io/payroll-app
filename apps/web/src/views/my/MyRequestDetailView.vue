<script setup lang="ts">
/**
 * My request detail (frontend spec): payload + status + thread (Timeline),
 * withdraw action for pending requests (ConfirmDialog + Toast).
 */
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import { useConfirm } from "primevue/useconfirm";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import StatusChip from "../../components/StatusChip.vue";
import RequestThread from "../../components/RequestThread.vue";
import RequestPayloadView from "../../components/RequestPayloadView.vue";
import { changeRequestsApi, type ChangeRequest, type ChangeRequestComment } from "../../lib/api";
import { requestTypeLabel } from "../../composables/useRequestTypes";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const router = useRouter();
const confirm = useConfirm();
const { date } = useDates();
const notify = useNotify();

const publicId = route.params.publicId as string;
const loading = ref(true);
const notFound = ref(false);
const busy = ref(false);
const request = ref<ChangeRequest | null>(null);
const comments = ref<ChangeRequestComment[]>([]);

async function load() {
  try {
    const detail = await changeRequestsApi.detail(publicId);
    request.value = detail.request;
    comments.value = detail.comments;
  } catch (err) {
    notFound.value = true;
    notify.error(err, "Could not load request");
  } finally {
    loading.value = false;
  }
}

async function sendComment(body: string) {
  busy.value = true;
  try {
    await changeRequestsApi.comment(publicId, body);
    await load();
    notify.success("Comment added");
  } catch (err) {
    notify.error(err, "Could not add comment");
  } finally {
    busy.value = false;
  }
}

function withdraw() {
  confirm.require({
    message: "Withdraw this request? It will no longer be reviewed.",
    header: "Withdraw request",
    icon: "pi pi-exclamation-triangle",
    rejectProps: { label: "Keep request", severity: "secondary", text: true },
    acceptProps: { label: "Withdraw", severity: "danger" },
    accept: async () => {
      busy.value = true;
      try {
        await changeRequestsApi.withdraw(publicId);
        notify.success("Request withdrawn");
        await load();
      } catch (err) {
        notify.error(err, "Could not withdraw");
      } finally {
        busy.value = false;
      }
    },
  });
}

onMounted(load);
</script>

<template>
  <div class="page stack">
    <PageHeader :title="request ? requestTypeLabel(request.requestType) : 'Request'">
      <Button label="Back to requests" text icon="pi pi-arrow-left" @click="router.push({ name: 'my-requests' })" />
      <Button
        v-if="request?.status === 'pending'"
        label="Withdraw"
        severity="danger"
        outlined
        icon="pi pi-undo"
        :loading="busy"
        @click="withdraw"
      />
    </PageHeader>

    <Skeleton v-if="loading" height="18rem" />

    <EmptyState
      v-else-if="notFound || !request"
      icon="pi pi-exclamation-circle"
      title="Request not found"
      body="It may have been removed, or the link is wrong."
    />

    <template v-else>
      <section class="card">
        <div class="head-row">
          <h3>Request</h3>
          <StatusChip :status="request.status" />
        </div>
        <dl class="kv">
          <dt>Effective from</dt>
          <dd>{{ date(request.effectiveFrom) }}</dd>
          <dt>Submitted</dt>
          <dd>{{ date(request.submittedAt) }}</dd>
          <dt v-if="request.decidedAt">Decided</dt>
          <dd v-if="request.decidedAt">{{ date(request.decidedAt) }}</dd>
          <dt v-if="request.appliedAt">Applied</dt>
          <dd v-if="request.appliedAt">{{ date(request.appliedAt) }}</dd>
        </dl>
      </section>

      <section class="card">
        <h3>Proposed values</h3>
        <RequestPayloadView :request-type="request.requestType" :payload="request.payload" />
      </section>

      <section class="card">
        <h3>Thread</h3>
        <RequestThread :comments="comments" :can-comment="true" :busy="busy" @submit="sendComment" />
      </section>
    </template>
  </div>
</template>

<style scoped>
.head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
.head-row h3 {
  margin: 0;
}
</style>
