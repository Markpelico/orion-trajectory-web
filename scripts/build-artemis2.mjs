/**
 * Bake the Artemis II mission table from JPL Horizons.
 *
 *   node scripts/build-artemis2.mjs [--refetch]
 *
 * Data source: NASA/JPL Horizons ephemeris for "Artemis II (spacecraft)",
 * SPK ID -1024 (post-flight reconstruction from NASA/JSC navigation OEMs).
 * The SPK spans ICPS separation (MET 3h24m) through just before entry
 * interface (Apr 10 23:51 TDB), so two ends are reconstructed here with the
 * same two-body machinery the EFT-1 profile used:
 *
 *   - MET 0 -> SPK start: shaped ascent envelope + conic chain through the
 *     documented burns (ICPS perigee raise @ 49:50, apogee raise @ 1:47:57),
 *     each conic anchored by BACKWARD Kepler propagation from the first real
 *     SPK state, so the seam is exact.
 *   - SPK end -> splashdown: ballistic continuation to entry interface
 *     (122 km), then a shaped skip-entry envelope hitting the documented
 *     chute altitudes (11 / 7.6 / 2.9 km) and the real splashdown time.
 *
 * Everything else between the seams is untouched Horizons data. The output
 * is a static JSON module — the web app never calls any API at runtime.
 *
 * Flown event times (MET) come from the Horizons -1024 object page
 * ("MAJOR EVENTS", revised 2026-Apr-20), which lists the as-flown timeline.
 *
 * Scene frame: J2000 Earth-equatorial (ICRF) mapped x=X, y=Z, z=-Y (y = north
 * pole, right-handed), in km. The client scales km -> scene units (1/1000).
 * Ground alignment is done by spinning the Earth MESH (real sidereal rate,
 * phased so the pad sits over Florida at liftoff) — the data stays inertial.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, ".artemis2-cache");
const OUT = join(HERE, "..", "lib", "artemis2.json");
const REFETCH = process.argv.includes("--refetch");

const MU = 398600.4418; // Earth GM, km^3/s^2
const R = 6371; // Earth mean radius, km (matches the scene's Earth)
const R_MOON = 1737.4;

// Launch: 2026-04-01 22:35:12 UTC. Horizons vector epochs are TDB;
// TDB-UTC = 32.184 + 37 leap seconds = 69.184 s in 2026.
const LAUNCH_UTC_MS = Date.UTC(2026, 3, 1, 22, 35, 12);
const TDB_MINUS_UTC = 69.184;
const LAUNCH_JD_TDB = LAUNCH_UTC_MS / 86400000 + 2440587.5 + TDB_MINUS_UTC / 86400;

// Flown MET timeline (seconds), Horizons -1024 object page.
export const EV = {
  PRM: 2990, // 0/00:49:50 ICPS perigee raise (2223 x 185 km)
  ARB: 6477, // 0/01:47:57 ICPS apogee raise  (70,377 km apogee)
  ICPS_SEP: 12258, // 0/03:24:18
  SM_PRB: 46500, // 0/12:55 Orion SM perigee raise burn
  TLI: 90840, // 1/01:14, 5m55s, dv 388 m/s
  TLI_END: 91195,
  LUNAR_SOI: 371012, // 4/07:03:32, 62,800 km from Moon center
  FLYBY: 433560, // 5/00:26, closest approach 8,282 km from Moon center
  MAX_DIST: 433800, // 5/00:30, 413,146.2 km from Earth center
  SOI_EXIT: 496020, // 5/17:47
  CMSM_SEP: 781080, // 9/00:58
  ENTRY: 782280, // 9/01:18, entry interface 122 km
  SPLASH: 783135, // 9/01:32:15 -> Apr 11 00:07:27 UTC (9d 01:32:15)
};

// Reconstructed ascent timeline (SLS Block 1, Artemis-I-like ascent shape).
const T_MAXQ = 72;
const T_SRB_SEP = 132;
const T_STAGE_SEP = 495;

/* ------------------------------------------------------------ vec utils -- */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => Math.sqrt(dot(a, a));
const unit = (a) => mul(a, 1 / norm(a));

