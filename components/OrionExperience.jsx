"use client";

import { useEffect, useState } from "react";
import Scene from "@/components/Scene";
import Hud from "@/components/Hud";
import Boot from "@/components/Boot";

export default function OrionExperience() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
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
