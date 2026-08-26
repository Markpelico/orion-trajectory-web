"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Stars, OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import {
  SAMPLES,
  stateAt,
  sampleIndex,
  EARTH_RADIUS_SCENE,
  ASCENT_END,
  BURN_T,
  tEntry,
} from "@/lib/mission";
import { useMission } from "@/lib/store";

/* ---------------------------------------------------------------- Earth -- */

const EARTH_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

// Mission-control globe: near-black sphere, 15-degree graticule, blue rim.
const EARTH_FRAG = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;

  float gridLine(float v, float step, float width) {
    float f = abs(fract(v / step - 0.5) - 0.5) * step;
    return 1.0 - smoothstep(0.0, width, f);
  }

  void main() {
    float lat = degrees(asin(clamp(vWorld.y, -1.0, 1.0)));
    float lon = degrees(atan(vWorld.z, vWorld.x));

    float g = max(gridLine(lat, 15.0, 0.28), gridLine(lon, 15.0, 0.28));
    // Fade the longitude pinch at the poles.
    g *= smoothstep(0.0, 0.12, 1.0 - abs(vWorld.y));

    vec3 base = vec3(0.016, 0.024, 0.045);
    vec3 grid = vec3(0.10, 0.16, 0.30);
    // Soft key light so the sphere reads as a body, not a disc.
    float lit = 0.45 + 0.55 * max(dot(vNormal, normalize(vec3(0.7, 0.35, 0.5))), 0.0);
    float fres = pow(1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 2.6);

    vec3 color = (base + grid * g * 0.8) * lit + vec3(0.10, 0.22, 0.55) * fres * 0.8;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const ATMO_FRAG = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    float f = pow(1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.2);
    gl_FragColor = vec4(vec3(0.18, 0.38, 0.95), f * 0.55);
  }
`;

function Earth() {
  return (
    <group>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS_SCENE, 96, 96]} />
        <shaderMaterial vertexShader={EARTH_VERT} fragmentShader={EARTH_FRAG} />
      </mesh>
      <mesh scale={1.035}>
        <sphereGeometry args={[EARTH_RADIUS_SCENE, 64, 64]} />
        <shaderMaterial
          vertexShader={EARTH_VERT}
          fragmentShader={ATMO_FRAG}
          transparent
          side={THREE.BackSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

/* ----------------------------------------------------------- Trajectory -- */

const PHASE_COLORS = {
  ascent: new THREE.Color("#ffffff"),
  coast: new THREE.Color("#4c5b74"),
  ellipse: new THREE.Color("#93a7cc"),
  entry: new THREE.Color("#fc3d21"),
};

function colorFor(t) {
  if (t <= ASCENT_END) return PHASE_COLORS.ascent;
  if (t <= BURN_T) return PHASE_COLORS.coast;
  if (t <= tEntry) return PHASE_COLORS.ellipse;
  return PHASE_COLORS.entry;
}

function Trajectory() {
  const progressRef = useRef();

  const { fullLine, progressGeom } = useMemo(() => {
    const positions = SAMPLES.pos;
    const colors = new Float32Array(SAMPLES.n * 3);
    for (let i = 0; i < SAMPLES.n; i++) {
      const c = colorFor(SAMPLES.ts[i]);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const dimGeom = new THREE.BufferGeometry();
    dimGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const dimMat = new THREE.LineBasicMaterial({
      color: "#41506b",
      transparent: true,
      opacity: 0.28,
    });
    const fullLine = new THREE.Line(dimGeom, dimMat);

    const progressGeom = new THREE.BufferGeometry();
    progressGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    progressGeom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    progressGeom.setDrawRange(0, 0);
    return { fullLine, progressGeom };
  }, []);

  const progressLine = useMemo(() => {
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return new THREE.Line(progressGeom, mat);
  }, [progressGeom]);

  useFrame(() => {
    const met = useMission.getState().met;
    progressGeom.setDrawRange(0, sampleIndex(met) + 1);
  });

  return (
    <group>
      <primitive object={fullLine} />
      <primitive object={progressLine} ref={progressRef} />
    </group>
  );
}

/* -------------------------------------------------------------- Capsule -- */

function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function Capsule() {
  const group = useRef();
  const plasma = useRef();
  const glowTex = useMemo(makeGlowTexture, []);

  useFrame(() => {
    const met = useMission.getState().met;
    const s = stateAt(met);
    if (group.current) group.current.position.set(s.x, s.y, s.z);
    if (plasma.current) {
      // Plasma only during entry: low altitude, high speed.
      const active = s.alt < 135 && s.speed > 1.2 && met > tEntry - 30;
      const k = active ? Math.min(1, s.g / 8.2) : 0;
      plasma.current.material.opacity = k * 0.9;
      const sc = 0.05 + k * 0.22;
      plasma.current.scale.set(sc, sc, 1);
    }
  });

  return (
    <group ref={group}>
      <mesh>
        <octahedronGeometry args={[0.02, 0]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </mesh>
      <sprite scale={[0.09, 0.09, 1]}>
        <spriteMaterial
          map={glowTex}
          color="#cfe0ff"
          transparent
          opacity={0.85}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </sprite>
      <sprite ref={plasma}>
        <spriteMaterial
          map={glowTex}
          color="#ff5a2a"
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </sprite>
    </group>
  );
}

/* -------------------------------------------------------------- Cameras -- */

function CameraRig() {
  const { camera } = useThree();
  const camMode = useMission((s) => s.camMode);
  const smoothed = useRef(new THREE.Vector3(0, 3, 16));
  const look = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    if (camMode !== "chase") return;
    const met = useMission.getState().met;
    const s = stateAt(met);
    const p = new THREE.Vector3(s.x, s.y, s.z);

    // Forward from a finite difference; falls back to local east on the pad.
    const prev = stateAt(met - 8);
    const fwd = new THREE.Vector3(s.x - prev.x, s.y - prev.y, s.z - prev.z);
    if (fwd.lengthSq() < 1e-9) fwd.set(-p.z, 0, p.x);
    fwd.normalize();

    const out = p.clone().normalize();
    // Pull back farther as the ship climbs; stay tight near the ground.
    const dist = 0.55 + (s.alt / 5800) * 3.4;
    const target = p
      .clone()
      .addScaledVector(fwd, -dist)
      .addScaledVector(out, dist * 0.45);

    const k = 1 - Math.exp(-3.2 * dt);
    smoothed.current.lerp(target, k);
    look.current.lerp(p, k);
    camera.position.copy(smoothed.current);
    camera.lookAt(look.current);
  });

  return camMode === "orbit" ? (
    <OrbitControls
      makeDefault
      enablePan={false}
      minDistance={7.5}
      maxDistance={60}
      target={[0, 0, 0]}
    />
  ) : null;
}

/* ----------------------------------------------------------------- Root -- */

function Ticker() {
  const tick = useMission((s) => s.tick);
  useFrame((_, dt) => tick(Math.min(dt, 0.1)));
  return null;
}

export default function Scene({ reducedMotion }) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [0, 3, 16], fov: 42, near: 0.01, far: 300 }}
      gl={{ antialias: true }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={["#040508"]} />
      <Ticker />
      <Earth />
      <Trajectory />
      <Capsule />
      <CameraRig />
      <Stars radius={90} depth={40} count={4000} factor={3.2} saturation={0} fade speed={0} />
      {!reducedMotion && (
        <EffectComposer>
          <Bloom mipmapBlur intensity={1.05} luminanceThreshold={0.16} luminanceSmoothing={0.35} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
