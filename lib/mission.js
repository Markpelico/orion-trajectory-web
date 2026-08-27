/**
 * ARTEMIS II — the real mission, replayed.
 *
 * Crewed lunar free-return: launched 2026-04-01 22:35:12 UTC (Wiseman,
 * Glover, Koch, Hansen), lunar flyby 6,545 km on April 6, Pacific splashdown
 * 2026-04-11 00:07:27 UTC. The sample table is baked by
 * scripts/build-artemis2.mjs from the JPL Horizons ephemeris of spacecraft
 * -1024 (the post-flight NASA/JSC navigation solution); ascent and the final
 * entry minutes are reconstructed there from published event times. No
 * runtime API calls — lib/artemis2.json is static data.
 *
 * Scene units: 1 unit = 1000 km. Y is up (Earth's north pole). The data is
 * inertial (J2000 axes); ground alignment comes from spinning the Earth mesh
 * at the real sidereal rate, phased so the pad is over Florida at liftoff.
 *
 * The previous synthetic EFT-1 profile lives on, unused, in
 * lib/mission-eft1.js.
 */

import DATA from "./artemis2.json";

const R = 6371; // km
const R_MOON = 1737.4; // km
const SCALE = 1 / 1000;

/** Flown event times, MET seconds (Horizons -1024 object page). */
export const EV = DATA.meta.events;
export const STATS = DATA.meta.stats;

/** Earth mesh spin: real sidereal rate, phased to put the pad over Florida. */
export const EARTH_SPIN = { phase0: DATA.meta.earthPhase0, omega: DATA.meta.earthOmega };

/** Real mid-mission Sun direction (scene frame): dusk launch, gibbous Moon. */
export const SUN_DIR = DATA.meta.sunDir;

// --- Phase table -----------------------------------------------------------

export const PHASES = [
  { t: -10, name: "TERMINAL COUNT", short: "T-COUNT" },
  { t: 0, name: "LIFTOFF", short: "LIFTOFF" },
  { t: EV.MAXQ, name: "MAX Q", short: "MAX Q" },
  { t: EV.SRB_SEP, name: "BOOSTER SEPARATION", short: "SRB SEP" },
  { t: 483, name: "CORE STAGE SEPARATION", short: "STAGE SEP" },
  { t: EV.INSERT, name: "ORBIT INSERTION", short: "ORBIT" },
  { t: EV.PRM, name: "ICPS PERIGEE RAISE", short: "PRM" },
  { t: EV.ARB, name: "APOGEE RAISE · 70,377 KM", short: "ARB" },
  { t: EV.ICPS_SEP, name: "ORION / ICPS SEPARATION", short: "ICPS SEP" },
  { t: EV.SM_PRB, name: "PERIGEE RAISE BURN", short: "PRB" },
  { t: EV.TLI, name: "TRANSLUNAR INJECTION", short: "TLI" },
  { t: EV.TLI_END, name: "OUTBOUND COAST", short: "OUTBOUND" },
  { t: EV.LUNAR_SOI, name: "LUNAR SPHERE OF INFLUENCE", short: "LUNAR SOI" },
  { t: EV.FLYBY, name: "LUNAR FLYBY · 6,545 KM", short: "FLYBY" },
  { t: EV.FLYBY + 2040, name: "RETURN COAST", short: "RETURN" },
  { t: EV.ENTRY, name: "ENTRY INTERFACE", short: "ENTRY" },
  { t: EV.PEAK_HEAT, name: "PEAK HEATING", short: "PEAK HEAT" },
  { t: EV.CHUTES, name: "CHUTES DEPLOY", short: "CHUTES" },
  { t: EV.SPLASH, name: "SPLASHDOWN", short: "SPLASH" },
];

/** Index of ENTRY INTERFACE in PHASES — slams at or past it go red. */
export const ENTRY_PHASE_IDX = PHASES.findIndex((p) => p.name === "ENTRY INTERFACE");

export const T_START = -10;
export const T_END = EV.SPLASH + 10;

// --- Sample table (from the baked ephemeris) -------------------------------

