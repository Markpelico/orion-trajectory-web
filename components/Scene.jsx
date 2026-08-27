"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree, useLoader } from "@react-three/fiber";
import { Stars, OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { Line2, LineGeometry, LineMaterial } from "three-stdlib";
import {
  SAMPLES,
  stateAt,
  sampleIndex,
  moonPosAt,
  EARTH_RADIUS_SCENE,
  MOON_RADIUS_SCENE,
  EARTH_SPIN,
  SUN_DIR,
  T_START,
  T_END,
  EV,
} from "@/lib/mission";
import { useMission, autoWarp } from "@/lib/store";

/** Current effective warp — the finite-difference dt for attitude and camera
 *  work scales with it so direction vectors stay clean at every speed. */
function currentWarp(st) {
  return st.warp === "auto" ? autoWarp(st.met) : st.warp;
}

/* ---------------------------------------------------------------- Earth -- */

const OVERLAY_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vWorld = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

// Faint 15-degree graticule over the texture, so the mission-control feel
// survives the switch to real imagery.
const GRID_FRAG = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;

  float gridLine(float v, float step, float width) {
    float f = abs(fract(v / step - 0.5) - 0.5) * step;
    return 1.0 - smoothstep(0.0, width, f);
  }

  void main() {
    float lat = degrees(asin(clamp(vWorld.y, -1.0, 1.0)));
    float lon = degrees(atan(vWorld.z, vWorld.x));
    float g = max(gridLine(lat, 15.0, 0.30), gridLine(lon, 15.0, 0.30));
    g *= smoothstep(0.0, 0.12, 1.0 - abs(vWorld.y));
    // Kept faint: at grazing angles these lines stack and bloom into bars.
    gl_FragColor = vec4(vec3(0.35, 0.55, 0.95), g * 0.09);
  }
`;

// Thin limb: high exponent confines the glow to grazing angles, so the
// atmosphere reads as a gradient shell instead of a solid blue ring.
// uFade collapses it further when the camera is close — at 200 km over the
// TLI perigee an unfaded shell fills half the frame with solid blue.
const ATMO_FRAG = /* glsl */ `
  varying vec3 vNormal;
  uniform float uFade;
  void main() {
    float d = 1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0);
    float f = pow(d, mix(8.5, 4.5, uFade));
    gl_FragColor = vec4(vec3(0.22, 0.45, 1.0), f * 0.65 * mix(0.4, 1.0, uFade));
  }
