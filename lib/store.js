import { create } from "zustand";
import { T_START, T_END, tEntry, BURN_T, ASCENT_END, phaseIndexAt } from "@/lib/mission";

/**
 * AUTO warp: real-time through the dynamic minutes (launch, burn, entry),
 * compressed through the hours of coast. The whole mission plays in ~6 min.
 */
export function autoWarp(t) {
  if (t < 95) return 1;
  if (t < ASCENT_END - 60) return 12;
  if (t < ASCENT_END + 20) return 4;
  if (t < BURN_T - 45) return 120;
  if (t < BURN_T + 90) return 8;
  if (t < tEntry - 45) return 120;
  if (t < tEntry + 320) return 2;
  return 4;
}

export const useMission = create((set) => ({
  met: T_START,
  playing: false,
  booted: false, // boot overlay dismissed
  complete: false,
  warp: "auto", // "auto" | 1 | 10 | 60 | 300
  camMode: "chase", // "chase" | "orbit"

  boot: () => set({ booted: true, playing: true }),
  setWarp: (warp) => set({ warp }),
  setCamMode: (camMode) => set({ camMode }),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  seek: (met) =>
    set({
      met: Math.max(T_START, Math.min(T_END, met)),
      complete: met >= T_END,
    }),
  restart: () => set({ met: T_START, playing: true, complete: false }),

  /** Advance by real dt seconds; applies warp. Called from useFrame. */
  tick: (dt) =>
    set((s) => {
      if (!s.playing || s.complete) return s;
      const w = s.warp === "auto" ? autoWarp(s.met) : s.warp;
      const met = s.met + dt * w;
      if (met >= T_END) return { met: T_END, complete: true, playing: false };
      return { met };
    }),
}));

export const selectPhaseIdx = (s) => phaseIndexAt(s.met);
