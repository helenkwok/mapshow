import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const inputArgument = process.argv[2];

if (!inputArgument) {
  console.error("Usage: npm run roads:build -- path/to/region.osm.pbf");
  process.exit(2);
}

const input = resolve(inputArgument);
if (!existsSync(input)) {
  console.error(`OSM PBF input not found: ${input}`);
  process.exit(2);
}

const outputDir = resolve("public/game-roads");
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const result = spawnSync(
  cargo,
  [
    "run",
    "--release",
    "--manifest-path",
    "road-schema/Cargo.toml",
    "--",
    "build-xyz",
    "--input",
    input,
    "--output-dir",
    outputDir,
    "--tile-url-template",
    "http://localhost:5173/game-roads/{z}/{x}/{y}.pbf",
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Unable to start Rust road generator: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log("\nLocal game-road tiles are ready in public/game-roads/.");
console.log("Start Mapshow with: npm run dev:roads");