function buildSamples() {
  const ts = DATA.sc.t;
  const n = ts.length;
  const pos = new Float32Array(n * 3);
  const alt = new Float32Array(n);
  const speed = new Float32Array(n);
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = DATA.sc.pos[i * 3];
    const y = DATA.sc.pos[i * 3 + 1];
    const z = DATA.sc.pos[i * 3 + 2];
    pos[i * 3] = x * SCALE;
    pos[i * 3 + 1] = y * SCALE;
    pos[i * 3 + 2] = z * SCALE;
    alt[i] = Math.max(0, Math.sqrt(x * x + y * y + z * z) - R);
    speed[i] = DATA.sc.speed[i];
    g[i] = DATA.sc.g[i];
  }
  return { ts, pos, alt, speed, g, n };
}

export const SAMPLES = buildSamples();

// Moon track: hourly geocentric positions across the mission window,
// interpolated linearly (the Moon moves ~0.55 deg/h — chord error is nothing
// at scene scale). Scene units.
const MOON = (() => {
  const ts = DATA.moon.t;
  const n = ts.length;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = DATA.moon.pos[i] * SCALE;
  return { ts, pos, n };
})();

/** Index of the last sample at or before t (binary search). */
export function sampleIndex(t) {
  const { ts } = SAMPLES;
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Moon position (scene units) at mission time t. */
export function moonPosAt(t, out) {
  const { ts, pos, n } = MOON;
  const tc = Math.max(ts[0], Math.min(ts[n - 1], t));
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= tc) lo = mid;
    else hi = mid - 1;
  }
  const f = (tc - ts[lo]) / (ts[lo + 1] - ts[lo] || 1);
  const o = out ?? [0, 0, 0];
  o[0] = pos[lo * 3] + (pos[(lo + 1) * 3] - pos[lo * 3]) * f;
  o[1] = pos[lo * 3 + 1] + (pos[(lo + 1) * 3 + 1] - pos[lo * 3 + 1]) * f;
  o[2] = pos[lo * 3 + 2] + (pos[(lo + 1) * 3 + 2] - pos[lo * 3 + 2]) * f;
  return o;
}

const scratchMoon = [0, 0, 0];

/** Interpolated state at mission time t. Ranges in km, positions in units. */
export function stateAt(t) {
  const { ts, pos, alt, speed, g, n } = SAMPLES;
  const tc = Math.max(T_START, Math.min(T_END, t));
  const i = Math.min(sampleIndex(tc), n - 2);
  const f = Math.min(1, Math.max(0, (tc - ts[i]) / (ts[i + 1] - ts[i] || 1)));
  const L = (arr, k) => arr[k] + (arr[k + 1] - arr[k]) * f;
  const x = pos[i * 3] + (pos[(i + 1) * 3] - pos[i * 3]) * f;
  const y = pos[i * 3 + 1] + (pos[(i + 1) * 3 + 1] - pos[i * 3 + 1]) * f;
  const z = pos[i * 3 + 2] + (pos[(i + 1) * 3 + 2] - pos[i * 3 + 2]) * f;
  const m = moonPosAt(tc, scratchMoon);
  const dm =
    Math.sqrt((x - m[0]) ** 2 + (y - m[1]) ** 2 + (z - m[2]) ** 2) * 1000 - R_MOON;
  return {
    x,
    y,
    z,
    alt: L(alt, i),
    speed: L(speed, i),
    g: L(g, i),
    rangeMoon: Math.max(0, dm),
    index: i,
  };
}

export function phaseIndexAt(t) {
  let idx = 0;
  for (let i = 0; i < PHASES.length; i++) if (t >= PHASES[i].t) idx = i;
  return idx;
}

/** "T+ 01:23:45" (or T- during countdown). Hours run past 217 by splashdown. */
export function formatMET(t) {
  const sign = t < 0 ? "T−" : "T+";
  const a = Math.abs(Math.round(t));
  const h = String(Math.floor(a / 3600)).padStart(2, "0");
  const m = String(Math.floor((a % 3600) / 60)).padStart(2, "0");
  const s = String(a % 60).padStart(2, "0");
  return `${sign} ${h}:${m}:${s}`;
}

/** "123,456 KM" with a sensible resolution for the size of the number. */
export function formatKm(km) {
  if (km >= 100000) return Math.round(km / 100) * 100;
  if (km >= 10000) return Math.round(km / 10) * 10;
  return Math.round(km);
}

export const EARTH_RADIUS_SCENE = R * SCALE;
export const MOON_RADIUS_SCENE = R_MOON * SCALE;
