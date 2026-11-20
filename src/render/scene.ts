/**
 * Three.js view of a Sim. Reads sim state every frame; never writes to it.
 * Works with an expo-gl context on native and web.
 */
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

import { getMove, type MoveId } from '@/game/moves';
import { CATEGORY_COLOR, type Category, type PartDef } from '@/game/parts';
import { aimHeading, ARENA_SIZE, CELL, foeOf, partWorld, type Bug, type Sim, type SimPart } from '@/game/sim';

import { createRenderer } from './gl';
import { ArenaDressing } from './arena';
import { FlexRig, GIVE } from './flex';
import { Spine } from './spine';
import { adjacentPairs, buildConnector, buildPart, seatHeight, setGhost, stackOffset, UNDER_LIFT, UNDER_SCALE, type Connector, type PartModel } from './models';

const HALF = ARENA_SIZE / CELL / 2;
const FOV = 50;
const BG = 0x12151a;

/** Sim floor (x, y) → three world (x, 0, z). One grid cell = 1 unit. */
const toWorld = (x: number, y: number, h = 0) => new THREE.Vector3(x / CELL - HALF, h, y / CELL - HALF);

/** Rotation about +y that points a model's −z at sim heading `h`. */
const yaw = (h: number) => Math.atan2(-Math.cos(h), -Math.sin(h));

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

type PartView = {
  part: SimPart;
  model: PartModel;
  attached: boolean;
  /** 1 when just hit, decays: the part pops. */
  punch: number;
  /** Index in the bug's FlexRig. */
  flex: number;
  /** Rest spot in pose space before the spine bends it. */
  rest: THREE.Vector3;
};
type BugView = {
  group: THREE.Group;
  pose: THREE.Group;
  parts: PartView[];
  /** Frame struts between neighbouring parts; hidden once either end breaks off. */
  links: { a: PartView; b: PartView; c: Connector }[];
  /** Spring joints: parts sway and lag instead of moving as one rigid block. */
  rig: FlexRig;
  /** Bendy body: rows of parts curve on turns and ripple as it walks. */
  spine: Spine;
  /** On the floor (stays down when the bug flies): part shadows + thin team ring. */
  ground: THREE.Group;
  /** Shadows only (shrink as the bug climbs). */
  shadows: THREE.Group;
  /** One soft contact shadow shaped like the bug's footprint; rebuilt when parts break off. */
  shadow: THREE.Mesh;
  /** Attached grid parts the shadow was last drawn for. */
  shadowCount: number;
  baseRadius: number;
  /** Altitude tether: a faint line from a flying bug down to a ring on the floor. */
  tether: THREE.Group;
  /** Silk net shown while webbed. */
  web: THREE.LineSegments;
  /** Mound of churned floor that travels with a burrowed bug. */
  mound: THREE.Mesh;
  /** 0 = on the surface .. 1 = fully underground. */
  sink: number;
  /** Current cloak opacity (1 = solid). */
  ghost: number;
  fxClock: number;
  /** Small bobbing pointer above the player's bug only. */
  marker: THREE.Mesh | null;
  shield: THREE.Group;
  walk: number;
  lean: number;
  lastHeading: number;
  /** Knockback flinch (world units), springs back to zero. */
  kick: THREE.Vector3;
  /** Smoothed wind-up crouch (0..1) and stagger reel (0..1). */
  wind: number;
  reel: number;
  /** Dizzy stars that circle a staggered bug. */
  stars: THREE.Group;
  /** Dodge streak: a fading ghost of the hop, from where it started. */
  trail: THREE.Mesh;
  trailFrom: THREE.Vector3;
  trailLife: number;
  /** Mirror Ward bubble, and a pop when a shot bounces off it. */
  ward: THREE.Group;
  wardPop: number;
  /** Anchor Grip: hooks bitten into the floor round its feet, and a steel ring. */
  anchor: THREE.Group;
  /** Mark Prey: a reticle floating over it (faces the camera), and the snap-in as it's applied. */
  reticle: THREE.Group;
  markSnap: number;
  /** Ink Cloud: dark smudge round its head while blinded. */
  ink: THREE.Group;
  /** Cosmetic leap height (world units) and pitch (Pounce / Dive Bomb). */
  hop: number;
  hopPitch: number;
  /** Ram Charge: head down while it charges (seconds left). */
  ramT: number;
};
/**
 * A signature move being staged: `charge` while the sim is frozen for the
 * cutscene (p = progress through it), then `strike` for a moment after it
 * resolves (the payoff: impacts, recoil, slow motion).
 */
type Cine = { id: MoveId; caster: number; phase: 'charge' | 'strike'; p: number };
/** Seconds of follow-through after an ultimate resolves. */
const FINISH = 0.8;
/** Which weapon each move channels through (for the charge glow). */
const MOVE_PART: Partial<Record<MoveId, { is: (p: PartDef) => boolean; reach: number }>> = {
  'mandible-crusher': { is: (p) => p.category === 'mandibles', reach: 0.9 },
  'venom-barrage': { is: (p) => p.tag === 'venom', reach: 0.9 },
  'sunder-beam': { is: (p) => p.tag === 'laser', reach: 0.8 },
  'carapace-lock': { is: (p) => p.category === 'armor', reach: 0 },
  'hornet-swarm': { is: (p) => p.move === 'hornet-swarm', reach: 0 },
  'quake-stomp': { is: (p) => p.category === 'thorax', reach: 0 },
};
/** Ultimates whose charge gathers around the body (no orb at a weapon). */
const BODY_ULT: MoveId[] = ['carapace-lock', 'quake-stomp'];
/** How long Pounce / Dive Bomb leaps last (mirrors the sim's resolveMove). */
const LEAP_T = { pounce: 0.45, dive: 0.5 };

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * A ribbon along a polyline: two crossed quads per segment, so it reads from
 * any angle (WebGL lines are 1 px). Electric arcs, magnet beams, sight lines.
 */
class Ribbon {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private attr: THREE.BufferAttribute;
  private a = new THREE.Vector3();
  private d = new THREE.Vector3();
  private p1 = new THREE.Vector3();
  private p2 = new THREE.Vector3();
  constructor(
    private max: number,
    color: THREE.ColorRepresentation,
  ) {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 8 * 3);
    const idx: number[] = [];
    for (let s = 0; s < max; s++)
      for (let q = 0; q < 2; q++) {
        const o = s * 8 + q * 4;
        idx.push(o, o + 1, o + 2, o + 2, o + 1, o + 3);
      }
    this.attr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.attr);
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }
  get material() {
    return this.mesh.material as THREE.MeshBasicMaterial;
  }
  /** Lay the ribbon through `pts` (`width` = half-width, tapering to `tip` × width at both ends). */
  set(pts: THREE.Vector3[], width: number, tip = 1) {
    const n = Math.min(pts.length - 1, this.max);
    for (let s = 0; s < n; s++) {
      const a = pts[s];
      const b = pts[s + 1];
      this.d.subVectors(b, a);
      if (this.d.lengthSq() < 1e-8) this.d.set(0, 0, 1e-3);
      this.d.normalize();
      this.p1.crossVectors(this.d, UP);
      if (this.p1.lengthSq() < 1e-6) this.p1.crossVectors(this.d, X_AXIS);
      this.p1.normalize();
      this.p2.crossVectors(this.d, this.p1).normalize();
      const wa = width * (s === 0 ? tip : 1);
      const wb = width * (s === n - 1 ? tip : 1);
      for (let q = 0; q < 2; q++) {
        const p = q ? this.p2 : this.p1;
        const o = (s * 8 + q * 4) * 3;
        this.a.copy(a).addScaledVector(p, wa).toArray(this.pos, o);
        this.a.copy(a).addScaledVector(p, -wa).toArray(this.pos, o + 3);
        this.a.copy(b).addScaledVector(p, wb).toArray(this.pos, o + 6);
        this.a.copy(b).addScaledVector(p, -wb).toArray(this.pos, o + 9);
      }
    }
    this.mesh.geometry.setDrawRange(0, n * 12);
    this.attr.needsUpdate = true;
  }
}

/** Chain Spark / Magnet Pull / Mark Prey: an arc or beam that lives for a moment. */
type Arc = {
  kind: 'spark' | 'magnet' | 'sight';
  glow: Ribbon;
  core: Ribbon;
  /** Sim-space path (spark) — or the two bugs it runs between (magnet, sight). */
  path: THREE.Vector3[];
  from: number;
  to: number;
  life: number;
  max: number;
  /** Next time the jagged path is re-rolled (spark flicker). */
  reroll: number;
  pts: THREE.Vector3[];
};

/** Silvery faceted bubble (Mirror Ward): big flat facets that catch the light, with bright edges. */
function mirrorShell(radius: number) {
  const g = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(radius, 0);
  geo.scale(1, 0.74, 1);
  geo.translate(0, radius * 0.42, 0);
  g.add(
    new THREE.Mesh(
      geo,
      new THREE.MeshPhongMaterial({ color: 0xd8e6f5, specular: 0xffffff, shininess: 90, flatShading: true, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
    ),
  );
  g.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }),
    ),
  );
  return g;
}

/** Shared bits for the per-bug status visuals and move props (built once). */
const STATUS_GEO = {
  hook: new THREE.TorusGeometry(0.2, 0.055, 5, 10, Math.PI),
  puff: new THREE.IcosahedronGeometry(1, 1),
  reticleRing: new THREE.RingGeometry(0.44, 0.52, 32),
  reticleTick: new THREE.PlaneGeometry(0.07, 0.26),
  dot: new THREE.CircleGeometry(0.07, 10),
  hex: new THREE.RingGeometry(0.5, 0.72, 6),
  jaw: new THREE.TorusGeometry(1, 0.1, 6, 18, Math.PI * 0.75),
  crack: new THREE.BoxGeometry(0.09, 0.02, 1).translate(0, 0, 0.5),
};

type Debris = { obj: THREE.Object3D; vel: THREE.Vector3; spin: THREE.Vector3; age: number };

/**
 * Draw a soft contact shadow under a bug: the union of a feathered disc under
 * each attached grid part (max, not sum, so overlaps don't darken), as an
 * alpha texture on one floor plane.
 */
function softShadow(mesh: THREE.Mesh, parts: { part: SimPart; attached: boolean }[]) {
  const pts = parts.filter((p) => p.attached && !p.part.z).map((p) => ({ x: p.part.lx / CELL, y: p.part.ly / CELL }));
  const mat = mesh.material as THREE.MeshBasicMaterial;
  mat.alphaMap?.dispose();
  mesh.visible = pts.length > 0;
  if (!pts.length) return;
  const M = 1.1;
  const x0 = Math.min(...pts.map((p) => p.x)) - M;
  const x1 = Math.max(...pts.map((p) => p.x)) + M;
  const y0 = Math.min(...pts.map((p) => p.y)) - M;
  const y1 = Math.max(...pts.map((p) => p.y)) + M;
  const PX = 14;
  const W = Math.ceil((x1 - x0) * PX);
  const H = Math.ceil((y1 - y0) * PX);
  const data = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) / PX;
      // Texture rows run along +v, which the rotated plane maps to −z.
      const y = y1 - (j + 0.5) / PX;
      let d = Infinity;
      for (const p of pts) d = Math.min(d, Math.hypot(x - p.x, y - p.y));
      const t = Math.min(1, Math.max(0, (1.0 - d) / 0.75));
      const a = t * t * (3 - 2 * t);
      const o = (j * W + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.round(a * 255);
      data[o + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  mat.alphaMap = tex;
  mat.needsUpdate = true;
  mesh.scale.set(x1 - x0, y1 - y0, 1);
  mesh.position.set((x0 + x1) / 2, 0.025, (y0 + y1) / 2);
}

/** Faceted energy shell (Carapace Lock): a faint additive fill plus bright facet edges. */
function hexShell(radius: number) {
  const g = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  geo.scale(1, 0.72, 1);
  geo.translate(0, radius * 0.45, 0);
  g.add(
    new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x4fa8ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    ),
  );
  g.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    ),
  );
  return g;
}

/** Point an object's local +z along a world direction. */
const faceAlong = (o: THREE.Object3D, d: THREE.Vector3) => o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.clone().normalize());

