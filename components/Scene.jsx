"use client";

import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree, useLoader } from "@react-three/fiber";
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
const ATMO_FRAG = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    float d = 1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0);
    float f = pow(d, 4.5);
    gl_FragColor = vec4(vec3(0.22, 0.45, 1.0), f * 0.65);
  }
`;

function Earth() {
  const map = useLoader(THREE.TextureLoader, "/textures/earth.jpg");
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;

  return (
    <group>
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
      <mesh scale={1.022}>
        <sphereGeometry args={[EARTH_RADIUS_SCENE, 48, 48]} />
        <shaderMaterial
          vertexShader={OVERLAY_VERT}
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

/* ----------------------------------------------------------------- Moon -- */

// Scenery for now (the EFT-1 profile never leaves Earth's neighborhood).
// Distance is compressed; radius is true to scale with the Earth beside it.
function Moon() {
  const map = useLoader(THREE.TextureLoader, "/textures/moon.jpg");
  map.colorSpace = THREE.SRGBColorSpace;
  return (
    <mesh position={[-70, 18, -55]} rotation={[0, Math.PI * 0.9, 0]}>
      <sphereGeometry args={[1.737, 48, 48]} />
      <meshStandardMaterial map={map} roughness={1} metalness={0} />
    </mesh>
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
  const { fullLine, progressLine, progressGeom } = useMemo(() => {
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
    const fullLine = new THREE.Line(
      dimGeom,
      new THREE.LineBasicMaterial({ color: "#5c7099", transparent: true, opacity: 0.45 })
    );

    const progressGeom = new THREE.BufferGeometry();
    progressGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    progressGeom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    progressGeom.setDrawRange(0, 0);
    const progressLine = new THREE.Line(
      progressGeom,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    return { fullLine, progressLine, progressGeom };
  }, []);

  useFrame(() => {
    progressGeom.setDrawRange(0, sampleIndex(useMission.getState().met) + 1);
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
function OrionModel() {
  return (
    <group>
      {/* Crew module: blunt cone, tip forward. */}
      <mesh position={[0.012, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.0135, 0.015, 24]} />
        <meshStandardMaterial color="#dfe2e8" metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Heat shield disc between CM and SM. */}
      <mesh position={[0.0038, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.0138, 0.0138, 0.0015, 24]} />
        <meshStandardMaterial color="#7a5c48" metalness={0.2} roughness={0.7} />
      </mesh>
      {/* Service module. */}
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
  );
}

function Capsule() {
  const group = useRef();
  const model = useRef();
  const plasma = useRef();
  const glowTex = useMemo(makeGlowTexture, []);
  const xAxis = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);

  useFrame(() => {
    const met = useMission.getState().met;
    const s = stateAt(met);
    if (group.current) group.current.position.set(s.x, s.y, s.z);

    // Point the stack along the velocity vector.
    if (model.current) {
      const prev = stateAt(met - 8);
      fwd.set(s.x - prev.x, s.y - prev.y, s.z - prev.z);
      if (fwd.lengthSq() < 1e-10) fwd.set(-s.z, 0, s.x); // pad fallback: local east
      fwd.normalize();
      quat.setFromUnitVectors(xAxis, fwd);
      model.current.quaternion.slerp(quat, 0.25);
    }

    if (plasma.current) {
      const active = s.alt < 135 && s.speed > 1.2 && met > tEntry - 30;
      const k = active ? Math.min(1, s.g / 8.2) : 0;
      plasma.current.material.opacity = k * 0.9;
      const sc = 0.05 + k * 0.22;
      plasma.current.scale.set(sc, sc, 1);
    }
  });

  return (
    <group ref={group}>
      <group ref={model} scale={0.7}>
        <OrionModel />
      </group>
      <sprite scale={[0.032, 0.032, 1]}>
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

  // Mode transitions. Entering orbit: jump to a vantage that frames Earth
  // and the trajectory, instead of inheriting a chase position that leaves
  // the night side filling the screen (the reported "black screen").
  // Returning to chase: sync the smoother so the camera glides, not snaps.
  useEffect(() => {
    if (camMode === "orbit") {
      const s = stateAt(useMission.getState().met);
      const dir = new THREE.Vector3(s.x, s.y, s.z).normalize();
      camera.position.copy(dir.multiplyScalar(30)).add(new THREE.Vector3(0, 10, 0));
      camera.lookAt(0, 0, 0);
    } else {
      smoothed.current.copy(camera.position);
    }
  }, [camMode, camera]);

  useFrame((_, dt) => {
    if (camMode !== "chase") return;
    const met = useMission.getState().met;
    const s = stateAt(met);
    const p = new THREE.Vector3(s.x, s.y, s.z);

    const prev = stateAt(met - 8);
    const fwd = new THREE.Vector3(s.x - prev.x, s.y - prev.y, s.z - prev.z);
    if (fwd.lengthSq() < 1e-9) fwd.set(-p.z, 0, p.x);
    fwd.normalize();

    const out = p.clone().normalize();
    // Far enough back that the capsule reads as a vehicle over a planet,
    // not a silhouette filling the frame. Low over the pad the camera sits
    // higher and pitches down so the ground and horizon anchor the launch;
    // both ease off as altitude builds and space takes over.
    const low = 1 - Math.min(s.alt / 120, 1); // 1 on the pad -> 0 by 120 km
    const dist = (1.35 + (s.alt / 5800) * 3.2) * (1 + low);
    // Low over the pad the camera leads the vehicle and looks back west:
    // east of Canaveral is featureless Atlantic, so a trailing camera sees
    // only blue - while the look-back frames the Florida coastline AND puts
    // the sun behind the lens, front-lighting the spacecraft. The offset
    // swings smoothly to a conventional trailing chase as altitude builds.
    const fwdOffset = -dist * (1 - 2 * low); // ahead at the pad, behind in space
    const target = p
      .clone()
      .addScaledVector(fwd, fwdOffset)
      .addScaledVector(out, dist * (0.5 + 0.4 * low));

    const k = 1 - Math.exp(-3.2 * dt);
    smoothed.current.lerp(target, k);
    look.current.lerp(
      p.clone().addScaledVector(fwd, 0.3 * (1 - low)).addScaledVector(out, -0.12 * low),
      k
    );
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
      maxDistance={90}
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
      camera={{ position: [0, 3, 16], fov: 42, near: 0.01, far: 400 }}
      gl={{ antialias: true }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={["#040508"]} />
      <directionalLight position={[50, 20, 30]} intensity={2.2} />
      {/* Hemisphere fill keeps the night side and backlit spacecraft readable. */}
      <hemisphereLight args={["#4a5c80", "#10141f", 0.85]} />
      <ambientLight intensity={0.18} />
      <ContextGuard />
      <Ticker />
      <Suspense fallback={null}>
        <Earth />
        <Moon />
      </Suspense>
      <Trajectory />
      <Capsule />
      <CameraRig />
      <Stars radius={120} depth={50} count={2500} factor={3.2} saturation={0} fade speed={0} />
      {!reducedMotion && (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.2} luminanceSmoothing={0.35} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
