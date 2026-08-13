import { defineConfig } from "vite";

export default defineConfig({
  // MapLibre creates its own worker module at runtime. Vite's dev dependency
  // optimizer can try to pre-bundle that worker and then reference a generated
  // maplibre-gl-worker.mjs file that does not exist in node_modules/.vite/deps.
  // Keep MapLibre out of optimizeDeps so Vite serves the package/worker graph
  // directly instead of caching a broken worker entry.
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
});
