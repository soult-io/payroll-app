<script setup lang="ts">
/**
 * Page header: title + optional subtitle + right-aligned actions.
 */
defineProps<{ title: string; subtitle?: string | undefined }>();
</script>

<template>
  <header class="page-header">
    <div>
      <h2>{{ title }}</h2>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
    </div>
    <div class="actions"><slot /></div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.25rem;
}
h2 {
  margin: 0;
  font-size: 1.35rem;
}
.subtitle {
  margin: 0.25rem 0 0;
  color: var(--p-text-muted-color, #666);
  font-size: 0.9rem;
}
.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
</style>
