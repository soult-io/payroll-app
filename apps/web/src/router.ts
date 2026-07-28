import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";

/**
 * Step 1: one placeholder route proving PrimeVue renders.
 * Real screens land in step 5 per plan/specs/frontend.md.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: "/", name: "home", component: HomeView }],
});
