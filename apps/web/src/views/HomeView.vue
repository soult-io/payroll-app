<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import Card from "primevue/card";

/**
 * Step-1 placeholder page: proves PrimeVue 4 + Material preset renders.
 * No real screens yet (step 5, plan/specs/frontend.md).
 */
const clicks = ref(0);
</script>

<template>
  <Card>
    <template #title>It renders</template>
    <template #content>
      <p>
        PrimeVue 4 (Material preset) is wired up. Real payroll screens arrive in
        step 5 per <code>plan/specs/frontend.md</code>.
      </p>
      <Button label="Clicked 0 times" @click="clicks++" :key="clicks">
        {{ clicks === 0 ? "Click me" : `Clicked ${clicks} times` }}
      </Button>
    </template>
  </Card>
</template>
