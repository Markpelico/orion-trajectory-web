/**
 * Deep links: #t=<MET seconds> pins the replay to a moment, #phase=<NAME>
 * pins it to a mission event (EV keys like TLI, FLYBY, or phase-rail short
 * names), and &cam=orbit|pov picks the camera. On load the boot ceremony is
 * skipped and the replay opens paused at that moment — a shareable URL for
 * "look at THIS".
 */
import { EV, PHASES, T_START, T_END } from "./mission";

const CAMS = ["chase", "orbit", "pov"];

export function parseHash(hash) {
  if (!hash || hash.length < 2) return null;
  let params;
  try {
    params = new URLSearchParams(hash.slice(1));
  } catch {
    return null;
  }
  let met = null;
  if (params.has("t")) {
    const v = Number(params.get("t"));
    if (Number.isFinite(v)) met = v;
  } else if (params.has("phase")) {
    const p = (params.get("phase") ?? "").toUpperCase();
    if (Object.prototype.hasOwnProperty.call(EV, p)) met = EV[p] + 0.01;
    else {
      const ph = PHASES.find((x) => x.short === p || x.name === p);
      if (ph) met = ph.t + 0.01;
    }
  }
  if (met == null) return null;
  // Clamp shy of T_END so a stale link never opens onto the completion card.
  met = Math.max(T_START, Math.min(T_END - 1, met));
  const camRaw = params.get("cam");
  return { met, cam: CAMS.includes(camRaw) ? camRaw : null };
}

export function buildHash(met, camMode) {
  const t = Math.round(met);
  return camMode && camMode !== "chase" ? `#t=${t}&cam=${camMode}` : `#t=${t}`;
}
