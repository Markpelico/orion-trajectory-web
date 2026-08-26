# Orion Trajectory Display — Web Console

Interactive replay of an EFT-1-style Orion mission in the browser: launch from
Cape Canaveral, a 5,800 km apogee-raise ellipse, and a 9 km/s reentry, rendered
as a real-time 3D mission console.

**Live:** https://orion.markpelico.com

This is the web companion to
[orion-trajectory-display](https://github.com/Markpelico/orion-trajectory-display),
a Python/matplotlib tool that streams live vehicle state from a
[NASA Trick](https://github.com/nasa/trick) variable server. The desktop
version needs a running Trick simulation; this version replays a computed
profile so anyone can see the mission.

## What is real and what is simplified

- The coast orbit and the apogee-raise ellipse are true two-body mechanics:
  vis-viva speeds, Kepler's equation solved by Newton iteration. Entry,
  peak-heating, chute, and splashdown phase stamps are derived from where the
  propagated ellipse actually crosses the 122 km entry interface — the HUD can
  never contradict the trajectory it is drawn over.
- Ascent and entry are shaped envelopes (altitude/velocity/g curves tuned to
  EFT-1's published figures), not integrated flight dynamics.
- The profile is inspired by EFT-1 (Dec 5, 2014): two orbits, 5,800 km apogee,
  high-energy reentry, Pacific splashdown.

## Console

- **AUTO time warp** — real-time through launch, the raise burn, and entry;
  compressed through the hours of coast. Full mission in about six minutes.
- **Chase / orbit cameras**, scrubbable mission timeline, phase callouts.
- Rolling telemetry sparklines (altitude, velocity, g-load) — the web echo of
  the desktop tool's matplotlib panels.
- Honors `prefers-reduced-motion`.

## Stack

Next.js · React Three Fiber · three.js · Framer Motion (`motion`) · Zustand ·
custom GLSL for the graticule Earth and atmosphere.

```bash
npm install
npm run dev
```
