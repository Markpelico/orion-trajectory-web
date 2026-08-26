/**
 * EFT-1 inspired mission profile, precomputed once at module load.
 *
 * This is a *replay* built from idealized physics, not recorded NASA data:
 * ascent and entry are hand-shaped envelopes, but the coast orbit and the
 * apogee-raise ellipse are real two-body mechanics (vis-viva speeds, Kepler's
 * equation solved by Newton iteration). Entry/peak/chute/splash phase stamps
 * are derived from where the propagated ellipse actually crosses the entry
 * interface, so the HUD never contradicts the trajectory it is drawn over.
 *
 * Scene units: 1 unit = 1000 km. Y is up (Earth's north pole).
 */

const R = 6371; // Earth radius, km
const MU = 398600.4418; // Earth GM, km^3/s^2
const SCALE = 1 / 1000;

// Launch: Cape Canaveral, due-east launch -> inclination equals latitude,
// so the pad sits at the ground track's northernmost point.
const LAT = (28.5 * Math.PI) / 180;
const LON = (-80.6 * Math.PI) / 180;

// Basis of the orbit plane: u0 = pad direction, e0 = local east at the pad.
// Signs follow three.js SphereGeometry texture space (equator point for
// longitude L sits at (cos L, 0, -sin L)), so the ground track crosses the
// Florida of the Earth texture and "east" matches the map's east.
const u0 = [
  Math.cos(LAT) * Math.cos(LON),
  Math.sin(LAT),
  -Math.cos(LAT) * Math.sin(LON),
];
const e0 = [-Math.sin(LON), 0, -Math.cos(LON)];

/** Position on the great circle: angle theta along track, radius r (km). */
function onTrack(theta, r) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [
    r * (u0[0] * c + e0[0] * s) * SCALE,
    r * (u0[1] * c + e0[1] * s) * SCALE,
    r * (u0[2] * c + e0[2] * s) * SCALE,
  ];
}

// --- Mission constants -----------------------------------------------------

const ASCENT_END = 1020; // s, orbit insertion
const LEO_R = R + 185;
const LEO_V = Math.sqrt(MU / LEO_R); // 7.797 km/s
const BURN_T = 6900; // apogee raise burn

// Raise ellipse: apogee 5,800 km altitude, perigee driven down to 90 km so the
// descending leg re-enters (EFT-1's burn targeted entry the same way).
const RA = R + 5800;
const RP = R + 90;
const A = (RA + RP) / 2;
const E = (RA - RP) / (RA + RP);
const P = A * (1 - E * E);
const N = Math.sqrt(MU / (A * A * A)); // mean motion, rad/s
const ENTRY_ALT = 122; // km, entry interface
const ENTRY_DUR = 660; // s, interface -> splashdown

/** Kepler: mean anomaly -> eccentric anomaly, Newton iteration. */
function keplerE(M) {
  let Ea = M;
  for (let i = 0; i < 8; i++) {
    Ea = Ea - (Ea - E * Math.sin(Ea) - M) / (1 - E * Math.cos(Ea));
  }
  return Ea;
}
const nuFromE = (Ea) =>
  2 * Math.atan2(Math.sqrt(1 + E) * Math.sin(Ea / 2), Math.sqrt(1 - E) * Math.cos(Ea / 2));
const EFromNu = (nu) =>
  2 * Math.atan2(Math.sqrt(1 - E) * Math.sin(nu / 2), Math.sqrt(1 + E) * Math.cos(nu / 2));

// Burn happens at r = LEO_R, which sits just past this ellipse's perigee.
const nu0 = Math.acos((P / LEO_R - 1) / E); // ascending side
const M0 = (() => {
  const Ea = EFromNu(nu0);
  return Ea - E * Math.sin(Ea);
})();

// Entry interface: descending crossing of r = R + ENTRY_ALT.
const nuEntry = 2 * Math.PI - Math.acos((P / (R + ENTRY_ALT) - 1) / E);
const tEntry = (() => {
  const Ea = EFromNu(nuEntry - 2 * Math.PI); // wrap to (-pi, pi)
  const M = Ea - E * Math.sin(Ea) + 2 * Math.PI;
  return BURN_T + (M - M0) / N;
})();
const T_SPLASH = tEntry + ENTRY_DUR;

