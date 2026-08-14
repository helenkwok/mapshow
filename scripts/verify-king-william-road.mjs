import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const APP_URL = process.env.MAPSHOW_E2E_URL ?? "http://127.0.0.1:5173";
const OUTPUT_DIR = process.env.MAPSHOW_E2E_OUTPUT ?? "/tmp/mapshow-visual";
const TARGET = { lat: -34.91630, lng: 138.59867 };
const VIEWPORT = { width: 1440, height: 900 };
const MAP_CLIP = { x: 430, y: 40, width: 980, height: 820 };
const CALIBRATION_PX = 48;
const TARGET_TOLERANCE_DEGREES = 0.00018;

const chromeCandidates = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error("No Chrome/Chromium executable found for King William Road regression");

mkdirSync(OUTPUT_DIR, { recursive: true });

function readPng(buffer) {
  return PNG.sync.read(buffer);
}

function orangeRoadMask(buffer) {
  const png = readPng(buffer);
  const pixels = png.width * png.height;
  const mask = new Uint8Array(pixels);
  for (let pixel = 0, offset = 0; pixel < pixels; pixel += 1, offset += 4) {
    const red = png.data[offset];
    const green = png.data[offset + 1];
    const blue = png.data[offset + 2];
    if (red >= 185 && green >= 70 && green <= 190 && blue <= 150 && red - green >= 40) mask[pixel] = 1;
  }
  return { width: png.width, height: png.height, mask };
}

function driveableRoadMask(buffer) {
  const png = readPng(buffer);
  const pixels = png.width * png.height;
  const mask = new Uint8Array(pixels);
  for (let pixel = 0, offset = 0; pixel < pixels; pixel += 1, offset += 4) {
    const red = png.data[offset];
    const green = png.data[offset + 1];
    const blue = png.data[offset + 2];
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    // Paved/unknown Mapshow surfaces are neutral dark greys. This deliberately also admits the
    // brown-grey unpaved material while rejecting the cream/green basemap and orange raw overlay.
    if (red >= 35 && red <= 135 && green >= 35 && green <= 125 && blue >= 35 && blue <= 125 && spread <= 45) {
      mask[pixel] = 1;
    }
  }
  return { width: png.width, height: png.height, mask };
}

function dilateSquare(mask, width, height, radius) {
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);
  const prefix = new Uint32Array(Math.max(width, height) + 1);
  for (let y = 0; y < height; y += 1) {
    prefix.fill(0, 0, width + 1);
    for (let x = 0; x < width; x += 1) prefix[x + 1] = prefix[x] + mask[y * width + x];
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      horizontal[y * width + x] = prefix[right + 1] - prefix[left] > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < width; x += 1) {
    prefix.fill(0, 0, height + 1);
    for (let y = 0; y < height; y += 1) prefix[y + 1] = prefix[y] + horizontal[y * width + x];
    for (let y = 0; y < height; y += 1) {
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height - 1, y + radius);
      output[y * width + x] = prefix[bottom + 1] - prefix[top] > 0 ? 1 : 0;
    }
  }
  return output;
}

function unsupportedReferenceRatio(referenceMask, supportMask) {
  let reference = 0;
  let unsupported = 0;
  for (let index = 0; index < referenceMask.length; index += 1) {
    if (!referenceMask[index]) continue;
    reference += 1;
    if (!supportMask[index]) unsupported += 1;
  }
  return reference === 0 ? 1 : unsupported / reference;
}

async function capture(page, name) {
  const screenshot = await page.screenshot({ type: "png", clip: MAP_CLIP });
  writeFileSync(`${OUTPUT_DIR}/${name}.png`, screenshot);
  return screenshot;
}

async function statusCenter(page) {
  const text = (await page.locator("#status").textContent()) ?? "";
  const match = text.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (!match) throw new Error(`Unable to parse map center from status: ${text}`);
  return { lat: Number(match[1]), lng: Number(match[2]), text };
}

async function dragMap(page, deltaX, deltaY) {
  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("MapLibre canvas has no bounding box");
  const startX = box.x + box.width * 0.70;
  const startY = box.y + box.height * 0.40;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(900);
}

