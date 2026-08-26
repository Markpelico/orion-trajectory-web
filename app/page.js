"use client";

import dynamic from "next/dynamic";

// The whole experience is client-only: WebGL canvas, requestAnimationFrame
// clock, and window-level media queries have no server render.
const OrionExperience = dynamic(() => import("@/components/OrionExperience"), {
  ssr: false,
  loading: () => (
    <main className="stage stage-loading">
      <span className="boot-line">LOADING FLIGHT SOFTWARE…</span>
    </main>
  ),
});

export default function Page() {
  return <OrionExperience />;
}
