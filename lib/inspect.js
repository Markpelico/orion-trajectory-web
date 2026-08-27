import { create } from "zustand";

/**
 * Trajectory inspection state, split from the mission store because hover
 * updates arrive at pointer-move rate and only two small components care:
 * the in-scene crosshair marker and the HTML chip.
 *
 * `hover`  — mouse resting near a sample: { i, px, py } (pointer CSS px).
 * `pinned` — touch tap on a sample: same shape, chip gains a JUMP HERE
 *            button instead of seeking instantly under a finger.
 */
export const useInspect = create((set) => ({
  hover: null,
  pinned: null,
  setHover: (hover) => set({ hover }),
  setPinned: (pinned) => set({ pinned }),
  clear: () => set({ hover: null, pinned: null }),
}));
