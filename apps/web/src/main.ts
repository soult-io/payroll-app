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
