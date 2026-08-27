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
import { useInspect } from "@/lib/inspect";

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
  const [map, nightMap] = useLoader(THREE.TextureLoader, [
    "/textures/earth.jpg",
    "/textures/earth-night.jpg", // NASA Black Marble 2016, public domain
  ]);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  nightMap.colorSpace = THREE.SRGBColorSpace;
  nightMap.anisotropy = 4;

  // Day texture extended in-shader: Black Marble city lights fade in past the
  // terminator (sun-dot mask with a soft band), a faint warm rim marks the
  // terminator itself, and the day texture's blue dominance doubles as an
  // ocean mask that tightens roughness so the Pacific catches a sun glint.
  // The sun mask uses the world-space normal, so it tracks the mesh's
  // sidereal spin automatically; SUN_DIR is the real mid-mission Sun.
  const earthMat = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNightMap = { value: nightMap };
      shader.uniforms.uSunDir = {
        value: new THREE.Vector3(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]),
      };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vEarthNormal;"
        )
        .replace(
          "#include <defaultnormal_vertex>",
          "#include <defaultnormal_vertex>\nvEarthNormal = normalize(mat3(modelMatrix) * objectNormal);"
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          [
            "#include <common>",
            "varying vec3 vEarthNormal;",
            "uniform sampler2D uNightMap;",
            "uniform vec3 uSunDir;",
          ].join("\n")
        )
        .replace(
          "#include <roughnessmap_fragment>",
          [
            "#include <roughnessmap_fragment>",
            "float oceanMask = smoothstep(0.015, 0.09, diffuseColor.b - max(diffuseColor.r, diffuseColor.g));",
            "roughnessFactor = mix(roughnessFactor, 0.38, oceanMask);",
          ].join("\n")
        )
        .replace(
          "#include <emissivemap_fragment>",
          [
            "#include <emissivemap_fragment>",
            "float sunDot = dot(normalize(vEarthNormal), uSunDir);",
            "float nightK = smoothstep(0.02, -0.14, sunDot);",
            "vec3 nightLights = texture2D(uNightMap, vMapUv).rgb;",
            "totalEmissiveRadiance += nightLights * nightK * 1.3;",
            // Narrow warm rim hugging the lit edge of the terminator. Keep it
            // tight: with the camera near the terminator (the dusk launch),
            // sunDot varies slowly across the disc and any generous band
            // veils half the planet in rust.
            "float termK = 1.0 - smoothstep(0.0, 0.045, abs(sunDot - 0.015));",
            "totalEmissiveRadiance += vec3(1.0, 0.36, 0.10) * termK * termK * 0.028;",
          ].join("\n")
        );
    };
    return mat;
  }, [map, nightMap]);

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
        <mesh material={earthMat}>
          <sphereGeometry args={[EARTH_RADIUS_SCENE, 64, 64]} />
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

/* -------------------------------------------------------------- Skybox -- */

/**
 * The Milky Way as a distant backdrop: ESO/S. Brunier 360-degree panorama
 * (eso0932a, CC BY 4.0), downscaled and deliberately dimmed — this is a
 * mission-control display, so the galaxy is an accent behind the data, not
 * wallpaper. Galactic-coordinate image, tilted roughly like the real band
 * against the equatorial frame the ephemeris flies in. drei Stars stay on
 * top (inside this sphere) for bright-point sparkle the JPEG can't carry.
 */
function MilkyWay() {
  const map = useLoader(THREE.TextureLoader, "/textures/milkyway.jpg");
  map.colorSpace = THREE.SRGBColorSpace;
  return (
    <mesh
      rotation={[THREE.MathUtils.degToRad(60), THREE.MathUtils.degToRad(-32), 0]}
      renderOrder={-2}
      frustumCulled={false}
    >
      <sphereGeometry args={[1400, 48, 24]} />
      <meshBasicMaterial map={map} side={THREE.BackSide} depthWrite={false} color="#565e6c" />
    </mesh>
  );
}

/* ----------------------------------------------------------------- Moon -- */

const moonScratch = [0, 0, 0];

