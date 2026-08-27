"use client";

import { memo, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  PHASES,
  T_START,
  T_END,
  EV,
  STATS,
  ENTRY_PHASE_IDX,
  stateAt,
  phaseIndexAt,
  formatMET,
  formatKm,
} from "@/lib/mission";
import { useMission } from "@/lib/store";

const SPAN = T_END - T_START;

/**
 * The mission clock updates every animation frame, but re-rendering the whole
 * HUD at 60 fps starves the GPU thread on weak machines. 10 Hz is
 * indistinguishable for text, and a trailing update guarantees the final
 * value lands after a pause or seek.
 */
function useThrottledMet(ms = 100) {
  const [met, setMet] = useState(() => useMission.getState().met);
  useEffect(() => {
    let last = 0;
    let timer = null;
    const apply = () => {
      last = performance.now();
      timer = null;
      setMet(useMission.getState().met);
    };
    const unsub = useMission.subscribe(() => {
      const now = performance.now();
      if (now - last >= ms) apply();
      else if (!timer) timer = setTimeout(apply, ms - (now - last));
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [ms]);
  return met;
}

/* ------------------------------------------------------------- Top bar -- */

function TopBar({ met }) {
  return (
    <header className="hud-top">
      <div className="hud-id">
        <span className="hud-id-main">ORION · TRAJECTORY DISPLAY</span>
        <span className="hud-id-sub">ARTEMIS II REPLAY // JPL HORIZONS EPHEMERIS</span>
      </div>
      <div className="hud-clock" aria-label="Mission elapsed time">
        {formatMET(met)}
      </div>
      <nav className="hud-links">
        <a
          className="hud-link"
          href="https://github.com/Markpelico/orion-trajectory-display"
          target="_blank"
          rel="noreferrer"
        >
          SOURCE ↗
        </a>
        <a className="hud-link" href="https://www.markpelico.com" target="_blank" rel="noreferrer">
          MARKPELICO.COM ↗
        </a>
      </nav>
    </header>
  );
}

/* ---------------------------------------------------------- Phase rail -- */

const PhaseRail = memo(function PhaseRail({ phaseIdx }) {
  const seek = useMission((s) => s.seek);
  return (
    <ol className="hud-rail" aria-label="Mission phases">
      {PHASES.map((p, i) => (
        <li key={p.name}>
          <button
            type="button"
            className={
              i === phaseIdx ? "hud-rail-item is-active" : i < phaseIdx ? "hud-rail-item is-past" : "hud-rail-item"
            }
            onClick={() => seek(p.t + 0.01)}
            title={p.plain ? `Jump to ${p.name} — ${p.plain}` : `Jump to ${p.name}`}
          >
            <span className="hud-rail-tick" aria-hidden="true" />
            {p.short}
          </button>
        </li>
      ))}
    </ol>
  );
});

/* ---------------------------------------------------------- Phase slam -- */

const PhaseSlam = memo(function PhaseSlam({ phaseIdx, reducedMotion }) {
  const [shown, setShown] = useState(null);

  useEffect(() => {
    if (phaseIdx < 1) return; // countdown handled separately
    setShown(phaseIdx);
    const id = setTimeout(() => setShown(null), 2400);
    return () => clearTimeout(id);
  }, [phaseIdx]);

  const phase = shown != null ? PHASES[shown] : null;
  const isEntry = shown != null && shown >= ENTRY_PHASE_IDX;

  return (
    <div className="hud-slam" aria-live="polite">
      <AnimatePresence mode="wait">
        {phase && (
          <motion.div
            key={phase.name}
            className="hud-slam-block"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, y: -28, filter: "blur(10px)" }
            }
            transition={{ duration: 0.55, ease: [0.19, 1, 0.22, 1] }}
          >
            <motion.h2
              className={isEntry ? "hud-slam-text is-entry" : "hud-slam-text"}
              initial={
                reducedMotion
                  ? {}
                  : { scale: 1.08, filter: "blur(16px)", letterSpacing: "0.5em" }
              }
              animate={
                reducedMotion
                  ? {}
                  : { scale: 1, filter: "blur(0px)", letterSpacing: "0.14em" }
              }
              transition={{ duration: 0.55, ease: [0.19, 1, 0.22, 1] }}
            >
              {phase.name}
            </motion.h2>
            {phase.plain && (
              <motion.p
                className="hud-slam-plain"
                initial={reducedMotion ? {} : { opacity: 0, y: 10 }}
                animate={reducedMotion ? {} : { opacity: 1, y: 0 }}
                transition={{ delay: 0.16, duration: 0.5, ease: [0.19, 1, 0.22, 1] }}
              >
                {phase.plain}
              </motion.p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/* ----------------------------------------------------------- Countdown -- */

function Countdown({ met }) {
  if (met >= 0) return null;
  const n = Math.ceil(-met);
  return (
    <div className="hud-slam" aria-hidden="true">
      <motion.div
        key={n}
        className="hud-count"
        initial={{ opacity: 0, scale: 1.35 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        {n}
      </motion.div>
    </div>
  );
}

/* ----------------------------------------------------------- Telemetry -- */

function Spark({ history, accent }) {
  const w = 120;
  const h = 26;
  if (history.length < 2) return <svg className="hud-spark" width={w} height={h} />;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;
  const pts = history
    .map((v, i) => `${(i / (history.length - 1)) * w},${h - 2 - ((v - min) / range) * (h - 4)}`)
    .join(" ");
  return (
    <svg className="hud-spark" width={w} height={h} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={accent ? "#fc3d21" : "#8fa3c8"} strokeWidth="1" />
    </svg>
  );
}

function Telemetry({ s }) {
  // Rolling history, pushed at ~5 Hz wall clock — the web echo of the
  // desktop tool's rolling matplotlib panels.
  const hist = useRef({ alt: [], speed: [], moon: [], g: [], last: 0 });
  const now = performance.now();
  if (now - hist.current.last > 200) {
    hist.current.last = now;
    const push = (arr, v) => {
      arr.push(v);
      if (arr.length > 120) arr.shift();
    };
    push(hist.current.alt, s.alt);
    push(hist.current.speed, s.speed);
    push(hist.current.moon, s.rangeMoon);
    push(hist.current.g, s.g);
  }

  const cards = [
    {
      // The same number wears two hats: pad-to-orbit it reads as altitude,
      // in translunar space as distance from Earth's surface.
      label: s.alt >= 10000 ? "EARTH RANGE" : "ALTITUDE",
      value: s.alt >= 1000 ? formatKm(s.alt).toLocaleString() : s.alt.toFixed(1),
      unit: "KM",
      hist: hist.current.alt,
    },
    { label: "VELOCITY", value: s.speed.toFixed(2), unit: "KM/S", hist: hist.current.speed },
    {
      label: "MOON RANGE",
      value: formatKm(s.rangeMoon).toLocaleString(),
      unit: "KM",
      hist: hist.current.moon,
      accent: s.rangeMoon < 20000,
    },
    { label: "G-LOAD", value: s.g.toFixed(1), unit: "G", hist: hist.current.g, accent: s.g > 3 },
  ];

  return (
    <div className="hud-telemetry">
      {cards.map((c) => (
        <div key={c.label} className={c.accent ? "hud-card is-accent" : "hud-card"}>
          <span className="hud-card-label">{c.label}</span>
          <span className="hud-card-value">
            {c.value}
            <span className="hud-card-unit">{c.unit}</span>
          </span>
          {c.hist && <Spark history={c.hist} accent={c.accent} />}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Controls -- */

// Manual presets sized for a nine-day mission: 25,000x runs a coast day in
// about 3.5 seconds.
const WARPS = ["auto", 1, 60, 1000, 25000];
const warpLabel = (w) => (w === "auto" ? "AUTO" : w >= 1000 ? `${w / 1000}K×` : `${w}×`);

function Controls() {
  const warp = useMission((s) => s.warp);
  const camMode = useMission((s) => s.camMode);
  const playing = useMission((s) => s.playing);
  const complete = useMission((s) => s.complete);
  const { setWarp, setCamMode, togglePlay } = useMission.getState();

  return (
    <div className="hud-controls">
      <div className="hud-btn-group" role="group" aria-label="Playback">
        <button className="hud-btn" onClick={togglePlay} disabled={complete}>
          {playing ? "PAUSE" : "PLAY"}
        </button>
      </div>
      <div className="hud-btn-group" role="group" aria-label="Time warp">
        {WARPS.map((w) => (
          <button
            key={w}
            className={warp === w ? "hud-btn is-on" : "hud-btn"}
            onClick={() => setWarp(w)}
          >
            {warpLabel(w)}
          </button>
        ))}
      </div>
      <div className="hud-btn-group" role="group" aria-label="Camera">
        {["chase", "orbit"].map((m) => (
          <button
            key={m}
            className={camMode === m ? "hud-btn is-on" : "hud-btn"}
            onClick={() => setCamMode(m)}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Scrubber -- */

function Scrubber({ met }) {
  const barRef = useRef(null);
  const seek = useMission((s) => s.seek);
  const frac = (met - T_START) / SPAN;

  function seekFromEvent(e) {
    const rect = barRef.current.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(T_START + f * SPAN);
  }

  return (
    <div
      ref={barRef}
      className="hud-scrub"
      role="slider"
      aria-label="Mission time"
      aria-valuemin={T_START}
      aria-valuemax={T_END}
      aria-valuenow={Math.round(met)}
      aria-valuetext={formatMET(met)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromEvent(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && seekFromEvent(e)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") seek(met + SPAN * 0.01);
        if (e.key === "ArrowLeft") seek(met - SPAN * 0.01);
      }}
    >
      <div className="hud-scrub-track">
        <div className="hud-scrub-fill" style={{ width: `${frac * 100}%` }} />
        {PHASES.map((p) => (
          <span
            key={p.name}
            className="hud-scrub-tick"
            style={{ left: `${((p.t - T_START) / SPAN) * 100}%` }}
            title={p.name}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Complete -- */

function Complete() {
  const complete = useMission((s) => s.complete);
  const restart = useMission((s) => s.restart);
  return (
    <AnimatePresence>
      {complete && (
        <motion.div
          className="hud-complete"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6 }}
        >
          <motion.h2
            className="hud-complete-title"
            initial={{ opacity: 0, y: 24, filter: "blur(10px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ delay: 0.25, duration: 0.7, ease: [0.19, 1, 0.22, 1] }}
          >
            SPLASHDOWN
            <br />
            CONFIRMED
          </motion.h2>
          <div className="hud-complete-stats">
            <div>
              <span>LUNAR FLYBY</span>
              <strong>{STATS.flybyAltKm.toLocaleString()} KM</strong>
            </div>
            <div>
              <span>MAX EARTH DISTANCE</span>
              <strong>{STATS.maxEarthKm.toLocaleString()} KM</strong>
            </div>
            <div>
              <span>ENTRY VELOCITY</span>
              <strong>{STATS.entrySpeedKms.toFixed(1)} KM/S</strong>
            </div>
            <div>
              <span>MISSION TIME</span>
              <strong>{formatMET(EV.SPLASH).slice(3)}</strong>
            </div>
          </div>
          <div className="hud-complete-actions">
            <button className="hud-btn is-big" onClick={restart}>
              REPLAY MISSION
            </button>
            <a
              className="hud-btn is-big"
              href="https://github.com/Markpelico/orion-trajectory-display"
              target="_blank"
              rel="noreferrer"
            >
              DESKTOP VERSION ↗
            </a>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------------------------------------------------------------- Root -- */

export default function Hud({ reducedMotion }) {
  const met = useThrottledMet(100);
  const s = stateAt(met);
  const phaseIdx = phaseIndexAt(met);

  return (
    <div className="hud">
      <TopBar met={met} />
      <PhaseRail phaseIdx={phaseIdx} />
      <PhaseSlam phaseIdx={phaseIdx} reducedMotion={reducedMotion} />
      <Countdown met={met} />
      <div className="hud-bottom">
        <Telemetry s={s} />
        <Controls />
        <Scrubber met={met} />
        <p className="hud-note">
          During my NASA internship at Johnson Space Center I built the desktop version of
          this display, streaming live telemetry from a Trick variable server. This web
          replay flies the April 2026 Artemis II mission from the JPL Horizons ephemeris
          of Orion (spacecraft −1024); ascent and the final entry minutes are
          reconstructed from published mission events. Not live or official telemetry.
        </p>
      </div>
      <Complete />
    </div>
  );
}
