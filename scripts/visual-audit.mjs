/**
 * Visual audit: fly the deployed mission in headless Chromium and screenshot
 * the moments that matter. WebGL renders through SwiftShader, so visuals are
 * real but frame rates are not representative of hardware.
 *
 *   node scripts/visual-audit.mjs [baseUrl] [outDir]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "https://orion.markpelico.com";
const OUT = process.argv[3] ?? "audit";
mkdirSync(OUT, { recursive: true });

const consoleErrors = [];

async function shoot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`shot: ${name}`);
}

async function run() {
  const browser = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
  });

  // --- Desktop pass ---------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "networkidle" });
  console.log(`loaded in ${Date.now() - t0}ms`);
  await page.waitForTimeout(3500);
  await shoot(page, "01-boot");

  await page.getByRole("button", { name: "INITIATE REPLAY" }).click();
  await page.waitForTimeout(2500); // countdown running
  await shoot(page, "02-countdown");

  await page.waitForTimeout(9000); // liftoff, early ascent (1x)
  await shoot(page, "03-liftoff");

  await page.getByRole("button", { name: "300×" }).click();
  await page.waitForTimeout(4000); // deep in ascent / orbit
  await shoot(page, "04-orbit-chase");

  // Orbit camera + a drag, the reported black-screen scenario.
  await page.getByRole("button", { name: "ORBIT", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.mouse.move(800, 450);
  await page.mouse.down();
  await page.mouse.move(1100, 350, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  await shoot(page, "05-orbit-cam-drag");

  await page.waitForTimeout(12000); // ellipse / apogee territory at 300x
  await shoot(page, "06-apogee");

  // Back to chase for entry.
  await page.getByRole("button", { name: "CHASE" }).click();
  await page.waitForTimeout(14000);
  await shoot(page, "07-late-mission");

  // Ride until complete (cap the wait).
  await page
    .waitForSelector(".hud-complete", { timeout: 90000 })
    .catch(() => console.log("complete overlay not reached in time"));
  await shoot(page, "08-final");

  // Canvas health check.
  const health = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const gl = c && (c.getContext("webgl2") || c.getContext("webgl"));
    return {
      canvas: c ? [c.width, c.height] : null,
      contextLost: gl ? gl.isContextLost() : null,
      clock: document.querySelector(".hud-clock")?.textContent ?? null,
    };
  });
  console.log("health:", JSON.stringify(health));
  await page.close();

  // --- Mobile pass ----------------------------------------------------------
  const mob = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await mob.goto(BASE, { waitUntil: "networkidle" });
  await mob.waitForTimeout(3500);
  await shoot(mob, "09-mobile-boot");
  await mob.getByRole("button", { name: "INITIATE REPLAY" }).click();
  await mob.waitForTimeout(12000);
  await shoot(mob, "10-mobile-flight");
  await mob.close();

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
  console.error("AUDIT FAILED:", e);
  process.exit(1);
});