async function calibratePan(page) {
  const start = await statusCenter(page);
  await dragMap(page, CALIBRATION_PX, 0);
  const afterX = await statusCenter(page);
  await dragMap(page, -CALIBRATION_PX, 0);
  const restoredX = await statusCenter(page);
  await dragMap(page, 0, CALIBRATION_PX);
  const afterY = await statusCenter(page);
  await dragMap(page, 0, -CALIBRATION_PX);
  const restored = await statusCenter(page);

  return {
    center: restored,
    x: {
      lat: (afterX.lat - start.lat) / CALIBRATION_PX,
      lng: (afterX.lng - start.lng) / CALIBRATION_PX,
    },
    y: {
      lat: (afterY.lat - restoredX.lat) / CALIBRATION_PX,
      lng: (afterY.lng - restoredX.lng) / CALIBRATION_PX,
    },
  };
}

function solveDrag(calibration, target) {
  const latError = target.lat - calibration.center.lat;
  const lngError = target.lng - calibration.center.lng;
  const determinant = calibration.x.lat * calibration.y.lng - calibration.y.lat * calibration.x.lng;
  if (Math.abs(determinant) < 1e-12) throw new Error("Map pan calibration matrix is singular");
  const dx = (latError * calibration.y.lng - calibration.y.lat * lngError) / determinant;
  const dy = (calibration.x.lat * lngError - latError * calibration.x.lng) / determinant;
  return {
    dx: Math.max(-520, Math.min(520, dx)),
    dy: Math.max(-520, Math.min(520, dy)),
  };
}

async function panToTarget(page) {
  let last;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const calibration = await calibratePan(page);
    last = calibration.center;
    const latError = TARGET.lat - last.lat;
    const lngError = TARGET.lng - last.lng;
    if (Math.max(Math.abs(latError), Math.abs(lngError)) <= TARGET_TOLERANCE_DEGREES) return last;
    const drag = solveDrag(calibration, TARGET);
    await dragMap(page, drag.dx, drag.dy);
  }
  last = await statusCenter(page);
  const error = Math.max(Math.abs(TARGET.lat - last.lat), Math.abs(TARGET.lng - last.lng));
  if (error > TARGET_TOLERANCE_DEGREES * 2) {
    throw new Error(`Unable to pan to King William target; stopped at ${last.lat}, ${last.lng}`);
  }
  return last;
}

async function setRoads(page, enabled) {
  const button = page.locator("#roads-toggle");
  const current = (await button.textContent())?.includes("on") === true;
  if (current !== enabled) await button.click();
  await page.waitForTimeout(900);
}

async function setPhysicsDebug(page, enabled) {
  const button = page.locator("#physics-debug-toggle");
  const current = (await button.textContent())?.includes("on") === true;
  if (current !== enabled) await button.click();
  await page.waitForTimeout(900);
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader"],
});

let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const text = document.querySelector("#status")?.textContent ?? "";
      return /roads \d+\/240/.test(text) && text.includes("physics ready");
    },
    null,
    { timeout: 180_000 },
  );
  await page.waitForTimeout(2_000);

  const targeted = await panToTarget(page);
  const zoomIn = page.locator(".maplibregl-ctrl-zoom-in");
  for (let index = 0; index < 4; index += 1) {
    await zoomIn.click();
    await page.waitForTimeout(450);
  }
  await page.waitForTimeout(2_000);
  const closeCenter = await statusCenter(page);

  await setPhysicsDebug(page, false);
  await setRoads(page, true);
  const roadsOn = await capture(page, "king-william-exact-roads-on");
  await setRoads(page, false);
  const roadsOff = await capture(page, "king-william-exact-roads-off");
  await setRoads(page, true);
  await setPhysicsDebug(page, true);
  const physicsOn = await capture(page, "king-william-exact-physics-on");

  const orange = orangeRoadMask(roadsOff);
  const driveable = driveableRoadMask(roadsOn);
  const driveableSupport = dilateSquare(driveable.mask, driveable.width, driveable.height, 7);
  const centerlineGapRatio = unsupportedReferenceRatio(orange.mask, driveableSupport);

  const metrics = {
    target: TARGET,
    targeted,
    closeCenter,
    centerlineGapRatio,
  };
  writeFileSync(`${OUTPUT_DIR}/king-william-metrics.json`, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(JSON.stringify(metrics, null, 2));

  if (Math.max(Math.abs(closeCenter.lat - TARGET.lat), Math.abs(closeCenter.lng - TARGET.lng)) > TARGET_TOLERANCE_DEGREES * 2) {
    console.error("King William close-zoom camera drifted too far from the requested regression location");
    exitCode = 1;
  }
  if (centerlineGapRatio > 0.12) {
    console.error(`King William road centerlines contain uncovered surface gaps: ${centerlineGapRatio} > 0.12`);
    exitCode = 1;
  }
  void physicsOn;
} finally {
  await browser.close();
}

process.exit(exitCode);
