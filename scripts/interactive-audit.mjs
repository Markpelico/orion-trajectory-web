/**
 * Interactive audit: exercise every Phase-2 interaction in headless
 * Chromium and screenshot the moments that matter — hover-inspect,
 * click-to-seek, the POV Earthrise, the press-and-hold TLI what-if,
 * deep links, the shortcuts overlay, and the mobile pass. WebGL renders
 * through SwiftShader, so visuals are real but frame rates are not.
 *
 * Relies on the tiny window.__orion audit hook (Scene.jsx) to seek the
 * clock and to ask where a mission time lands on screen, so the pointer
 * tests hover the real trajectory instead of guessing pixels.
 *
 *   node scripts/interactive-audit.mjs [baseUrl] [outDir]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3500";
const OUT = process.argv[3] ?? "audit/interactive-final";
mkdirSync(OUT, { recursive: true });

const TLI = 90840;
const TLI_END = 91195;
const FLYBY = 433560;

const consoleErrors = [];
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  ok " : "FAIL "} ${msg}`);
  if (!ok) failures++;
};

async function shoot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`shot: ${name}`);
}

function wire(page, tag = "") {
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(tag + m.text().slice(0, 200)));
  page.on("pageerror", (e) => consoleErrors.push(tag + "PAGEERROR: " + String(e).slice(0, 300)));
}

async function run() {
  const browser = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
  });

  // ---- Desktop ------------------------------------------------------------
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(BASE).origin });
  const page = await ctx.newPage();
  wire(page);

  // Deep link straight into the flyby: boot skipped, paused, right moment.
  await page.goto(`${BASE}/#t=${FLYBY}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(4500);
  const dl = await page.evaluate(() => {
    const s = window.__orion.state();
    return { met: Math.round(s.met), playing: s.playing, booted: s.booted };
  });
  check(dl.booted && !dl.playing && dl.met === FLYBY, `deep link #t=${FLYBY}: paused at flyby (${JSON.stringify(dl)})`);
  await shoot(page, "01-deeplink-flyby");

  // Hover-inspect: ask the app where a sample lands, hover it, read the chip.
  await page.evaluate(() => window.__orion.seek(200000));
  await page.waitForTimeout(1000);
  const pt = await page.evaluate(() => window.__orion.screenAt(150000));
  await page.mouse.move(pt.x, pt.y, { steps: 4 });
  await page.waitForTimeout(600);
  const chipText = await page.locator(".hud-inspect").innerText().catch(() => "");
  check(/MET/.test(chipText) && /JPL HORIZONS/.test(chipText), `hover chip quotes the ephemeris row (${chipText.split("\n")[1] ?? ""})`);
  await shoot(page, "02-hover-inspect");

  // Click-to-seek: the clock must jump to the hovered row.
  const before = await page.locator(".hud-clock").textContent();
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.locator(".hud-clock").textContent();
  check(before !== after, `click seeks the clock (${before} -> ${after})`);
  await shoot(page, "03-click-seek");

  // POV Earthrise: the money shot, ~24 min after closest approach.
  await page.evaluate(() => window.__orion.state().setCamMode("pov"));
  await page.evaluate((t) => window.__orion.seek(t), FLYBY + 1500);
  await page.waitForTimeout(3000);
  await shoot(page, "04-pov-earthrise");
  await page.evaluate((t) => window.__orion.seek(t), FLYBY + 2400);
  await page.waitForTimeout(2600);
  await shoot(page, "05-pov-earthrise-risen");
  await page.evaluate(() => window.__orion.state().setCamMode("chase"));

  // Press-and-hold TLI, released early: ghost + verdict.
  await page.evaluate((t) => window.__orion.seek(t), TLI - 40);
  await page.waitForTimeout(800);
  const armed = await page.locator(".hud-tli-btn").isVisible().catch(() => false);
  check(armed, "TLI control armed before ignition");
  const bb = await page.locator(".hud-tli-btn").boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3000); // ~half the burn at 60x
  await page.mouse.up();
  await page.waitForTimeout(2200);
  const verdict = await page.locator(".hud-verdict").innerText().catch(() => "");
  const ghostState = await page.evaluate(() => {
    const s = window.__orion.state();
    return { mode: s.tli.mode, cam: s.camMode, pts: s.tli.ghost ? s.tli.ghost.pts.length : 0 };
  });
  check(
    ghostState.mode === "ghost" && ghostState.pts > 0 && /CUTOFF/.test(verdict) && /TWO-BODY/.test(verdict),
    `early cutoff -> ghost + verdict (${verdict.split("\n")[0]}, ${ghostState.pts / 3} pts, cam ${ghostState.cam})`
  );
  await shoot(page, "06-tli-ghost-verdict");
  await page.getByRole("button", { name: "RESUME REPLAY" }).click();
  await page.waitForTimeout(500);
  const resumed = await page.evaluate(() => window.__orion.state().playing);
  check(resumed, "RESUME REPLAY returns to the ephemeris");

  // SHARE MOMENT writes a deep link to the clipboard.
  await page.getByRole("button", { name: /SHARE MOMENT/ }).click();
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  check(/#t=\d+/.test(clip), `SHARE MOMENT copies a deep link (${clip})`);

  // Shortcuts: overlay + a couple of bindings.
  await page.keyboard.press("Shift+Slash");
  await page.waitForTimeout(400);
  check(await page.locator(".hud-help").isVisible().catch(() => false), "? opens the shortcuts overlay");
  await shoot(page, "07-shortcuts-overlay");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const paused0 = await page.evaluate(() => window.__orion.state().playing);
  await page.keyboard.press("Space");
  await page.waitForTimeout(250);
  const paused1 = await page.evaluate(() => window.__orion.state().playing);
  check(paused0 !== paused1, "Space toggles play/pause");
  if (paused1) await page.keyboard.press("Space"); // make sure we are paused
  await page.waitForTimeout(250);
  const mB = await page.evaluate(() => Math.round(window.__orion.state().met));
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(250);
  const mC = await page.evaluate(() => Math.round(window.__orion.state().met));
  check(mC - mB === 60, `ArrowRight scrubs +60 s (${mB} -> ${mC})`);
  await page.close();

  // ---- Mobile -------------------------------------------------------------
  const mob = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  wire(mob, "MOB ");
  await mob.goto(`${BASE}/#t=200000`, { waitUntil: "networkidle" });
  await mob.waitForTimeout(4000);

  // Tap-to-inspect pins a chip with JUMP HERE.
  const mpt = await mob.evaluate(() => window.__orion.screenAt(150000));
  await mob.touchscreen.tap(mpt.x, mpt.y);
  await mob.waitForTimeout(700);
  const jumpVisible = await mob.getByRole("button", { name: "JUMP HERE" }).isVisible().catch(() => false);
  check(jumpVisible, "mobile tap pins inspect chip with JUMP HERE");
  await shoot(mob, "08-mobile-inspect");
  if (jumpVisible) {
    const mBefore = await mob.locator(".hud-clock").textContent();
    await mob.getByRole("button", { name: "JUMP HERE" }).tap();
    await mob.waitForTimeout(600);
    const mAfter = await mob.locator(".hud-clock").textContent();
    check(mBefore !== mAfter, `JUMP HERE seeks (${mBefore} -> ${mAfter})`);
  }

  // Burn control reachable on a phone.
  await mob.evaluate((t) => window.__orion.seek(t), TLI - 40);
  await mob.waitForTimeout(900);
  const mbb = await mob.locator(".hud-tli-btn").boundingBox().catch(() => null);
  check(
    mbb && mbb.y > 60 && mbb.y + mbb.height < 844 - 220,
    `mobile TLI button reachable, clear of HUD (${mbb ? JSON.stringify({ y: Math.round(mbb.y), h: mbb.height }) : "missing"})`
  );
  await shoot(mob, "09-mobile-tli-armed");
  await mob.close();

  await browser.close();

  console.log("\nconsole errors (deduped):");
  const seen = new Set();
  for (const e of consoleErrors) if (!seen.has(e)) { seen.add(e); console.log("  -", e); }
  if (!consoleErrors.length) console.log("  none");
  check(consoleErrors.length === 0, "zero console errors across the pass");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall interactive checks passed");
  process.exit(failures ? 1 : 0);
}

run().catch((e) => {
  console.error("AUDIT FAILED:", e);
  process.exit(1);
});
