import { createRouter, createWebHistory } from "vue-router";
import { pinia } from "./stores/pinia";
import { useAuthStore } from "./stores/auth";
import LoginView from "./views/LoginView.vue";

/**
 * Route inventory per plan/specs/frontend.md. Auth screens load eagerly
 * (they ARE the entry); every business screen is a lazy chunk (bundle-size
 * discipline: route-level code-splitting).
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // ------------------------------------------------------------- public
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    {
      path: "/accept-invite",
      name: "accept-invite",
      component: () => import("./views/AcceptInviteView.vue"),
      meta: { public: true },
    },
    {
      path: "/reset-password",
      name: "reset-password",
      component: () => import("./views/ResetPasswordView.vue"),
      meta: { public: true },
    },

    // ------------------------------------------------------- employee /my
    { path: "/", redirect: { name: "my-dashboard" } },
    {
      path: "/my/dashboard",
      name: "my-dashboard",
      component: () => import("./views/my/MyDashboardView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/payslips",
      name: "my-payslips",
      component: () => import("./views/my/MyPayslipsView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/payslips/:publicId",
      name: "my-payslip-detail",
      component: () => import("./views/my/MyPayslipDetailView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/invoices",
      name: "my-invoices",
      component: () => import("./views/my/MyInvoicesView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/profile",
      name: "my-profile",
      component: () => import("./views/my/MyProfileView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/requests",
      name: "my-requests",
      component: () => import("./views/my/MyRequestsView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/requests/new",
      name: "my-request-new",
      component: () => import("./views/my/MyRequestNewView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/requests/:publicId",
      name: "my-request-detail",
      component: () => import("./views/my/MyRequestDetailView.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/my/settings",
      name: "my-settings",
      component: () => import("./views/my/MySettingsView.vue"),
      meta: { requiresAuth: true },
    },

    // --------------------------------------------------------- admin /admin
    {
      path: "/admin/dashboard",
      name: "admin-dashboard",
      component: () => import("./views/admin/AdminDashboardView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/payroll",
      name: "admin-payroll",
      component: () => import("./views/admin/AdminPayrollView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/payroll/:publicId",
      name: "admin-payroll-run",
      component: () => import("./views/admin/AdminPayrollRunView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/employees",
      name: "admin-employees",
      component: () => import("./views/admin/AdminEmployeesView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/employees/:employeeId",
      name: "admin-employee-detail",
      component: () => import("./views/admin/AdminEmployeeDetailView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/contractors",
      name: "admin-contractors",
      component: () => import("./views/admin/AdminContractorsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/contractors/:employeeId",
      name: "admin-contractor-detail",
      component: () => import("./views/admin/AdminContractorDetailView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/requests",
      name: "admin-requests",
      component: () => import("./views/admin/AdminRequestsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/requests/:publicId",
      name: "admin-request-detail",
      component: () => import("./views/admin/AdminRequestDetailView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/config",
      name: "admin-config",
      component: () => import("./views/admin/AdminConfigView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/settings",
      name: "admin-settings",
      component: () => import("./views/admin/AdminSettingsView.vue"),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    // Step-2 stub route — user management now lives in /admin/settings.
    { path: "/admin/users", redirect: { name: "admin-settings" } },

    { path: "/:pathMatch(.*)*", redirect: { name: "my-dashboard" } },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore(pinia);
  await auth.ensureLoaded();

  if (to.meta.public) {
    // Signed-in users have no business on the login screen.
    if (to.name === "login" && auth.user) return { name: "my-dashboard" };
    return true;
  }
  if (to.meta.requiresAuth && !auth.user) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (to.meta.requiresAdmin && !auth.isAdmin) {
    return { name: "my-dashboard" };
  }
  return true;
});
