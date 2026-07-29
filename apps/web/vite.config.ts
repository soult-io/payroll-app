import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // Dev-only: forward API calls to the Fastify server (spec 8 port 8927).
      "/api": "http://localhost:8927",
      "/health": "http://localhost:8927",
    },
  },
  build: {
    outDir: "dist",
  },
});
