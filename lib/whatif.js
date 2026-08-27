/**
 * TLI what-if: simplified two-body Kepler propagation for the press-and-hold
 * burn. Cut the real 5m55s translunar injection early (or hold it late) and
 * this computes the orbit you would actually be stranded on, from the flown
 * state vector at the moment of cutoff — vis-viva energy, eccentricity
 * vector, conic sampled point by point for the ghost line.
 *
 * Honesty label, load-bearing: this is EARTH TWO-BODY ONLY. No lunar
 * gravity, no SM propellant model beyond an average-thrust estimate derived
 * from the flown ephemeris itself. It exists to show *roughly* what an
 * off-nominal cutoff costs, next to the real flown line. The UI must say so.
 */
import { stateAt, moonPosAt, EV } from "./mission";

const MU = 398600.4418; // km^3/s^2, Earth
const R_EARTH = 6371;

/** Position (km) and velocity (km/s) vectors from the flown table at met. */
function flownRV(met) {
  const s = stateAt(met);
  const prev = stateAt(met - 6);
  let dx = s.x - prev.x;
  let dy = s.y - prev.y;
  let dz = s.z - prev.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl;
  dy /= dl;
  dz /= dl;
  return {
    r: [s.x * 1000, s.y * 1000, s.z * 1000],
    v: [dx * s.speed, dy * s.speed, dz * s.speed],
  };
}

function energyAt(met) {
  const s = stateAt(met);
  const r = Math.hypot(s.x, s.y, s.z) * 1000;
  return (s.speed * s.speed) / 2 - MU / r;
}

/**
 * Average thrust acceleration of the flown TLI, recovered from the table:
 * d(energy)/dt = a_thrust * v for a prograde burn, so
 * a = delta-energy / integral(v dt). ~1e-3 km/s^2 for the AJ10 + stack.
 */
function tliThrustAccel() {
  const dE = energyAt(EV.TLI_END) - energyAt(EV.TLI);
  let vInt = 0;
  const dt = 5;
  let last = stateAt(EV.TLI).speed;
  for (let t = EV.TLI + dt; t <= EV.TLI_END; t += dt) {
    const v = stateAt(t).speed;
    vInt += ((last + v) / 2) * dt;
    last = v;
  }
  return dE / vInt;
}

const A_THRUST = tliThrustAccel();

/** Max seconds the hold may run past the documented cutoff (propellant). */
export const TLI_MAX_OVER = 45;

/**
 * The flown injection's own osculating two-body apogee at cutoff. This — not
 * the Moon's raw distance — is the honest yardstick for the what-if: the
 * real trajectory rides lunar gravity the rest of the way out (three-body
 * help this model deliberately does not include), so a what-if is judged by
 * how far its injection energy falls from the energy the mission actually
 * flew.
 */
let FLOWN_RA = null;

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * Ghost trajectory + verdict for a burn that cut off at `cutoffMet`.
 * Early cutoff reads the flown state mid-burn; late cutoff integrates the
 * overburn seconds of extra prograde thrust past the flown end state.
 * Returns { pts, closed, verdict, frame } — pts in scene units.
 */
function osculating(cutoffMet) {
  let r, v;
  const over = Math.max(0, cutoffMet - EV.TLI_END);
  if (over <= 0.01) {
    ({ r, v } = flownRV(cutoffMet));
  } else {
    ({ r, v } = flownRV(EV.TLI_END));
    // Semi-implicit Euler, 0.25 s steps: gravity + average prograde thrust.
    const dt = 0.25;
    for (let t = 0; t < over; t += dt) {
      const rm = norm(r);
      const vm = norm(v) || 1;
      const g = -MU / (rm * rm * rm);
      v[0] += (g * r[0] + (A_THRUST * v[0]) / vm) * dt;
      v[1] += (g * r[1] + (A_THRUST * v[1]) / vm) * dt;
      v[2] += (g * r[2] + (A_THRUST * v[2]) / vm) * dt;
      r[0] += v[0] * dt;
      r[1] += v[1] * dt;
      r[2] += v[2] * dt;
    }
  }

  const rm = norm(r);
  const vm = norm(v);
  const energy = (vm * vm) / 2 - MU / rm;
  const h = cross(r, v);
  const hm = norm(h);
  const rHat = [r[0] / rm, r[1] / rm, r[2] / rm];
  const vxh = cross(v, h);
  const eVec = [vxh[0] / MU - rHat[0], vxh[1] / MU - rHat[1], vxh[2] / MU - rHat[2]];
  const e = norm(eVec);
  const p = (hm * hm) / MU;
  const hyperbolic = energy >= 0 || e >= 1;
  const a = -MU / (2 * energy); // negative for hyperbolic
  const raKm = hyperbolic ? Infinity : a * (1 + e);
  return { r, v, e, eVec, p, a, hm, h, rHat, energy, hyperbolic, raKm, over };
}

