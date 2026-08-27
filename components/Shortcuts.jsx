"use client";

import { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useMission } from "@/lib/store";
import { useInspect } from "@/lib/inspect";

const WARP_KEYS = { Digit1: 1, Digit2: 60, Digit3: 1000, Digit4: 25000 };
const CAM_CYCLE = ["chase", "orbit", "pov"];

const ROWS = [
  ["SPACE", "PLAY / PAUSE"],
  ["HOLD SPACE", "EXECUTE TLI (WHEN ARMED)"],
  ["← →", "SCRUB ±60 S"],
  ["SHIFT ← →", "SCRUB ±1 H"],
  ["1 · 2 · 3 · 4", "WARP 1× · 60× · 1K× · 25K×"],
  ["A", "WARP AUTO"],
  ["C", "CYCLE CAMERA (CHASE · ORBIT · POV)"],
  ["?", "THIS OVERLAY"],
  ["ESC", "CLOSE / DISMISS"],
];

/**
 * Global keyboard control. The TLI hold registers its own capture-phase
 * Space handlers and stops propagation while armed or burning, so this
 * layer never fights the burn. Arrow keys defer to the focused scrubber
 * (it has its own finer/coarser seek), and everything defers to typing
 * contexts — there are none today, but cheap insurance outlives cheap
 * assumptions.
 */
export default function Shortcuts() {
  const helpOpen = useMission((s) => s.helpOpen);

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
      )
        return;
      const st = useMission.getState();
      if (!st.booted) return;

      if (e.key === "?") {
        e.preventDefault();
        st.setHelpOpen(!st.helpOpen);
        return;
      }
      if (e.code === "Escape") {
        if (st.helpOpen) {
          e.preventDefault();
          st.setHelpOpen(false);
        } else if (useInspect.getState().pinned) {
          useInspect.getState().setPinned(null);
        } else if (st.tli.mode === "ghost") {
          st.tliResume();
        }
        return;
      }
      if (st.helpOpen) return; // overlay swallows the rest

      switch (e.code) {
        case "Space":
          e.preventDefault();
          st.togglePlay();
          break;
        case "ArrowRight":
        case "ArrowLeft": {
          if (t && t.closest && t.closest('[role="slider"]')) return; // scrubber owns focus
          e.preventDefault();
          const step = (e.shiftKey ? 3600 : 60) * (e.code === "ArrowRight" ? 1 : -1);
          st.seek(st.met + step);
          break;
        }
        case "KeyA":
          st.setWarp("auto");
          break;
        case "KeyC": {
          const i = CAM_CYCLE.indexOf(st.camMode);
          st.setCamMode(CAM_CYCLE[(i + 1) % CAM_CYCLE.length]);
          break;
        }
        default:
          if (e.code in WARP_KEYS) st.setWarp(WARP_KEYS[e.code]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <AnimatePresence>
      {helpOpen && (
        <motion.div
          className="hud-help"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          onClick={() => useMission.getState().setHelpOpen(false)}
          role="dialog"
          aria-label="Keyboard shortcuts"
        >
          <div className="hud-help-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="hud-help-title">CONSOLE SHORTCUTS</h3>
            <table className="hud-help-table">
              <tbody>
                {ROWS.map(([k, v]) => (
                  <tr key={k}>
                    <td className="hud-help-key">{k}</td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="hud-btn hud-help-close" onClick={() => useMission.getState().setHelpOpen(false)}>
              ESC · CLOSE
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
