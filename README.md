# Orion Trajectory Display — Artemis II Web Console

Replay the real Artemis II mission in the browser — launch from Kennedy,
translunar injection, a 6,545 km lunar flyby, and an 11 km/s Pacific
reentry — rendered as a real-time 3D mission console.

**Live:** https://orion.markpelico.com — the flyby, one link long:
[orion.markpelico.com/#t=433560](https://orion.markpelico.com/#t=433560)

## What this is

Artemis II (April 1–11, 2026; Wiseman, Glover, Koch, Hansen) flew a crewed
lunar free-return. This console replays it from the **JPL Horizons ephemeris
of spacecraft −1024** — the post-flight NASA/JSC navigation solution — baked
at build time by `scripts/build-artemis2.mjs` into a 1,721-row sample table
(`lib/artemis2.json`). No runtime API calls; the mission ships as static
data. The Moon rides its own baked hourly ephemeris, the Earth spins at the
real sidereal rate phased to put the pad over Florida at liftoff, and the
Sun sits where it sat in April 2026.

**Honest-reconstruction note:** Horizons carries the flown trajectory;
ascent and the final entry minutes are reconstructed from published event
times and tuned to the documented figures. The HUD says so on screen, and
`scripts/verify-mission.mjs` asserts the table against documented anchors
(8,282 km minimum Moon-center distance, 413,146 km max Earth distance,
splashdown at the documented MET) on every change. Not live or official
telemetry.

## The console

- **AUTO time warp** — real time through launch, the burns, the flyby, and
  entry; brutally compressed through the coast days. Nine days in about six
  minutes, or scrub anywhere.
- **Three cameras** — chase, orbit, and a capsule **POV** that looks where
  the crew looked. Around closest approach the POV composes the Earthrise
  the geometry actually serves: Earth slips behind the lunar limb ~18
  minutes before the flyby and rises again ~20 minutes after, Apollo 8
  rerun.
- **Inspect the trajectory** — hover (or tap) any pixel of the line and a
  chip quotes the underlying ephemeris row verbatim: MET, Earth range, Moon
  range, velocity, row number. Click to seek the replay to that instant.
- **Fly the TLI yourself** — an armed HOLD TO EXECUTE TLI control appears a
  minute before the real ignition. Hold it (or Space) to burn the real
  5m55s at a labeled 60×; cut off early or ride into the overburn and a
  **simplified two-body what-if** draws the dashed orbit you'd be stranded
  on next to the flown line, with a verdict card measuring the miss. The
  Moon's gravity is deliberately not modeled and the card says so. Leave it
  alone and AUTO flies the real burn.
- **Deep links** — `#t=<MET seconds>` or `#phase=TLI`, plus `&cam=orbit|pov`;
  the SHARE MOMENT chip under the clock copies a URL to the current second.
- **Keyboard console** — press `?` in the app for the table.
- Phase rail, scrubber, rolling telemetry sparklines, `prefers-reduced-motion`
  support, and a poster fallback for no-WebGL visitors.

## Heritage

During my NASA internship at Johnson Space Center I built
[orion-trajectory-display](https://github.com/Markpelico/orion-trajectory-display),
a Python/matplotlib console that streams live vehicle state from a
[NASA Trick](https://github.com/nasa/trick) variable server. The desktop
version needs a running simulation; this web version replays the flown
mission so anyone can see it. Same mission-console soul, zero setup.

## Stack

Next.js (App Router) · React Three Fiber + drei · three.js — Line2 fat
lines, custom GLSL for the graticule Earth, night lights, and atmosphere ·
postprocessing (bloom → ACES → vignette) · Motion · Zustand · Playwright
visual audits in `scripts/`.

```bash
npm install
npm run dev
```

Checks: `node scripts/verify-mission.mjs` (data anchors + AUTO-warp wall
time), `node scripts/artemis-audit.mjs` and `node scripts/interactive-audit.mjs`
(headless Playwright passes that fly the mission and screenshot the moments
that matter).

---

Built by [Mark Pelico](https://www.markpelico.com).
