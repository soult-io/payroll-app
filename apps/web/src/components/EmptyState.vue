<script setup lang="ts">
/**
 * Empty state (UX conventions: a fresh install must not look broken).
 */
defineProps<{ icon?: string; title: string; body?: string }>();
</script>

<template>
  <div class="empty-state">
    <i :class="['pi', icon ?? 'pi-inbox']" aria-hidden="true" />
    <h3>{{ title }}</h3>
    <p v-if="body">{{ body }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 2.5rem 1rem;
  text-align: center;
  color: var(--p-text-muted-color, #666);
}
.empty-state .pi {
  font-size: 2rem;
  opacity: 0.5;
}
.empty-state h3 {
  margin: 0;
  font-size: 1.05rem;
  color: var(--p-text-color, #222);
}
.empty-state p {
  margin: 0;
  max-width: 42ch;
}
</style>
