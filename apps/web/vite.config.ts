import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // Dev-only: forward API calls to the Fastify server (spec 8 port 8989).
      "/api": "http://localhost:8989",
      "/health": "http://localhost:8989",
    },
  },
  build: {
    outDir: "dist",
  },
});