`;

function Earth() {
  const spin = useRef();
  const atmoUniforms = useMemo(() => ({ uFade: { value: 1 } }), []);
  const map = useLoader(THREE.TextureLoader, "/textures/earth.jpg");
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;

  // Real sidereal rotation, phased so the pad sits over Florida at liftoff.
  // The trajectory stays inertial; the planet turns beneath it, which also
  // parks the splashdown track over the eastern Pacific nine days later.
  useFrame(({ camera }) => {
    if (spin.current) {
      const met = useMission.getState().met;
      spin.current.rotation.y = EARTH_SPIN.phase0 + EARTH_SPIN.omega * Math.max(0, met);
    }
    // Collapse the atmosphere shell when the camera hugs the planet.
    const d = camera.position.length();
    atmoUniforms.uFade.value = THREE.MathUtils.clamp((d - EARTH_RADIUS_SCENE - 1.2) / 8, 0.12, 1);
  });

  return (
    <group>
      <group ref={spin}>
        <mesh>
          <sphereGeometry args={[EARTH_RADIUS_SCENE, 64, 64]} />
          <meshStandardMaterial map={map} roughness={1} metalness={0} />
        </mesh>
        <mesh scale={1.002}>
          <sphereGeometry args={[EARTH_RADIUS_SCENE, 48, 48]} />
          <shaderMaterial
            vertexShader={OVERLAY_VERT}
            fragmentShader={GRID_FRAG}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>
      <mesh scale={1.022}>
        <sphereGeometry args={[EARTH_RADIUS_SCENE, 48, 48]} />
        <shaderMaterial
          vertexShader={OVERLAY_VERT}
          fragmentShader={ATMO_FRAG}
          uniforms={atmoUniforms}
          transparent
          side={THREE.BackSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

/* ----------------------------------------------------------------- Moon -- */

const moonScratch = [0, 0, 0];

// The real Moon: true radius at true distance, riding the baked hourly
// ephemeris track (it sweeps ~117 degrees of its orbit across the mission).
// Tidally locked: the same face turns toward Earth the whole way.
function Moon() {
  const group = useRef();
  const map = useLoader(THREE.TextureLoader, "/textures/moon.jpg");
  map.colorSpace = THREE.SRGBColorSpace;

  useFrame(() => {
    if (!group.current) return;
    const met = useMission.getState().met;
    moonPosAt(met, moonScratch);
    group.current.position.set(moonScratch[0], moonScratch[1], moonScratch[2]);
    group.current.lookAt(0, 0, 0);
  });

  // Faint arc of the Moon's motion over the mission window — orientation
  // furniture for the orbit camera at figure-eight scale.
  const track = useMemo(() => {
    const pts = [];
    for (let t = T_START; t <= T_END; t += 7200) {
      const p = moonPosAt(t, [0, 0, 0]);
      pts.push(new THREE.Vector3(p[0], p[1], p[2]));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(
      geom,
      new THREE.LineBasicMaterial({ color: "#3c4a5e", transparent: true, opacity: 0.35 })
    );
  }, []);

  return (
    <group>
      <group ref={group}>
        <mesh rotation={[0, Math.PI, 0]}>
          <sphereGeometry args={[MOON_RADIUS_SCENE, 48, 48]} />
          <meshStandardMaterial map={map} roughness={1} metalness={0} />
        </mesh>
      </group>
      <primitive object={track} />
    </group>
  );
}

/* ----------------------------------------------------------- Trajectory -- */

const PHASE_COLORS = {
  ascent: new THREE.Color("#ffffff"),
  earthOps: new THREE.Color("#54627e"),
  outbound: new THREE.Color("#93a7cc"),
  flyby: new THREE.Color("#e9edf6"),
  ret: new THREE.Color("#7d8fb5"),
  entry: new THREE.Color("#fc3d21"),
};

function colorFor(t) {
  if (t <= EV.INSERT) return PHASE_COLORS.ascent;
  if (t <= EV.TLI) return PHASE_COLORS.earthOps;
  if (t <= EV.LUNAR_SOI) return PHASE_COLORS.outbound;
  if (t <= EV.SOI_EXIT) return PHASE_COLORS.flyby;
  if (t <= EV.ENTRY) return PHASE_COLORS.ret;
  return PHASE_COLORS.entry;
}

/**
 * Fat lines (Line2): the trajectory is the hero element, and 1px GL lines
 * vanish in thumbnails. Both lines share one position table; the progress
 * line adds per-phase vertex colors and reveals itself by capping
 * geometry.instanceCount (one instance per segment — the fat-line analogue
 * of setDrawRange, O(1) per frame at 1,721 points).
 */
function Trajectory() {
  const size = useThree((s) => s.size);

  const { fullLine, progressLine, fullMat, progMat } = useMemo(() => {
    const positions = Array.from(SAMPLES.pos);
    const colors = new Array(SAMPLES.n * 3);
    for (let i = 0; i < SAMPLES.n; i++) {
      const c = colorFor(SAMPLES.ts[i]);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const fullGeom = new LineGeometry();
    fullGeom.setPositions(positions);
    const fullMat = new LineMaterial({
      color: 0x5c7099,
      linewidth: 1.5,
      transparent: true,
      opacity: 0.33,
      depthWrite: false,
    });
    const fullLine = new Line2(fullGeom, fullMat);
    fullLine.frustumCulled = false;

    const progGeom = new LineGeometry();
    progGeom.setPositions(positions);
    progGeom.setColors(colors);
    progGeom.instanceCount = 0;
    const progMat = new LineMaterial({
      vertexColors: true,
      linewidth: 2.75,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const progressLine = new Line2(progGeom, progMat);
    progressLine.frustumCulled = false;

    return { fullLine, progressLine, fullMat, progMat };
  }, []);

  // LineMaterial resolves width in screen space and must know the viewport.
  useEffect(() => {
    fullMat.resolution.set(size.width, size.height);
    progMat.resolution.set(size.width, size.height);
  }, [size, fullMat, progMat]);

  useFrame(() => {
    // sampleIndex(met) segments are fully in the past — draw exactly those.
    progressLine.geometry.instanceCount = Math.min(
      sampleIndex(useMission.getState().met),
      SAMPLES.n - 1
    );
  });

  return (
    <group>
      <primitive object={fullLine} />
      <primitive object={progressLine} />
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

/**
 * Stylized Orion stack, built from primitives so it costs nothing to load:
 * blunt crew-module cone, cylindrical ESA service module, and the four
 * solar-array wings in their X configuration. Model +X is the flight
 * direction. Deliberately oversized — a to-scale capsule would be
 * sub-pixel; the HUD note already says the replay is simplified.
 */
function OrionModel({ smRef }) {
  return (
    <group>
      {/* Crew module: blunt cone, tip forward (+X); heat shield at its base. */}
      <mesh position={[0.012, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.0135, 0.015, 24]} />
        <meshStandardMaterial color="#dfe2e8" metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Heat shield disc — stays with the CM through entry. */}
      <mesh position={[0.0038, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.0138, 0.0138, 0.0015, 24]} />
        <meshStandardMaterial color="#7a5c48" metalness={0.2} roughness={0.7} />
      </mesh>
      {/* Service module + wings — jettisoned at CM/SM sep, so they can be
          hidden without touching the crew module. */}
      <group ref={smRef}>
        <mesh position={[-0.006, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.0128, 0.0128, 0.018, 24]} />
          <meshStandardMaterial color="#9aa1ab" metalness={0.6} roughness={0.4} />
        </mesh>
        {/* Four solar-array wings, X configuration, canted back. */}
        {[45, 135, 225, 315].map((a) => (
          <group key={a} position={[-0.01, 0, 0]} rotation={[THREE.MathUtils.degToRad(a), 0, 0]}>
            <mesh position={[-0.006, 0.022, 0]} rotation={[0, 0, THREE.MathUtils.degToRad(-18)]}>
              <boxGeometry args={[0.0048, 0.028, 0.0008]} />
              <meshStandardMaterial
                color="#2a4a85"
                metalness={0.4}
                roughness={0.35}
                emissive="#16294d"
                emissiveIntensity={0.5}
              />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}

function Capsule() {
  const group = useRef();
  const model = useRef();
  const sm = useRef();
  const plasma = useRef();
  const glow = useRef();
  const glowTex = useMemo(makeGlowTexture, []);
  const xAxis = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(), []);
  const pitchAxis = useMemo(() => new THREE.Vector3(), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);
  const flipQuat = useMemo(() => new THREE.Quaternion(), []);

  useFrame(({ camera }, dt) => {
    const st = useMission.getState();
    const met = st.met;
    const s = stateAt(met);
    if (group.current) group.current.position.set(s.x, s.y, s.z);

    // Point the stack along the velocity vector, and grow it gently with
    // camera distance so it still reads as a vehicle at translunar range.
    if (model.current) {
      // Finite-difference forward vector. The lookback scales with warp so it
      // stays small against the per-frame time step: at 1x during ascent a
      // 1-second dt tracks the pitch-over, at 32,000x a 60-second dt is still
      // a sliver of the frame's own ~500 s advance.
      const dts = THREE.MathUtils.clamp(currentWarp(st) * 0.5, 1, 60);
      const prev = stateAt(met - dts);
      fwd.set(s.x - prev.x, s.y - prev.y, s.z - prev.z);
      if (fwd.lengthSq() < 1e-10) fwd.set(-s.z, 0, s.x); // pad fallback: local east
      fwd.normalize();
      quat.setFromUnitVectors(xAxis, fwd);

      // Entry attitude: the real capsule flies blunt-end-first. Across the
      // CM/SM sep -> entry-interface window, pitch 180 degrees about the
      // local horizontal so the heat shield leads through the plasma.
      const flipK = THREE.MathUtils.smoothstep(met, EV.CMSM_SEP, EV.ENTRY);
      if (flipK > 0) {
        up.set(s.x, s.y, s.z).normalize();
        pitchAxis.crossVectors(fwd, up);
        if (pitchAxis.lengthSq() < 1e-8) pitchAxis.set(0, 1, 0);
        pitchAxis.normalize();
        flipQuat.setFromAxisAngle(pitchAxis, Math.PI * flipK);
        quat.premultiply(flipQuat);
      }

      // Frame-rate-aware damping: warp changes and rail seeks glide the
      // attitude around in ~half a second instead of snapping it.
      model.current.quaternion.slerp(quat, 1 - Math.exp(-6.5 * dt));

      // SM + wings are gone after separation; the bare CM rides to splash.
      if (sm.current) sm.current.visible = met < EV.CMSM_SEP;

      const camDist = camera.position.distanceTo(group.current.position);
      // Extra presence near the Moon so the money shot has a vehicle in it.
      const prox = 1 - THREE.MathUtils.clamp((s.rangeMoon - 2000) / 18000, 0, 1);
      const sc = 0.7 * THREE.MathUtils.clamp(camDist / 2.4, 1, 3.6) * (1 + prox * 0.9);
      model.current.scale.setScalar(sc);
      if (glow.current) {
        const gs = 0.032 * THREE.MathUtils.clamp(camDist / 2.6, 1, 5);
        glow.current.scale.set(gs, gs, 1);
      }
    }

    if (plasma.current) {
      const active = s.alt < 135 && s.speed > 1.2 && met > EV.ENTRY - 60;
      const k = active ? Math.min(1, s.g / 4.2) : 0;
      plasma.current.material.opacity = k * 0.9;
      const sc = 0.05 + k * 0.22;
      plasma.current.scale.set(sc, sc, 1);
    }
  });

  return (
    <group ref={group}>
      <group ref={model} scale={0.7}>
        <OrionModel smRef={sm} />
      </group>
      <sprite ref={glow} scale={[0.032, 0.032, 1]}>
        <spriteMaterial
          map={glowTex}
          color="#cfe0ff"
          transparent
          opacity={0.5}
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
  const [orbitTarget, setOrbitTarget] = useState([0, 0, 0]);

  // Mode transitions. Entering orbit: a high oblique vantage — the translunar
  // trajectory is nearly planar, so an edge-on entry collapses the
  // figure-eight into a line. Deep in the mission the pivot moves to the
  // halfway point so the whole Earth-to-Moon structure fits the frame.
  // Returning to chase: sync the smoother so the camera glides, not snaps.
  useEffect(() => {
    if (camMode === "orbit") {
      const s = stateAt(useMission.getState().met);
      const p = new THREE.Vector3(s.x, s.y, s.z);
      const far = p.length() > 60;
      const mid = far ? p.clone().multiplyScalar(0.5) : new THREE.Vector3();
      const d = Math.max(30, p.length() * 1.35 + 40);
      const dir = p
        .clone()
        .normalize()
        .multiplyScalar(0.45)
        .add(new THREE.Vector3(0, 0.88, 0))
        .normalize();
      camera.position.copy(mid).addScaledVector(dir, d);
      camera.lookAt(mid);
      setOrbitTarget(mid.toArray());
    } else {
      smoothed.current.copy(camera.position);
    }
  }, [camMode, camera]);

  useFrame((_, dt) => {
    if (camMode !== "chase") return;
    const st = useMission.getState();
    const met = st.met;
    const s = stateAt(met);
    const p = new THREE.Vector3(s.x, s.y, s.z);

    const prev = stateAt(met - 8);
    const fwd = new THREE.Vector3(s.x - prev.x, s.y - prev.y, s.z - prev.z);
    if (fwd.lengthSq() < 1e-9) fwd.set(-p.z, 0, p.x);
    fwd.normalize();

    const out = p.clone().normalize();
    // Near Earth this is the proven launch framing: camera high over the pad,
    // swinging to a trailing chase as altitude builds. From there the pull-back
    // grows with altitude (capped) so the coast reads as a vehicle in deep
    // space rather than an empty frame. The lead-and-look-back half of the
    // low mode is a LAUNCH shot (it frames the Florida coastline); during
    // entry it would bury the lens in terrain, so the descent keeps a mostly
    // trailing view with the limb and the incoming track in frame.
    const lowGate = met < EV.TLI ? 1 : 0.3;
    const low = (1 - Math.min(s.alt / 120, 1)) * lowGate;
    const altU = s.alt / 1000; // scene units above the surface
    let dist = (1.35 + Math.min(altU * 0.75, 4.4)) * (1 + low);

    // Lunar approach, two ramps: from ~60,000 km the LOOK swings toward the
    // Moon (the "turn to face it" through the SOI leg); inside ~20,000 km the
    // camera also pulls back so closest approach frames spacecraft and Moon
    // together with the capsule in the foreground.
    moonPosAt(met, moonScratch);
    const moonP = new THREE.Vector3(moonScratch[0], moonScratch[1], moonScratch[2]);
    // The Earth-look and Moon-look are nearly opposite on approach, so the
    // swing between them passes through an empty broadside frame no matter
    // what. Commit fast: start turning at 60,000 km, fully Moon-facing by
    // ~38,000 km, instead of dawdling in the limbo.
    const prox = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp((60000 - s.rangeMoon) / 22000, 0, 1), 0, 1);
    const proxClose = THREE.MathUtils.smoothstep(1 - THREE.MathUtils.clamp((s.rangeMoon - 2000) / 18000, 0, 1), 0, 1);
    // Intercept geometry: mid-approach the Moon rides ~40 degrees off the
    // velocity vector (you fly to where it WILL be), so the camera needs
    // extra standoff to hold capsule and Moon in one frame.
    dist += prox * 2.2 + proxClose * (p.distanceTo(moonP) * 0.2 + 1.2);

    // Low over the pad the camera leads the vehicle and looks back west:
    // east of Canaveral is featureless Atlantic, so a trailing camera sees
    // only blue - while the look-back frames the Florida coastline.
    const fwdOffset = -dist * (1 - 2 * low); // ahead at the pad, behind in space
    const target = p
      .clone()
      .addScaledVector(fwd, fwdOffset)
      .addScaledVector(out, dist * (0.5 + 0.4 * low));

    const lookBase = p
      .clone()
      .addScaledVector(fwd, 0.3 * (1 - low))
      .addScaledVector(out, -0.12 * low);

    // Deep-space coast (both directions): Earth is hundreds of units away
    // while the capsule sits ~6 from the lens, so the only composition that
    // holds both in a 42-degree frame is the camera almost directly
    // anti-Earthward of the capsule, looking home THROUGH it — capsule
    // foreground ~15 degrees off axis, Earth a marble near center, shrinking
    // outbound and growing on the way back.
    const coastK =
      THREE.MathUtils.smoothstep(THREE.MathUtils.clamp((s.alt - 25000) / 55000, 0, 1), 0, 1) *
      (1 - prox);
    if (coastK > 0.001) {
      const side = new THREE.Vector3().crossVectors(out, fwd);
      if (side.lengthSq() < 1e-8) side.set(0, 1, 0);
      side.normalize();
      const coastPos = p
        .clone()
        .addScaledVector(out, dist * 0.9)
        .addScaledVector(side, dist * 0.35);
      target.lerp(coastPos, coastK);
      lookBase.lerp(p.clone().addScaledVector(out, -dist * 2.0), coastK);
    }

    // Off-axis shift near the Moon: stand to the side of the capsule-Moon
    // line so the encounter reads in profile instead of stacked.
    if (prox > 0.01) {
      const side = new THREE.Vector3().subVectors(moonP, p).normalize().cross(out).normalize();
      target.addScaledVector(side, prox * dist * 0.55);
      target.addScaledVector(out, prox * dist * 0.2);
    }
    const lookTarget = lookBase.lerp(
      p.clone().lerp(moonP, 0.35 + 0.2 * proxClose),
      prox * 0.9
    );

    // Smoothing scaled with warp: at 40,000x the capsule moves whole units
    // per frame, and an un-scaled smoother would trail it off screen.
    const w = st.warp === "auto" ? autoWarp(met) : st.warp;
    const k = 1 - Math.exp(-3.2 * dt * THREE.MathUtils.clamp(w / 8, 1, 40));
    smoothed.current.lerp(target, k);
    look.current.lerp(lookTarget, k);
    camera.position.copy(smoothed.current);
    camera.lookAt(look.current);
  });

  return camMode === "orbit" ? (
    <OrbitControls
      makeDefault
      enableDamping
      dampingFactor={0.08}
      enablePan={false}
      minDistance={10.5}
      maxDistance={620}
      target={orbitTarget}
    />
  ) : null;
}

/* ----------------------------------------------------------------- Root -- */

function Ticker() {
  const tick = useMission((s) => s.tick);
  useFrame((_, dt) => tick(Math.min(dt, 0.1)));
  return null;
}

// A lost WebGL context leaves a permanently black canvas; reloading is the
// bluntest but most reliable recovery on low-end GPUs.
function ContextGuard() {
  const { gl } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    const onLost = (e) => {
      e.preventDefault();
      setTimeout(() => window.location.reload(), 400);
    };
    el.addEventListener("webglcontextlost", onLost);
    return () => el.removeEventListener("webglcontextlost", onLost);
  }, [gl]);
  return null;
}

export default function Scene({ reducedMotion }) {
  return (
    <Canvas
      dpr={[1, 1.5]}
      camera={{ position: [0, 3, 16], fov: 42, near: 0.05, far: 3000 }}
      // ACES here covers the reduced-motion path (no composer). With the
      // composer active the renderer is forced to NoToneMapping and the
      // <ToneMapping> effect below takes over.
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={["#040508"]} />
      {/* The real mid-mission Sun: the dusk launch, Earth's terminator and the
          Moon's waning-gibbous face all light the way they did in April 2026. */}
      <directionalLight
        position={[SUN_DIR[0] * 200, SUN_DIR[1] * 200, SUN_DIR[2] * 200]}
        intensity={2.2}
      />
      {/* Anti-sun fill: keeps the far side of the Moon, night-side Earth and
          backlit hardware legible during the far-side flyby minutes. */}
      <directionalLight
        position={[-SUN_DIR[0] * 200, -SUN_DIR[1] * 200, -SUN_DIR[2] * 200]}
        intensity={0.5}
        color="#7e8ba6"
      />
      {/* Hemisphere fill keeps the night side and backlit spacecraft readable. */}
      <hemisphereLight args={["#4a5c80", "#10141f", 1.0]} />
      <ambientLight intensity={0.22} />
      <ContextGuard />
      <Ticker />
      <Suspense fallback={null}>
        <Earth />
        <Moon />
      </Suspense>
      <Trajectory />
      <Capsule />
      <CameraRig />
      <Stars radius={1200} depth={120} count={3000} factor={12} saturation={0} fade speed={0} />
      {!reducedMotion && (
        <EffectComposer multisampling={0}>
          {/* Bloom gathers in scene-referred light, then ACES compresses it,
              then the vignette shapes the display-referred frame. Intensity
              re-tuned up from 0.85: ACES pulls the highlights down. */}
          <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.18} luminanceSmoothing={0.35} />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          <Vignette eskil={false} offset={0.24} darkness={0.55} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