export function computeWhatIf(cutoffMet) {
  const osc = osculating(cutoffMet);
  const { r, v, e, eVec, p, a, hm, h, rHat, hyperbolic, raKm, over } = osc;
  if (FLOWN_RA == null) FLOWN_RA = osculating(EV.TLI_END).raKm;

  // Orbit-plane basis from periapsis direction and h.
  const hHat = [h[0] / hm, h[1] / hm, h[2] / hm];
  let ep;
  if (e > 1e-8) ep = [eVec[0] / e, eVec[1] / e, eVec[2] / e];
  else ep = rHat;
  const eq = cross(hHat, ep);

  // True anomaly now (sign from the radial velocity).
  let th0 = Math.acos(Math.max(-1, Math.min(1, dot(ep, rHat))));
  if (dot(r, v) < 0) th0 = -th0;

  const pts = [];
  const N = 420;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const push = (th) => {
    const rr = p / (1 + e * Math.cos(th));
    if (rr <= 0 || rr > 900000) return false;
    const x = (rr * (Math.cos(th) * ep[0] + Math.sin(th) * eq[0])) / 1000;
    const y = (rr * (Math.cos(th) * ep[1] + Math.sin(th) * eq[1])) / 1000;
    const z = (rr * (Math.cos(th) * ep[2] + Math.sin(th) * eq[2])) / 1000;
    pts.push(x, y, z);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
    return true;
  };

  let closed = false;
  if (!hyperbolic) {
    for (let i = 0; i <= N; i++) push(th0 + (i / N) * Math.PI * 2);
    closed = true;
  } else {
    const thInf = Math.acos(-1 / e);
    const span = Math.max(0.05, thInf - 0.06 - th0);
    for (let i = 0; i <= N; i++) if (!push(th0 + (i / N) * span)) break;
  }

  // Frame the reveal: ghost + Earth + the Moon it does (or doesn't) reach.
  const moon = moonPosAt(cutoffMet, [0, 0, 0]);
  minX = Math.min(minX, -7, moon[0]);
  minY = Math.min(minY, -7, moon[1]);
  minZ = Math.min(minZ, -7, moon[2]);
  maxX = Math.max(maxX, 7, moon[0]);
  maxY = Math.max(maxY, 7, moon[1]);
  maxZ = Math.max(maxZ, 7, moon[2]);
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
    20
  );
  // Orbit-plane normal, for framing the reveal face-on.
  const normal = hHat[1] >= 0 ? hHat : [-hHat[0], -hHat[1], -hHat[2]];

  // Verdict against the flown injection's own two-body apogee (see FLOWN_RA).
  const cutoffDelta = Math.round(EV.TLI_END - cutoffMet); // + early, - late
  const diffKm = hyperbolic ? Infinity : raKm - FLOWN_RA;
  let kind;
  if (hyperbolic) kind = "escape";
  else if (diffKm < -20000) kind = "short";
  else if (diffKm > 20000) kind = "hot";
  else kind = "corridor";

  return {
    pts: new Float32Array(pts),
    closed,
    frame: { center, radius, normal },
    verdict: {
      kind,
      cutoffDelta,
      overSec: Math.round(over),
      raKm: hyperbolic ? null : Math.round(raKm),
      perigeeKm: hyperbolic ? null : Math.round(a * (1 - e) - R_EARTH),
      flownRaKm: Math.round(FLOWN_RA),
      diffKm: hyperbolic ? null : Math.round(diffKm),
    },
  };
}