/* --------------------------------------------- universal Kepler (Curtis) -- */

function stumpffC(z) {
  if (z > 1e-8) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-8) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5;
}
function stumpffS(z) {
  if (z > 1e-8) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-8) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6;
}

/** Two-body propagation of state (r0,v0) by dt seconds (dt may be negative). */
function kepler(r0v, v0v, dt) {
  if (dt === 0) return { r: [...r0v], v: [...v0v] };
  const r0 = norm(r0v);
  const v0 = norm(v0v);
  const vr0 = dot(r0v, v0v) / r0;
  const alpha = 2 / r0 - (v0 * v0) / MU; // 1/a
  const sqmu = Math.sqrt(MU);
  let chi = Math.abs(alpha) > 1e-10 ? sqmu * Math.abs(alpha) * dt : (sqmu * dt) / r0;
  for (let i = 0; i < 60; i++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z);
    const S = stumpffS(z);
    const F =
      ((r0 * vr0) / sqmu) * chi * chi * C + (1 - alpha * r0) * chi * chi * chi * S + r0 * chi - sqmu * dt;
    const dF =
      ((r0 * vr0) / sqmu) * chi * (1 - z * S) + (1 - alpha * r0) * chi * chi * C + r0;
    const step = F / dF;
    chi -= step;
    if (Math.abs(step) < 1e-9) break;
  }
  const z = alpha * chi * chi;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const f = 1 - ((chi * chi) / r0) * C;
  const g = dt - (chi * chi * chi * S) / sqmu;
  const rv = add(mul(r0v, f), mul(v0v, g));
  const rn = norm(rv);
  const fdot = (sqmu / (rn * r0)) * chi * (z * S - 1);
  const gdot = 1 - ((chi * chi) / rn) * C;
  return { r: rv, v: add(mul(r0v, fdot), mul(v0v, gdot)) };
}

/* ------------------------------------------------------ Horizons fetches -- */

async function horizons(params, cacheName) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, cacheName + ".txt");
  if (!REFETCH && existsSync(file)) return readFileSync(file, "utf8");
  const qs = new URLSearchParams({
    format: "text",
    OBJ_DATA: "NO",
    MAKE_EPHEM: "YES",
    EPHEM_TYPE: "VECTORS",
    CENTER: "500@399",
    VEC_TABLE: "2",
    REF_PLANE: "FRAME",
    CSV_FORMAT: "YES",
    OUT_UNITS: "KM-S",
    ...params,
  });
  const url = "https://ssd.jpl.nasa.gov/api/horizons.api?" + qs.toString();
  process.stdout.write(`fetch ${cacheName} ... `);
  // Horizons dislikes parallel hits; retry politely on 503.
  let text = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      text = await res.text();
      break;
    }
    if (attempt === 4) throw new Error(`Horizons HTTP ${res.status} for ${cacheName}`);
    await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
  }
  if (!text.includes("$$SOE")) throw new Error(`No data block in ${cacheName}:\n${text.slice(0, 400)}`);
  writeFileSync(file, text);
  console.log("ok");
  return text;
}

/** Parse a CSV vector table into [{t (MET s), r:[..], v:[..]}]. */
function parseVectors(text) {
  const body = text.split("$$SOE")[1].split("$$EOE")[0].trim();
  const out = [];
  for (const line of body.split("\n")) {
    const c = line.split(",").map((s) => s.trim());
    if (c.length < 8) continue;
    const jd = parseFloat(c[0]);
    const t = (jd - LAUNCH_JD_TDB) * 86400;
    out.push({
      t,
      r: [parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4])],
      v: [parseFloat(c[5]), parseFloat(c[6]), parseFloat(c[7])],
    });
  }
  return out;
}

