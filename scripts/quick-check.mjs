/**
 * Quick spot-check during graphics work: seek straight to the shots that
 * exercise the current change set and screenshot them. Not a shipping
 * audit — scripts/artemis-audit.mjs remains the full pass.
 *
 *   node scripts/quick-check.mjs [baseUrl] [outDir]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3501";
const OUT = process.argv[3] ?? "audit/quick";
mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
const SPAN = 783155;

async function shoot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const clock = await page.locator(".hud-clock").textContent().catch(() => "?");
  console.log(`shot: ${name}   [${clock}]`);
}

async function scrubTo(page, met) {
  const bar = page.locator(".hud-scrub");
  const box = await bar.boundingBox();
  const f = (met + 10) / SPAN;
  await page.mouse.click(box.x + box.width * f, box.y + box.height / 2);
}

const pause = (page) => page.getByRole("button", { name: "PAUSE", exact: true }).click();
const play = (page) => page.getByRole("button", { name: "PLAY", exact: true }).click();

async function run() {
  const browser = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "INITIATE REPLAY" }).click();
  await page.waitForTimeout(1500);

  // Ascent: attitude should track the pitch-over closely now.
  await scrubTo(page, 200);
  await page.waitForTimeout(500);
  await pause(page);
  await page.waitForTimeout(1800);
  await shoot(page, "a-ascent");
  await play(page);

  // Night-side pass in low orbit: Black Marble city lights + terminator.
  await scrubTo(page, 1500);
  await page.waitForTimeout(500);
  await pause(page);
  await page.waitForTimeout(1800);
  await shoot(page, "a2-orbit-night");
  await play(page);

  // Mid-ARB: ICPS plume firing on the apogee raise.
  await scrubTo(page, 6800);
  await page.waitForTimeout(500);
  await pause(page);
  await page.waitForTimeout(1800);
  await shoot(page, "b0-arb-plume");
  await play(page);

  // TLI slam with the plain-English subtitle still up.
  await scrubTo(page, 90850);
  await page.waitForTimeout(1100);
  await shoot(page, "b1-tli-slam");

  // TLI hold: fat progress line over Earth, stack prograde, plume window.
  await scrubTo(page, 90980);
  await page.waitForTimeout(500);
  await pause(page);
  await page.waitForTimeout(1800);
  await shoot(page, "b-tli");
  await play(page);

  // Mid-coast: Earth marble + trajectory receding.
  await scrubTo(page, 200000);
  await page.waitForTimeout(500);
  await pause(page);
  await page.waitForTimeout(1800);
  await shoot(page, "c-midcoast");
  await play(page);

  // Flyby money shot.
  await scrubTo(page, 433560);
  await page.waitForTimeout(500);
  await pause(page);
  await page.waitForTimeout(2000);
  await shoot(page, "d-flyby");
  await play(page);

  // Entry: SM should be gone, capsule blunt-end-first, plasma building.
  await scrubTo(page, 782360);
  await page.waitForTimeout(500);
  await pause(page);
  await page.waitForTimeout(1800);
  await shoot(page, "e-entry");
  await play(page);

  // Orbit camera: the whole figure-eight as fat lines.
  const camGroup = page.getByRole("group", { name: "Camera" });
  await camGroup.getByRole("button", { name: "ORBIT" }).click();
  await page.waitForTimeout(1800);
  await shoot(page, "f-orbit-figure8");

  await page.close();
  await browser.close();

  console.log("\nconsole errors (deduped):");
  const seen = new Set();
  for (const e of consoleErrors) {
    if (!seen.has(e)) {
      seen.add(e);
      console.log("  -", e);
    }
  }
  if (!consoleErrors.length) console.log("  none");
}

run().catch((e) => {
  console.error("QUICK CHECK FAILED:", e);
  process.exit(1);
});
