"use client";

import dynamic from "next/dynamic";

// The whole experience is client-only: WebGL canvas, requestAnimationFrame
// clock, and window-level media queries have no server render. While the
// flight software loads — and for no-JS / no-WebGL visitors, forever — the
// stage shows the flown flyby as a full-bleed poster instead of a spinner.
const OrionExperience = dynamic(() => import("@/components/OrionExperience"), {
  ssr: false,
  loading: () => (
    <main className="stage stage-loading">
      {/* eslint-disable-next-line @next/next/no-img-element -- next/image
          needs client JS; this poster must paint for no-JS visitors too. */}
      <img
        className="stage-poster"
        src="/poster.jpg"
        alt="Artemis II lunar flyby: the flown trajectory arcing past the Moon, Earth in the far field"
      />
      <div className="stage-poster-scrim" aria-hidden="true" />
      <span className="boot-line stage-loading-line">LOADING FLIGHT SOFTWARE…</span>
      <noscript>
        <span className="boot-line stage-loading-line">
          JAVASCRIPT IS OFF — SHOWING THE FLOWN ARTEMIS II FLYBY FROM THE JPL EPHEMERIS.
        </span>
      </noscript>
    </main>
  ),
});

export default function Page() {
  return <OrionExperience />;
}
