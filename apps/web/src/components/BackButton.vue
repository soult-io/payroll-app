<script setup lang="ts">
/**
 * PAY-17: back affordance for detail pages. Pushes the list route carrying the
 * current query — list filters live in the query (useQueryFilters), so the
 * user returns to the exact filtered list they came from. Browser-back behaves
 * identically because the filtered list URL is already in the history stack.
 */
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";

const props = defineProps<{ to: string; label: string }>();
const route = useRoute();
const router = useRouter();

function go() {
  void router.push({ name: props.to, query: route.query });
}
</script>

<template>
  <Button :label="label" icon="pi pi-arrow-left" text size="small" @click="go" />
</template>
