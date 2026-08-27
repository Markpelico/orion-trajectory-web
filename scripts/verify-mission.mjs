/**
 * Headless checks of the baked Artemis II table — run before shipping:
 *
 *   node scripts/verify-mission.mjs
 *
 * Asserts: finite values everywhere, strictly monotonic time, lunar flyby
 * minimum distance matching the documented 8,282 km (Moon center), splashdown
 * at 0 km / 0 km/s at the documented MET, and prints the AUTO-warp wall time
 * (the schedule here mirrors lib/store.js — keep them in sync).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(readFileSync(join(HERE, "..", "lib", "artemis2.json"), "utf8"));
const EV = DATA.meta.events;

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  ok " : "FAIL "} ${msg}`);
  if (!ok) failures++;
};

const { t, pos, speed, g } = DATA.sc;
const n = t.length;

// --- integrity --------------------------------------------------------------
let finite = true;
let mono = true;
for (let i = 0; i < n; i++) {
  if (
    !Number.isFinite(t[i]) ||
    !Number.isFinite(speed[i]) ||
    !Number.isFinite(g[i]) ||
    !Number.isFinite(pos[i * 3]) ||
    !Number.isFinite(pos[i * 3 + 1]) ||
    !Number.isFinite(pos[i * 3 + 2])
  )
    finite = false;
  if (i > 0 && t[i] <= t[i - 1]) mono = false;
}
check(finite, `all ${n} samples finite (t, pos, speed, g)`);
check(mono, "time strictly monotonic");
check(t[0] === -10 && Math.abs(t[n - 1] - (EV.SPLASH + 10)) < 1, "span covers T-10s .. splash+10s");

// --- physical anchors -------------------------------------------------------
const R = 6371;
const rAt = (i) => Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);

const moonAt = (tt) => {
  const mt = DATA.moon.t;
  const mp = DATA.moon.pos;
  let i = 0;
  while (i < mt.length - 2 && mt[i + 1] <= tt) i++;
  const f = (tt - mt[i]) / (mt[i + 1] - mt[i]);
  return [
    mp[i * 3] + (mp[(i + 1) * 3] - mp[i * 3]) * f,
    mp[i * 3 + 1] + (mp[(i + 1) * 3 + 1] - mp[i * 3 + 1]) * f,
    mp[i * 3 + 2] + (mp[(i + 1) * 3 + 2] - mp[i * 3 + 2]) * f,
  ];
};

let minMoon = Infinity;
let minMoonT = 0;
let maxEarth = 0;
for (let i = 0; i < n; i++) {
  const m = moonAt(t[i]);
  const d = Math.hypot(pos[i * 3] - m[0], pos[i * 3 + 1] - m[1], pos[i * 3 + 2] - m[2]);
  if (d < minMoon) {
    minMoon = d;
    minMoonT = t[i];
  }
  maxEarth = Math.max(maxEarth, rAt(i));
}
check(
  Math.abs(minMoon - 8282) < 60,
  `flyby min Moon-center distance ${minMoon.toFixed(0)} km (documented 8,282; alt ${(minMoon - 1737.4).toFixed(0)} km)`
);
check(
  Math.abs(minMoonT - EV.FLYBY) < 900,
  `flyby time MET ${minMoonT.toFixed(0)} s vs documented ${EV.FLYBY}`
);
check(
  Math.abs(maxEarth - 413146) < 500,
  `max Earth-center distance ${maxEarth.toFixed(0)} km (documented 413,146)`
);

const iLast = n - 1;
check(Math.abs(rAt(iLast) - R) < 0.5, `splashdown altitude ${(rAt(iLast) - R).toFixed(2)} km`);
check(speed[iLast] === 0, `splashdown speed ${speed[iLast]} km/s`);
check(Math.abs(t[iLast] - 10 - EV.SPLASH) < 1, `splashdown MET ${t[iLast] - 10} s = 9d 01:32:15`);

// TLI signature: specific orbital energy flips from bound HEO toward the Moon.
const idxAt = (tt) => {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= tt) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};
const energy = (i) => (speed[i] * speed[i]) / 2 - 398600.4418 / rAt(i);
const ePre = energy(idxAt(EV.TLI - 300));
const ePost = energy(idxAt(EV.TLI_END + 300));
check(ePost > ePre + 1, `TLI energy jump ${ePre.toFixed(2)} -> ${ePost.toFixed(2)} km^2/s^2`);

const iEI = idxAt(EV.ENTRY + 40);
check(speed[iEI] > 10.7, `entry interface speed ${speed[iEI].toFixed(2)} km/s (lunar return ~11)`);

// --- AUTO warp wall time (mirror of lib/store.js autoWarp) ------------------
function autoWarp(tt) {
  if (tt < 95) return 1;
  if (tt < 150) return 4;
  if (tt < 470) return 24;
  if (tt < 560) return 8;
  if (tt < EV.PRM - 60) return 120;
  if (tt < EV.PRM + 90) return 20;
  if (tt < EV.ARB - 60) return 150;
  if (tt < 7000) return 30;
  if (tt < EV.ICPS_SEP - 100) return 400;
  if (tt < EV.ICPS_SEP + 150) return 40;
  if (tt < EV.SM_PRB - 120) return 3000;
  if (tt < EV.SM_PRB + 120) return 60;
  if (tt < EV.TLI - 400) return 3000;
  if (tt < EV.TLI_END + 80) return 24;
  if (tt < 100000) return 350;
  if (tt < 360000) return 32000;
  if (tt < EV.FLYBY - 5500) return 10000;
  if (tt < EV.FLYBY + 5500) return 600;
  if (tt < 480000) return 10000;
  if (tt < 778000) return 40000;
  if (tt < EV.ENTRY - 180) return 900;
  if (tt < EV.PEAK_HEAT + 240) return 10;
  return 12;
}
let wall = 0;
for (let tt = -10; tt < EV.SPLASH; ) {
  const w = autoWarp(tt);
  tt += w; // 1-second wall steps
  wall++;
}
const mm = Math.floor(wall / 60);
const ss = wall % 60;
console.log(`     AUTO replay wall time ~ ${mm}m ${String(ss).padStart(2, "0")}s`);
check(wall >= 270 && wall <= 450, "AUTO replay lands in the 4.5-7.5 minute window");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
