import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const APP_URL = process.env.MAPSHOW_E2E_URL ?? "http://127.0.0.1:5173";
const OUTPUT_DIR = process.env.MAPSHOW_E2E_OUTPUT ?? "/tmp/mapshow-visual";
const VIEWPORT = { width: 1440, height: 900 };
const MAP_CLIP = { x: 430, y: 40, width: 980, height: 820 };
const CLOSE_ROAD_MAX_RATIO = 0.16;

const chromeCandidates = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!executablePath) {
  throw new Error(`No system Chromium/Chrome found. Checked: ${chromeCandidates.join(", ")}`);
}

mkdirSync(OUTPUT_DIR, { recursive: true });

function readPng(buffer) {
  return PNG.sync.read(buffer);
}

function changedPixelMask(leftBuffer, rightBuffer, channelThreshold = 24) {
  const left = readPng(leftBuffer);
  const right = readPng(rightBuffer);
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(`Screenshot dimensions differ: ${left.width}x${left.height} vs ${right.width}x${right.height}`);
  }

  const pixels = left.width * left.height;
  const mask = new Uint8Array(pixels);
  let changed = 0;
  for (let pixel = 0, offset = 0; pixel < pixels; pixel += 1, offset += 4) {
    const delta = Math.max(
      Math.abs(left.data[offset] - right.data[offset]),
      Math.abs(left.data[offset + 1] - right.data[offset + 1]),
      Math.abs(left.data[offset + 2] - right.data[offset + 2]),
    );
    if (delta >= channelThreshold) {
      mask[pixel] = 1;
      changed += 1;
    }
  }
  return { width: left.width, height: left.height, mask, changed, ratio: changed / pixels };
}

function changedPixelRatio(leftBuffer, rightBuffer, channelThreshold = 24) {
  return changedPixelMask(leftBuffer, rightBuffer, channelThreshold).ratio;
}

function orangeRoadMask(buffer) {
  const png = readPng(buffer);
  const pixels = png.width * png.height;
  const mask = new Uint8Array(pixels);
  for (let pixel = 0, offset = 0; pixel < pixels; pixel += 1, offset += 4) {
    const red = png.data[offset];
    const green = png.data[offset + 1];
    const blue = png.data[offset + 2];
    // The local game-road carrier is #ff6b35 at 0.8 opacity. Keep this deliberately broad so
    // antialiasing and the underlying map do not make the spatial check brittle.
    if (red >= 185 && green >= 70 && green <= 185 && blue <= 145 && red - green >= 45) {
      mask[pixel] = 1;
    }
  }
  return { width: png.width, height: png.height, mask };
}

function dilateSquare(mask, width, height, radius) {
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      const addX = x + radius;
      const removeX = x - radius - 1;
      if (addX < width) count += mask[y * width + addX];
      if (removeX >= 0) count -= mask[y * width + removeX];
      horizontal[y * width + x] = count > 0 ? 1 : 0;
    }
  }

  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      const addY = y + radius;
      const removeY = y - radius - 1;
      if (addY < height) count += horizontal[addY * width + x];
      if (removeY >= 0) count -= horizontal[removeY * width + x];
      output[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return output;
}

function unsupportedChangedRatio(changed, supportMask) {
  if (changed.changed === 0) return 1;
  let unsupported = 0;
  for (let index = 0; index < changed.mask.length; index += 1) {
    if (changed.mask[index] && !supportMask[index]) unsupported += 1;
  }
  return unsupported / changed.changed;
}

async function capture(page, name) {
  const screenshot = await page.screenshot({ type: "png", clip: MAP_CLIP });
  writeFileSync(`${OUTPUT_DIR}/${name}.png`, screenshot);
  return screenshot;
}

async function setRoads(page, enabled) {
  const button = page.locator("#roads-toggle");
  const current = (await button.textContent())?.includes("on") === true;
  if (current !== enabled) await button.click();
  await page.waitForFunction(
    (desired) => document.querySelector("#roads-toggle")?.textContent?.includes(desired ? "on" : "off") === true,
    enabled,
    { timeout: 10_000 },
  );
  if (enabled) {
    await page.waitForFunction(
      () => /roads \d+\/240/.test(document.querySelector("#status")?.textContent ?? ""),
      null,
      { timeout: 60_000 },
    );
  }
}

async function setPhysicsDebug(page, enabled) {
  const button = page.locator("#physics-debug-toggle");
  const current = (await button.textContent())?.includes("on") === true;
  if (current !== enabled) await button.click();
  await page.waitForFunction(
    (desired) => document.querySelector("#physics-debug-toggle")?.textContent?.includes(desired ? "on" : "off") === true,
    enabled,
    { timeout: 10_000 },
  );
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader",
  ],
});

