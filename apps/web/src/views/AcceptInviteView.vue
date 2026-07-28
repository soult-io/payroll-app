<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import Message from "primevue/message";
import OnboardingWizard from "../components/OnboardingWizard.vue";

const route = useRoute();
const token = computed(() => (typeof route.query.token === "string" ? route.query.token : ""));
</script>

<template>
  <OnboardingWizard v-if="token" :token="token" mode="invite" />
  <Message v-else severity="error" :closable="false">
    This invite link is missing its token. Use the full link from your invitation email.
  </Message>
</template>
