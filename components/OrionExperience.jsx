"use client";

import { useEffect, useState } from "react";
import Scene from "@/components/Scene";
import Hud from "@/components/Hud";
import Boot from "@/components/Boot";
import { parseHash } from "@/lib/deeplink";
import { useMission } from "@/lib/store";

export default function OrionExperience() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // A shared moment (#t=..., #phase=...) skips the boot ceremony and opens
  // paused right there, in the right camera.
  useEffect(() => {
    const link = parseHash(window.location.hash);
    if (link && !useMission.getState().booted) useMission.getState().bootAt(link);
  }, []);

  return (
    <main className="stage">
      <Scene reducedMotion={reducedMotion} />
      <div className="scanlines" aria-hidden="true" />
      <Hud reducedMotion={reducedMotion} />
      <Boot />
    </main>
  );
}