// The real Moon: true radius at true distance, riding the baked hourly
// ephemeris track (it sweeps ~117 degrees of its orbit across the mission).
// Tidally locked: the same face turns toward Earth the whole way.
function Moon() {
  const group = useRef();
  const [map, normalMap] = useLoader(THREE.TextureLoader, [
    "/textures/moon.jpg",
    "/textures/moon-normal.jpg", // derived from LRO LOLA ldem_3 (SVS CGI Moon Kit)
  ]);
  map.colorSpace = THREE.SRGBColorSpace;
  normalMap.colorSpace = THREE.NoColorSpace;

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
          {/* LOLA-derived normals give the terminator real crater relief. */}
          <meshStandardMaterial
            map={map}
            roughness={1}
            metalness={0}
            normalMap={normalMap}
            normalScale={[0.85, 0.85]}
          />
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

/**
 * Real propulsive windows (nothing fires outside them — the return is a
 * free ride and entry is unpowered). Starts are the documented event times;
 * durations: TLI's 5m55s is published, ARB rides its documented 15-minute
 * burn window, the two perigee raises get the store's dwell windows.
 * ICPS burns fly hydrolox blue-white, the SM's AJ10 a warm hypergolic tint.
 */
const BURNS = [
  { start: EV.PRM, end: EV.PRM + 88, color: new THREE.Color("#bcdcff") },
  { start: EV.ARB, end: EV.ARB + 900, color: new THREE.Color("#bcdcff") },
  { start: EV.SM_PRB, end: EV.SM_PRB + 95, color: new THREE.Color("#ffc998") },
  { start: EV.TLI, end: EV.TLI_END, color: new THREE.Color("#ffc998") },
];

function burnStateAt(met) {
  for (const b of BURNS) {
    if (met < b.start || met > b.end) continue;
    const ease = Math.min(14, (b.end - b.start) * 0.3);
    const k =
      THREE.MathUtils.smoothstep(met, b.start, b.start + ease) *
      (1 - THREE.MathUtils.smoothstep(met, b.end - ease, b.end));
    return { k, color: b.color };
  }
  return null;
}

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
  const plume = useRef();
  const plumeOuterMat = useRef();
  const plumeCoreMat = useRef();
  const plumeGlow = useRef();
  const plasma = useRef();
  const glow = useRef();
  const glowTex = useMemo(makeGlowTexture, []);
  const xAxis = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(), []);
  const pitchAxis = useMemo(() => new THREE.Vector3(), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);
  const flipQuat = useMemo(() => new THREE.Quaternion(), []);

  useFrame(({ camera, clock }, dt) => {
    const st = useMission.getState();
    const met = st.met;
    const s = stateAt(met);
    if (group.current) group.current.position.set(s.x, s.y, s.z);

    // POV rides the hull: hide the stylized stack and its glow so the crew
    // view is sky, not the inside of an oversized cone. The plasma sprite
    // stays — through entry it wraps the lens the way it wrapped the windows.
    const pov = st.camMode === "pov";
    if (model.current) model.current.visible = !pov;
    if (glow.current) glow.current.visible = !pov;

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

    // Engine plume, only inside the real burn windows. Length and glow ease
    // in and out across each window; a wall-clock flicker keeps it alive
    // whatever the warp. The plume rides the model group, so the attitude
    // plumbing above already aims it opposite the velocity vector.
    if (plume.current) {
      const burn = burnStateAt(met);
      const k = burn ? burn.k : 0;
      plume.current.visible = k > 0.002;
      if (plumeGlow.current) plumeGlow.current.visible = k > 0.002;
      if (plume.current.visible) {
        const f = 0.92 + 0.08 * Math.sin(clock.elapsedTime * 31.0);
        plume.current.scale.set(Math.max(k * f, 0.02), 0.55 + 0.45 * k, 0.55 + 0.45 * k);
        plumeOuterMat.current.opacity = 0.62 * k * f;
        plumeOuterMat.current.color.copy(burn.color);
        plumeCoreMat.current.opacity = 0.85 * k * f;
        if (plumeGlow.current) {
          plumeGlow.current.material.opacity = 0.85 * k;
          plumeGlow.current.material.color.copy(burn.color);
          const gs = 0.011 * (0.5 + 0.5 * k * f);
          plumeGlow.current.scale.set(gs, gs, 1);
        }
      }
    }
  });

  return (
    <group ref={group}>
      <group ref={model} scale={0.7}>
        <OrionModel smRef={sm} />
        {/* Plume cones grow backward (-X) from the SM engine bell; the group
            scales on X for length, Y/Z for spread. Hidden outside burns. */}
        <group ref={plume} position={[-0.0155, 0, 0]} visible={false}>
          <mesh rotation={[0, 0, Math.PI / 2]} position={[-0.016, 0, 0]}>
            <coneGeometry args={[0.0056, 0.032, 16, 1, true]} />
            <meshBasicMaterial
              ref={plumeOuterMat}
              color="#bcdcff"
              transparent
              opacity={0}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh rotation={[0, 0, Math.PI / 2]} position={[-0.009, 0, 0]}>
            <coneGeometry args={[0.0028, 0.018, 12, 1, true]} />
            <meshBasicMaterial
              ref={plumeCoreMat}
              color="#ffffff"
              transparent
              opacity={0}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>
        <sprite ref={plumeGlow} position={[-0.0165, 0, 0]} scale={[0.011, 0.011, 1]} visible={false}>
          <spriteMaterial
            map={glowTex}
            color="#bcdcff"
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </sprite>
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

/* -------------------------------------------------------------- Inspect -- */

function makeCrosshairTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(32, 32, 17, 0, Math.PI * 2);
  ctx.stroke();
  // Cross ticks with a gap around the ring, mission-control reticle style.
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of [
    [32, 2, 32, 11],
    [32, 53, 32, 62],
    [2, 32, 11, 32],
    [53, 32, 62, 32],
  ]) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
  return new THREE.CanvasTexture(canvas);
}

