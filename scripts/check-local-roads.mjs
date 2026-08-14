import { existsSync } from "node:fs";
import { resolve } from "node:path";

const tilejson = resolve("public/game-roads/tilejson.json");
if (!existsSync(tilejson)) {
  console.error("Local game-road tiles are missing.");
  console.error("Build a preset first, for example:");
  console.error("  npm run roads:build -- adelaide");
  console.error("  npm run roads:build -- hong-kong");
  console.error("Or pass your own .osm.pbf path/URL to roads:build.");
  process.exit(2);
}
