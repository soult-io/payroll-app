import { createRouter, createWebHistory } from "vue-router";
import { pinia } from "./stores/pinia";
import { useAuthStore } from "./stores/auth";
import LoginView from "./views/LoginView.vue";
import AcceptInviteView from "./views/AcceptInviteView.vue";
import ResetPasswordView from "./views/ResetPasswordView.vue";
import DashboardView from "./views/DashboardView.vue";
import AdminView from "./views/AdminView.vue";

/**
 * Step 2 routes: public auth screens + role-guarded stubs proving the guard
 * classes. Business screens land in step 5 per plan/specs/frontend.md.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    {
      path: "/accept-invite",
      name: "accept-invite",
      component: AcceptInviteView,
      meta: { public: true },
    },
    {
      path: "/reset-password",
      name: "reset-password",
      component: ResetPasswordView,
      meta: { public: true },
    },
    { path: "/", redirect: { name: "dashboard" } },
    {
      path: "/my/dashboard",
      name: "dashboard",
      component: DashboardView,
      meta: { requiresAuth: true },
    },
    {
      path: "/admin/users",
      name: "admin-users",
      component: AdminView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore(pinia);
  await auth.ensureLoaded();

  if (to.meta.public) {
    // Signed-in users have no business on the login screen.
    if (to.name === "login" && auth.user) return { name: "dashboard" };
    return true;
  }
  if (to.meta.requiresAuth && !auth.user) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (to.meta.requiresAdmin && !auth.isAdmin) {
    return { name: "dashboard" };
  }
  return true;
});