/**
 * Trajectory inspection: nearest-sample search in screen space. Raycasting
 * fat Line2 geometry is possible (raycaster.params.Line2) but noisy at
 * grazing angles; projecting all 1,721 ephemeris samples and picking the
 * closest to the pointer is exact, cheap (~100k flops), and lands on a real
 * table row — the chip shows actual JPL Horizons data, never interpolation.
 *
 * Pointer handling deliberately never captures or stops propagation, so
 * OrbitControls drags keep working; a "click" is pointerdown→up within a few
 * pixels. Touch taps pin the chip (with a JUMP HERE button) instead of
 * seeking under the finger.
 */
function segmentHitsSphere(cam, dir, len, cx, cy, cz, r) {
  // Ray from camera along dir (unit), does it enter the sphere before len?
  const ocx = cx - cam.x;
  const ocy = cy - cam.y;
  const ocz = cz - cam.z;
  const b = ocx * dir.x + ocy * dir.y + ocz * dir.z;
  if (b <= 0 || b >= len + r) return false;
  const perp2 = ocx * ocx + ocy * ocy + ocz * ocz - b * b;
  const rr = r * r;
  if (perp2 >= rr) return false;
  return b - Math.sqrt(rr - perp2) < len - 1e-3;
}

function InspectLayer() {
  const { camera, size, gl } = useThree();
  const setHover = useInspect((s) => s.setHover);
  const setPinned = useInspect((s) => s.setPinned);
  const marker = useRef();
  const markerTex = useMemo(makeCrosshairTexture, []);
  const proj = useMemo(() => new THREE.Vector3(), []);
  const rayDir = useMemo(() => new THREE.Vector3(), []);
  const ptr = useRef({
    x: 0,
    y: 0,
    active: false,
    downX: 0,
    downY: 0,
    downAt: 0,
    lastWritten: null, // {i, px, py} to skip redundant store writes
  });

  // Nearest visible (non-occluded) sample to a CSS-pixel point, or null.
  function nearest(px, py, threshold) {
    const { pos, n } = SAMPLES;
    const met = useMission.getState().met;
    moonPosAt(met, moonScratch);
    const t2 = threshold * threshold;
    const w = size.width;
    const h = size.height;
    const cand = [];
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      proj.set(x, y, z).project(camera);
      if (proj.z < -1 || proj.z > 1) continue; // behind / beyond far plane
      const sx = ((proj.x + 1) / 2) * w;
      const sy = ((1 - proj.y) / 2) * h;
      const dx = sx - px;
      const dy = sy - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < t2) cand.push({ i, d2, x, y, z });
    }
    cand.sort((a, b) => a.d2 - b.d2);
    for (const c of cand) {
      rayDir.set(c.x - camera.position.x, c.y - camera.position.y, c.z - camera.position.z);
      const len = rayDir.length();
      if (len < 1e-6) continue;
      rayDir.multiplyScalar(1 / len);
      if (segmentHitsSphere(camera.position, rayDir, len, 0, 0, 0, EARTH_RADIUS_SCENE)) continue;
      if (
        segmentHitsSphere(
          camera.position,
          rayDir,
          len,
          moonScratch[0],
          moonScratch[1],
          moonScratch[2],
          MOON_RADIUS_SCENE
        )
      )
        continue;
      return c;
    }
    return null;
  }

  // Stable ref so the effect below can call the latest closure.
  const nearestRef = useRef(nearest);
  nearestRef.current = nearest;

  useEffect(() => {
    const el = gl.domElement;
    const p = ptr.current;

    const onMove = (e) => {
      if (e.pointerType === "touch") return; // no hover on touch
      const rect = el.getBoundingClientRect();
      p.x = e.clientX - rect.left;
      p.y = e.clientY - rect.top;
      // Dragging (orbit rotate, scrub spillover): suspend hover entirely.
      p.active = e.buttons === 0;
      if (!p.active && p.lastWritten) {
        p.lastWritten = null;
        useInspect.getState().setHover(null);
      }
    };
    const onLeave = () => {
      p.active = false;
      if (p.lastWritten) {
        p.lastWritten = null;
        useInspect.getState().setHover(null);
      }
    };
    const onDown = (e) => {
      if (!e.isPrimary) return;
      p.downX = e.clientX;
      p.downY = e.clientY;
      p.downAt = performance.now();
    };
    const onUp = (e) => {
      if (!e.isPrimary) return;
      const dx = e.clientX - p.downX;
      const dy = e.clientY - p.downY;
      if (dx * dx + dy * dy > 36 || performance.now() - p.downAt > 600) return; // a drag, not a click
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (e.pointerType === "touch") {
        const hit = nearestRef.current(px, py, 30);
        useInspect.getState().setPinned(hit ? { i: hit.i, px, py } : null);
      } else {
        const hit = nearestRef.current(px, py, 16);
        if (hit) {
          useInspect.getState().setPinned(null);
          useMission.getState().seek(SAMPLES.ts[hit.i]);
        }
      }
    };

    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave, { passive: true });
    el.addEventListener("pointerdown", onDown, { passive: true });
    el.addEventListener("pointerup", onUp, { passive: true });
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [gl]);

  useFrame(() => {
    const p = ptr.current;
    // Re-scan every frame while a mouse rests on the canvas: the camera keeps
    // moving under a still pointer, so hover must track the scene, not the
    // last pointermove event.
    if (p.active) {
      const hit = nearest(p.x, p.y, 16);
      const last = p.lastWritten;
      if (!hit && last) {
        p.lastWritten = null;
        setHover(null);
      } else if (hit && (!last || last.i !== hit.i || Math.abs(last.px - p.x) + Math.abs(last.py - p.y) > 2)) {
        p.lastWritten = { i: hit.i, px: p.x, py: p.y };
        setHover(p.lastWritten);
      }
    }

    // Crosshair marker on the inspected sample, constant ~26 px on screen.
    const ins = useInspect.getState();
    const target = ins.hover ?? ins.pinned;
    if (marker.current) {
      marker.current.visible = !!target;
      if (target) {
        const { pos } = SAMPLES;
        const i = target.i;
        marker.current.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        const dist = marker.current.position.distanceTo(camera.position);
        const worldPerPx =
          (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))) / size.height;
        const s = 26 * worldPerPx;
        marker.current.scale.set(s, s, 1);
      }
    }
  });

  return (
    <sprite ref={marker} visible={false} renderOrder={10}>
      <spriteMaterial
        map={markerTex}
        color="#ffffff"
        transparent
        opacity={0.95}
        depthTest={false}
        depthWrite={false}
      />
    </sprite>
  );
}

