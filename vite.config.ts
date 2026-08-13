import { defineConfig } from "vite";

const MAIN_ENTRY = 'src="/src/main.ts"';
const MAPLIBRE_BOOTSTRAP_ENTRY = 'src="/src/maplibre-worker-bootstrap.ts"';

export default defineConfig({
  plugins: [
    {
      name: "mapshow-maplibre-worker-bootstrap",
      enforce: "pre",
      transformIndexHtml(html) {
        if (html.includes(MAPLIBRE_BOOTSTRAP_ENTRY)) return html;
        return html.replace(MAIN_ENTRY, MAPLIBRE_BOOTSTRAP_ENTRY);
      },
    },
  ],
});
