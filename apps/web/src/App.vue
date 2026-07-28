<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import { useAuthStore } from "./stores/auth";
import { pinia } from "./stores/pinia";

const router = useRouter();
const auth = useAuthStore(pinia);
const signedIn = computed(() => Boolean(auth.user));

async function logout() {
  await auth.logout();
  await router.push({ name: "login" });
}
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <h1>Payroll</h1>
      <nav v-if="signedIn" class="nav">
        <RouterLink :to="{ name: 'dashboard' }">Dashboard</RouterLink>
        <RouterLink v-if="auth.isAdmin" :to="{ name: 'admin-users' }">Admin</RouterLink>
        <Button label="Sign out" size="small" text @click="logout" />
      </nav>
    </header>
    <RouterView />
  </main>
</template>

<style scoped>
.app-shell {
  max-width: 960px;
  margin: 0 auto;
  padding: 2rem 1rem;
  font-family: system-ui, sans-serif;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #e2e2e2;
  margin-bottom: 1.5rem;
}
.topbar h1 {
  font-size: 1.25rem;
}
.nav {
  display: flex;
  gap: 1rem;
  align-items: center;
}
</style>