/* ---------------------------------------------------------------- main -- */

const cosEase = (a, b, f) => a + ((b - a) * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, f))))) / 2;

/** Piecewise-cosine interpolation through [t, value] nodes. */
function envelope(nodes) {
  return (t) => {
    if (t <= nodes[0][0]) return nodes[0][1];
    for (let i = 0; i < nodes.length - 1; i++) {
      const [t0, v0] = nodes[i];
      const [t1, v1] = nodes[i + 1];
      if (t <= t1) return cosEase(v0, v1, (t - t0) / (t1 - t0));
    }
    return nodes[nodes.length - 1][1];
  };
}

async function main() {
  // --- 1. Fetch -------------------------------------------------------------
  // Windows in TDB. SPK coverage: 2026-Apr-02 01:59 -> Apr-10 23:51 TDB.
  // Sequential: Horizons 503s under parallel load.
  const wHeo = await horizons({ COMMAND: "'-1024'", START_TIME: "'2026-04-02 02:00'", STOP_TIME: "'2026-04-03 01:00'", STEP_SIZE: "'1m'" }, "sc-heo");
  const wOut = await horizons({ COMMAND: "'-1024'", START_TIME: "'2026-04-03 01:00'", STOP_TIME: "'2026-04-06 17:00'", STEP_SIZE: "'20m'" }, "sc-outbound");
  const wFly = await horizons({ COMMAND: "'-1024'", START_TIME: "'2026-04-06 17:00'", STOP_TIME: "'2026-04-07 06:00'", STEP_SIZE: "'2m'" }, "sc-flyby");
  const wRet = await horizons({ COMMAND: "'-1024'", START_TIME: "'2026-04-07 06:00'", STOP_TIME: "'2026-04-10 21:00'", STEP_SIZE: "'20m'" }, "sc-return");
  const wEnd = await horizons({ COMMAND: "'-1024'", START_TIME: "'2026-04-10 21:00'", STOP_TIME: "'2026-04-10 23:51'", STEP_SIZE: "'1m'" }, "sc-endgame");
  const wMoon = await horizons({ COMMAND: "'301'", START_TIME: "'2026-04-01 22:00'", STOP_TIME: "'2026-04-11 01:00'", STEP_SIZE: "'1h'" }, "moon");

  const sc = [];
  for (const text of [wHeo, wOut, wFly, wRet, wEnd]) {
    for (const s of parseVectors(text)) {
      if (!sc.length || s.t > sc[sc.length - 1].t + 0.5) sc.push(s);
    }
  }
  const moon = parseVectors(wMoon);
  console.log(`spacecraft samples: ${sc.length}, moon samples: ${moon.length}`);
  console.log(`SPK MET span: ${sc[0].t.toFixed(1)} .. ${sc[sc.length - 1].t.toFixed(1)} s`);

  // --- 2. Backward conic chain: seam -> ARB -> PRM -> insertion -------------
  const seam = sc[0];

  /**
   * Speed at position r, direction v̂ (impulse: burns only change magnitude),
   * such that the orbit's apsis radius equals rApsis. From h = r·v·cosγ and
   * energy conservation: v² = 2μ(1/r − 1/rA) / (1 − (r·cosγ/rA)²).
   */
  const speedForApsis = (rVec, vHat, rApsis) => {
    const r = norm(rVec);
    const cosG = norm(sub(vHat, mul(unit(rVec), dot(vHat, unit(rVec))))); // |v̂ ⊥ r̂|
    const q = (r * cosG) / rApsis;
    return Math.sqrt((2 * MU * (1 / r - 1 / rApsis)) / (1 - q * q));
  };

  // The real orbit at the seam is ~70,370 x 9 km — the barely-orbital perigee
  // is exactly why the SM perigee raise burn at MET 12:55 existed. Its perigee
  // passage (~MET 1h52m) sits inside the documented 15-minute ARB burn window
  // (burn start 1:47:57), so the cleanest impulse model puts the apogee-raise
  // kick AT that perigee: position and direction stay continuous (tangent
  // handoff), only the speed steps.
  const periVr = (t) => {
    const s = kepler(seam.r, seam.v, t - seam.t);
    return dot(s.r, s.v);
  };
  let lo = EV.ARB - 200;
  let hi = EV.ARB + 600;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (periVr(mid) < 0) lo = mid;
    else hi = mid;
  }
  const T_KISS = (lo + hi) / 2; // real ellipse perigee, ~MET 6,7xx
  const atKiss = kepler(seam.r, seam.v, T_KISS - seam.t);

  // Intermediate orbit (insertion -> ARB): tangent at the kiss point. Its
  // apogee is solved so the ascent hands over at ~155 km — the documented
  // intermediate apogee was 2,223 km; the solve lands nearby. This leg is a
  // representative reconstruction, not tracked data.
  const T_INSERT = 500;
  const insAltFor = (apogeeAlt) => {
    const v = speedForApsis(atKiss.r, unit(atKiss.v), R + apogeeAlt);
    const s = kepler(atKiss.r, mul(unit(atKiss.v), v), T_INSERT - T_KISS);
    return norm(s.r) - R;
  };
  let aLo = 2250;
  let aHi = 4500;
  for (let i = 0; i < 50; i++) {
    const mid = (aLo + aHi) / 2;
    if (insAltFor(mid) < 155) aLo = mid;
    else aHi = mid;
  }
  const APO_INT = (aLo + aHi) / 2;
  const stKiss = {
    r: atKiss.r,
    v: mul(unit(atKiss.v), speedForApsis(atKiss.r, unit(atKiss.v), R + APO_INT)),
  };
  const atIns = kepler(stKiss.r, stKiss.v, T_INSERT - T_KISS);
  console.log(
    `chain: kiss @ MET ${T_KISS.toFixed(0)} s alt ${(norm(atKiss.r) - R).toFixed(1)} km, ` +
      `intermediate apogee ${APO_INT.toFixed(0)} km (documented 2,223)`
  );
  console.log(
    `insertion (recon): MET ${T_INSERT} s, alt ${(norm(atIns.r) - R).toFixed(1)} km, ` +
      `v ${norm(atIns.v).toFixed(3)} km/s, ascending ${dot(atIns.r, atIns.v) > 0}`
  );

  // --- 3. Ascent envelope 0 -> T_INSERT ------------------------------------
  const altIns = norm(atIns.r) - R;
  const vIns = norm(atIns.v);
  const ascentAlt = (t) => altIns * (1 - Math.pow(1 - t / T_INSERT, 2.2));
  const ascentSpeed = (t) => 0.05 + (vIns - 0.05) * Math.pow(t / T_INSERT, 1.6);
  const ascentG = (t) => {
    // SLS-flavored: build to ~2.9g before SRB sep, dip, second build, MECO cut.
    if (t < T_SRB_SEP) return 1 + 1.9 * Math.pow(Math.min(1, t / T_SRB_SEP), 2);
    if (t < T_STAGE_SEP) return 0.9 + 2.1 * Math.pow((t - T_SRB_SEP) / (T_STAGE_SEP - T_SRB_SEP), 1.8);
    return 0.7;
  };

  // Track geometry: ascent lives in the insertion orbit plane, ending at the
  // insertion point with the envelope's integrated downrange arc behind it.
  const rHatIns = unit(atIns.r);
  const nHat = unit(cross(atIns.r, atIns.v)); // orbit plane normal
  const tHatIns = unit(cross(nHat, rHatIns)); // in-plane, along-track

  let arc = 0; // integrate downrange angle (same v/R approximation as EFT-1)
  const ascent = [];
  for (let t = 0; t <= T_INSERT; t += 2) {
    ascent.push({ t, arc, alt: ascentAlt(t), speed: ascentSpeed(t), g: t === 0 ? 1 : ascentG(t) });
    arc += (ascentSpeed(t) * 2) / R;
  }
  const arcTotal = arc;
  for (const s of ascent) {
    const th = s.arc - arcTotal; // negative: behind the insertion point
    const dir = add(mul(rHatIns, Math.cos(th)), mul(tHatIns, Math.sin(th)));
    s.r = mul(dir, R + s.alt);
  }
  const pad = ascent[0].r;
  const padLatDeg = (Math.asin(pad[2] / norm(pad)) * 180) / Math.PI; // J2000 z = pole
  console.log(`pad (recon): lat ${padLatDeg.toFixed(2)} deg, downrange arc ${(arcTotal * R).toFixed(0)} km`);

  // --- 4. Conic samples T_INSERT -> seam ------------------------------------
  const conic = [];
  const pushConic = (state, t0, t1) => {
    for (let t = t0; t < t1; t += t1 - t0 > 3000 ? 20 : 10) {
      const s = kepler(state.r, state.v, t - t0);
      conic.push({ t, r: s.r, speed: norm(s.v), g: 0 });
    }
  };
  // Intermediate ellipse to the kiss, then the real ellipse to the SPK start.
  pushConic({ r: atIns.r, v: atIns.v }, T_INSERT + 10, T_KISS);
  pushConic({ r: atKiss.r, v: atKiss.v }, T_KISS, seam.t);

  // Seam continuity check: last conic step vs first SPK sample.
  const lastConic = kepler(atKiss.r, atKiss.v, seam.t - T_KISS);
  const seamGap = norm(sub(lastConic.r, seam.r));
  console.log(`seam gap at SPK start: ${seamGap.toFixed(2)} km (should be ~0)`);

  // --- 5. Entry tail: last SPK state -> EI -> splashdown --------------------
  const last = sc[sc.length - 1];
  // Ballistic continuation to the 122 km entry-interface crossing.
  let tEI = last.t;
  let stEI = { r: last.r, v: last.v };
  for (let i = 0; i < 400; i++) {
    if (norm(stEI.r) - R <= 122) break;
    tEI += 1;
    stEI = kepler(last.r, last.v, tEI - last.t);
  }
  const vEI = norm(stEI.v);
  console.log(
    `EI (recon): MET ${tEI.toFixed(0)} s (documented ${EV.ENTRY}), v ${vEI.toFixed(2)} km/s, ` +
      `alt at SPK end ${(norm(last.r) - R).toFixed(1)} km`
  );

  // Skip-entry envelope (Orion flies a skip to reach the San Diego zone).
  // Nodes shaped to the documented beats: chute altitudes 11 / 7.6 / 2.9 km,
  // splashdown at the real MET. Times normalized to the actual EI->splash span.
  const dur = EV.SPLASH - tEI;
  const k = dur / 867;
  const nAlt = envelope([
    [0, 122], [120 * k, 62], [260 * k, 94], [430 * k, 55], [560 * k, 25],
    [700 * k, 11], [730 * k, 7.6], [790 * k, 2.9], [dur, 0],
  ]);
  const nSpeed = envelope([
    [0, vEI], [120 * k, 8.1], [260 * k, 7.6], [430 * k, 4.2], [560 * k, 1.1],
    [700 * k, 0.32], [730 * k, 0.14], [790 * k, 0.1], [dur, 0],
  ]);
  const entryG = (te) => {
    const bell = (p, s, a) => a * Math.exp(-Math.pow((te - p) / s, 2));
    // Twin heating pulses of the skip, then chute jerks.
    return Math.max(
      bell(135 * k, 48 * k, 4.1), bell(470 * k, 65 * k, 3.0),
      bell(732 * k, 9, 2.2), bell(792 * k, 9, 1.7),
      te >= dur ? 1 : 0.15
    );
  };

  const rHatEI = unit(stEI.r);
  const tHatEI = unit(sub(stEI.v, mul(rHatEI, dot(stEI.v, rHatEI)))); // horizontal track dir
  const entry = [];
  let earc = 0;
  for (let te = 0; te <= dur; te += 2) {
    entry.push({ t: tEI + te, arc: earc, alt: nAlt(te), speed: nSpeed(te), g: entryG(te) });
    earc += (nSpeed(te) * 2) / R;
  }
  if (entry[entry.length - 1].t < EV.SPLASH) {
    entry.push({ t: EV.SPLASH, arc: earc, alt: 0, speed: 0, g: 1 });
  }
  for (const s of entry) {
    const dir = add(mul(rHatEI, Math.cos(s.arc)), mul(tHatEI, Math.sin(s.arc)));
    s.r = mul(dir, R + s.alt);
  }
  console.log(`entry downrange (recon): ${(earc * R).toFixed(0)} km over ${dur.toFixed(0)} s`);

  // --- 6. Merge + downsample ------------------------------------------------
  /** samples: {t, r, speed, g} */
  const merged = [];
  const pushRow = (t, r, speed, g) => merged.push({ t, r, speed, g });
  pushRow(-10, ascent[0].r, 0, 1); // pad hold for the countdown
  for (const s of ascent) pushRow(s.t, s.r, s.speed, s.g);
  for (const s of conic) pushRow(s.t, s.r, s.speed, s.g);
  for (const s of sc) {
    if (s.t <= T_INSERT || s.t >= tEI) continue;
    pushRow(s.t, s.r, norm(s.v), 0);
  }
  for (const s of entry) pushRow(s.t, s.r, s.speed, s.g);
  merged.sort((a, b) => a.t - b.t);

  // Adaptive keep: turn angle of the position-delta direction, plus a time cap.
  const kept = [merged[0]];
  let lastDir = null;
  for (let i = 1; i < merged.length - 1; i++) {
    const prev = kept[kept.length - 1];
    const cur = merged[i];
    const d = sub(cur.r, prev.r);
    const dn = norm(d);
    const dir = dn > 1e-6 ? mul(d, 1 / dn) : lastDir;
    const dt = cur.t - prev.t;
    const inDynamic = cur.t < T_INSERT + 60 || cur.t > tEI - 60; // keep ascent/entry dense
    let turn = 0;
    if (dir && lastDir) turn = Math.acos(Math.min(1, Math.max(-1, dot(dir, lastDir))));
    const keep =
      inDynamic ||
      dt >= 1150 ||
      turn > (2.0 * Math.PI) / 180 ||
      Math.abs(cur.speed - prev.speed) > 0.12;
    if (keep) {
      kept.push(cur);
      if (dir) lastDir = dir;
    }
  }
  kept.push(merged[merged.length - 1]);
  console.log(`samples: merged ${merged.length} -> kept ${kept.length}`);

  // --- 7. Scene mapping + Earth spin phase ----------------------------------
  // J2000 (X,Y,Z) -> scene (X, Z, -Y): y-up = north pole, right-handed.
  const toScene = (r) => [r[0], r[2], -r[1]];
  const padScene = toScene(pad);
  const padSceneLon = Math.atan2(-padScene[2], padScene[0]); // texture convention
  const PAD_GEO_LON = (-80.6 * Math.PI) / 180;
  const earthPhase0 = padSceneLon - PAD_GEO_LON; // mesh yaw at MET 0
  const earthOmega = (2 * Math.PI) / 86164.0905; // sidereal rate, rad/s

  // --- 8. Validate ----------------------------------------------------------
  const moonAt = (t) => {
    let i = 0;
    while (i < moon.length - 2 && moon[i + 1].t <= t) i++;
    const f = (t - moon[i].t) / (moon[i + 1].t - moon[i].t);
    return add(mul(moon[i].r, 1 - f), mul(moon[i + 1].r, f));
  };
  let minMoon = Infinity;
  let minMoonT = 0;
  let maxEarth = 0;
  let maxEarthT = 0;
  let bad = 0;
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (![s.t, s.speed, s.g, ...s.r].every(Number.isFinite)) bad++;
    if (i > 0 && s.t <= kept[i - 1].t) bad++;
    const dMoon = norm(sub(s.r, moonAt(s.t)));
    if (dMoon < minMoon) {
      minMoon = dMoon;
      minMoonT = s.t;
    }
    const dE = norm(s.r);
    if (dE > maxEarth) {
      maxEarth = dE;
      maxEarthT = s.t;
    }
  }
  const end = kept[kept.length - 1];
  console.log(`validate: bad rows ${bad}`);
  console.log(
    `  min Moon-center distance ${minMoon.toFixed(0)} km at MET ${minMoonT.toFixed(0)} ` +
      `(documented 8,282 km @ ${EV.FLYBY}) -> altitude ${(minMoon - R_MOON).toFixed(0)} km`
  );
  console.log(
    `  max Earth-center distance ${maxEarth.toFixed(0)} km at MET ${maxEarthT.toFixed(0)} ` +
      `(documented 413,146 km @ ${EV.MAX_DIST})`
  );
  console.log(`  final: alt ${(norm(end.r) - R).toFixed(2)} km, speed ${end.speed.toFixed(3)} km/s`);
  if (bad) throw new Error("validation failed: non-finite or non-monotonic rows");

  // --- 9. Write -------------------------------------------------------------
  const r2 = (x) => Math.round(x * 100) / 100;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const json = {
    meta: {
      mission: "ARTEMIS II",
      source: "NASA/JPL Horizons ephemeris, spacecraft -1024 (Artemis II / Integrity)",
      sourceNote:
        "Geocentric ICRF state vectors from the post-flight NASA/JSC navigation solution. " +
        "Ascent (MET < 3h24m) and entry (final ~17 min) reconstructed from published event " +
        "times with two-body conics + shaped envelopes; seams anchored to the real states.",
      generated: new Date().toISOString(),
      launchUTC: "2026-04-01T22:35:12Z",
      splashUTC: "2026-04-11T00:07:27Z",
      frame: "J2000 Earth-equatorial mapped to scene axes (x=X, y=Z, z=-Y), km",
      events: {
        ...EV,
        MAXQ: T_MAXQ,
        SRB_SEP: T_SRB_SEP,
        STAGE_SEP: T_STAGE_SEP,
        INSERT: T_INSERT,
        EI_RECON: Math.round(tEI),
        PEAK_HEAT: Math.round(tEI + 135 * k),
        SKIP: Math.round(tEI + 260 * k),
        CHUTES: Math.round(tEI + 730 * k),
      },
      stats: {
        flybyAltKm: Math.round(minMoon - R_MOON),
        flybyMoonCenterKm: Math.round(minMoon),
        maxEarthKm: Math.round(maxEarth),
        entrySpeedKms: r4(vEI),
        samples: kept.length,
      },
      earthPhase0: r4(earthPhase0),
      earthOmega,
    },
    sc: {
      t: kept.map((s) => Math.round(s.t * 10) / 10),
      pos: kept.flatMap((s) => toScene(s.r).map(r2)),
      speed: kept.map((s) => r4(s.speed)),
      g: kept.map((s) => Math.round(s.g * 1000) / 1000),
    },
    moon: {
      t: moon.map((s) => Math.round(s.t)),
      pos: moon.flatMap((s) => toScene(s.r).map((x) => Math.round(x))),
    },
  };
  writeFileSync(OUT, JSON.stringify(json));
  const kb = (JSON.stringify(json).length / 1024).toFixed(0);
  console.log(`wrote ${OUT} (${kb} KB, ${kept.length} samples)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