const easeInOut = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// --- Phase table -----------------------------------------------------------

export const PHASES = [
  { t: -10, name: "TERMINAL COUNT", short: "T-COUNT" },
  { t: 0, name: "LIFTOFF", short: "LIFTOFF" },
  { t: 80, name: "MAX Q", short: "MAX Q" },
  { t: 236, name: "BOOSTER SEPARATION", short: "SRB SEP" },
  { t: 333, name: "CORE STAGE SEPARATION", short: "STAGE SEP" },
  { t: ASCENT_END, name: "ORBIT INSERTION", short: "ORBIT" },
  { t: BURN_T, name: "APOGEE RAISE BURN", short: "RAISE BURN" },
  // Apogee: mean anomaly must sweep from M0 (burn) to pi.
  { t: BURN_T + (Math.PI - M0) / N, name: "APOGEE · 5,800 KM", short: "APOGEE" },
  { t: tEntry, name: "ENTRY INTERFACE", short: "ENTRY" },
  { t: tEntry + 180, name: "PEAK HEATING", short: "PEAK HEAT" },
  { t: tEntry + 540, name: "CHUTES DEPLOY", short: "CHUTES" },
  { t: T_SPLASH, name: "SPLASHDOWN", short: "SPLASH" },
];

export const T_START = -10;
export const T_END = T_SPLASH + 10;

// --- State model -----------------------------------------------------------

/**
 * Raw state at mission-elapsed-time t (seconds).
 * Returns { pos, alt (km), speed (km/s), g, theta }.
 */
function rawState(t) {
  if (t <= 0) {
    return { pos: onTrack(0, R), alt: 0, speed: 0, g: 1, theta: 0 };
  }

  if (t <= ASCENT_END) {
    // Ascent: shaped altitude + speed envelopes, downrange integrated.
    const tau = clamp01(t / ASCENT_END);
    const alt = 185 * (1 - Math.pow(1 - tau, 2.2));
    const speed = 0.05 + (LEO_V - 0.05) * Math.pow(tau, 1.6);
    // Integrated angle: closed-form of the same power law.
    // theta(t) = ∫ v/r dt with r ~ R (error < 3%): v = a + b·tau^1.6
    const b = LEO_V - 0.05;
    const theta = ((0.05 * t + (b * ASCENT_END * Math.pow(tau, 2.6)) / 2.6) / R);
    // G-load: builds to ~3.6 before SRB sep, dips at staging, mild second stage.
    let g;
    if (t < 236) g = 1 + 2.6 * easeInOut(clamp01(t / 236));
    else if (t < 333) g = 1.2;
    else g = 1.1 + 1.4 * easeInOut(clamp01((t - 333) / 687));
    return { pos: onTrack(theta, R + alt), alt, speed, g, theta };
  }

  // Angle at insertion, reused by every later segment.
  const bIns = LEO_V - 0.05;
  const thetaIns = (0.05 * ASCENT_END + (bIns * ASCENT_END) / 2.6) / R;

  if (t <= BURN_T) {
    // Circular coast at 185 km.
    const theta = thetaIns + ((t - ASCENT_END) * LEO_V) / LEO_R;
    return { pos: onTrack(theta, LEO_R), alt: 185, speed: LEO_V, g: 0, theta };
  }

  const thetaBurn = thetaIns + ((BURN_T - ASCENT_END) * LEO_V) / LEO_R;

  if (t <= tEntry) {
    // Transfer ellipse, propagated with Kepler.
    const M = M0 + N * (t - BURN_T);
    const Ea = keplerE(M);
    const nu = nuFromE(Ea);
    const r = A * (1 - E * Math.cos(Ea));
    const speed = Math.sqrt(MU * (2 / r - 1 / A)); // vis-viva
    const theta = thetaBurn + (nu - nu0);
    return { pos: onTrack(theta, r), alt: r - R, speed, g: 0, theta };
  }

  // Entry: shaped envelopes from interface to splashdown.
  const te = clamp01((t - tEntry) / ENTRY_DUR);
  const vEntry = Math.sqrt(MU * (2 / (R + ENTRY_ALT) - 1 / A)); // ~8.9 km/s
  const alt = ENTRY_ALT * (1 - easeInOut(te));
  let speed;
  if (te < 0.82) speed = vEntry * (1 - easeInOut(te / 0.82)) + 0.12;
  else speed = 0.12 - 0.11 * ((te - 0.82) / 0.18); // under chutes
  // G bell peaking ~8.2 around interface + 180 s, chute jerk near the end.
  const gBell = 8.2 * Math.exp(-Math.pow((t - tEntry - 180) / 95, 2));
  const gChute = 2.6 * Math.exp(-Math.pow((t - tEntry - 545) / 12, 2));
  const g = Math.max(gBell, gChute, te >= 1 ? 1 : 0.2);

  const thetaE = thetaBurn + (nuEntry - nu0);
  // Downrange bleed during entry: ~1,500 km, decaying with speed.
  const theta = thetaE + (1500 / R) * (1 - Math.pow(1 - te, 2.4));
  return { pos: onTrack(theta, R + alt), alt, speed, g, theta };
}

