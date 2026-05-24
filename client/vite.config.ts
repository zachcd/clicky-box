import { defineConfig } from "vite";

export default defineConfig({
  // VITE_BASE is injected by the GitHub Actions workflow as /repo-name/
  // Falls back to / for local dev and for custom-domain Pages deployments
  base: process.env.VITE_BASE ?? "/",
  server: {
    port: 5173,
  },
});