/**
 * Tiny hook for the Playwright audits: lets a headless run seek the mission
 * clock and ask where a mission time lands on screen, so scripts can hover
 * the real trajectory instead of guessing pixels. Harmless in production.
 */
function AuditHook() {
  const { camera, size } = useThree();
  useEffect(() => {
    window.__orion = {
      state: () => useMission.getState(),
      seek: (t) => useMission.getState().seek(t),
      screenAt: (t) => {
        const s = stateAt(t);
        const v = new THREE.Vector3(s.x, s.y, s.z).project(camera);
        return {
          x: ((v.x + 1) / 2) * size.width,
          y: ((1 - v.y) / 2) * size.height,
          z: v.z,
        };
      },
    };
    return () => {
      delete window.__orion;
    };
  }, [camera, size]);
  return null;
}

/* -------------------------------------------------------------- Cameras -- */

/**
 * POV look scheduling: slerp between mission-phase view directions.
 * `slerpDir` interpolates unit vectors along the great circle (nlerp is fine
 * at these angles but drifts speed; setFromUnitVectors keeps it exact).
 */
const povScratch = {
  q: new THREE.Quaternion(),
  m: new THREE.Matrix4(),
  a: new THREE.Vector3(),
};

function slerpDir(out, from, to, k) {
  if (k <= 0) return out.copy(from);
  if (k >= 1) return out.copy(to);
  povScratch.q.identity();
  povScratch.a.crossVectors(from, to);
  const dot = THREE.MathUtils.clamp(from.dot(to), -1, 1);
  if (povScratch.a.lengthSq() < 1e-12) {
    // Parallel or anti-parallel: fall back to lerp+normalize with a nudge.
    return out.copy(from).lerp(to, k).add(povScratch.a.set(0, 1e-4, 0)).normalize();
  }
  povScratch.a.normalize();
  povScratch.q.setFromAxisAngle(povScratch.a, Math.acos(dot) * k);
  return out.copy(from).applyQuaternion(povScratch.q);
}

