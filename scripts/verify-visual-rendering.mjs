import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const APP_URL = process.env.MAPSHOW_E2E_URL ?? "http://127.0.0.1:5173";
const OUTPUT_DIR = process.env.MAPSHOW_E2E_OUTPUT ?? "/tmp/mapshow-visual";
const VIEWPORT = { width: 1440, height: 900 };
const MAP_CLIP = { x: 430, y: 40, width: 980, height: 820 };

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

function changedPixelRatio(leftBuffer, rightBuffer, channelThreshold = 24) {
  const left = readPng(leftBuffer);
  const right = readPng(rightBuffer);
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(`Screenshot dimensions differ: ${left.width}x${left.height} vs ${right.width}x${right.height}`);
  }

  let changed = 0;
  const pixels = left.width * left.height;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const delta = Math.max(
      Math.abs(left.data[offset] - right.data[offset]),
      Math.abs(left.data[offset + 1] - right.data[offset + 1]),
      Math.abs(left.data[offset + 2] - right.data[offset + 2]),
    );
    if (delta >= channelThreshold) changed += 1;
  }
  return changed / pixels;
}

async function capture(page, name) {
  const screenshot = await page.screenshot({ type: "png", clip: MAP_CLIP });
  writeFileSync(`${OUTPUT_DIR}/${name}.png`, screenshot);
  return screenshot;
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
  await page.locator("#roads-toggle").click();
  await page.waitForFunction(
    () => document.querySelector("#roads-toggle")?.textContent?.includes("off") === true,
    null,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(750);
  const roadsOff = await capture(page, "roads-off");
  const roadRatio = changedPixelRatio(roadsOn, roadsOff);

  await page.locator("#roads-toggle").click();
  await page.waitForFunction(
    () => {
      const statusText = document.querySelector("#status")?.textContent ?? "";
      return document.querySelector("#roads-toggle")?.textContent?.includes("on") === true
        && /roads \d+\/240/.test(statusText);
    },
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(1_000);
  const physicsOff = await capture(page, "physics-off");

  await page.locator("#physics-debug-toggle").click();
  await page.waitForFunction(
    () => document.querySelector("#physics-debug-toggle")?.textContent?.includes("on") === true,
    null,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(750);
  const physicsOn = await capture(page, "physics-on");
  const physicsRatio = changedPixelRatio(physicsOff, physicsOn);

  const roadThreshold = Math.max(0.002, ambientRatio * 5 + 0.0005);
  const physicsThreshold = Math.max(0.0003, ambientRatio * 5 + 0.0001);
  const metrics = {
    executablePath,
    status,
    ambientRatio,
    roadRatio,
    roadThreshold,
    physicsRatio,
    physicsThreshold,
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
} finally {
  await browser.close();
}

process.exit(exitCode);
