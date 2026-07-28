import { createApp } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import Material from "@primeuix/themes/material";
import App from "./App.vue";
import { router } from "./router";

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(PrimeVue, {
  // Material design preset (D2). Current PrimeVue 4.x themes live in
  // @primeuix/themes (@primevue/themes is deprecated).
  theme: {
    preset: Material,
  },
});

app.mount("#app");