export class ArenaRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private bugs: BugView[] = [];
  private debris: Debris[] = [];
  private projectiles: THREE.Mesh[] = [];
  private sparks: THREE.Mesh[] = [];
  private arena: ArenaDressing;
  private aura: THREE.Group;
  private auraSparks: THREE.Mesh[] = [];
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private clock = 0;
  private ultWeight = 0;
  /** Pulled further back on tall (portrait) screens so the arena fits. */
  /** ≥1: how much to pull cameras back for narrow (portrait) screens. */
  private aspectK = 1;
  private ultSide = 0;
  /** Direction the camera looks from (radians around +y; 0 = from the south side). */
  private camYaw = 0;
  /** Pre-fight intro, 1 → 0: the camera swoops in from high above as it counts down. */
  intro = 0;
  private eventCursor = 0;
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private bits: { m: THREE.Mesh; vel: THREE.Vector3; life: number; max: number }[] = [];
  private nextBit = 0;
  private waves: { m: THREE.Mesh; life: number; max: number; size: number }[] = [];
  private nextWave = 0;
  /** Follow-through after an ultimate resolves. */
  private finisher: { id: MoveId; caster: number; t: number } | null = null;
  /** Glowing orb that gathers at the weapon during a charge. */
  private orb: THREE.Mesh;
  /** Speed streaks behind a lunging / dashing bug. */
  private streaks: THREE.Mesh[] = [];
  private streakLife = 0;
  private streakBug = 0;
  private streakColor = new THREE.Color();
  /** Trails behind big venom darts (pooled alongside projectiles). */
  private trails: THREE.Mesh[] = [];
  /** Sunder Beam: a glowing shaft (outer colour + white core), unit length along +z. */
  private beam = new THREE.Group();
  /** Flash spheres (muzzle flash, bite flash). */
  private flashes: { m: THREE.Mesh; life: number; max: number; size: number }[] = [];
  /** Hornet Swarm drones and Thorn Bloom spikes, made on demand per projectile slot. */
  private drones: (THREE.Group | undefined)[] = [];
  private thorns: (THREE.Mesh | undefined)[] = [];
  /** Chain Spark arcs, Magnet Pull beams, Mark Prey sight lines. */
  private arcs: Arc[] = [];
  /** Field rings that slide along a Magnet Pull beam toward the caster. */
  private fieldRings: THREE.Mesh[] = [];
  /** Soft puffs: ink smog, stomp dust, landing dust. */
  private puffs: { m: THREE.Mesh; vel: THREE.Vector3; life: number; max: number; size: number; alpha: number }[] = [];
  private nextPuff = 0;
  /** Mirror Ward bounces: a silver hex shard that faces the camera. */
  private hexes: { m: THREE.Mesh; life: number }[] = [];
  /** Vise Lock: two jaws that clamp shut round the enemy. */
  private clamps: { g: THREE.Group; bug: number; from: number; life: number }[] = [];
  /** Quake Stomp: cracks radiating across the floor (dark, with a hot glow that fades first). */
  private cracks = new THREE.Group();
  private crackLife = 0;
  /** Extra cosmetic camera rumble (Quake Stomp), decays. */
  private rumble = 0;

  /**
   * Wall-clock pacing hint for the screen's sim loop: a brief slow motion
   * right as an ultimate lands (cosmetic; the sim itself stays deterministic).
   */
  get timeScale() {
    const f = this.finisher;
    if (!f) return 1;
    return f.t < 0.12 ? 0.25 : f.t < 0.55 ? 0.25 + ((f.t - 0.12) / 0.43) * 0.75 : 1;
  }

  constructor(
    private gl: ExpoWebGLRenderingContext,
    sim: Sim,
  ) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.renderer = createRenderer(gl, BG);

    this.camera = new THREE.PerspectiveCamera(FOV, w / h, 0.1, 200);
    this.fitOffset(w / h);

    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x30343c, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-8, 20, 10);
    this.scene.add(sun);

    this.arena = new ArenaDressing(this.scene, sim);
    sim.bugs.forEach((b) => this.bugs.push(this.buildBug(b)));

    // Ultimate charge aura (hidden until needed).
    this.aura = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.12, 6, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }),
    );
    ring.rotation.x = Math.PI / 2;
    this.aura.add(ring);
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      this.aura.add(s);
      this.auraSparks.push(s);
    }
    this.aura.visible = false;
    this.scene.add(this.aura);

    // Impact particles and break shockwaves (pooled).
    const bitGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(bitGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      m.visible = false;
      this.scene.add(m);
      this.bits.push({ m, vel: new THREE.Vector3(), life: 0, max: 1 });
    }
    const waveGeo = new THREE.RingGeometry(0.82, 1, 28);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(waveGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.scene.add(m);
      this.waves.push({ m, life: 0, max: 0.45, size: 1 });
    }

    this.orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.orb.visible = false;
    this.scene.add(this.orb);
    const shaft = new THREE.CylinderGeometry(1, 1, 1, 12).rotateX(Math.PI / 2);
    this.beam.add(new THREE.Mesh(shaft, new THREE.MeshBasicMaterial({ color: 0x5cf2ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })));
    const core = new THREE.Mesh(shaft, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    core.scale.set(0.4, 0.4, 1);
    this.beam.add(core);
    this.beam.visible = false;
    this.scene.add(this.beam);
    const streakGeo = new THREE.BoxGeometry(0.06, 0.06, 1);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(
        streakGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      m.visible = false;
      this.scene.add(m);
      this.streaks.push(m);
    }
    const flashGeo = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(
        flashGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      m.visible = false;
      this.scene.add(m);
      this.flashes.push({ m, life: 0, max: 1, size: 1 });
    }
    for (let i = 0; i < 3; i++) {
      const glow = new Ribbon(48, 0xffffff);
      const core = new Ribbon(48, 0xffffff);
      this.scene.add(glow.mesh, core.mesh);
      this.arcs.push({ kind: 'spark', glow, core, path: [], from: 0, to: 0, life: 0, max: 1, reroll: 0, pts: Array.from({ length: 49 }, () => new THREE.Vector3()) });
    }
    const ringGeo = new THREE.TorusGeometry(0.5, 0.05, 4, 20);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xaeb8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false;
      this.scene.add(m);
      this.fieldRings.push(m);
    }
    for (let i = 0; i < 28; i++) {
      const m = new THREE.Mesh(STATUS_GEO.puff, new THREE.MeshBasicMaterial({ color: 0x2b2838, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false;
      this.scene.add(m);
      this.puffs.push({ m, vel: new THREE.Vector3(), life: 0, max: 1, size: 1, alpha: 1 });
    }
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(STATUS_GEO.hex, new THREE.MeshBasicMaterial({ color: 0xe6f2ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false;
      this.scene.add(m);
      this.hexes.push({ m, life: 0 });
    }
    const jawMat = new THREE.MeshBasicMaterial({ color: 0xff6b5a, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      for (const sd of [1, -1]) {
        const jaw = new THREE.Mesh(STATUS_GEO.jaw, jawMat);
        jaw.rotation.set(Math.PI / 2, 0, sd > 0 ? Math.PI * 0.125 : Math.PI * 1.125);
        g.add(jaw);
      }
      g.visible = false;
      this.scene.add(g);
      this.clamps.push({ g, bug: 0, from: 0, life: 0 });
    }
    // Quake Stomp floor cracks: zig-zag lines out from the centre (dark seam + hot glow).
    const seam = new THREE.MeshBasicMaterial({ color: 0x1c130d, transparent: true, opacity: 0, depthWrite: false });
    const hot = new THREE.MeshBasicMaterial({ color: 0xff9a3d, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 9; i++) {
      let a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
      let at = new THREE.Vector3(Math.cos(a) * 1.2, 0, Math.sin(a) * 1.2);
      for (let k = 0; k < 4; k++) {
        const len = 1.1 + Math.random() * 1.3;
        a += (Math.random() - 0.5) * 0.9;
        for (const [mat, w] of [
          [seam, 1.6],
          [hot, 0.7],
        ] as const) {
          const m = new THREE.Mesh(STATUS_GEO.crack, mat);
          m.position.copy(at).setY(mat === seam ? 0.035 : 0.045);
          m.rotation.y = Math.atan2(Math.cos(a), Math.sin(a));
          m.scale.set(w * (1 - k * 0.2), 1, len);
          this.cracks.add(m);
        }
        at = at.clone().add(new THREE.Vector3(Math.cos(a) * len, 0, Math.sin(a) * len));
      }
    }
    this.cracks.visible = false;
    this.scene.add(this.cracks);

    // Start the fight camera already in position (a long step snaps it there).
    this.updateCamera(sim, 10, 0);
  }

  private buildBug(bug: Bug): BugView {
    const group = new THREE.Group();
    const pose = new THREE.Group();
    group.add(pose);
    const ground = new THREE.Group();
    const shadows = new THREE.Group();
    ground.add(shadows);
    const seats = new Map<string, number>();
    // A part with something slung underneath rides higher.
    const lifted = new Set(bug.parts.filter((p) => p.z === -1).map((p) => `${p.x},${p.y}`));
    const lift = (p: SimPart) => (lifted.has(`${p.x},${p.y}`) ? UNDER_LIFT : 0);
    const parts = bug.parts.map((p) => {
      const model = buildPart(p.part.id, p.z ? 0 : Math.sign(Math.round(p.lx)), p.y);
      model.root.position.set(p.lx / CELL, 0, p.ly / CELL);
      model.root.rotation.y = -p.r * (Math.PI / 2); // weapons can point sideways or backwards
      pose.add(model.root);
      if (!p.z) {
        model.root.position.y = lift(p);
        seats.set(`${p.x},${p.y}`, seatHeight(model) + lift(p));
      }
      if (p.z === -1) {
        model.root.scale.setScalar(UNDER_SCALE);
        model.root.position.y = 0.02;
      }
      return { part: p, model, attached: true, punch: 0, flex: -1, rest: new THREE.Vector3() };
    });
    // Stacked parts rest on top of the part in their cell.
    for (const pv of parts) {
      if (pv.part.z === 1) pv.model.root.position.y = stackOffset(pv.model, seats.get(`${pv.part.x},${pv.part.y}`) ?? 0.9);
    }

    const onGrid = parts.filter((pv) => !pv.part.z);
    const links = adjacentPairs(onGrid.map((pv) => pv.part)).map(([i, j]) => {
      const a = onGrid[i];
      const b = onGrid[j];
      const c = buildConnector(a.part.part.category, b.part.part.category);
      c.update(a.model.root.position, b.model.root.position);
      pose.add(c.obj);
      return { a, b, c };
    });

    // Spring joints: each part hangs off the neighbour one step closer to the
    // thorax (stacked/slung parts off the part in their cell).
    for (const pv of parts) pv.rest.copy(pv.model.root.position);
    const rig = new FlexRig(pose);
    const at = new Map(onGrid.map((pv) => [`${pv.part.x},${pv.part.y}`, pv]));
    const root = onGrid.find((pv) => pv.part.part.category === 'thorax') ?? onGrid[0];
    const queue: { pv: PartView; parent: number; depth: number }[] = root ? [{ pv: root, parent: -1, depth: 0 }] : [];
    const seen = new Set<PartView>(root ? [root] : []);
    while (queue.length) {
      const { pv, parent, depth } = queue.shift()!;
      pv.flex = rig.add(pv.model.root, pv.model.root.position, parent, GIVE[pv.part.part.category], depth);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const n = at.get(`${pv.part.x + dx},${pv.part.y + dy}`);
        if (n && !seen.has(n)) {
          seen.add(n);
          queue.push({ pv: n, parent: pv.flex, depth: depth + 1 });
        }
      }
    }
    for (const pv of parts) {
      if (pv.flex >= 0) continue;
      const base = at.get(`${pv.part.x},${pv.part.y}`);
      pv.flex = rig.add(pv.model.root, pv.model.root.position, base && !pv.part.z ? -1 : (base?.flex ?? -1), GIVE[pv.part.part.category], 2);
    }
    rig.finalize();
    const thorax = onGrid.find((pv) => pv.part.part.category === 'thorax') ?? onGrid[0];
    const spine = new Spine(
      onGrid.map((pv) => pv.rest.z),
      thorax?.rest.z ?? 0,
    );

    const r = bug.radius / CELL;
    const team = bug.team === 0 ? (bug.index === 0 ? 0x3ddc97 : 0x58c7ff) : 0xff5d5d;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r + 0.22, r + 0.29, 40),
      new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.14, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ground.add(ring);
    this.scene.add(ground);

    // A small camera-facing pointer over the player's bug.
    let marker: THREE.Mesh | null = null;
    if (bug.index === 0) {
      const tri = new THREE.Shape();
      tri.moveTo(-0.26, 0.3);
      tri.lineTo(0.26, 0.3);
      tri.lineTo(0, -0.12);
      tri.closePath();
      marker = new THREE.Mesh(new THREE.ShapeGeometry(tri), new THREE.MeshBasicMaterial({ color: team, depthTest: false, transparent: true, opacity: 0.9 }));
      marker.renderOrder = 10;
      this.scene.add(marker);
    }

    // Flight height cue (hidden on the ground).
    const tether = new THREE.Group();
    const tetherMat = new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.6, depthWrite: false });
    tether.add(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1, 6), tetherMat));
    const tring = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.8, 28), new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
    tring.rotation.x = -Math.PI / 2;
    tring.position.y = 0.05;
    tether.add(tring);
    tether.visible = false;
    this.scene.add(tether);

    const shield = hexShell(r + 0.6);
    shield.visible = false;
    group.add(shield);
    // Silk net (Web Snare).
    const webGeo = new THREE.IcosahedronGeometry(r + 0.35, 2);
    webGeo.scale(1, 0.6, 1);
    webGeo.translate(0, (r + 0.35) * 0.3, 0);
    const web = new THREE.LineSegments(
      new THREE.EdgesGeometry(webGeo),
      new THREE.LineBasicMaterial({ color: 0xf4f1e6, transparent: true, opacity: 0.75, depthWrite: false }),
    );
    web.visible = false;
    group.add(web);
    // Travelling dirt mound (Burrow Strike).
    const mound = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshToonMaterial({ color: 0x3f2c1c }));
    mound.scale.set(r * 0.75, 0.5, r * 0.75);
    mound.visible = false;
    this.scene.add(mound);
    this.scene.add(group);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 1;
    shadows.add(shadow);
    softShadow(shadow, parts);
    const stars = new THREE.Group();
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffd23f });
    for (let i = 0; i < 4; i++) {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), starMat);
      const a = (i / 4) * Math.PI * 2;
      star.position.set(Math.cos(a) * r * 0.55, 0, Math.sin(a) * r * 0.55);
      stars.add(star);
    }
    stars.position.y = 2.7;
    stars.visible = false;
    group.add(stars);
    const trail = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.05, 1),
      new THREE.MeshBasicMaterial({ color: bug.team === 0 ? 0x9df3ff : 0xffc9a8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    trail.visible = false;
    this.scene.add(trail);

    // Mirror Ward bubble.
    const ward = mirrorShell(r + 0.75);
    ward.visible = false;
    group.add(ward);
    // Anchor Grip: six hooks round the feet (they drive down into the floor) on a steel ring.
    const anchor = new THREE.Group();
    const hookMat = new THREE.MeshToonMaterial({ color: 0x9aa7bd });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const hook = new THREE.Mesh(STATUS_GEO.hook, hookMat);
      hook.position.set(Math.cos(a) * (r * 0.8 + 0.2), 0, Math.sin(a) * (r * 0.8 + 0.2));
      hook.rotation.y = -a;
      anchor.add(hook);
    }
    const aring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.8 + 0.1, r * 0.8 + 0.3, 36),
      new THREE.MeshBasicMaterial({ color: 0x9aa7bd, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }),
    );
    aring.rotation.x = -Math.PI / 2;
    aring.position.y = 0.04;
    anchor.add(aring);
    anchor.visible = false;
    ground.add(anchor);
    // Mark Prey reticle: ring, four ticks, a centre dot and a pip per sure crit left.
    const reticle = new THREE.Group();
    const retMat = new THREE.MeshBasicMaterial({ color: 0xff8fd8, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(STATUS_GEO.reticleRing, retMat));
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(STATUS_GEO.reticleTick, retMat);
      const a = (i / 4) * Math.PI * 2;
      tick.position.set(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0);
      tick.rotation.z = a + Math.PI / 2;
      spin.add(tick);
    }
    reticle.add(spin);
    reticle.add(new THREE.Mesh(STATUS_GEO.dot, retMat));
    for (let i = 0; i < 3; i++) {
      const pip = new THREE.Mesh(STATUS_GEO.dot, retMat);
      pip.position.set((i - 1) * 0.24, -0.74, 0);
      reticle.add(pip);
    }
    reticle.traverse((o) => (o.renderOrder = 11));
    reticle.visible = false;
    this.scene.add(reticle);
    // Ink smudge round the head (Ink Cloud).
    const ink = new THREE.Group();
    const inkMat = new THREE.MeshBasicMaterial({ color: 0x24202f, transparent: true, opacity: 0.7, depthWrite: false });
    for (let i = 0; i < 6; i++) ink.add(new THREE.Mesh(STATUS_GEO.puff, inkMat));
    const head = parts.find((pv) => pv.part.part.category === 'head' && !pv.part.z) ?? parts.reduce((a, b) => (b.model.root.position.z < a.model.root.position.z ? b : a), parts[0]);
    ink.position.set(head?.model.root.position.x ?? 0, 0.75, head?.model.root.position.z ?? -r * 0.6);
    ink.visible = false;
    group.add(ink);
    return { group, pose, parts, links, rig, spine, tether, web, mound, sink: 0, ghost: 1, fxClock: 0, ground, shadows, shadow, shadowCount: parts.length, baseRadius: r, marker, shield, walk: 0, lean: 0, lastHeading: bug.heading, kick: new THREE.Vector3(), wind: 0, reel: 0, stars, trail, trailFrom: new THREE.Vector3(), trailLife: 0, ward, wardPop: 0, anchor, reticle, markSnap: 0, ink, hop: 0, hopPitch: 0, ramT: 0 };
  }

  private fitOffset(aspect: number) {
    this.aspectK = Math.max(1, 0.85 / aspect);
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitOffset(w / h);
  }

  render(sim: Sim, dt: number) {
    this.clock += dt;
    const t = this.clock;
    const ult = sim.ult;

    this.react(sim);
    this.updateReactions(dt);
    if (this.finisher) {
      this.finisher.t += dt;
      if (this.finisher.t > FINISH) this.finisher = null;
    }
    const cine = this.cine(sim);

    // Bugs
    const frozen = !!ult || sim.hitstop > 0 || sim.over;
    sim.bugs.forEach((bug, bi) => {
      const v = this.bugs[bi];
      v.kick.multiplyScalar(Math.exp(-dt * 13));
      const altU = bug.alt / CELL;
      v.group.position.copy(toWorld(bug.pos.x, bug.pos.y, altU)).add(v.kick);
      this.statusFx(sim, bug, v, t, dt);
      v.group.rotation.y = yaw(bug.heading);
      // Floor marks stay on the floor; shadows shrink as the bug climbs.
      v.ground.position.copy(toWorld(bug.pos.x, bug.pos.y));
      v.ground.rotation.y = v.group.rotation.y;
      v.shadows.scale.setScalar(Math.max(0.45, 1 - altU * 0.18));
      (v.shadow.material as THREE.MeshBasicMaterial).opacity = 0.42 * Math.max(0.35, 1 - altU * 0.12);
      // Height cue for flyers: a line down to the floor and a ring where it lands.
      v.tether.visible = altU > 0.35 && !bug.dead && v.ghost > 0.2;
      if (v.tether.visible) {
        v.tether.position.copy(toWorld(bug.pos.x, bug.pos.y));
        const line = v.tether.children[0];
        line.scale.y = altU + 0.3;
        line.position.y = (altU + 0.3) / 2;
        const ring = v.tether.children[1] as THREE.Mesh;
        ring.scale.setScalar(0.8 + Math.sin(t * 4) * 0.08);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.min(0.3, altU * 0.08);
      }
      // Carapace shell: forms during the Carapace Lock charge, then holds while the shield lasts.
      const forming = cine?.id === 'carapace-lock' && cine.caster === bi && cine.phase === 'charge' ? smooth((cine.p - 0.35) / 0.55) : 0;
      v.shield.visible = bug.shield > 0 || forming > 0;
      if (v.shield.visible) {
        const snap = cine?.id === 'carapace-lock' && cine.caster === bi && cine.phase === 'strike' ? 1 - cine.p : 0;
        const sc = bug.shield > 0 ? 1 + snap * snap * 0.2 + Math.sin(t * 5) * 0.015 : 1.35 - forming * 0.35;
        v.shield.scale.setScalar(sc);
        v.shield.rotation.y = t * 0.6;
        const fill = v.shield.children[0] as THREE.Mesh;
        const edges = v.shield.children[1] as THREE.LineSegments;
        const a = bug.shield > 0 ? Math.min(1, bug.shield * 2) * (0.75 + Math.sin(t * 7) * 0.25) : forming;
        (fill.material as THREE.MeshBasicMaterial).opacity = 0.06 * a + snap * 0.12;
        (edges.material as THREE.LineBasicMaterial).opacity = 0.6 * a;
      }
      v.ground.visible = !bug.dead && v.sink < 0.5 && v.ghost > 0.2;
      v.ground.scale.setScalar(Math.max(0.4, bug.radius / CELL / v.baseRadius));
      if (v.marker) {
        v.marker.visible = !bug.dead && !ult;
        v.marker.position.copy(v.group.position).setY(v.group.position.y + 3.6 + Math.sin(t * 3) * 0.1);
        v.marker.quaternion.copy(this.camera.quaternion);
      }

      // Locomotion: the walk cycle advances with distance covered; the body bobs and leans into turns.
      const speedAbs = Math.hypot(bug.vel.x, bug.vel.y);
      const speed = bug.dead ? 0 : Math.min(1, speedAbs / 90);
      let turn = bug.heading - v.lastHeading;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      v.lastHeading = bug.heading;
      if (!frozen && !bug.dead) {
        v.walk += (speedAbs / CELL) * dt * 2.4;
        const want = THREE.MathUtils.clamp((-turn / Math.max(dt, 1e-3)) * 0.05, -0.16, 0.16);
        v.lean += (want - v.lean) * Math.min(1, dt * 8);
      }

      // Signature-move choreography (see poseCine), or the normal locomotion pose.
      let ov: { weapon?: Category; attack?: number; air?: number; glow?: number } = {};
      if (cine && cine.caster === bi && cine.phase === 'charge') {
        ov = this.poseCine(v, cine, t, sim);
      } else {
        if (cine && cine.caster === bi && cine.id === 'mandible-crusher') ov = { weapon: 'mandibles', attack: 1 - smooth(cine.p / 0.5) };
        v.pose.scale.lerp(new THREE.Vector3(1, 1, 1), 0.3);
        v.pose.position.x *= 0.7;
        v.pose.position.z *= 0.75;
        // (Wrap first: Carapace Lock ends a full turn round, which must not unwind.)
        const ry = v.pose.rotation.y;
        v.pose.rotation.y = (((ry + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        v.pose.rotation.y *= 0.7;
        // Nose down when diving, up when climbing, levelling out on the way down to land.
        const high = THREE.MathUtils.clamp((bug.alt - 2) / 26, 0, 1);
        // Wide open after a miss: it slumps forward.
        // (Plus the arc of a Pounce / Dive Bomb, and head down for a Ram Charge.)
        const tilt = THREE.MathUtils.clamp(bug.vAlt / 260, -0.35, 0.3) * high - (bug.open > 0 && !bug.dead ? 0.1 : 0) + v.hopPitch - (v.ramT > 0 ? 0.12 : 0);
        v.pose.rotation.x += (tilt - v.pose.rotation.x) * (high < 1 ? 0.35 : 0.2);
        // Strikes read as a motion: crouch back while a weapon winds up, then snap forward as it lands.
        let swinging = false;
        let struck = 9;
        for (const p of bug.parts) {
          if (!p.alive || !p.part.weapon || p.part.weapon.projectileSpeed) continue;
          if (p.windup > 0) swinging = true;
          struck = Math.min(struck, p.struck);
        }
        v.wind += ((swinging && !bug.dead ? 1 : 0) - v.wind) * Math.min(1, dt * 24);
        const lash = !bug.dead && sim.time > 1 && struck < 0.16 ? 1 - struck / 0.16 : 0;
        v.pose.position.z += (0.24 * v.wind - 0.42 * lash) * 0.25; // (×0.25: this adds up against the ×0.75 decay above)
        v.pose.scale.set(1 + 0.06 * v.wind - 0.03 * lash, 1 - 0.13 * v.wind + 0.05 * lash, 1 - 0.05 * v.wind + 0.14 * lash);
        // While pitched, lift the body so the dipping end (the pivot is mid-body) can't sink into the floor.
        const clear = Math.abs(Math.sin(v.pose.rotation.x)) * (bug.radius / CELL) * 0.9;
        const bob = bug.dead ? 0 : Math.abs(Math.sin(v.walk)) * 0.05 * speed + Math.sin(t * 2.2 + bi) * 0.012;
        v.pose.position.y += (bob + clear - v.pose.position.y) * 0.3;
        v.pose.position.y = Math.max(v.pose.position.y, clear);
      }
      // Bend the spine (turning lag, walking sway and ripple), then the spring joints on top,
      // then re-seat the struts between the swaying parts.
      const yawRate = frozen || bug.dead ? 0 : -turn / Math.max(dt, 1e-3);
      v.spine.update(frozen ? 0 : dt, THREE.MathUtils.clamp(yawRate, -6, 6), v.walk, speed, Math.min(1, bug.alt / 14), t);
      for (const pv of v.parts) {
        if (!pv.attached || pv.flex < 0) continue;
        const b = v.spine.transform(pv.rest.x, pv.rest.z);
        this.tmpV.set(b.x, pv.rest.y + b.lift, b.z);
        v.rig.setPose(pv.flex, this.tmpV, b.yaw, b.pitch);
      }
      // Near the floor, parts can bounce up but not sag into it (e.g. on landing).
      v.rig.floor = bug.alt < 10 ? -0.03 : -Infinity;
      v.rig.update(dt);
      for (const l of v.links) {
        l.c.obj.visible = l.a.attached && l.b.attached && v.ghost > 0.9;
        if (l.c.obj.visible) l.c.update(l.a.model.root.position, l.b.model.root.position);
      }
      // Staggered: it reels, with stars circling. Dodging: it banks into the hop.
      v.reel += ((bug.stagger > 0 && !bug.dead ? 1 : 0) - v.reel) * Math.min(1, dt * 10);
      v.stars.visible = v.reel > 0.3 && v.ghost > 0.5;
      if (v.stars.visible) {
        v.stars.rotation.y = t * 5;
        v.stars.position.y = 2.7 + Math.sin(t * 6) * 0.12;
      }
      let bank = 0;
      if (bug.dash > 0) {
        const sp = Math.hypot(bug.dashVel.x, bug.dashVel.y) || 1;
        bank = ((-Math.sin(bug.heading) * bug.dashVel.x + Math.cos(bug.heading) * bug.dashVel.y) / sp) * -0.38;
      }
      if (bug.dead) v.pose.rotation.z = Math.min(0.5, v.pose.rotation.z + dt);
      else v.pose.rotation.z = v.lean + Math.sin(v.walk) * 0.025 * speed + Math.sin(t * 13) * 0.17 * v.reel + bank;
      // Dodge streak, fading out behind it.
      v.trailLife = Math.max(0, v.trailLife - dt);
      v.trail.visible = v.trailLife > 0;
      if (v.trail.visible) {
        const to = v.group.position;
        const dx = to.x - v.trailFrom.x;
        const dz = to.z - v.trailFrom.z;
        const len = Math.hypot(dx, dz);
        v.trail.position.set((to.x + v.trailFrom.x) / 2, to.y + 0.45, (to.z + v.trailFrom.z) / 2);
        v.trail.rotation.y = Math.atan2(dx, dz);
        v.trail.scale.set(v.baseRadius * 1.1, 1, Math.max(0.01, len));
        (v.trail.material as THREE.MeshBasicMaterial).opacity = 0.42 * (v.trailLife / 0.38);
      }

      const attachedNow = v.parts.reduce((n, pv) => n + (pv.attached ? 1 : 0), 0);
      if (attachedNow !== v.shadowCount) {
        v.shadowCount = attachedNow;
        softShadow(v.shadow, v.parts);
      }
      for (const pv of v.parts) {
        if (pv.attached && !pv.part.alive) this.detach(bug, pv);
        if (!pv.attached) continue;
        const p = pv.part;
        pv.model.tint(Math.max(0, p.hp) / p.part.hp, p.flash > 0, ov.glow ?? 0);
        pv.punch = Math.max(0, pv.punch - dt * 7);
        pv.model.root.scale.setScalar(1 + pv.punch * pv.punch * 0.3);
        if (bug.dead) continue;
        // 1 at the moment the weapon fires, fading over ~0.28 s.
        const w = p.part.weapon;
        // Rear back (jaws wide, stinger cocked) through the wind-up; 1 at the moment it lands or fires, fading over ~0.28 s.
        let attack = 0;
        if (w && sim.time > 1) attack = p.windup > 0 ? -0.9 * Math.min(1, 1.35 - p.windup / 0.34) : THREE.MathUtils.clamp(1 - p.struck / 0.28, 0, 1);
        if (ov.attack !== undefined && ov.weapon === p.part.category) attack = ov.attack;
        pv.model.animate({ t, walk: v.walk, speed, attack, air: Math.max(ov.air ?? 0, Math.min(1, bug.alt / 14)) });
      }
    });

    this.updateDebris(dt);
    this.arena.update(sim, t, dt);
    this.updateProjectiles(sim);
    this.updateSparks(sim);
    this.updateCineFx(sim, cine, t, dt);
    this.updateMoveFx(sim, t, dt);
    this.updateCamera(sim, dt, t);

    this.renderer.render(this.scene, this.camera);
    this.gl.endFrameEXP();
  }

  /** Screen position (0..1 from the top-left) of a point on the arena floor plane, `h` units up. */
  project(x: number, y: number, h = 1): { x: number; y: number } {
    const p = toWorld(x, y, h).project(this.camera);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  }

  private burst(at: THREE.Vector3, count: number, color: THREE.ColorRepresentation, power: number) {
    for (let i = 0; i < count; i++) {
      const b = this.bits[this.nextBit];
      this.nextBit = (this.nextBit + 1) % this.bits.length;
      const a = Math.random() * Math.PI * 2;
      const up = 2 + Math.random() * 4;
      const out = (1.5 + Math.random() * 3) * power;
      b.vel.set(Math.cos(a) * out, up * power, Math.sin(a) * out);
      b.m.position.copy(at);
      (b.m.material as THREE.MeshBasicMaterial).color.set(color);
      b.life = b.max = 0.35 + Math.random() * 0.3;
      b.m.visible = true;
    }
  }

  /** Turn new sim events into reactions: part pop, knockback flinch, sparks, shockwaves. */
  private react(sim: Sim) {
    for (; this.eventCursor < sim.events.length; this.eventCursor++) {
      const e = sim.events[this.eventCursor];
      if (e.type === 'hit') {
        const v = this.bugs[e.bug];
        const pv = v.parts[e.part];
        if (pv) pv.punch = 1;
        // Knock the struck part's joint away from the attacker (in the bug's pose space).
        if (pv && e.by !== null) {
          const from = sim.bugs[e.by].pos;
          const dir = toWorld(e.x, e.y).sub(toWorld(from.x, from.y)).setY(0.4);
          if (dir.lengthSq() > 1e-6) {
            v.pose.getWorldQuaternion(this.tmpQ).invert();
            dir.normalize().applyQuaternion(this.tmpQ);
            v.rig.impulse(pv.flex, dir, THREE.MathUtils.clamp(e.dmg / 4, 1.5, 6));
            // …and the whole body wobbles from the blow.
            v.spine.kick(pv.rest.z, dir.x * THREE.MathUtils.clamp(e.dmg / 5, 0.6, 3) * (e.crit ? 1.6 : 1));
          }
        }
        const at = toWorld(e.x, e.y, e.h / CELL + 0.7);
        const strength = THREE.MathUtils.clamp(e.dmg / 10, 0.5, 2.2);
        if (e.by !== null) {
          const from = sim.bugs[e.by].pos;
          const dir = toWorld(e.x, e.y).sub(toWorld(from.x, from.y)).setY(0);
          if (dir.lengthSq() > 1e-6) {
            dir.normalize();
            v.kick.addScaledVector(dir, 0.16 * strength); // victim flinches away…
            this.bugs[e.by].kick.addScaledVector(dir, 0.07 * strength); // …attacker follows through
          }
        }
        this.burst(at, Math.round(3 + strength * 3), e.shielded ? 0x7fb3ff : e.dmg >= 14 ? 0xffb347 : 0xffe08a, 0.8 + strength * 0.25);
        if (e.crit) {
          // Critical: a hot flash, a ring, an extra shower of sparks and a harder flinch.
          this.flash(at, 0xff9a2e, 0.9, 0.22);
          this.flash(at, 0xffffff, 0.45, 0.12);
          this.wave(at, 0xff9a2e);
          this.burst(at, 10, 0xffffff, 1.5);
          if (pv) pv.punch = 1.4;
          if (e.by !== null) {
            const from = sim.bugs[e.by].pos;
            const dir = toWorld(e.x, e.y).sub(toWorld(from.x, from.y)).setY(0);
            if (dir.lengthSq() > 1e-6) v.kick.addScaledVector(dir.normalize(), 0.25);
          }
        }
        if (e.counter) {
          // Punished a miss: a cold flash and a ring on top of the crit.
          this.flash(at, 0x7cf0ff, 1.1, 0.25);
          this.wave(at, 0x7cf0ff, 1.2);
        }
      } else if (e.type === 'dash') {
        const v = this.bugs[e.bug];
        v.trailFrom.copy(toWorld(e.x, e.y, e.h / CELL));
        v.trailLife = 0.38;
        // Kicked-up dust where it pushed off.
        this.burst(toWorld(e.x - e.dx * 8, e.y - e.dy * 8, e.h / CELL + 0.1), 8, e.h > 8 ? 0xffffff : 0xd9d4c7, 0.8);
      } else if (e.type === 'whiff') {
        // Cutting air: a thin white flick where the strike ended up.
        const at = toWorld(e.x, e.y, e.h / CELL + 0.7);
        this.flash(at, 0xffffff, 0.45, 0.1);
        if (e.dodged) this.burst(at, 4, 0xffffff, 0.6);
      } else if (e.type === 'clash') {
        const at = toWorld(e.x, e.y, e.h / CELL + 0.8);
        this.arena.hype(0.7);
        this.flash(at, 0xffffff, 1.7, 0.22);
        this.flash(at, 0xffd23f, 1.2, 0.36);
        this.wave(at, 0xffffff, 1.7);
        this.wave(at, 0xffd23f, 1.1);
        this.burst(at, 26, 0xffe08a, 2);
        this.burst(at, 12, 0xffffff, 2.5);
      } else if (e.type === 'stagger') {
        const v = this.bugs[e.bug];
        const at = toWorld(e.x, e.y, e.h / CELL + 1.2);
        this.arena.hype(0.5);
        this.wave(at, 0xffd23f, 1.4);
        this.burst(at, 12, 0xffd23f, 1.3);
        v.spine.kick(0, 3);
      } else if (e.type === 'ult-release') {
        this.arena.hype(0.9);
        this.finisher = { id: e.move, caster: e.bug, t: 0 };
        // Any turn the cutscene made is now in the sim's heading.
        this.bugs[e.bug].pose.rotation.y = 0;
        this.bugs[e.bug].lastHeading = sim.bugs[e.bug].heading;
        this.releaseFx(sim, e.move, e.bug);
      } else if (e.type === 'move') {
        this.moveFx(sim, e.move, e.bug);
      } else if (e.type === 'heal') {
        const to = toWorld(e.x, e.y, e.h / CELL + 0.9);
        const src = sim.bugs[e.from];
        if (src.team === sim.bugs[e.bug].team) {
          // A repair (Rally Pulse): golden sparkles and a little ring on whoever it patched up.
          this.burst(to, 6, 0xffd23f, 0.7);
          this.burst(to, 3, 0xffffff, 0.6);
          if (e.bug !== e.from) this.wave(to, 0xffd23f, 0.8);
        } else {
          // Health flowing from the victim into the drinker: a few red droplets and a green glint.
          const from = toWorld(src.pos.x, src.pos.y, src.alt / CELL + 0.8);
          this.drip(from, to, Math.min(6, 2 + Math.round(e.amount / 3)));
          this.burst(to, 3, 0x7cffb2, 0.5);
        }
      } else if (e.type === 'arc') {
        this.startArc(sim, e.move === 'magnet-pull' ? 'magnet' : 'spark', e.bug, e.points);
      } else if (e.type === 'reflect') {
        // A shot glances off the mirror: a silver hex shard and a glint.
        const at = toWorld(e.x, e.y, e.h / CELL + 0.7);
        this.hexFlash(at);
        this.flash(at, 0xdff0ff, 0.5, 0.14);
        this.burst(at, 5, 0xe6f2ff, 0.7);
        this.bugs[e.bug].wardPop = 1;
      } else if (e.type === 'land') {
        // Touchdown: a dust ring, a puff of grit and impact sparks.
        const dive = e.move === 'dive-bomb';
        const floor = toWorld(e.x, e.y, 0.15);
        const at = toWorld(e.x, e.y, e.h / CELL + 0.5);
        this.wave(floor, 0xd9c9a8, dive ? 1.7 : 1.3);
        this.burst(floor, dive ? 14 : 10, 0xcbbd9c, 1.3);
        this.burst(at, 8, dive ? 0x9ad8ff : 0xffd27a, 1.5);
        this.flash(at, 0xffffff, dive ? 1.1 : 0.8, 0.14);
        this.dust(floor, dive ? 7 : 5, 0xc9b896, 1, 0.55);
        this.arena.hype(0.4);
      } else if (e.type === 'erupt') {
        // A burrower bursts out of the floor.
        const at = toWorld(e.x, e.y, 0.3);
        this.burst(at, 26, 0x8a6a45, 1.8);
        this.burst(at, 12, 0xd9c4a0, 1.4);
        this.wave(at, 0xc98b4a, 1.5);
        this.wave(at, 0xffffff, 1);
        this.flash(at, 0xc98b4a, 1.8, 0.3);
        this.arena.hype(0.6);
      } else if (e.type === 'crash') {
        this.arena.hype(0.4);
        const at = toWorld(e.x, e.y, 0.2);
        this.burst(at, 16, 0x8c98a6, 1.3);
        const w = this.waves[this.nextWave];
        this.nextWave = (this.nextWave + 1) % this.waves.length;
        w.m.position.copy(at).setY(0.06);
        (w.m.material as THREE.MeshBasicMaterial).color.set(0xd9d4c7);
        w.life = w.max = 0.45;
        w.size = 1;
        w.m.visible = true;
      } else if (e.type === 'break') {
        this.arena.hype(0.35);
        const at = toWorld(e.x, e.y, e.h / CELL + 0.6);
        this.burst(at, 12, CATEGORY_COLOR[e.category], 1.4);
        this.burst(at, 6, 0xffffff, 1.1);
        const w = this.waves[this.nextWave];
        this.nextWave = (this.nextWave + 1) % this.waves.length;
        w.m.position.copy(at).setY(0.06);
        (w.m.material as THREE.MeshBasicMaterial).color.set(CATEGORY_COLOR[e.category]);
        w.life = w.max = 0.45;
        w.size = 1;
        w.m.visible = true;
      }
    }
  }

  private updateReactions(dt: number) {
    for (const b of this.bits) {
      if (b.life <= 0) continue;
      b.life -= dt;
      b.vel.y -= 16 * dt;
      b.m.position.addScaledVector(b.vel, dt);
      if (b.m.position.y < 0.05) {
        b.m.position.y = 0.05;
        b.vel.y *= -0.4;
      }
      b.m.rotation.x += dt * 12;
      b.m.rotation.y += dt * 9;
      b.m.scale.setScalar(Math.max(0.01, b.life / b.max));
      if (b.life <= 0) b.m.visible = false;
    }
    for (const w of this.waves) {
      if (w.life <= 0) continue;
      w.life -= dt;
      const k = 1 - w.life / w.max;
      w.m.scale.setScalar((0.4 + k * 2.6) * w.size);
      (w.m.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
      if (w.life <= 0) w.m.visible = false;
    }
  }

  private detach(bug: Bug, pv: PartView) {
    pv.attached = false;
    this.bugs[bug.index].rig.deactivate(pv.flex);
    const root = pv.model.root;
    setGhost(root, 1); // broken-off bits are never cloaked
    const w = partWorld(bug, pv.part);
    const v = this.bugs[bug.index];
    const height = root.position.y + v.group.position.y;
    v.pose.remove(root);
    root.position.copy(toWorld(w.x, w.y, height));
    root.rotation.y = yaw(bug.heading) - pv.part.r * (Math.PI / 2);
    this.scene.add(root);
    const out = toWorld(w.x - bug.pos.x, w.y - bug.pos.y).add(new THREE.Vector3(HALF, 0, HALF)).normalize();
    this.debris.push({
      obj: root,
      vel: new THREE.Vector3(out.x * 4 + (Math.random() - 0.5) * 2, 6 + Math.random() * 3, out.z * 4 + (Math.random() - 0.5) * 2),
      spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
      age: 0,
    });
  }

  private updateDebris(dt: number) {
    for (const d of this.debris) {
      d.age += dt;
      d.vel.y -= 20 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      if (d.obj.position.y < 0) {
        d.obj.position.y = 0;
        d.vel.y *= -0.35;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.6);
      }
      d.obj.rotation.x += d.spin.x * dt;
      d.obj.rotation.z += d.spin.z * dt;
      if (d.age > 2.5) d.obj.scale.setScalar(Math.max(0.001, 1 - (d.age - 2.5) * 2));
    }
    const dead = this.debris.filter((d) => d.age > 3);
    dead.forEach((d) => this.scene.remove(d.obj));
    this.debris = this.debris.filter((d) => d.age <= 3);
  }

  private updateProjectiles(sim: Sim) {
    while (this.projectiles.length < sim.projectiles.length) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: 0xe07bff }));
      this.scene.add(m);
      this.projectiles.push(m);
      // Glowing tail (shown on the big venom darts).
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 1, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.5),
        new THREE.MeshBasicMaterial({ color: 0xc77dff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      tail.visible = false;
      this.scene.add(tail);
      this.trails.push(tail);
    }
    this.projectiles.forEach((m, i) => {
      const p = sim.projectiles[i];
      const tail = this.trails[i];
      m.visible = !!p;
      const laser = p?.kind === 'laser';
      const webShot = p?.kind === 'web';
      tail.visible = !!p && (p.big || laser);
      const drone = p?.kind === 'drone' ? (this.drones[i] ??= this.makeDrone()) : this.drones[i];
      const thorn = p?.kind === 'thorn' ? (this.thorns[i] ??= this.makeThorn()) : this.thorns[i];
      if (drone) drone.visible = p?.kind === 'drone';
      if (thorn) thorn.visible = p?.kind === 'thorn';
      if (!p) return;
      m.position.copy(toWorld(p.x, p.y, p.z / CELL + 0.7));
      if (p.kind === 'drone' && drone) {
        // A tiny buzzing drone: wobbles about its flight line, wings a blur, a short amber trail.
        m.visible = false;
        const vel = this.tmpV.set(p.vx, p.vz, p.vy);
        drone.position.copy(m.position);
        drone.position.y += Math.sin(this.clock * 23 + i * 1.7) * 0.08;
        faceAlong(drone, vel);
        const flap = Math.sin(this.clock * 95 + i * 2.1);
        drone.children[2].rotation.z = 0.35 + flap * 0.55;
        drone.children[3].rotation.z = -0.35 - flap * 0.55;
        tail.position.copy(drone.position);
        faceAlong(tail, vel);
        tail.scale.set(0.45, 0.45, 1.1 + Math.sin(this.clock * 40 + i) * 0.15);
        (tail.material as THREE.MeshBasicMaterial).color.set(0xffb22e);
        return;
      }
      if (p.kind === 'thorn' && thorn) {
        m.visible = false;
        tail.visible = false;
        thorn.position.copy(m.position);
        faceAlong(thorn, this.tmpV.set(p.vx, p.vz, p.vy));
        return;
      }
      m.scale.setScalar(webShot ? 2.4 + Math.sin(this.clock * 30 + i) * 0.3 : laser ? 0.7 : p.big ? 1.8 : 1);
      (m.material as THREE.MeshBasicMaterial).color.set(webShot ? 0xf4f1e6 : laser ? 0xe9feff : 0xe07bff);
      (tail.material as THREE.MeshBasicMaterial).color.set(webShot ? 0xf4f1e6 : laser ? 0x5cf2ff : 0xc77dff);
      if (laser) {
        // A bolt of light: a long thin streak.
        tail.position.copy(m.position);
        faceAlong(tail, new THREE.Vector3(p.vx, p.vz, p.vy));
        tail.scale.set(0.55, 0.55, 4.2);
      } else if (p.big) {
        // Stretch the tail back along the flight path.
        const vel = new THREE.Vector3(p.vx, p.vz, p.vy);
        tail.position.copy(m.position);
        faceAlong(tail, vel);
        tail.scale.set(1.4, 1.4, 1.6 + Math.sin(this.clock * 40 + i) * 0.2);
      }
    });
  }

  /** A Hornet Swarm drone: amber body, dark nose, two flickering wings (children 2 and 3). */
  private makeDrone() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.droneParts.body, this.droneParts.amber);
    body.scale.set(1, 0.8, 1.5);
    g.add(body);
    const nose = new THREE.Mesh(this.droneParts.body, this.droneParts.dark);
    nose.scale.setScalar(0.6);
    nose.position.z = 0.2;
    g.add(nose);
    for (const sd of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set(0, 0.1, 0.02);
      const wing = new THREE.Mesh(this.droneParts.wing, this.droneParts.film);
      wing.position.x = sd * 0.17;
      wing.rotation.x = -Math.PI / 2;
      pivot.add(wing);
      g.add(pivot);
    }
    g.visible = false;
    this.scene.add(g);
    return g;
  }

  private makeThorn() {
    const m = new THREE.Mesh(this.droneParts.thorn, this.droneParts.green);
    m.visible = false;
    this.scene.add(m);
    return m;
  }

  private droneParts = {
    body: new THREE.SphereGeometry(0.13, 8, 6),
    wing: new THREE.PlaneGeometry(0.3, 0.13),
    thorn: new THREE.ConeGeometry(0.1, 0.75, 5).rotateX(Math.PI / 2),
    amber: new THREE.MeshToonMaterial({ color: 0xffc23f, emissive: 0x5a3500 }),
    dark: new THREE.MeshToonMaterial({ color: 0x2a2320 }),
    film: new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
    green: new THREE.MeshToonMaterial({ color: 0x8bd450, emissive: 0x1e3a0a }),
  };

  private updateSparks(sim: Sim) {
    while (this.sparks.length < sim.effects.length) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
      this.scene.add(m);
      this.sparks.push(m);
    }
    this.sparks.forEach((m, i) => {
      const e = sim.effects[i];
      m.visible = !!e;
      if (!e) return;
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.set(e.color);
      mat.opacity = Math.min(0.9, e.ttl * 3);
      m.position.copy(toWorld(e.x, e.y, e.h / CELL + 0.8));
      m.scale.setScalar((e.size / CELL) * (1.3 - e.ttl));
      m.rotation.y += 0.2;
    });
  }

  /** The move being staged right now, if any. */
  private cine(sim: Sim): Cine | null {
    if (sim.ult) return { id: sim.ult.id, caster: sim.ult.caster, phase: 'charge', p: sim.ult.t / sim.ult.dur };
    if (this.finisher) return { id: this.finisher.id, caster: this.finisher.caster, phase: 'strike', p: this.finisher.t / FINISH };
    return null;
  }

  /**
   * Charge-up body language per move (pose space: −z is the bug's front).
   * Returns animation overrides for the caster's parts.
   */
  private poseCine(v: BugView, c: Cine, t: number, sim: Sim) {
    const k = c.p;
    const crouch = smooth(k / 0.3);
    switch (c.id) {
      case 'mandible-crusher': {
        // Drop low, spread the jaws, draw back shuddering… then lunge.
        const draw = smooth((k - 0.2) / 0.55) * (1 - smooth((k - 0.84) / 0.1));
        const lunge = smooth((k - 0.86) / 0.14);
        v.pose.scale.set(1 + crouch * 0.07, 1 - crouch * 0.2 + lunge * 0.12, 1 + crouch * 0.05 + lunge * 0.1);
        v.pose.position.set(Math.sin(t * 70) * 0.04 * draw, -0.16 * crouch * (1 - lunge), 0.7 * draw - 1.5 * lunge);
        v.pose.rotation.x = -0.14 * crouch * (1 - lunge) + 0.05 * lunge;
        v.pose.rotation.y = 0;
        return { weapon: 'mandibles' as Category, attack: k < 0.88 ? -1.4 * smooth(k / 0.35) : 1, glow: 0.12 * draw };
      }
      case 'sunder-beam':
      case 'venom-barrage': {
        // Plant wide, draw power into the weapon (body creeps back with each pulse), then brace.
        const charge = smooth((k - 0.15) / 0.7);
        const pulse = Math.max(0, Math.sin(t * 22)) * charge;
        v.pose.scale.set(1 + crouch * 0.1, 1 - crouch * 0.14, 1 + crouch * 0.04);
        v.pose.position.set(0, -0.12 * crouch, 0.35 * charge + pulse * 0.05);
        v.pose.rotation.x = -0.06 * crouch;
        // Swing the stinger round onto the target (the sim snaps to this heading on release).
        const caster = sim.bugs[c.caster];
        let turn = aimHeading(caster, foeOf(sim, caster), c.id === 'sunder-beam' ? 'laser' : 'venom') - caster.heading;
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        v.pose.rotation.y = -turn * smooth(k / 0.6);
        return { weapon: 'stinger' as Category, attack: 0.25 + 0.75 * charge, glow: 0.1 * pulse };
      }
      case 'carapace-lock': {
        // Hunker down, tuck the legs, spin once while the plates gather and seal.
        const spin = smooth((k - 0.25) / 0.6);
        v.pose.scale.set(1 + crouch * 0.1, 1 - crouch * 0.3, 1 + crouch * 0.1);
        v.pose.position.set(0, -0.22 * crouch, 0);
        v.pose.rotation.x = 0;
        v.pose.rotation.y = spin * Math.PI * 2;
        return { air: 0.85 * crouch, glow: 0.06 + Math.sin(t * 12) * 0.04 * spin };
      }
      case 'hornet-swarm': {
        // Head down, abdomen raised high; the hive throbs faster and faster as the drones wake.
        const rear = smooth((k - 0.05) / 0.4);
        const beat = Math.max(0, Math.sin(t * (14 + 26 * k)));
        const quiver = Math.sin(t * 80) * 0.025 * rear;
        v.pose.scale.set(1 + crouch * 0.05, 1 - crouch * 0.08, 1 + rear * 0.06);
        v.pose.position.set(quiver, 0.12 * rear, 0.15 * rear);
        v.pose.rotation.x = -0.32 * rear + beat * 0.03 * rear;
        v.pose.rotation.y = 0;
        const hive = v.parts.find((pv) => pv.attached && pv.part.part.move === 'hornet-swarm');
        if (hive) hive.punch = Math.max(hive.punch, (0.35 + 0.55 * beat) * rear);
        return { glow: 0.04 + 0.08 * beat * rear };
      }
      case 'quake-stomp': {
        // Rears up on its back legs, front high, shuddering at the top… then slams down.
        const rear = smooth((k - 0.08) / 0.6) * (1 - smooth((k - 0.86) / 0.1));
        const slam = smooth((k - 0.88) / 0.1);
        const shudder = Math.sin(t * 60) * 0.03 * smooth((k - 0.5) / 0.3) * (1 - slam);
        const r = sim.bugs[c.caster].radius / CELL;
        v.pose.scale.set(1 + slam * 0.1, 1 - crouch * 0.1 * (1 - rear) - slam * 0.18 + rear * 0.06, 1 + slam * 0.06);
        v.pose.rotation.x = 0.55 * rear + shudder;
        v.pose.rotation.y = 0;
        v.pose.position.set(shudder, Math.sin(0.55 * rear) * r * 0.55 - 0.12 * crouch * (1 - rear) - 0.1 * slam, 0.35 * rear);
        return { air: 0.6 * rear, glow: 0.06 * rear + Math.max(0, Math.sin(t * 16)) * 0.05 * rear };
      }
      default:
        return {};
    }
  }

  /** World position just in front of the caster's channelling weapon (or its centre). */
  private weaponTip(bi: number, sim: Sim, spec: { is: (p: PartDef) => boolean; reach: number } | undefined) {
    const v = this.bugs[bi];
    const bug = sim.bugs[bi];
    const pv = spec ? v.parts.find((p) => p.attached && spec.is(p.part.part)) : undefined;
    // The way the weapon points (it may face sideways or backwards).
    const a = bug.heading + (pv?.part.r ?? 0) * (Math.PI / 2);
    const f = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const at = new THREE.Vector3();
    if (pv) pv.model.root.getWorldPosition(at).add(new THREE.Vector3(0, 0.55, 0));
    else v.group.getWorldPosition(at).add(new THREE.Vector3(0, 0.8, 0));
    return { at: at.addScaledVector(f, spec?.reach ?? 0.9), f };
  }

  private flash(at: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life = 0.35) {
    const fl = this.flashes.find((x) => x.life <= 0) ?? this.flashes[0];
    fl.m.position.copy(at);
    (fl.m.material as THREE.MeshBasicMaterial).color.set(color);
    fl.life = fl.max = life;
    fl.size = size;
    fl.m.visible = true;
  }

  private wave(at: THREE.Vector3, color: THREE.ColorRepresentation, size = 1, life = 0.45) {
    const w = this.waves[this.nextWave];
    this.nextWave = (this.nextWave + 1) % this.waves.length;
    w.m.position.copy(at).setY(0.08);
    (w.m.material as THREE.MeshBasicMaterial).color.set(color);
    w.size = size;
    w.life = w.max = life;
    w.m.visible = true;
  }

  private startStreaks(bi: number, color: THREE.ColorRepresentation, life: number) {
    this.streakBug = bi;
    this.streakLife = life;
    this.streakColor.set(color);
  }

  /** The payoff the moment an ultimate resolves. */
  private releaseFx(sim: Sim, id: MoveId, bi: number) {
    const color = getMove(id).color;
    const { at, f } = this.weaponTip(bi, sim, MOVE_PART[id]);
    const v = this.bugs[bi];
    if (id === 'mandible-crusher') {
      const foe = foeOf(sim, sim.bugs[bi]);
      const bite = at.clone().lerp(toWorld(foe.pos.x, foe.pos.y, 0.8), 0.4);
      this.flash(bite, color, 1.5, 0.4);
      this.flash(bite, 0xffffff, 0.7, 0.18);
      this.wave(bite, color);
      this.wave(bite, 0xffffff);
      this.burst(bite, 18, color, 1.6);
      this.burst(bite, 10, 0xffffff, 1.3);
      this.startStreaks(bi, color, 0.3);
    } else if (id === 'sunder-beam') {
      this.flash(at, color, 1.6, 0.4);
      this.flash(at, 0xffffff, 0.9, 0.2);
      this.burst(at, 12, 0xffffff, 1.2);
      v.kick.addScaledVector(f, -1.1); // recoil
    } else if (id === 'venom-barrage') {
      this.flash(at, color, 1.3, 0.3);
      this.flash(at, 0xffffff, 0.6, 0.15);
      this.burst(at, 14, color, 1.2);
      v.kick.addScaledVector(f, -0.9); // recoil
    } else if (id === 'carapace-lock') {
      const c = v.group.position.clone().setY(0.8);
      this.flash(c, color, 1.8, 0.35);
      this.wave(c, color);
      this.wave(c, 0xffffff);
      this.burst(c, 16, color, 1.2);
    } else if (id === 'hornet-swarm') {
      // The hive bursts open: an amber flash, a ring and a shower of sparks as the drones pour out.
      this.flash(at, color, 1.7, 0.35);
      this.flash(at, 0xffffff, 0.8, 0.15);
      this.wave(at, color, 1.6);
      this.burst(at, 18, color, 1.4);
      this.burst(at, 6, 0x2a2320, 1.2);
      v.kick.addScaledVector(f, 0.5); // the launch shoves it forward
    } else if (id === 'quake-stomp') {
      // The slam: a huge dust shockwave, cracks across the floor and a heavy rumble.
      const b = sim.bugs[bi];
      const c = toWorld(b.pos.x, b.pos.y, 0.2);
      const reach = 170 / CELL / 3; // (a wave grows to ~3× its size)
      this.flash(c.clone().setY(0.6), color, 2.6, 0.35);
      this.flash(c.clone().setY(0.4), 0xffffff, 1.3, 0.15);
      this.wave(c, color, reach, 0.75);
      this.wave(c, 0xe8d2b0, reach * 0.75, 0.6);
      this.wave(c, 0xffffff, reach * 0.45, 0.4);
      this.burst(c, 30, 0x8a6a45, 2.2);
      this.burst(c, 14, 0xd9c4a0, 1.6);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
        const p = this.puff(c.clone().add(new THREE.Vector3(Math.cos(a) * 1.2, 0.25, Math.sin(a) * 1.2)), i % 2 ? 0xc9a77c : 0xa8885f, 1.2 + Math.random() * 0.6, 0.7, 0.9 + Math.random() * 0.4);
        p.vel.set(Math.cos(a) * 11, 0.8 + Math.random(), Math.sin(a) * 11);
      }
      this.cracks.position.copy(c).setY(0);
      this.cracks.rotation.y = Math.random() * Math.PI * 2;
      this.cracks.scale.setScalar(Math.max(0.8, b.radius / CELL / 2.2));
      this.crackLife = 1.8;
      this.rumble = 1;
      v.spine.kick(0, 4);
    }
  }

  /** Red droplets that fly from one point to another (vampiric healing). */
  private drip(from: THREE.Vector3, to: THREE.Vector3, n: number) {
    for (let i = 0; i < n; i++) {
      const b = this.bits[this.nextBit];
      this.nextBit = (this.nextBit + 1) % this.bits.length;
      b.m.position.copy(from).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, Math.random() * 0.4, (Math.random() - 0.5) * 0.6));
      const life = 0.32 + Math.random() * 0.12;
      // Aim so it arrives at `to` as gravity pulls it down (16 units/s²).
      const v = to.clone().sub(b.m.position).divideScalar(life);
      v.y += 8 * life;
      b.vel.copy(v);
      (b.m.material as THREE.MeshBasicMaterial).color.set(i % 3 === 0 ? 0xff6b6b : 0xc8102e);
      b.life = b.max = life;
      b.m.visible = true;
    }
  }

  /** Effects for the quick (non-cutscene) moves, fired the moment they're used. */
  private moveFx(sim: Sim, id: MoveId, bi: number) {
    const b = sim.bugs[bi];
    const color = getMove(id).color;
    const floor = toWorld(b.pos.x, b.pos.y, 0.2);
    const mid = toWorld(b.pos.x, b.pos.y, b.alt / CELL + 0.8);
    switch (id) {
      case 'carapace-lock':
        // The plates slam shut: a blue flash and a ring (the shell itself shows while it holds).
        this.flash(mid, color, 1.9, 0.3);
        this.wave(mid, color, 1.4);
        this.burst(mid, 10, 0xffffff, 0.9);
        break;
      case 'skitter-dash':
        this.burst(floor, 12, 0xc9c2b0, 0.9); // dust kicked up
        this.startStreaks(bi, color, 0.35);
        break;
      case 'static-burst':
        this.flash(mid, color, 2.6, 0.3);
        this.flash(mid, 0xffffff, 1.2, 0.15);
        this.wave(mid, color, 2.1);
        this.wave(mid, 0xffffff, 1.5);
        this.burst(mid, 18, color, 1.6);
        break;
      case 'skewer': {
        // The tail comes down on the enemy: a toxic flash and a ring where it lands.
        const foe = foeOf(sim, b);
        const hit = toWorld(foe.pos.x, foe.pos.y, foe.alt / CELL + 0.9);
        this.flash(hit, color, 1.6, 0.3);
        this.flash(hit, 0xffffff, 0.8, 0.14);
        this.wave(hit, color, 1.5);
        this.burst(hit, 16, color, 1.6);
        this.startStreaks(bi, color, 0.3);
        break;
      }
      case 'gale-flap':
        this.wave(mid, color, 2.6);
        this.wave(mid, 0xffffff, 1.8);
        this.burst(mid, 16, 0xffffff, 1.8);
        break;
      case 'web-snare':
        this.burst(mid, 8, 0xf4f1e6, 0.9);
        break;
      case 'ghost-shell':
        this.flash(mid, color, 1.8, 0.35);
        this.burst(mid, 10, color, 0.9);
        break;
      case 'overclock':
        this.flash(mid, color, 1.7, 0.3);
        this.wave(mid, color, 1.2);
        this.startStreaks(bi, color, 0.5);
        break;
      case 'blood-siphon':
        this.flash(mid, color, 1.4, 0.3);
        this.burst(mid, 10, color, 0.9);
        break;
      case 'burrow-strike':
        this.burst(floor, 16, 0x8a6a45, 1.2);
        this.wave(floor, 0xc98b4a, 1);
        break;
      case 'chain-spark': {
        // The crown discharges (the bolt itself arrives as an 'arc' event).
        const { at } = this.weaponTip(bi, sim, { is: (p) => p.move === 'chain-spark', reach: 0 });
        this.flash(at, color, 1.2, 0.2);
        this.flash(at, 0xffffff, 0.6, 0.1);
        this.burst(at, 8, color, 1.1);
        break;
      }
      case 'pounce':
        // Springs off: dust where it pushed off, streaks behind it.
        this.burst(floor, 12, 0xcbbd9c, 1.1);
        this.dust(floor, 4, 0xc9b896, 0.7, 0.45);
        this.wave(floor, 0xd9c9a8, 0.9);
        this.startStreaks(bi, color, 0.45);
        break;
      case 'dive-bomb':
        // Wings snap back for the dive: a gust and streaks.
        this.wave(mid, 0xffffff, 1.2);
        this.burst(mid, 10, 0xffffff, 1.2);
        this.flash(mid, color, 1.2, 0.2);
        this.startStreaks(bi, color, 0.55);
        break;
      case 'thorn-bloom':
        // The plate bursts open: a green flash and ring as the thorns fly.
        this.flash(mid, color, 1.9, 0.22);
        this.flash(mid, 0xffffff, 0.8, 0.1);
        this.wave(mid, color, 2.2);
        this.burst(mid, 14, color, 1.6);
        this.bugs[bi].spine.kick(0, 2);
        break;
      case 'ink-cloud': {
        // A big rolling puff of black smog that hangs for a second.
        const c = toWorld(b.pos.x, b.pos.y, b.alt / CELL + 0.6);
        this.flash(c, 0x3a3450, 2.2, 0.3);
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
          const out = 3.2 + Math.random() * 3.6;
          const p = this.puff(c.clone().add(new THREE.Vector3(Math.cos(a) * 0.6, Math.random() * 0.6, Math.sin(a) * 0.6)), i % 3 ? 0x2b2838 : 0x4a4560, 1.4 + Math.random() * 0.5, 0.85, 1.05 + Math.random() * 0.35);
          p.vel.set(Math.cos(a) * out, 0.4 + Math.random() * 0.8, Math.sin(a) * out);
        }
        this.burst(c, 8, 0x24202f, 1.2);
        break;
      }
      case 'rally-pulse':
        // A golden repair pulse rolls out, sparkles rising.
        this.flash(mid, color, 1.8, 0.3);
        this.wave(mid, color, 3.4, 0.7);
        this.wave(mid, 0xffffff, 2, 0.5);
        this.burst(mid, 16, color, 1.4);
        this.burst(mid, 6, 0xffffff, 1.1);
        break;
      case 'magnet-pull': {
        // The core flares (the beam arrives as an 'arc' event).
        const { at } = this.weaponTip(bi, sim, { is: (p) => p.move === 'magnet-pull', reach: 0 });
        this.flash(at, color, 1.4, 0.25);
        this.wave(at, color, 1.2);
        break;
      }
      case 'mirror-ward':
        // The mirror field snaps up: a silver flash and ring.
        this.flash(mid, 0xe6f2ff, 2.2, 0.25);
        this.wave(mid, 0xffffff, 1.6);
        this.burst(mid, 10, 0xffffff, 1);
        this.bugs[bi].wardPop = 1.6;
        break;
      case 'anchor-grip':
        // Hooks slam into the floor: grit and a steel ring (the hooks show while it holds).
        this.flash(floor, color, 1.4, 0.2);
        this.wave(floor, color, 1.3);
        this.burst(floor, 14, 0xb9b2a0, 1.1);
        this.dust(floor, 5, 0xbdb39b, 0.8, 0.5);
        break;
      case 'ram-charge':
        // Head down, dust kicked up behind, long streaks.
        this.burst(floor, 14, 0xcbbd9c, 1);
        this.dust(floor, 4, 0xc9b896, 0.8, 0.5);
        this.startStreaks(bi, color, 0.65);
        this.bugs[bi].ramT = 0.6;
        break;
      case 'vise-lock': {
        // The claws clamp shut on the enemy.
        const foe = foeOf(sim, b);
        const at = toWorld(foe.pos.x, foe.pos.y, foe.alt / CELL + 0.8);
        this.flash(at, color, 1.3, 0.2);
        this.flash(at, 0xffffff, 0.6, 0.1);
        this.burst(at, 10, color, 1.2);
        this.startClamp(bi, foe.index);
        break;
      }
      case 'mark-prey': {
        // A sight line flicks to the enemy and the reticle snaps onto it.
        const foe = foeOf(sim, b);
        this.startArc(sim, 'sight', bi, [], foe.index);
        this.bugs[foe.index].markSnap = 1;
        break;
      }
      default:
        break;
    }
  }

  /** Start an arc: a Chain Spark bolt through `points`, or a beam/sight line between two bugs. */
  private startArc(sim: Sim, kind: Arc['kind'], from: number, points: { x: number; y: number; h: number }[], to = -1) {
    const arc = this.arcs.find((a) => a.life <= 0) ?? this.arcs[0];
    arc.kind = kind;
    arc.from = from;
    arc.path = points.map((p) => toWorld(p.x, p.y, p.h / CELL + 0.6));
    if (to < 0 && points.length > 1) {
      // The bug at the far end (the one being pulled).
      const end = points[points.length - 1];
      let best = Infinity;
      for (const b of sim.bugs)
        if (b.index !== from && !b.dead && Math.hypot(b.pos.x - end.x, b.pos.y - end.y) < best) {
          best = Math.hypot(b.pos.x - end.x, b.pos.y - end.y);
          to = b.index;
        }
    }
    arc.to = Math.max(0, to);
    arc.life = arc.max = kind === 'spark' ? 0.32 : kind === 'magnet' ? 0.5 : 0.3;
    arc.reroll = 0;
    const color = kind === 'spark' ? 0x7df9ff : kind === 'magnet' ? 0x8f7dff : 0xff8fd8;
    arc.glow.material.color.set(color);
    arc.core.material.color.set(kind === 'magnet' ? 0xdfe4ff : 0xffffff);
    if (kind === 'spark')
      arc.path.forEach((p, i) => {
        if (i === 0) return;
        this.flash(p, 0x7df9ff, 0.7, 0.18);
        this.burst(p, 5, i % 2 ? 0x7df9ff : 0xffffff, 0.9);
      });
  }

  /** A soft puff (smog, dust) that drifts and grows, then fades. */
  private puff(at: THREE.Vector3, color: THREE.ColorRepresentation, size: number, alpha: number, life: number) {
    const p = this.puffs[this.nextPuff];
    this.nextPuff = (this.nextPuff + 1) % this.puffs.length;
    p.m.position.copy(at);
    (p.m.material as THREE.MeshBasicMaterial).color.set(color);
    p.vel.set(0, 0, 0);
    p.size = size;
    p.alpha = alpha;
    p.life = p.max = life;
    p.m.visible = true;
    return p;
  }

  /** A few low dust puffs rolling outward along the floor. */
  private dust(at: THREE.Vector3, n: number, color: THREE.ColorRepresentation, size: number, life: number) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random();
      const p = this.puff(at.clone().setY(0.3), color, size * (0.8 + Math.random() * 0.4), 0.6, life * (0.8 + Math.random() * 0.4));
      p.vel.set(Math.cos(a) * 3 * size, 0.6, Math.sin(a) * 3 * size);
    }
  }

  private hexFlash(at: THREE.Vector3) {
    const h = this.hexes.find((x) => x.life <= 0) ?? this.hexes[0];
    h.m.position.copy(at);
    h.m.rotation.z = Math.random() * Math.PI;
    h.life = 0.25;
    h.m.visible = true;
  }

  private startClamp(bi: number, foe: number) {
    const c = this.clamps.find((x) => x.life <= 0) ?? this.clamps[0];
    c.bug = foe;
    c.from = bi;
    c.life = 0.9;
    c.g.visible = true;
  }

  /** Arcs, beams, puffs, hex shards, clamps and cracks from the newer moves. */
  private updateMoveFx(sim: Sim, t: number, dt: number) {
    for (const arc of this.arcs) {
      const on = arc.life > 0;
      arc.glow.mesh.visible = arc.core.mesh.visible = on;
      if (!on) continue;
      arc.life -= dt;
      const k = 1 - arc.life / arc.max;
      const A = this.bugs[arc.from];
      const B = this.bugs[arc.to];
      if (arc.kind === 'spark') {
        // Jagged, flickering lightning through the hit points (re-rolled a few times a second).
        if (t >= arc.reroll) {
          arc.reroll = t + 0.045;
          let n = 0;
          arc.pts[n++].copy(arc.path[0]);
          for (let s = 1; s < arc.path.length && n < arc.pts.length; s++) {
            const a = arc.path[s - 1];
            const b = arc.path[s];
            const len = a.distanceTo(b);
            const m = Math.max(3, Math.min(10, Math.round(len / 0.5)));
            for (let j = 1; j <= m && n < arc.pts.length; j++) {
              const p = arc.pts[n++].copy(a).lerp(b, j / m);
              if (j < m) p.add(this.tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(Math.min(0.8, len * 0.12)));
            }
          }
          const pts = arc.pts.slice(0, n);
          arc.glow.set(pts, 0.17, 0.5);
          arc.core.set(pts, 0.05);
        }
        const flick = 0.55 + Math.random() * 0.45;
        arc.glow.material.opacity = 0.7 * flick * (1 - k * k);
        arc.core.material.opacity = flick * (1 - k * k);
        continue;
      }
      // Beam / sight line between two live bugs (ends follow them).
      const a = A.group.position.clone().add(this.tmpV.set(0, 0.8, 0));
      const b = B.group.position.clone().add(this.tmpV.set(0, 0.8, 0));
      const n = 24;
      const dir = b.clone().sub(a);
      const p1 = new THREE.Vector3().crossVectors(dir, UP).normalize();
      const p2 = new THREE.Vector3().crossVectors(dir, p1).normalize();
      const pts = arc.pts.slice(0, n + 1);
      const fade = arc.kind === 'sight' ? 1 - k : Math.min(1, arc.life * 6);
      if (arc.kind === 'magnet') {
        // A twisting field beam (helix) round a straight bright core.
        for (let i = 0; i <= n; i++) {
          const u = i / n;
          const amp = 0.32 * Math.sin(Math.PI * u);
          const ph = u * 14 - t * 24;
          pts[i].copy(a).lerp(b, u).addScaledVector(p1, Math.cos(ph) * amp).addScaledVector(p2, Math.sin(ph) * amp);
        }
        arc.glow.set(pts, 0.11, 0.4);
        arc.core.set([a, b], 0.06);
        arc.glow.material.opacity = 0.9 * fade;
        arc.core.material.opacity = (0.6 + Math.sin(t * 50) * 0.2) * fade;
      } else {
        // Mark Prey: a thin pink laser sight that snaps on and fades.
        const reach = smooth(k / 0.25);
        const end = a.clone().lerp(b, reach);
        arc.glow.set([a, end], 0.07);
        arc.core.set([a, end], 0.02);
        arc.glow.material.opacity = 0.7 * fade;
        arc.core.material.opacity = fade;
      }
    }
    // Field rings slide down the strongest magnet beam toward the caster.
    const mag = this.arcs.find((x) => x.kind === 'magnet' && x.life > 0);
    this.fieldRings.forEach((m, i) => {
      m.visible = !!mag;
      if (!mag) return;
      const a = this.bugs[mag.from].group.position.clone().setY(this.bugs[mag.from].group.position.y + 0.8);
      const b = this.bugs[mag.to].group.position.clone().setY(this.bugs[mag.to].group.position.y + 0.8);
      const u = 1 - ((t * 2.6 + i / this.fieldRings.length) % 1);
      m.position.copy(a).lerp(b, u);
      faceAlong(m, b.clone().sub(a));
      m.scale.setScalar(0.6 + u * 1.3);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.8 * Math.sin(Math.PI * u) * Math.min(1, mag.life * 6);
    });

    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const k = 1 - p.life / p.max;
      p.vel.multiplyScalar(Math.exp(-dt * 3.2));
      p.m.position.addScaledVector(p.vel, dt);
      p.m.scale.setScalar(p.size * (0.45 + 0.75 * Math.sqrt(k)));
      (p.m.material as THREE.MeshBasicMaterial).opacity = p.alpha * Math.min(1, k * 8) * (1 - k * k);
      if (p.life <= 0) p.m.visible = false;
    }
    for (const h of this.hexes) {
      if (h.life <= 0) continue;
      h.life -= dt;
      const k = 1 - h.life / 0.25;
      h.m.quaternion.copy(this.camera.quaternion);
      h.m.rotateZ(k * 1.5);
      h.m.scale.setScalar(0.5 + k * 0.9);
      (h.m.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - k);
      if (h.life <= 0) h.m.visible = false;
    }
    for (const c of this.clamps) {
      if (c.life <= 0) continue;
      c.life -= dt;
      const foe = sim.bugs[c.bug];
      const by = sim.bugs[c.from];
      const k = 1 - c.life / 0.9;
      const shut = smooth(k / 0.12);
      c.g.position.copy(this.bugs[c.bug].group.position).setY(this.bugs[c.bug].group.position.y + 0.7);
      // Jaws come in from either side of the caster → enemy line.
      c.g.rotation.y = Math.atan2(foe.pos.x - by.pos.x, foe.pos.y - by.pos.y) + Math.PI / 2;
      c.g.scale.setScalar((foe.radius / CELL) * 0.75 + 0.3);
      const open = (1 - shut) * 0.9 + (k > 0.12 ? Math.sin(t * 60) * 0.02 : 0);
      c.g.children[0].position.z = open;
      c.g.children[1].position.z = -open;
      const mat = (c.g.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = Math.min(1, c.life * 5) * (0.75 + 0.25 * Math.sin(t * 30));
      if (c.life <= 0 || foe.dead) {
        c.life = 0;
        c.g.visible = false;
      }
    }
    this.crackLife = Math.max(0, this.crackLife - dt);
    this.cracks.visible = this.crackLife > 0;
    if (this.cracks.visible) {
      const seam = (this.cracks.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      const hot = (this.cracks.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      seam.opacity = 0.75 * Math.min(1, this.crackLife / 0.6);
      hot.opacity = 0.9 * Math.max(0, (this.crackLife - 1.2) / 0.6);
    }
    this.rumble = Math.max(0, this.rumble - dt * 1.4);
  }

  /** Per-bug status visuals: burrowing, webbing, cloaking, stun sparks, overclock embers. */
  private statusFx(sim: Sim, bug: Bug, v: BugView, t: number, dt: number) {
    // Burrowed: the bug sinks under the floor and a mound of dirt travels with it.
    const under = bug.burrow > 0;
    v.sink += ((under ? 1 : 0) - v.sink) * Math.min(1, dt * (under ? 9 : 14));
    v.group.position.y -= v.sink * 2.8;
    v.mound.visible = v.sink > 0.05;
    if (v.mound.visible) {
      v.mound.position.copy(toWorld(bug.pos.x, bug.pos.y));
      v.mound.scale.y = (0.42 + Math.sin(t * 34) * 0.1) * v.sink;
    }
    // Webbed: a net of silk over it.
    v.web.visible = bug.webbed > 0 && !bug.dead;
    if (v.web.visible) {
      (v.web.material as THREE.LineBasicMaterial).opacity = 0.8 * Math.min(1, bug.webbed * 2);
      v.web.rotation.y = Math.sin(t * 9) * 0.03; // strains against it
    }
    // Cloaked: allies fade to a ghost, enemies all but vanish.
    const want = bug.cloak > 0 && !bug.dead ? (bug.team === 0 ? 0.3 : 0.05) : 1;
    if (v.ghost !== want) {
      const next = v.ghost + (want - v.ghost) * Math.min(1, dt * 7);
      v.ghost = Math.abs(next - want) < 0.02 ? want : next;
      for (const pv of v.parts) if (pv.attached) setGhost(pv.model.root, v.ghost);
    }
    // Pounce / Dive Bomb: the model really arcs through the air (the sim only hops a little).
    let hop = 0;
    let pitch = 0;
    if (bug.leap > 0 && bug.leapKind && !bug.dead) {
      const u = THREE.MathUtils.clamp(1 - bug.leap / LEAP_T[bug.leapKind], 0, 1);
      if (bug.leapKind === 'pounce') {
        hop = 4 * u * (1 - u) * Math.min(2.2, 1 + bug.radius / CELL / 3);
        pitch = 0.4 * (1 - 2 * u);
      } else {
        // Rise, then dive down onto the target's height.
        const foe = sim.bugs[bug.leapAt];
        const drop = foe ? Math.min(0, (foe.alt - bug.alt) / CELL) : 0;
        const rise = smooth(u / 0.3);
        const dive = smooth((u - 0.3) / 0.7);
        hop = 1.5 * rise * (1 - dive) + drop * dive;
        pitch = 0.3 * rise * (1 - dive) - 0.75 * dive * (1 - smooth((u - 0.9) / 0.1));
      }
      v.hop = hop;
      v.hopPitch = pitch;
    } else {
      v.hop += (0 - v.hop) * Math.min(1, dt * 10);
      v.hopPitch += (0 - v.hopPitch) * Math.min(1, dt * 10);
    }
    v.group.position.y += v.hop;
    v.ramT = Math.max(0, v.ramT - dt);

    // Mirror Ward: a silvery faceted bubble that turns slowly and pops when a shot bounces off.
    v.wardPop = Math.max(0, v.wardPop - dt * 5);
    v.ward.visible = bug.ward > 0 && !bug.dead;
    if (v.ward.visible) {
      const fade = Math.min(1, bug.ward * 3);
      v.ward.rotation.y = -t * 0.7;
      v.ward.scale.setScalar(1 + v.wardPop * 0.1 + Math.sin(t * 4) * 0.012);
      ((v.ward.children[0] as THREE.Mesh).material as THREE.MeshPhongMaterial).opacity = (0.16 + v.wardPop * 0.2) * fade;
      ((v.ward.children[1] as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity = (0.45 + 0.2 * Math.sin(t * 9) + v.wardPop * 0.4) * fade;
    }
    // Anchor Grip: hooks drive into the floor round the feet and hold.
    v.anchor.visible = bug.anchor > 0 && !bug.dead && bug.alt < 12;
    if (v.anchor.visible) {
      const since = 3 - bug.anchor;
      const plant = smooth(since / 0.14);
      const pull = bug.anchor < 0.3 ? 1 - bug.anchor / 0.3 : 0;
      v.anchor.children.forEach((h, i) => {
        if (i < 6) h.position.y = 0.7 * (1 - plant) + 0.5 * pull * pull - 0.04 + Math.sin(t * 20 + i) * 0.01 * plant;
      });
      const ring = v.anchor.children[6] as THREE.Mesh;
      ring.scale.setScalar(1 + (1 - plant) * 0.4);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.5 * plant * (1 - pull);
    }
    // Mark Prey: a pink reticle hovers over the marked bug, a pip for each sure crit left.
    v.markSnap = Math.max(0, v.markSnap - dt * 4);
    v.reticle.visible = bug.marked > 0 && !bug.dead && v.ghost > 0.2 && !sim.ult;
    if (v.reticle.visible) {
      v.reticle.position.copy(v.group.position).setY(v.group.position.y + 2.75 + Math.sin(t * 3.4) * 0.06);
      v.reticle.quaternion.copy(this.camera.quaternion);
      v.reticle.children[0].rotation.z = -t * 1.6;
      v.reticle.scale.setScalar((1 + v.markSnap * v.markSnap * 2.2) * Math.max(0.9, bug.radius / CELL / 2.2));
      for (let i = 0; i < 3; i++) v.reticle.children[2 + i].visible = i < bug.marked;
      const mat = (v.reticle.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (0.8 + Math.sin(t * 8) * 0.15) * Math.min(1, bug.markedT * 2);
    }
    // Blinded by ink: a dark smudge swirling round its head.
    v.ink.visible = bug.blind > 0 && !bug.dead && v.ghost > 0.2;
    if (v.ink.visible) {
      const a = Math.min(1, bug.blind * 2);
      v.ink.children.forEach((m, i) => {
        const ang = t * (1.4 + i * 0.13) + i * 1.05;
        m.position.set(Math.cos(ang) * 0.5, 0.25 + Math.sin(t * 2.3 + i) * 0.16, Math.sin(ang) * 0.5);
        m.scale.setScalar((0.32 + 0.08 * Math.sin(t * 3 + i * 2)) * (0.6 + 0.4 * a));
      });
      ((v.ink.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.72 * a;
    }

    // Sparks: dirt while tunnelling, static while stunned, embers while overclocked.
    v.fxClock += dt;
    if (v.fxClock > 0.09 && !sim.ult) {
      v.fxClock = 0;
      if (bug.blind > 0 && !bug.dead) {
        const head = v.ink.getWorldPosition(this.tmpV);
        this.burst(head, 1, 0x24202f, 0.4);
      }
      if (under) this.burst(toWorld(bug.pos.x, bug.pos.y, 0.2), 2, 0x8a6a45, 0.8);
      if (bug.stun > 0) this.burst(toWorld(bug.pos.x, bug.pos.y, bug.alt / CELL + 1.3), 2, 0xffe14d, 0.6);
      if (bug.siphon > 0 && !bug.dead) this.burst(toWorld(bug.pos.x, bug.pos.y, bug.alt / CELL + 1.1), 1, 0xe8323f, 0.5);
      if (bug.haste > 0 && !bug.dead) this.burst(toWorld(bug.pos.x, bug.pos.y, bug.alt / CELL + 0.6), 1, 0xff9a2e, 0.6);
    }
  }

  /** Charge glow, converging sparks, speed streaks and flashes. */
  private updateCineFx(sim: Sim, c: Cine | null, t: number, dt: number) {
    const charging = c?.phase === 'charge' ? c : null;
    // Sunder Beam: a lance of light for the moment after release.
    this.beam.visible = !!c && c.id === 'sunder-beam' && c.phase === 'strike' && c.p < 0.7;
    if (c && this.beam.visible) {
      const { at, f } = this.weaponTip(c.caster, sim, MOVE_PART[c.id]);
      const len = 30;
      const w = Math.max(0.03, 0.4 * (1 - c.p / 0.7) * (0.85 + Math.sin(t * 70) * 0.15));
      this.beam.position.copy(at).addScaledVector(f, len / 2);
      faceAlong(this.beam, f);
      this.beam.scale.set(w, w, len);
    }
    this.aura.visible = !!charging;
    this.orb.visible = false;
    if (charging) {
      const color = new THREE.Color(getMove(charging.id).color);
      const caster = sim.bugs[charging.caster];
      const k = charging.p;
      const { at } = this.weaponTip(charging.caster, sim, MOVE_PART[charging.id]);
      this.aura.position.copy(toWorld(caster.pos.x, caster.pos.y, 0.1));
      const ring = this.aura.children[0] as THREE.Mesh;
      (ring.material as THREE.MeshBasicMaterial).color.copy(color);
      ring.scale.setScalar((1.3 - k * 0.5 + Math.sin(t * 20) * 0.04) * Math.max(0.8, caster.radius / CELL / 2.2));
      // Sparks stream in toward the weapon (or onto the shell for Carapace Lock).
      const local = at.clone().sub(this.aura.position);
      this.auraSparks.forEach((s, i) => {
        const a = (i / this.auraSparks.length) * Math.PI * 2 + t * 2.5;
        const u = (t * 1.4 + i * 0.23) % 1;
        const from = new THREE.Vector3(Math.cos(a) * 3.2, 0.3 + (i % 3) * 0.9, Math.sin(a) * 3.2);
        let to = local;
        if (charging.id === 'carapace-lock') to = new THREE.Vector3(Math.cos(a) * 1.6, 0.6 + (i % 4) * 0.35, Math.sin(a) * 1.6);
        else if (charging.id === 'quake-stomp') to = new THREE.Vector3(Math.cos(a) * 1.3, 0.15, Math.sin(a) * 1.3);
        else if (charging.id === 'hornet-swarm') {
          // A buzzing cloud of drones gathering round the hive.
          const r = 0.5 + 0.5 * smooth(k / 0.6);
          to = local.clone().add(new THREE.Vector3(Math.cos(a * 3 + t * 9) * r, Math.sin(t * 13 + i) * 0.35, Math.sin(a * 3 + t * 9) * r));
        }
        s.position.copy(from).lerp(to, charging.id === 'hornet-swarm' ? Math.min(1, u * 2.5) : u * u);
        s.scale.setScalar(0.6 + (1 - u) * 0.8);
        s.rotation.set(t * 5 + i, t * 3, 0);
        (s.material as THREE.MeshBasicMaterial).color.copy(color);
      });
      // Energy gathering at the weapon.
      if (!BODY_ULT.includes(charging.id)) {
        const grow = smooth((k - 0.1) / 0.75) * (charging.id === 'mandible-crusher' ? 1 - smooth((k - 0.88) / 0.08) : 1);
        this.orb.visible = grow > 0.01;
        this.orb.position.copy(at);
        this.orb.scale.setScalar(0.15 + grow * (charging.id === 'mandible-crusher' ? 0.7 : charging.id === 'hornet-swarm' ? 0.6 : 1.1) + Math.sin(t * 30) * 0.05 * grow);
        const om = this.orb.material as THREE.MeshBasicMaterial;
        om.color.copy(color).lerp(new THREE.Color(0xffffff), 0.35);
        om.opacity = 0.55 + 0.35 * grow;
      }
      if (charging.id === 'mandible-crusher' && k > 0.86 && this.streakLife <= 0) this.startStreaks(charging.caster, color, 0.45);
    }

    // Speed streaks trailing a lunging / dashing bug.
    this.streakLife = Math.max(0, this.streakLife - dt);
    const sb = sim.bugs[this.streakBug];
    const back = new THREE.Vector3(-Math.cos(sb.heading), 0, -Math.sin(sb.heading));
    const side = new THREE.Vector3(-back.z, 0, back.x);
    const base = this.bugs[this.streakBug].group.position.clone().add(this.bugs[this.streakBug].pose.position.clone().applyQuaternion(this.bugs[this.streakBug].group.quaternion));
    this.streaks.forEach((m, i) => {
      m.visible = this.streakLife > 0;
      if (!m.visible) return;
      const off = ((i * 0.37) % 1) - 0.5;
      const len = 1.5 + ((i * 0.61) % 1) * 2.5;
      m.position.copy(base).addScaledVector(side, off * 2).addScaledVector(back, 1 + len / 2 + ((t * 9 + i * 0.3) % 1) * 1.2);
      m.position.y = 0.3 + ((i * 0.53) % 1) * 1.3;
      m.scale.set(1, 1, len);
      faceAlong(m, back);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.copy(this.streakColor);
      mat.opacity = Math.min(1, this.streakLife * 4) * 0.8;
    });

    for (const fl of this.flashes) {
      if (fl.life <= 0) continue;
      fl.life -= dt;
      const k = 1 - fl.life / fl.max;
      fl.m.scale.setScalar(fl.size * (0.4 + k * 0.9));
      (fl.m.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
      if (fl.life <= 0) fl.m.visible = false;
    }
  }

  private updateCamera(sim: Sim, dt: number, t: number) {
    // Fight camera: a three-quarter view from behind the player's bug looking at
    // the opponent (so on a tall phone screen the fight runs up the screen, with
    // real depth), swinging round smoothly as they circle and pulling back/up as
    // they separate or take to the air.
    // Follow the player's bug (or an ally once it's down) and whoever it's fighting.
    const a = sim.bugs[0].dead ? (sim.bugs.find((x) => x.team === 0 && !x.dead) ?? sim.bugs[0]) : sim.bugs[0];
    const picked = sim.bugs[a.ai.foe];
    const b = picked && !picked.dead && picked.team !== a.team ? picked : foeOf(sim, a);
    const pa = toWorld(a.pos.x, a.pos.y, a.alt / CELL);
    const pb = toWorld(b.pos.x, b.pos.y, b.alt / CELL);
    const target = pa.clone().multiplyScalar(0.5).add(pb.clone().multiplyScalar(0.5));
    const axis = pb.clone().sub(pa).setY(0);
    let sep = axis.length();
    if (sim.bugs.length > 2) {
      // Team fights: lean toward the middle of everyone still standing and widen to keep them in view.
      const alive = sim.bugs.filter((x) => !x.dead);
      const mid = new THREE.Vector3();
      for (const x of alive) mid.add(toWorld(x.pos.x, x.pos.y, x.alt / CELL));
      mid.multiplyScalar(1 / Math.max(1, alive.length));
      target.lerp(mid, 0.5);
      for (const x of alive) sep = Math.max(sep, toWorld(x.pos.x, x.pos.y).sub(target).setY(0).length() * 1.7);
    }
    target.y = target.y * 0.7 + 0.6;
    if (sep > 2.5) {
      // Camera direction (target → camera) = behind the player, 35° off the axis.
      const behind = Math.atan2(-axis.x, -axis.z);
      const options = [behind + 0.6, behind - 0.6].map((y) => {
        let d = y - this.camYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        return d;
      });
      const turn = Math.abs(options[0]) < Math.abs(options[1]) ? options[0] : options[1];
      this.camYaw += THREE.MathUtils.clamp(turn, -0.8 * dt, 0.8 * dt);
    }
    const high = Math.max(...sim.bugs.map((x) => (x.dead ? 0 : x.alt))) / CELL;
    // Drop to a lower, more side-on angle while anyone's flying, so height reads.
    const pitch = 0.72 - Math.min(0.24, high * 0.07);
    const dist = THREE.MathUtils.clamp(sep * 0.7 + 25, 25, sim.bugs.length > 2 ? 46 : 38) * Math.sqrt(this.aspectK);
    const dir = new THREE.Vector3(Math.sin(this.camYaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(this.camYaw) * Math.cos(pitch));
    const followPos = target.clone().addScaledVector(dir, dist);
    const k = 1 - Math.exp(-dt * 3.5);
    this.camLook.lerp(target, k);
    this.camPos.lerp(followPos, k);

    // Pre-fight countdown: swoop down from a high, wide orbit into the fight view.
    if (this.intro > 0) {
      const k = smooth(this.intro);
      const a = this.camYaw + k * 1.5;
      const high = new THREE.Vector3(Math.sin(a) * 30, 24, Math.cos(a) * 30).multiplyScalar(Math.sqrt(this.aspectK));
      this.camPos.copy(followPos).lerp(high, k);
      this.camLook.copy(target).lerp(new THREE.Vector3(0, 0, 0), k * 0.6);
    }

    const c = this.cine(sim);
    this.ultWeight = c ? Math.min(1, this.ultWeight + dt * 6) : Math.max(0, this.ultWeight - dt * 2.5);
    let pos = this.camPos.clone();
    let look = this.camLook.clone();
    let fov = FOV;

    if (!c) this.ultSide = 0;
    if (c) {
      const caster = sim.bugs[c.caster];
      const foe = foeOf(sim, caster);
      const center = toWorld(caster.pos.x, caster.pos.y, caster.alt / CELL);
      const foeAt = toWorld(foe.pos.x, foe.pos.y, foe.alt / CELL);
      const r = caster.radius / CELL;
      const K = this.aspectK;
      // Shoot from whichever side is further from the opponent, so the camera never ends up inside it.
      if (this.ultSide === 0) {
        const probe = (sd: number) =>
          Math.hypot(caster.pos.x + Math.cos(caster.heading + 0.95 * sd) * 120 - foe.pos.x, caster.pos.y + Math.sin(caster.heading + 0.95 * sd) * 120 - foe.pos.y);
        this.ultSide = probe(1) >= probe(-1) ? 1 : -1;
      }
      const side = this.ultSide;
      const dirAt = (a: number) => new THREE.Vector3(Math.cos(caster.heading + a), 0, Math.sin(caster.heading + a));
      const p = c.p;
      let shot: THREE.Vector3;
      let aim: THREE.Vector3;
      if (c.id === 'venom-barrage' || c.id === 'sunder-beam') {
        // Over the shoulder, looking down the barrel at the target.
        // (Behind = away from the target, whichever way the stinger is mounted.)
        const away = Math.atan2(caster.pos.y - foe.pos.y, caster.pos.x - foe.pos.x) + 0.45 * side;
        const behind = new THREE.Vector3(Math.cos(away), 0, Math.sin(away));
        const push = c.phase === 'charge' ? smooth((p - 0.6) / 0.4) : 1 - smooth(p);
        shot = center.clone().addScaledVector(behind, r + (4.2 - push * 1.2) * K).add(new THREE.Vector3(0, 1.5 + 0.8 * K, 0));
        aim = center.clone().lerp(foeAt, c.phase === 'charge' ? 0.35 : 0.35 + smooth(p) * 0.4).add(new THREE.Vector3(0, 0.6, 0));
        fov = FOV - 6 * push;
      } else if (c.id === 'carapace-lock') {
        // Circle the bug as the shell forms.
        const a = 0.95 * side + (c.phase === 'charge' ? smooth(p) * 1.8 : 1.8 + p * 0.3) * side;
        shot = center.clone().addScaledVector(dirAt(a), r + 5 * K).add(new THREE.Vector3(0, 1.7 + 0.8 * K, 0));
        aim = center.clone().add(new THREE.Vector3(0, 0.6, 0));
        fov = FOV - 4;
      } else if (c.id === 'hornet-swarm') {
        // From high behind the raised hive (it fills the frame as it throbs)… then pull up and
        // back to watch the swarm stream across to the enemy.
        const away = Math.atan2(caster.pos.y - foe.pos.y, caster.pos.x - foe.pos.x) + 0.7 * side;
        const behind = new THREE.Vector3(Math.cos(away), 0, Math.sin(away));
        if (c.phase === 'charge') {
          const push = smooth((p - 0.3) / 0.7);
          shot = center.clone().addScaledVector(behind, r + (5 - push * 1.3) * K).add(new THREE.Vector3(0, 2.4 + 0.8 * K, 0));
          aim = center.clone().add(new THREE.Vector3(0, 0.9, 0)).lerp(foeAt, 0.15);
          fov = FOV - 5 * push;
        } else {
          const mid = center.clone().lerp(foeAt, 0.45);
          shot = center.clone().addScaledVector(behind, r + (4 + p * 2.5) * K).add(new THREE.Vector3(0, 3 + p * 1.5 + 0.8 * K, 0));
          aim = mid.add(new THREE.Vector3(0, 0.6, 0));
          fov = FOV - 3 * (1 - p);
        }
      } else if (c.id === 'quake-stomp') {
        // Low and to the side, looking up as it rears… then up and back for the shockwave.
        const fwd = dirAt(1.3 * side);
        if (c.phase === 'charge') {
          const push = smooth((p - 0.5) / 0.4);
          shot = center.clone().addScaledVector(fwd, r + (5.2 - push * 1.2) * K).add(new THREE.Vector3(0, 0.55 + 0.4 * K, 0));
          aim = center.clone().add(new THREE.Vector3(0, 1.3 + 0.5 * smooth(p / 0.7), 0));
          fov = FOV - 6 * push;
        } else {
          const up = smooth(p / 0.6);
          shot = center.clone().addScaledVector(fwd, r + (5 + up * 3) * K).add(new THREE.Vector3(0, 1.2 + up * 5 + 0.6 * K, 0));
          aim = center.clone().add(new THREE.Vector3(0, 0.3, 0));
          fov = FOV + 4 * up;
        }
      } else if (c.phase === 'charge') {
        // Mandible Crusher: low front three-quarter, then push in hard for the lunge.
        const fwd = dirAt(0.95 * side);
        const push = smooth((p - 0.8) / 0.2);
        shot = center.clone().addScaledVector(fwd, r + (5.2 - push * 1.4) * K).add(new THREE.Vector3(0, 1.0 + 0.7 * K - push * 0.3, 0));
        aim = center.clone().add(new THREE.Vector3(0, 0.6, 0));
        fov = FOV - 9 * push;
      } else {
        // …and the bite from the side, framing both bugs.
        const mid = center.clone().lerp(foeAt, 0.5);
        const axis = foeAt.clone().sub(center).setY(0).normalize();
        const perp = new THREE.Vector3(-axis.z, 0, axis.x).multiplyScalar(side);
        shot = mid.clone().addScaledVector(perp, (5.5 + p * 1.5) * K).add(new THREE.Vector3(0, 1.4 + 0.6 * K, 0));
        aim = mid.clone().add(new THREE.Vector3(0, 0.5, 0));
        fov = FOV - 6 * (1 - p);
      }
      // Handheld drift.
      shot.add(new THREE.Vector3(Math.sin(t * 2.3) * 0.12, Math.sin(t * 3.1) * 0.08, Math.cos(t * 1.7) * 0.1));
      const swing = c.phase === 'charge' ? smooth(p / 0.3) : 1;
      pos = pos.lerp(shot, swing * this.ultWeight);
      look = look.lerp(aim, swing * this.ultWeight);
      fov = THREE.MathUtils.lerp(FOV, fov, this.ultWeight);
    }

    // Background falls into fog around the caster (cheap depth-of-field stand-in).
    const fog = this.scene.fog as THREE.Fog;
    let focus = 8;
    if (c) {
      const b = sim.bugs[c.caster];
      focus = pos.distanceTo(toWorld(b.pos.x, b.pos.y, b.alt / CELL)) + b.radius / CELL + (c.id === 'carapace-lock' ? 0 : 6);
    }
    fog.near = THREE.MathUtils.lerp(55, focus + 0.5, this.ultWeight);
    fog.far = THREE.MathUtils.lerp(120, focus + 10, this.ultWeight);

    if (sim.shake > 0 || this.rumble > 0) {
      const s = sim.shake * 0.9 + this.rumble * this.rumble * 1.4;
      pos.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose() {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.renderer.dispose();
  }
}
