<script setup lang="ts">
/**
 * Status chips (UX conventions): consistent colors matching the state
 * machines — runs (draft/awaiting/approved/issued/void) and requests
 * (pending/approved/denied/withdrawn), plus generic user/employee states.
 */
import { computed } from "vue";
import Tag from "primevue/tag";

const props = defineProps<{ status: string; label?: string }>();

const LABELS: Record<string, string> = {
  draft: "Draft",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  paid: "Paid",
  issued: "Issued",
  void: "Void",
  pending: "Pending",
  denied: "Denied",
  withdrawn: "Withdrawn",
  active: "Active",
  terminated: "Terminated",
  sent: "Sent",
  failed: "Failed",
  suppressed: "Suppressed",
};

const SEVERITIES: Record<
  string,
  "success" | "info" | "warn" | "danger" | "secondary" | "contrast"
> = {
  draft: "secondary",
  awaiting_approval: "warn",
  approved: "info",
  paid: "success",
  issued: "success",
  void: "danger",
  pending: "warn",
  denied: "danger",
  withdrawn: "secondary",
  active: "success",
  terminated: "danger",
  sent: "success",
  failed: "danger",
  suppressed: "secondary",
};

const chipLabel = computed(
  () => props.label ?? LABELS[props.status] ?? props.status.replaceAll("_", " "),
);
const severity = computed(() => SEVERITIES[props.status] ?? "info");
</script>

<template>
  <Tag :value="chipLabel" :severity="severity" />
</template>
