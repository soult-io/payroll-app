<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import Message from "primevue/message";
import OnboardingWizard from "../components/OnboardingWizard.vue";

const route = useRoute();
const token = computed(() => (typeof route.query.token === "string" ? route.query.token : ""));
</script>

<template>
  <OnboardingWizard v-if="token" :token="token" mode="reset" />
  <Message v-else severity="error" :closable="false">
    This reset link is missing its token. Use the full link from the reset email.
  </Message>
</template>
