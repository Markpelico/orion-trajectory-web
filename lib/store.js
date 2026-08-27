import { create } from "zustand";
import { T_START, T_END, EV, phaseIndexAt } from "@/lib/mission";
import { TLI_MAX_OVER } from "@/lib/whatif";

/**
 * Press-and-hold TLI presentation rate: the real burn runs 5m55s; holding
 * compresses it 60:1 so a full-duration hold is just under six real seconds.
 * The UI labels the compression — nothing pretends to be real time.
 */
export const TLI_HOLD_RATE = 60;
export const TLI_ARM_LEAD = 60; // control arms this many mission-seconds before TLI

const tliIdle = { mode: "idle", cutoffMet: null, ghost: null, nominal: false, attempted: false };

/**
 * AUTO warp: real time through the dynamic minutes (launch, burns, flyby,
 * entry), brutally compressed through the multi-day coasts. A 9-day lunar
 * mission plays in about six minutes; scripts/verify-mission.mjs integrates
 * this schedule and prints the exact wall time.
 */
export function autoWarp(t) {
  if (t < 95) return 1; // countdown, liftoff, max q
  if (t < 150) return 4; // SRB sep near-real
  if (t < 470) return 24; // core stage ride
  if (t < 560) return 8; // staging + insertion
  if (t < EV.PRM - 60) return 120; // low-orbit coast
  if (t < EV.PRM + 90) return 20; // ICPS perigee raise
  if (t < EV.ARB - 60) return 150; // climb to the apogee raise
  if (t < 7000) return 30; // ARB through the perigee kiss
  if (t < EV.ICPS_SEP - 100) return 400; // up the big ellipse
  if (t < EV.ICPS_SEP + 150) return 40; // ICPS separation
  if (t < EV.SM_PRB - 120) return 3000; // HEO climb, half a day
  if (t < EV.SM_PRB + 120) return 60; // SM perigee raise burn
  if (t < EV.TLI - 400) return 3000; // HEO lap back to perigee
  if (t < EV.TLI_END + 80) return 24; // TLI burn, 5m55s
  if (t < 100000) return 350; // Earth starts shrinking
  if (t < 360000) return 32000; // outbound coast, 3 days
  if (t < EV.FLYBY - 5500) return 10000; // into the lunar sphere
  if (t < EV.FLYBY + 5500) return 600; // the flyby itself
  if (t < 480000) return 10000; // departing the Moon
  if (t < 778000) return 40000; // return coast, 3.5 days
  if (t < EV.ENTRY - 180) return 900; // approach + CM/SM sep
  if (t < EV.PEAK_HEAT + 240) return 10; // interface, plasma, skip
  return 12; // chutes, splashdown
}

export const useMission = create((set) => ({
  met: T_START,
  playing: false,
  booted: false, // boot overlay dismissed
  complete: false,
  warp: "auto", // "auto" | 1 | 60 | 1000 | 25000
  camMode: "chase", // "chase" | "orbit" | "pov"

  tli: { ...tliIdle },
  helpOpen: false, // "?" shortcuts overlay

  setHelpOpen: (helpOpen) => set({ helpOpen }),
  boot: () => set({ booted: true, playing: true }),
  /** Deep-link entry: skip the boot ceremony, open paused at a moment. */
  bootAt: ({ met, cam }) =>
    set({
      booted: true,
      playing: false,
      met: Math.max(T_START, Math.min(T_END - 1, met)),
      camMode: cam ?? "chase",
      complete: false,
    }),
  setWarp: (warp) => set({ warp }),
  setCamMode: (camMode) => set({ camMode }),
  togglePlay: () =>
    set((s) => {
      if (s.tli.mode === "holding") return s; // release the burn first
      // Pressing play out of a what-if is "resume replay": drop the ghost.
      if (s.tli.mode === "ghost")
        return { playing: true, tli: { ...s.tli, mode: "idle", ghost: null } };
      return { playing: !s.playing };
    }),
  seek: (met) =>
    set((s) => ({
      met: Math.max(T_START, Math.min(T_END, met)),
      complete: met >= T_END,
      // Scrubbing always abandons a hold or a ghost — the what-if must never
      // block the replay. Scrub back before the arming window to re-arm.
      tli: {
        ...s.tli,
        mode: "idle",
        ghost: null,
        nominal: false,
        attempted: s.tli.attempted && met >= EV.TLI - TLI_ARM_LEAD - 30,
      },
    })),
  restart: () => set({ met: T_START, playing: true, complete: false, tli: { ...tliIdle } }),

  /**
   * Arm/hold/cutoff for the interactive TLI. Holding snaps the clock to
   * ignition and burns at TLI_HOLD_RATE regardless of warp; release decides
   * nominal vs ghost in the component (it owns the two-body math).
   */
  tliHold: () =>
    set((s) => {
      if (s.tli.mode !== "idle") return s;
      return {
        met: EV.TLI,
        playing: true,
        tli: { ...s.tli, mode: "holding", attempted: true, nominal: false, ghost: null },
      };
    }),
  tliCutoffNominal: (cutoffMet) =>
    set((s) => ({
      playing: true,
      tli: { ...s.tli, mode: "idle", ghost: null, nominal: true, cutoffMet },
    })),
  tliCutoffGhost: (ghost, cutoffMet) =>
    set((s) => ({
      playing: false,
      tli: { ...s.tli, mode: "ghost", ghost, nominal: false, cutoffMet },
    })),
  tliResume: () =>
    set((s) => ({
      playing: true,
      tli: { ...s.tli, mode: "idle", ghost: null, nominal: false },
    })),
  tliClearNominal: () => set((s) => ({ tli: { ...s.tli, nominal: false } })),

  /** Advance by real dt seconds; applies warp. Called from useFrame. */
  tick: (dt) =>
    set((s) => {
      // Holding the TLI burn drives the clock itself, play/pause aside.
      if (s.tli.mode === "holding") {
        const met = Math.min(s.met + dt * TLI_HOLD_RATE, EV.TLI_END + TLI_MAX_OVER);
        return { met };
      }
      if (!s.playing || s.complete) return s;
      let w = s.warp === "auto" ? autoWarp(s.met) : s.warp;
      // Approaching an armed, untried TLI on AUTO: linger so the control is
      // pressable — ~10 wall seconds through the last minute instead of 2.5.
      if (
        s.warp === "auto" &&
        s.tli.mode === "idle" &&
        !s.tli.attempted &&
        s.met >= EV.TLI - TLI_ARM_LEAD &&
        s.met < EV.TLI
      )
        w = Math.min(w, 6);
      const met = s.met + dt * w;
      if (met >= T_END) return { met: T_END, complete: true, playing: false };
      return { met };
    }),
}));

export const selectPhaseIdx = (s) => phaseIndexAt(s.met);