let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const text = document.querySelector("#status")?.textContent ?? "";
      return /roads \d+\/240/.test(text) && text.includes("Rapier") && text.includes("physics ready");
    },
    null,
    { timeout: 180_000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(3_000);

  const status = await page.locator("#status").textContent();
  console.log(`Mapshow status: ${status}`);

  const stableA = await capture(page, "stable-a");
  await page.waitForTimeout(750);
  const stableB = await capture(page, "stable-b");
  const ambientRatio = changedPixelRatio(stableA, stableB);

  const roadsOn = stableB;
  await setRoads(page, false);
  await page.waitForTimeout(750);
  const roadsOff = await capture(page, "roads-off");
  const roadRatio = changedPixelRatio(roadsOn, roadsOff);

  await setRoads(page, true);
  await page.waitForTimeout(1_000);
  const physicsOff = await capture(page, "physics-off");

  await setPhysicsDebug(page, true);
  await page.waitForTimeout(750);
  const physicsOn = await capture(page, "physics-on");
  const physicsRatio = changedPixelRatio(physicsOff, physicsOn);

  const roadThreshold = Math.max(0.002, ambientRatio * 5 + 0.0005);
  const physicsThreshold = Math.max(0.0003, ambientRatio * 5 + 0.0001);

  // Reproduce the user's close-zoom failure. Absolute Mercator transforms can look plausible at z15-16
  // yet lose enough precision near z20 to explode metre-scale meshes into giant triangles.
  await setPhysicsDebug(page, false);
  const zoomIn = page.locator(".maplibregl-ctrl-zoom-in");
  for (let index = 0; index < 4; index += 1) {
    await zoomIn.click();
    await page.waitForTimeout(450);
  }
  await page.waitForFunction(
    () => /z19\./.test(document.querySelector("#status")?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1_500);

  await setRoads(page, true);
  const closeRoadsOn = await capture(page, "close-roads-on");
  await setRoads(page, false);
  await page.waitForTimeout(750);
  const closeRoadsOff = await capture(page, "close-roads-off");
  const closeRoadChange = changedPixelMask(closeRoadsOn, closeRoadsOff);
  const orange = orangeRoadMask(closeRoadsOff);
  const roadSupport = dilateSquare(orange.mask, orange.width, orange.height, 72);
  const closeRoadUnsupportedRatio = unsupportedChangedRatio(closeRoadChange, roadSupport);

  await setRoads(page, true);
  await page.waitForTimeout(1_000);
  const closePhysicsOff = await capture(page, "close-physics-off");
  await setPhysicsDebug(page, true);
  await page.waitForTimeout(750);
  const closePhysicsOn = await capture(page, "close-physics-on");
  const closePhysicsChange = changedPixelMask(closePhysicsOff, closePhysicsOn);
  const closePhysicsUnsupportedRatio = unsupportedChangedRatio(closePhysicsChange, roadSupport);

  const closeStatus = await page.locator("#status").textContent();
  const metrics = {
    executablePath,
    status,
    closeStatus,
    ambientRatio,
    roadRatio,
    roadThreshold,
    physicsRatio,
    physicsThreshold,
    closeRoadRatio: closeRoadChange.ratio,
    closeRoadMaxRatio: CLOSE_ROAD_MAX_RATIO,
    closeRoadUnsupportedRatio,
    closePhysicsRatio: closePhysicsChange.ratio,
    closePhysicsUnsupportedRatio,
    consoleErrors,
  };
  writeFileSync(`${OUTPUT_DIR}/metrics.json`, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(JSON.stringify(metrics, null, 2));

  if (roadRatio <= roadThreshold) {
    console.error(`Road surfaces are not visibly changing the canvas: ${roadRatio} <= ${roadThreshold}`);
    exitCode = 1;
  }
  if (physicsRatio <= physicsThreshold) {
    console.error(`Physics debug is not visibly changing the canvas: ${physicsRatio} <= ${physicsThreshold}`);
    exitCode = 1;
  }
  if (closeRoadChange.ratio <= roadThreshold) {
    console.error(`Close-zoom road surfaces are not visible: ${closeRoadChange.ratio} <= ${roadThreshold}`);
    exitCode = 1;
  }
  if (closeRoadChange.ratio > CLOSE_ROAD_MAX_RATIO) {
    console.error(`Close-zoom road geometry covers too much canvas: ${closeRoadChange.ratio} > ${CLOSE_ROAD_MAX_RATIO}`);
    exitCode = 1;
  }
  if (closeRoadUnsupportedRatio > 0.2) {
    console.error(`Close-zoom road geometry spills away from road centerlines: ${closeRoadUnsupportedRatio} > 0.2`);
    exitCode = 1;
  }
  if (closePhysicsChange.ratio <= physicsThreshold) {
    console.error(`Close-zoom physics debug is not visible: ${closePhysicsChange.ratio} <= ${physicsThreshold}`);
    exitCode = 1;
  }
  if (closePhysicsUnsupportedRatio > 0.25) {
    console.error(`Close-zoom physics geometry spills away from road centerlines: ${closePhysicsUnsupportedRatio} > 0.25`);
    exitCode = 1;
  }
} finally {
  await browser.close();
}

process.exit(exitCode);