// --- Sample table (adaptive resolution) ------------------------------------

function buildSamples() {
  const ts = [];
  let t = T_START;
  while (t <= T_END) {
    ts.push(t);
    let dt;
    if (t < ASCENT_END + 30) dt = 2;
    else if (t < BURN_T - 60) dt = 20;
    else if (t < BURN_T + 120) dt = 4;
    else if (t < tEntry - 120) dt = 20;
    else dt = 2;
    t += dt;
  }
  ts.push(T_END);

  const n = ts.length;
  const pos = new Float32Array(n * 3);
  const alt = new Float32Array(n);
  const speed = new Float32Array(n);
  const g = new Float32Array(n);
  const downrange = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const s = rawState(ts[i]);
    pos[i * 3] = s.pos[0];
    pos[i * 3 + 1] = s.pos[1];
    pos[i * 3 + 2] = s.pos[2];
    alt[i] = s.alt;
    speed[i] = s.speed;
    g[i] = s.g;
    downrange[i] = Math.max(0, s.theta) * R;
  }
  return { ts, pos, alt, speed, g, downrange, n };
}

export const SAMPLES = buildSamples();

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

/** Interpolated state at mission time t. */
export function stateAt(t) {
  const { ts, pos, alt, speed, g, downrange, n } = SAMPLES;
  const tc = Math.max(T_START, Math.min(T_END, t));
  const i = Math.min(sampleIndex(tc), n - 2);
  const f = Math.min(1, Math.max(0, (tc - ts[i]) / (ts[i + 1] - ts[i] || 1)));
  const L = (arr, k) => arr[k] + (arr[k + 1] - arr[k]) * f;
  return {
    x: pos[i * 3] + (pos[(i + 1) * 3] - pos[i * 3]) * f,
    y: pos[i * 3 + 1] + (pos[(i + 1) * 3 + 1] - pos[i * 3 + 1]) * f,
    z: pos[i * 3 + 2] + (pos[(i + 1) * 3 + 2] - pos[i * 3 + 2]) * f,
    alt: L(alt, i),
    speed: L(speed, i),
    g: L(g, i),
    downrange: L(downrange, i),
    index: i,
  };
}

export function phaseIndexAt(t) {
  let idx = 0;
  for (let i = 0; i < PHASES.length; i++) if (t >= PHASES[i].t) idx = i;
  return idx;
}

/** "T+ 01:23:45" (or T- during countdown). */
export function formatMET(t) {
  const sign = t < 0 ? "T−" : "T+";
  const a = Math.abs(Math.round(t));
  const h = String(Math.floor(a / 3600)).padStart(2, "0");
  const m = String(Math.floor((a % 3600) / 60)).padStart(2, "0");
  const s = String(a % 60).padStart(2, "0");
  return `${sign} ${h}:${m}:${s}`;
}

export const EARTH_RADIUS_SCENE = R * SCALE;
export { tEntry, T_SPLASH, BURN_T, ASCENT_END };