function CameraRig() {
  const { camera } = useThree();
  const camMode = useMission((s) => s.camMode);
  const smoothed = useRef(new THREE.Vector3(0, 3, 16));
  const look = useRef(new THREE.Vector3());
  const [orbitTarget, setOrbitTarget] = useState([0, 0, 0]);
  const povQ = useMemo(() => new THREE.Quaternion(), []);
  const povV = useMemo(
    () => ({
      p: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      out: new THREE.Vector3(),
      side: new THREE.Vector3(),
      moonP: new THREE.Vector3(),
      dirEarth: new THREE.Vector3(),
      dirMoon: new THREE.Vector3(),
      dirA: new THREE.Vector3(),
      dirRise: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      up: new THREE.Vector3(),
      upRise: new THREE.Vector3(),
      eye: new THREE.Vector3(),
    }),
    []
  );

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
    // The crew view uses a wider lens: a window, not a telephoto chase drone.
    const wantFov = camMode === "pov" ? 58 : 42;
    if (camera.fov !== wantFov) {
      camera.fov = wantFov;
      camera.updateProjectionMatrix();
    }
    if (camMode === "pov") povQ.copy(camera.quaternion);
  }, [camMode, camera, povQ]);

  useFrame((_, dt) => {
    // ------------------------------------------------------------- POV --
    // Capsule POV: ride just outside the hull and look where the crew
    // looked. One continuous direction schedule across the mission:
    //   ascent/Earth orbit  — prograde, Earth's horizon in the lower frame
    //   outbound coast      — turned to the Moon, watching it grow
    //   flyby               — the Apollo 8 composition: Moon terrain below,
    //                         Earth rising over the lunar limb ("up" is
    //                         away from the Moon, so the limb is a horizon)
    //   return coast        — home: Earth centered, growing
    //   entry               — prograde into the plasma
    if (camMode === "pov") {
      const st = useMission.getState();
      const met = st.met;
      const s = stateAt(met);
      const V = povV;
      V.p.set(s.x, s.y, s.z);

      const dts = THREE.MathUtils.clamp(currentWarp(st) * 0.5, 1, 60);
      const prev = stateAt(met - dts);
      V.fwd.set(s.x - prev.x, s.y - prev.y, s.z - prev.z);
      if (V.fwd.lengthSq() < 1e-10) V.fwd.set(-s.z, 0, s.x);
      V.fwd.normalize();
      V.out.copy(V.p).normalize();

      moonPosAt(met, moonScratch);
      V.moonP.set(moonScratch[0], moonScratch[1], moonScratch[2]);
      V.dirEarth.copy(V.p).multiplyScalar(-1).normalize();
      V.dirMoon.copy(V.moonP).sub(V.p).normalize();

      // Prograde-with-horizon: ahead, biased down toward the planet under us.
      V.dirA.copy(V.fwd).addScaledVector(V.out, -0.38).normalize();

      // Schedule weights. The ephemeris says Earth slips behind the lunar
      // limb ~18 min before closest approach and rises again ~20 min after
      // (the Apollo 8 geometry, rerun) — so the "Earthrise" shot holds from
      // just before occultation until well into departure.
      const kAB = THREE.MathUtils.smoothstep(met, EV.TLI_END + 1200, EV.TLI_END + 26000);
      const kBC = THREE.MathUtils.smoothstep(met, EV.FLYBY - 4200, EV.FLYBY - 1500);
      const kCD = THREE.MathUtils.smoothstep(met, EV.FLYBY + 3600, EV.FLYBY + 9600);
      const kDE = THREE.MathUtils.smoothstep(met, EV.ENTRY - 4800, EV.ENTRY - 900);

      // Earthrise composition, driven by the real separation angle A between
      // Earth and the Moon's center as seen from the capsule: look ~2 deg
      // Moonward of Earth, so Earth rides just above the frame center while
      // the limb (A minus the Moon's angular radius below it) fills the
      // lower frame. While Earth is occulted this collapses toward the
      // Moon's disc on its own — home is behind the rock, then it rises.
      const sepA = THREE.MathUtils.radToDeg(
        Math.acos(THREE.MathUtils.clamp(V.dirEarth.dot(V.dirMoon), -1, 1))
      );
      const kLimb = THREE.MathUtils.clamp(1.7 / Math.max(sepA, 0.001), 0.06, 0.6);
      slerpDir(V.dirRise, V.dirEarth, V.dirMoon, kLimb);

      // The rise itself gets a long lens — Anders shot the original on a
      // 250mm. Zoom in as Earth clears the limb, ease back out on departure.
      const riseZoom =
        THREE.MathUtils.smoothstep(met, EV.FLYBY + 500, EV.FLYBY + 1400) *
        (1 - THREE.MathUtils.smoothstep(met, EV.FLYBY + 3600, EV.FLYBY + 6600));
      const wantFov = 58 - 25 * riseZoom;
      if (Math.abs(camera.fov - wantFov) > 0.01) {
        camera.fov = wantFov;
        camera.updateProjectionMatrix();
      }

      slerpDir(V.dir, V.dirA, V.dirMoon, kAB);
      slerpDir(V.dir, V.dir, V.dirRise, kBC);
      slerpDir(V.dir, V.dir, V.dirEarth, kCD);
      // Entry: back to prograde (blunt-end first — the view out the window
      // is the direction of travel wreathed in plasma).
      slerpDir(V.dir, V.dir, V.dirA, kDE);

      // "Up": away from Earth through most of the flight, away from the Moon
      // through the flyby so the lunar surface reads as the ground below.
      const riseK = kBC * (1 - kCD);
      V.upRise.copy(V.p).sub(V.moonP).normalize();
      slerpDir(V.up, V.out, V.upRise, riseK);

      // Stand a whisker off the flight path so the fat trajectory line
      // doesn't run through the lens.
      V.side.crossVectors(V.out, V.fwd);
      if (V.side.lengthSq() < 1e-9) V.side.set(0, 1, 0);
      V.side.normalize();
      V.eye.copy(V.p).addScaledVector(V.side, 0.05).addScaledVector(V.up, 0.02);

      camera.position.copy(V.eye);
      povScratch.m.lookAt(V.eye, povScratch.a.copy(V.eye).add(V.dir), V.up);
      povQ.setFromRotationMatrix(povScratch.m);
      // Cinematic damping on attitude only; position must track exactly.
      camera.quaternion.slerp(povQ, 1 - Math.exp(-2.6 * dt));
      return;
    }

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
        <MilkyWay />
        <Earth />
        <Moon />
      </Suspense>
      <Trajectory />
      <Capsule />
      <InspectLayer />
      <AuditHook />
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
