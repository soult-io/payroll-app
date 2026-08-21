import { createApp } from "vue";
import PrimeVue from "primevue/config";
import Material from "@primeuix/themes/material";
import ToastService from "primevue/toastservice";
import ConfirmationService from "primevue/confirmationservice";
import "primeicons/primeicons.css";
import "./style.css";
import App from "./App.vue";
import { router } from "./router";
import { pinia } from "./stores/pinia";
import { useAuthStore } from "./stores/auth";
import { setSessionExpiredHandler } from "./lib/session-expired";

// PAY-6: any unexpected 401 (expired/revoked session) redirects straight to
// the login page, preserving the current path for post-login return. No-op
// when nobody is signed in (login/onboarding flows keep their local errors).
setSessionExpiredHandler(() => {
  const auth = useAuthStore(pinia);
  if (!auth.user) return;
  auth.user = null;
  const current = router.currentRoute.value;
  if (current.name === "login") return;
  void router.push({ name: "login", query: { redirect: current.fullPath } });
});

const app = createApp(App);

app.use(pinia);
app.use(router);
app.use(PrimeVue, {
  // Material design preset (D2). Current PrimeVue 4.x themes live in
  // @primeuix/themes (@primevue/themes is deprecated).
  theme: {
    preset: Material,
  },
});
app.use(ToastService);
app.use(ConfirmationService);

app.mount("#app");
