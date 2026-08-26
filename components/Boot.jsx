"use client";

import { motion, AnimatePresence } from "motion/react";
import { useMission } from "@/lib/store";

const LINES = [
  "ORION MULTI-PURPOSE CREW VEHICLE",
  "TRAJECTORY DISPLAY // WEB CONSOLE",
  "HERITAGE .......... NASA JSC INTERNSHIP TOOLING",
  "REPLAY PROFILE .... EFT-1 (SIMPLIFIED)",
  "DATA SOURCE ....... COMPUTED STATE VECTORS",
  "TRICK LINK ........ OFFLINE — SEE DESKTOP VERSION",
  "ALL SYSTEMS ....... GO",
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
              ORION
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
