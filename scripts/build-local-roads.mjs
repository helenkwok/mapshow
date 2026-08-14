import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MEBIBYTE = 1024 * 1024;
const CACHE_DIR = resolve(".cache/mapshow/osm");

const PRESETS = {
  adelaide: {
    label: "Adelaide",
    provider: "BBBike",
    url: "https://download.bbbike.org/osm/bbbike/Adelaide/Adelaide.osm.pbf",
    cacheFile: "adelaide.osm.pbf",
    approximateSize: "18 MB",
  },
  "hong-kong": {
    label: "Hong Kong",
    provider: "Geofabrik",
    url: "https://download.geofabrik.de/asia/china/hong-kong-latest.osm.pbf",
    cacheFile: "hong-kong.osm.pbf",
    approximateSize: "36 MB",
  },
  manhattan: {
    label: "Manhattan / New York",
    provider: "BBBike",
    url: "https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf",
    cacheFile: "new-york.osm.pbf",
    approximateSize: "145 MB",
  },
  tokyo: {
    label: "Tokyo",
    provider: "BBBike",
    url: "https://download.bbbike.org/osm/bbbike/Tokyo/Tokyo.osm.pbf",
    cacheFile: "tokyo.osm.pbf",
    approximateSize: "75 MB",
  },
};

const ALIASES = new Map([
  ["adelaide", "adelaide"],
  ["sa", "adelaide"],
  ["hong-kong", "hong-kong"],
  ["hongkong", "hong-kong"],
  ["hk", "hong-kong"],
  ["manhattan", "manhattan"],
  ["new-york", "manhattan"],
  ["newyork", "manhattan"],
  ["nyc", "manhattan"],
  ["tokyo", "tokyo"],
]);

function printPresets() {
  console.log("Built-in road-data presets:");
  for (const [key, preset] of Object.entries(PRESETS)) {
    console.log(`  ${key.padEnd(10)} ${preset.label} · ${preset.provider} · ~${preset.approximateSize}`);
  }
}

function printUsage() {
  console.log("Usage:");
  console.log("  npm run roads:build -- adelaide");
  console.log("  npm run roads:build -- hong-kong");
  console.log("  npm run roads:build -- manhattan");
  console.log("  npm run roads:build -- tokyo");
  console.log("  npm run roads:build -- path/to/region.osm.pbf");
  console.log("  npm run roads:build -- https://example.com/region.osm.pbf");
  console.log("");
  printPresets();
}

function formatMegabytes(bytes) {
  return `${(bytes / MEBIBYTE).toFixed(1)} MB`;
}

function cachedFileIsUsable(path) {
  return existsSync(path) && statSync(path).size > 0;
}

async function downloadPbf(url, target, label) {
  if (cachedFileIsUsable(target)) {
    console.log(`Using cached ${label}: ${target} (${formatMegabytes(statSync(target).size)})`);
    return target;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const temporary = `${target}.part`;
  rmSync(temporary, { force: true });

  console.log(`Downloading ${label}...`);
  console.log(`  ${url}`);

  const response = await fetch(url, {
    headers: {
      "user-agent": "mapshow-road-builder/0.1 (+https://github.com/helenkwok/mapshow)",
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status} ${response.statusText}`);
  }

  const expectedBytes = Number(response.headers.get("content-length")) || 0;
  if (expectedBytes > 0) console.log(`  expected ${formatMegabytes(expectedBytes)}`);

  let receivedBytes = 0;
  let nextProgressBytes = 10 * MEBIBYTE;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes >= nextProgressBytes) {
        console.log(`  downloaded ${formatMegabytes(receivedBytes)}`);
        nextProgressBytes += 10 * MEBIBYTE;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(temporary));
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }

  console.log(`Cached ${label}: ${target} (${formatMegabytes(statSync(target).size)})`);
  return target;
}

function normalizePreset(value) {
  return ALIASES.get(value.trim().toLowerCase()) ?? null;
}

async function resolveInput(argument) {
  const presetKey = normalizePreset(argument);
  if (presetKey) {
    const preset = PRESETS[presetKey];
    const target = resolve(CACHE_DIR, preset.cacheFile);
    return downloadPbf(preset.url, target, `${preset.label} OSM PBF from ${preset.provider}`);
  }

  if (/^https?:\/\//i.test(argument)) {
    const url = new URL(argument);
    const fileName = basename(url.pathname) || "custom.osm.pbf";
    if (!fileName.endsWith(".pbf")) {
      throw new Error(`Remote input must point to a .pbf file: ${argument}`);
    }
    return downloadPbf(url.toString(), resolve(CACHE_DIR, fileName), "remote OSM PBF");
  }

  const input = resolve(argument);
  if (existsSync(input)) return input;

  const legacyPlaceholder = argument.replaceAll("\\", "/") === "data/region.osm.pbf";
  if (legacyPlaceholder) {
    console.error("data/region.osm.pbf was an example placeholder; Mapshow does not ship that file.");
  }
  console.error(`OSM PBF input not found: ${input}`);
  console.error("");
  console.error("Use a built-in preset to download a matching city extract automatically, for example:");
  console.error("  npm run roads:build -- adelaide");
  console.error("  npm run roads:build -- hong-kong");
  console.error("Or pass the path/URL of a real .osm.pbf file.");
  process.exit(2);
}

const inputArgument = process.argv[2]?.trim();
if (!inputArgument || inputArgument === "--help" || inputArgument === "-h") {
  printUsage();
  process.exit(inputArgument ? 0 : 2);
}
if (inputArgument === "--list") {
  printPresets();
  process.exit(0);
}

let input;
try {
  input = await resolveInput(inputArgument);
} catch (error) {
  console.error(`Unable to prepare OSM PBF input: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const cargoCheck = spawnSync(cargo, ["--version"], { encoding: "utf8" });
if (cargoCheck.error || cargoCheck.status !== 0) {
  console.error("Rust/Cargo is required to build game-road tiles but was not found.");
  console.error("Install the Rust stable toolchain, then run this command again.");
  process.exit(1);
}

const outputDir = resolve("public/game-roads");
const buildDir = resolve("public/.game-roads-build");
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

console.log(`\nBuilding Mapshow game-road tiles from:\n  ${input}`);
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
    buildDir,
    "--tile-url-template",
    "http://localhost:5173/game-roads/{z}/{x}/{y}.pbf",
  ],
  { stdio: "inherit" },
);

if (result.error) {
  rmSync(buildDir, { recursive: true, force: true });
  console.error(`Unable to start Rust road generator: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  rmSync(buildDir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

rmSync(outputDir, { recursive: true, force: true });
renameSync(buildDir, outputDir);

console.log("\nLocal game-road tiles are ready in public/game-roads/.");
console.log("Start Mapshow with: npm run dev:roads");
