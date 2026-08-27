"use client";

import { motion, AnimatePresence } from "motion/react";
import { useMission } from "@/lib/store";

const LINES = [
  "ORION CREW VEHICLE “INTEGRITY” // TRAJECTORY DISPLAY",
  "MISSION ........... ARTEMIS II — CREWED LUNAR FREE-RETURN",
  "CREW .............. WISEMAN · GLOVER · KOCH · HANSEN",
  "FLOWN ............. 2026 APR 01 22:35 UTC → APR 11 00:07 UTC",
  "DATA SOURCE ....... JPL HORIZONS EPHEMERIS (SPACECRAFT -1024)",
  "RECONSTRUCTED ..... ASCENT + ENTRY, FROM PUBLISHED EVENTS",
  "HERITAGE .......... NASA JSC INTERNSHIP TOOLING",
  "ALL SYSTEMS ....... GO FOR REPLAY",
];

export default function Boot() {
  const booted = useMission((s) => s.booted);
  const boot = useMission((s) => s.boot);

  return (
    <AnimatePresence>
      {!booted && (
        <motion.div
          className="boot"
          exit={{ opacity: 0, transition: { duration: 0.7, ease: "easeInOut" } }}
        >
          <div className="boot-inner">
            <motion.pre
              className="boot-lines"
              initial="hidden"
              animate="show"
              variants={{ show: { transition: { staggerChildren: 0.28, delayChildren: 0.4 } } }}
            >
              {LINES.map((line) => (
                <motion.span
                  key={line}
                  className="boot-line"
                  variants={{
                    hidden: { opacity: 0, y: 6 },
                    show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
                  }}
                >
                  {line}
                </motion.span>
              ))}
            </motion.pre>

            <motion.h1
              className="boot-title"
              initial={{ opacity: 0, letterSpacing: "0.6em", filter: "blur(12px)" }}
              animate={{ opacity: 1, letterSpacing: "0.18em", filter: "blur(0px)" }}
              transition={{ delay: 2.2, duration: 1.0, ease: [0.19, 1, 0.22, 1] }}
            >
              ARTEMIS II
            </motion.h1>

            <motion.button
              className="hud-btn is-big boot-btn"
              onClick={boot}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 2.9, duration: 0.5 }}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              INITIATE REPLAY
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
