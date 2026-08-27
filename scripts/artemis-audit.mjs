/**
 * Artemis II visual audit: fly the mission in headless Chromium and
 * screenshot the moments that matter — boot, launch, TLI, mid-coast,
 * the lunar flyby, entry, splashdown. WebGL renders through SwiftShader,
 * so visuals are real but frame rates are not.
 *
 *   node scripts/artemis-audit.mjs [baseUrl] [outDir]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3500";
const OUT = process.argv[3] ?? "audit/artemis";
mkdirSync(OUT, { recursive: true });

const consoleErrors = [];

async function shoot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const clock = await page.locator(".hud-clock").textContent().catch(() => "?");
  console.log(`shot: ${name}   [${clock}]`);
}

/** Click a phase-rail button by its short label. */
async function railTo(page, label) {
  await page.getByRole("button", { name: label, exact: true }).click();
}

/** Click the scrubber at mission fraction f (met = T_START + f * SPAN). */
async function scrubTo(page, f) {
  const bar = page.locator(".hud-scrub");
  const box = await bar.boundingBox();
  await page.mouse.click(box.x + box.width * f, box.y + box.height / 2);
}

const pause = (page) => page.getByRole("button", { name: "PAUSE", exact: true }).click();
const play = (page) => page.getByRole("button", { name: "PLAY", exact: true }).click();

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
  await page.waitForTimeout(7000); // countdown at 1x
  await shoot(page, "02-countdown");

  await page.waitForTimeout(7500); // liftoff + early ascent
  await shoot(page, "03-liftoff");

  await page.waitForTimeout(12000); // SRB sep territory, still low
  await shoot(page, "04-ascent");

  // TLI: seek via the rail, catch the slam, then hold for the composition.
  await railTo(page, "TLI");
  await page.waitForTimeout(1400);
  await shoot(page, "05-tli-slam");
  await pause(page);
  await page.waitForTimeout(2000);
  await shoot(page, "06-tli-hold");
  await play(page);

  // Mid-coast: Earth shrinking behind the spacecraft (met ~ 200,000 s).
  await scrubTo(page, (200000 + 10) / 783155);
  await page.waitForTimeout(800);
  await pause(page);
  await page.waitForTimeout(2000);
  await shoot(page, "07-midcoast");
  await play(page);

  // Approach: inside the lunar sphere of influence.
  await railTo(page, "LUNAR SOI");
  await page.waitForTimeout(2500);
  await shoot(page, "08-soi");

  // Moon looming on approach.
  await scrubTo(page, (429500 + 10) / 783155);
  await page.waitForTimeout(600);
  await pause(page);
  await page.waitForTimeout(2200);
  await shoot(page, "09-approach");
  await play(page);

  // The money shot: closest approach, spacecraft and Moon in frame.
  await railTo(page, "FLYBY");
  await page.waitForTimeout(900);
  await shoot(page, "10-flyby-slam");
  await pause(page);
  await page.waitForTimeout(2500);
  await shoot(page, "11-flyby-money");
  await play(page);
  await page.waitForTimeout(5000);
  await shoot(page, "12-flyby-depart");

  // Orbit camera at figure-eight scale.
  const camGroup = page.getByRole("group", { name: "Camera" });
  await camGroup.getByRole("button", { name: "ORBIT" }).click();
  await page.waitForTimeout(1500);
  await shoot(page, "13-orbit-figure8");
  await camGroup.getByRole("button", { name: "CHASE" }).click();
  await page.waitForTimeout(1000);

  // Entry: interface slam, then peak plasma.
  await railTo(page, "ENTRY");
  await page.waitForTimeout(1500);
  await shoot(page, "14-entry-slam");
  await page.waitForTimeout(11000); // ~EI + 130s of mission at 10x
  await shoot(page, "15-plasma");

  // Chutes to splashdown and the completion overlay.
  await railTo(page, "CHUTES");
  await page.waitForTimeout(2000);
  await shoot(page, "16-chutes");
  await page
    .waitForSelector(".hud-complete", { timeout: 90000 })
    .catch(() => console.log("complete overlay not reached in time"));
  await page.waitForTimeout(1200);
  await shoot(page, "17-splashdown");

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
  await shoot(mob, "18-mobile-boot");
  await mob.getByRole("button", { name: "INITIATE REPLAY" }).click();
  await mob.waitForTimeout(12000);
  await shoot(mob, "19-mobile-flight");
  // The rail is hidden on mobile; scrub to the flyby instead.
  await scrubTo(mob, (433560 + 10) / 783155);
  await mob.waitForTimeout(700);
  await mob.getByRole("button", { name: "PAUSE", exact: true }).click();
  await mob.waitForTimeout(2000);
  await shoot(mob, "20-mobile-flyby");
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
