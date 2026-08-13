import { defineConfig } from "vite";

const MAIN_ENTRY = 'src="/src/main.ts"';
const MAPLIBRE_BOOTSTRAP_ENTRY = 'src="/src/maplibre-worker-bootstrap.ts"';
const LOCAL_GAME_ROAD_TILEJSON = "http://localhost:5173/game-roads/tilejson.json";

export default defineConfig(({ mode }) => ({
  define: mode === "roads"
    ? {
        "import.meta.env.VITE_GAME_ROADS_TILEJSON": JSON.stringify(LOCAL_GAME_ROAD_TILEJSON),
      }
    : undefined,
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
}));
