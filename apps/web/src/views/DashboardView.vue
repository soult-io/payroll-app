<script setup lang="ts">
/**
 * Authenticated stub (step 2): proves the session + guard pipeline end-to-end.
 * Real employee dashboard lands in step 5.
 */
import { useAuthStore } from "../stores/auth";
import { pinia } from "../stores/pinia";

const auth = useAuthStore(pinia);
</script>

<template>
  <section>
    <h2>Dashboard</h2>
    <p>
      Signed in as <strong>{{ auth.user?.name }}</strong> ({{ auth.user?.email }}) — role:
      <code>{{ auth.user?.role ?? "employee" }}</code>
    </p>
    <p>Employee self-service screens arrive in step 5.</p>
  </section>
</template>
