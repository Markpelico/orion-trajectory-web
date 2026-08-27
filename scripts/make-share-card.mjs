/**
 * Capture the money frame for the share card and the no-WebGL poster:
 * the lunar flyby with the fat trajectory, Moon relief and upgraded Earth.
 * Writes raw PNGs; a PIL pass turns them into public/og.png (1200x630)
 * and public/poster.jpg (1600x900, q70).
 *
 *   node scripts/make-share-card.mjs [baseUrl] [outDir]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3502";
const OUT = process.argv[3] ?? "audit/sharecard";
mkdirSync(OUT, { recursive: true });

async function captureAt(browser, width, height, name) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2800);
  await page.getByRole("button", { name: "INITIATE REPLAY" }).click();
  await page.waitForTimeout(1500);
  // Seek to the flyby via the rail, let the camera commit, pause, let the
  // slam finish its exit so the frame is pure scene + console chrome.
  await page.getByRole("button", { name: "FLYBY", exact: true }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "PAUSE", exact: true }).click();
  await page.waitForTimeout(3400);
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  console.log(`captured ${name} ${width}x${height}`);
  await page.close();
}

const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
await captureAt(browser, 2400, 1260, "hero-2400x1260");
await captureAt(browser, 1600, 900, "poster-1600x900");
await browser.close();
