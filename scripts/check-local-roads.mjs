import { existsSync } from "node:fs";
import { resolve } from "node:path";

const tilejson = resolve("public/game-roads/tilejson.json");
if (!existsSync(tilejson)) {
  console.error("Local game-road tiles are missing.");
  console.error("Build them first with: npm run roads:build -- path/to/region.osm.pbf");
  process.exit(2);
}
