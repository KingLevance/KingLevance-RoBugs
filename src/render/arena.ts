/**
 * Arena dressing: everything around the fight that isn't a bug. Each arena has
 * its own theme (floor, walls, hazards, lights, sky, stadium colours), built
 * from primitives and procedural textures (no image assets, works on native).
 *
 *   pit      The Acid Pit:   rusty riveted scrapyard plates, sunken bubbling acid vats
 *   foundry  Stomper Foundry: dark tread-plate steel with glowing molten seams, hydraulic presses
 *   hive     The Hive Ring:  honeycomb floor in amber and gold, wax walls
 *   meadow   The Meadow:     outdoors on a sunny lawn; pebble edging, giant grass and flowers, mud patches
 *   pond     Moonlit Pond:   a mossy flagstone bank at night; reeds, lily pads, fireflies, a pool of water
 *
 * Reads sim state; never writes it.
 */
import * as THREE from 'three';

import type { ArenaId } from '@/game/opponents';
import { ARENA_SIZE, CELL, stompWarning, type Sim } from '@/game/sim';

import { toonMaterial, toonMesh } from './models';

const HALF = ARENA_SIZE / CELL / 2;
const SIZE = HALF * 2;
const toWorld = (x: number, y: number, h = 0) => new THREE.Vector3(x / CELL - HALF, h, y / CELL - HALF);

type Theme = {
  sky: [number, number];
  fog: number;
  wallA: number;
  wallB: number;
  rail: number;
  trim: number;
  plinth: number;
  stands: [number, number];
  pylonLight: number;
  spike: number;
  accent: { color: number; intensity: number } | null;
  floor: () => { map: THREE.DataTexture; emissive?: THREE.DataTexture };
  /** Outdoor arenas swap the stadium (walls, stands, crowd, floodlights) for open ground. */
  outdoor?: 'meadow' | 'pond';
  /** Extra sky/ground light (daylight, moonlight). */
  ambient?: { sky: number; ground: number; intensity: number };
  /** Colours of the "acid" pools (water at the pond). */
  pool?: { surface: number; emissive: number; bubble: number; steam: number; rim: number };
  /** Drifting particles: dust, pollen, fireflies. */
  motes?: { color: number; size: number; glow: boolean };
};

// ── Procedural textures ─────────────────────────────────────────────

const TEX = 512;

/** Deterministic hash noise in 0..1. */
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
/** Smooth value noise in 0..1. */
function noise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fill a texture from a per-pixel colour function (colours given in sRGB, stored linear). */
function paint(fn: (x: number, y: number, out: THREE.Color) => void, size = TEX) {
  const data = new Uint8Array(size * size * 4);
  const c = new THREE.Color();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn(x, y, c);
      c.convertSRGBToLinear();
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, c.r * 255);
      data[i + 1] = Math.min(255, c.g * 255);
      data[i + 2] = Math.min(255, c.b * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

const mix = (out: THREE.Color, a: number, b: number, t: number) => out.set(a).lerp(new THREE.Color(b), Math.max(0, Math.min(1, t)));

/** Riveted metal plates (shared by the pit and the foundry). */
function plates(
  base: number,
  dark: number,
  rivet: number,
  stain: number,
  stainAmt: number,
  tread: boolean,
): (x: number, y: number, c: THREE.Color) => void {
  const P = TEX / 4;
  return (x, y, c) => {
    const px = x % P;
    const py = y % P;
    const plate = Math.floor(x / P) * 7 + Math.floor(y / P) * 13;
    const tint = (hash(plate, 3) - 0.5) * 0.12;
    const n = noise(x / 22, y / 22) * 0.6 + noise(x / 6, y / 6) * 0.4;
    mix(c, base, stain, (noise(x / 40 + plate, y / 40) - (1 - stainAmt)) * 2.2);
    c.offsetHSL(0, 0, tint + (n - 0.5) * 0.08);
    // Diamond tread
    if (tread) {
      const dx = ((px + py) % 16) - 8;
      const dy = ((px - py + 1024) % 16) - 8;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 5) c.offsetHSL(0, 0, 0.06);
    }
    // Scratches
    if (hash(Math.floor(x / 3), Math.floor((y + x * 0.35) / 1.5)) > 0.997) c.offsetHSL(0, 0, 0.12);
    // Seams
    if (px < 3 || py < 3 || px > P - 3 || py > P - 3) c.set(dark);
    // Rivets
    for (const [rx, ry] of [
      [10, 10],
      [P - 10, 10],
      [10, P - 10],
      [P - 10, P - 10],
    ]) {
      const d = Math.hypot(px - rx, py - ry);
      if (d < 4) c.set(rivet).offsetHSL(0, 0, (4 - d) * 0.03);
      else if (d < 5.2) c.set(dark);
    }
  };
}

function honeycomb(): (x: number, y: number, c: THREE.Color) => void {
  const R = 26; // hex radius in px
  const w = Math.sqrt(3) * R;
  return (x, y, c) => {
    // Axial hex rounding.
    const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / R;
    const r = ((2 / 3) * y) / R;
    let rx = Math.round(q);
    let rz = Math.round(r);
    const ry = Math.round(-q - r);
    const dx = Math.abs(rx - q);
    const dy = Math.abs(ry - (-q - r));
    const dz = Math.abs(rz - r);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy <= dz) rz = -rx - ry;
    const cx = w * (rx + rz / 2);
    const cy = 1.5 * R * rz;
    const d = Math.hypot(x - cx, y - cy) / R;
    const cell = hash(rx, rz);
    const capped = cell > 0.72; // some cells are wax-capped (darker, glossy)
    mix(c, capped ? 0x7a4c14 : 0xa8741f, capped ? 0x5e3a10 : 0xc4913a, 1 - d);
    c.offsetHSL(0, 0, (noise(x / 9, y / 9) - 0.5) * 0.08);
    if (d > 0.84) c.set(0x3a2208);
    else if (d > 0.76) c.set(0x553210);
  };
}

/** Sunny lawn: mown stripes, clover patches and the odd daisy or buttercup. */
function lawn(): (x: number, y: number, c: THREE.Color) => void {
  return (x, y, c) => {
    const n = noise(x / 48, y / 48) * 0.55 + noise(x / 11, y / 11) * 0.3 + noise(x / 2.5, y / 9) * 0.25;
    mix(c, 0x3c8a2a, 0x86cf4e, n - 0.05);
    if (Math.floor(x / (TEX / 8)) % 2) c.offsetHSL(0, 0, 0.035); // mown stripes
    if (noise(x / 26 + 40, y / 26) > 0.78) c.offsetHSL(0.015, 0.04, -0.025); // clover
    const cell = 18;
    const fx = Math.floor(x / cell);
    const fy = Math.floor(y / cell);
    if (hash(fx, fy) > 0.94) {
      const cx = fx * cell + 4 + hash(fx, fy + 7) * (cell - 8);
      const cy = fy * cell + 4 + hash(fx + 3, fy) * (cell - 8);
      const d = Math.hypot(x - cx, y - cy);
      const yellow = hash(fx + 9, fy + 9) > 0.55;
      if (d < 1.4) c.set(yellow ? 0xff9a1a : 0xffd84a);
      else if (d < 3.4) c.set(yellow ? 0xffe14a : 0xfffaf0);
    }
  };
}

/** Mossy flagstones: irregular stones (cellular noise) with moss in the joints. */
function flagstones(): (x: number, y: number, c: THREE.Color) => void {
  const G = 64;
  const site = (i: number, j: number) => ({ x: (i + 0.15 + hash(i, j) * 0.7) * G, y: (j + 0.15 + hash(j + 31, i) * 0.7) * G });
  return (x, y, c) => {
    const gi = Math.floor(x / G);
    const gj = Math.floor(y / G);
    let d1 = Infinity;
    let d2 = Infinity;
    let id = 0;
    for (let i = gi - 1; i <= gi + 1; i++)
      for (let j = gj - 1; j <= gj + 1; j++) {
        const p = site(i, j);
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = i * 57 + j * 131;
        } else if (d < d2) d2 = d;
      }
    const edge = d2 - d1;
    mix(c, 0x55605a, 0x8a9488, hash(id, 5) * 0.8 + noise(x / 7, y / 7) * 0.3);
    c.offsetHSL(0, 0, (noise(x / 3, y / 3) - 0.5) * 0.06);
    if (noise(x / 30 + id, y / 30) > 0.68) mix(c, 0x55605a, 0x4f7a3a, 0.7); // moss on the stone
    if (edge < 4) mix(c, 0x2a3a22, 0x3f6a2c, noise(x / 4, y / 4)); // mossy joints
  };
}

/** Diagonal hazard stripes. */
function stripes(a: number, b: number, size = 128) {
  return paint((x, y, c) => c.set(((x + y) % 64) < 32 ? a : b).offsetHSL(0, 0, (noise(x / 8, y / 8) - 0.5) * 0.06), size);
}

// ── Themes ──────────────────────────────────────────────────────────

const THEMES: Record<ArenaId, Theme> = {
  pit: {
    sky: [0x120f0d, 0x3a2b1f],
    fog: 0x261d16,
    wallA: 0xf2c14e,
    wallB: 0x23201c,
    rail: 0x8c98a6,
    trim: 0xf2a93b,
    plinth: 0x2a221c,
    stands: [0x2e2620, 0x29221d],
    pylonLight: 0x7ce654,
    spike: 0xd9d4c7,
    accent: { color: 0x7ce654, intensity: 6 },
    floor: () => ({ map: paint(plates(0x5a5550, 0x221e1b, 0x9a8a78, 0x6e4a32, 0.28, false)) }),
  },
  foundry: {
    sky: [0x0e0a09, 0x40200f],
    fog: 0x24140d,
    wallA: 0xff6a1a,
    wallB: 0x1d1f24,
    rail: 0x6b7280,
    trim: 0xff8a3d,
    plinth: 0x1d1a19,
    stands: [0x2a2422, 0x241f1d],
    pylonLight: 0xff8a3d,
    spike: 0xffc7a0,
    accent: { color: 0xff7a2a, intensity: 9 },
    floor: () => {
      const P = TEX / 4;
      return {
        map: paint(plates(0x3a3f47, 0x15171b, 0x8c98a6, 0x4a3a30, 0.25, true)),
        // Molten seams between the plates.
        emissive: paint((x, y, c) => {
          const px = x % P;
          const py = y % P;
          const e = Math.min(px, py, P - px, P - py);
          const glow = e < 3 ? 1 : e < 9 ? (9 - e) / 14 : 0;
          c.setRGB(1.0 * glow, 0.38 * glow * glow, 0.05 * glow);
          c.convertLinearToSRGB(); // paint() converts back
        }),
      };
    },
  },
  hive: {
    sky: [0x140f06, 0x4a3412],
    fog: 0x2b1f0e,
    wallA: 0xe0b25a,
    wallB: 0x5a3610,
    rail: 0xc98a2b,
    trim: 0xf2c14e,
    plinth: 0x2c2110,
    stands: [0x33270f, 0x2c210d],
    pylonLight: 0xffd36b,
    spike: 0xfff0c2,
    accent: { color: 0xffb347, intensity: 5 },
    floor: () => ({ map: paint(honeycomb()) }),
  },
  meadow: {
    sky: [0x3f93e6, 0xd8eeff],
    fog: 0xc7e3f7,
    wallA: 0xf2c14e,
    wallB: 0x23201c,
    rail: 0x8c98a6,
    trim: 0x86cf4e,
    plinth: 0x4f8f31,
    stands: [0x4f8f31, 0x4f8f31],
    pylonLight: 0xffffff,
    spike: 0xd9d4c7,
    accent: null,
    floor: () => ({ map: paint(lawn()) }),
    outdoor: 'meadow',
    ambient: { sky: 0xcbe8ff, ground: 0x5f9a3a, intensity: 0.7 },
    motes: { color: 0xfff3b0, size: 0.11, glow: false },
  },
  pond: {
    sky: [0x050913, 0x1d2c4a],
    fog: 0x111c30,
    wallA: 0x6fb7ff,
    wallB: 0x1d2c4a,
    rail: 0x6b7280,
    trim: 0x6fb7ff,
    plinth: 0x22301f,
    stands: [0x22301f, 0x22301f],
    pylonLight: 0xb8e0ff,
    spike: 0xd9d4c7,
    accent: { color: 0x8fc8ff, intensity: 4 },
    floor: () => ({ map: paint(flagstones()) }),
    outdoor: 'pond',
    ambient: { sky: 0x6f8fd8, ground: 0x0e1a12, intensity: 0.45 },
    pool: { surface: 0x4aa3ff, emissive: 0x1f6fc0, bubble: 0xe0f4ff, steam: 0xcfe6ff, rim: 0x6b7a62 },
    motes: { color: 0xd8ff6a, size: 0.16, glow: true },
  },
};

// ── Dressing ────────────────────────────────────────────────────────

type Vat = { surface: THREE.Mesh; bubbles: THREE.InstancedMesh; steam: THREE.Mesh[]; x: number; z: number; r: number; seed: number };
type Mud = { blobs: THREE.InstancedMesh; x: number; z: number; r: number; seed: number };
/** A swaying instanced set (grass blades, reeds): base matrices plus per-instance phase. */
type Sway = { mesh: THREE.InstancedMesh; base: THREE.Matrix4[]; phase: number[]; amount: number };
type Flyer = { obj: THREE.Group; wings: THREE.Mesh[]; seed: number; r: number; h: number };
type Press = {
  head: THREE.Group;
  shadow: THREE.Mesh;
  lights: THREE.MeshBasicMaterial[];
  ring: THREE.Mesh;
  idx: number;
  x: number;
  z: number;
  r: number;
  /** Head materials: fade a little while a bug is right underneath. */
  mats: THREE.Material[];
  outlines: THREE.Object3D[];
  fade: number;
};

/** Where the press head waits between slams: above the camera's view. */
const PRESS_HIGH = 26;

export class ArenaDressing {
  private theme: Theme;
  private vats: Vat[] = [];
  private muds: Mud[] = [];
  private sways: Sway[] = [];
  private flyers: Flyer[] = [];
  private clouds: THREE.Group[] = [];
  private lilies: THREE.Mesh[] = [];
  private presses: Press[] = [];
  private seamMat: THREE.MeshToonMaterial | null = null;
  private pylonLights: THREE.MeshBasicMaterial[] = [];
  private beams: { mesh: THREE.Mesh; from: THREE.Vector3; phase: number }[] = [];
  private motes: THREE.Points;
  private crowd: THREE.InstancedMesh | null = null;
  private crowdBase: THREE.Matrix4[] = [];
  private crowdPhase: number[] = [];
  private hypeLevel = 0.15;
  private frame = 0;
  private m = new THREE.Matrix4();

  constructor(
    private scene: THREE.Scene,
    sim: Sim,
  ) {
    this.theme = THEMES[sim.arena];
    const T = this.theme;
    scene.fog = new THREE.Fog(T.fog, 55, 120);

    this.buildSky();
    this.buildFloor();
    if (T.outdoor) this.buildOutdoors(T.outdoor);
    else {
      this.buildWalls(sim.spikedWalls);
      this.buildStadium();
    }
    this.buildLights();
    sim.hazards.forEach((h, idx) =>
      h.kind === 'acid' ? this.buildVat(h.x, h.y, h.r) : h.kind === 'mud' ? this.buildMud(h.x, h.y, h.r) : this.buildPress(h.x, h.y, h.r, idx),
    );

    // Drifting motes: dust in the floodlights, pollen in the sun, fireflies at night.
    const mote = T.motes ?? { color: 0xfff1c8, size: 0.09, glow: false };
    const pts = new Float32Array(220 * 3);
    for (let i = 0; i < 220; i++) {
      pts[i * 3] = (hash(i, 1) - 0.5) * SIZE * 1.4;
      pts[i * 3 + 1] = 0.5 + hash(i, 2) * 9;
      pts[i * 3 + 2] = (hash(i, 3) - 0.5) * SIZE * 1.4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.motes = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: mote.color,
        size: mote.size,
        transparent: true,
        opacity: mote.glow ? 0.9 : 0.5,
        depthWrite: false,
        blending: mote.glow ? THREE.AdditiveBlending : THREE.NormalBlending,
      }),
    );
    scene.add(this.motes);
  }

  /** Crowd excitement: bumps on big moments, decays back to a murmur. */
  hype(n: number) {
    this.hypeLevel = Math.min(1.4, this.hypeLevel + n);
  }

  private buildSky() {
    const [top, horizon] = this.theme.sky;
    const geo = new THREE.SphereGeometry(170, 24, 16);
    const colors: number[] = [];
    const a = new THREE.Color(top);
    const b = new THREE.Color(horizon);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const k = THREE.MathUtils.clamp(pos.getY(i) / 170, 0, 1);
      const c = b.clone().lerp(a, Math.pow(k, 0.6));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    sky.renderOrder = -10;
    this.scene.add(sky);
  }

  private buildFloor() {
    const { map, emissive } = this.theme.floor();
    const mat = toonMaterial(0xffffff);
    mat.map = map;
    if (emissive) {
      mat.emissive.set(0xffffff);
      mat.emissiveMap = emissive;
      this.seamMat = mat;
    }
    const floor = new THREE.Mesh(new THREE.BoxGeometry(SIZE, 0.4, SIZE), mat);
    floor.position.y = -0.2;
    this.scene.add(floor);

    if (this.theme.outdoor) return;
    // Hazard-striped border just inside the walls.
    const stripeTex = stripes(this.theme.wallA, this.theme.wallB);
    for (let i = 0; i < 4; i++) {
      const horiz = i < 2;
      const t = stripeTex.clone();
      t.needsUpdate = true;
      t.repeat.set(horiz ? 22 : 0.6, horiz ? 0.6 : 22);
      const band = new THREE.Mesh(new THREE.BoxGeometry(horiz ? SIZE : 0.45, 0.03, horiz ? 0.45 : SIZE), toonMaterial(0xffffff));
      (band.material as THREE.MeshToonMaterial).map = t;
      band.position.set(horiz ? 0 : (i === 2 ? -1 : 1) * (HALF - 0.23), 0.015, horiz ? (i === 0 ? -1 : 1) * (HALF - 0.23) : 0);
      this.scene.add(band);
    }
  }

  private buildWalls(spiked: boolean) {
    const T = this.theme;
    const stripeTex = stripes(T.wallA, T.wallB);
    const railMat = toonMaterial(T.rail);
    const spikeMat = toonMaterial(T.spike);
    for (let i = 0; i < 4; i++) {
      const horiz = i < 2;
      const len = horiz ? SIZE + 1.6 : SIZE;
      const tex = stripeTex.clone();
      tex.needsUpdate = true;
      tex.repeat.set(len / 1.4, 1);
      const wallMat = toonMaterial(0xffffff);
      wallMat.map = tex;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(horiz ? len : 0.8, 1.3, horiz ? 0.8 : len), wallMat);
      const off = HALF + 0.4;
      const pos = new THREE.Vector3(horiz ? 0 : i === 2 ? -off : off, 0.65, horiz ? (i === 0 ? -off : off) : 0);
      wall.position.copy(pos);
      if (!horiz) wall.rotation.y = 0; // UVs run along the long side either way
      this.scene.add(wall);
      // Padded rail on top.
      const rail = toonMesh(new THREE.CylinderGeometry(0.28, 0.28, len, 10), railMat, 0.03);
      rail.rotation.set(horiz ? 0 : Math.PI / 2, 0, horiz ? Math.PI / 2 : 0);
      rail.position.copy(pos).setY(1.4);
      this.scene.add(rail);

      if (!spiked) continue;
      for (let k = 0; k < 11; k++) {
        const spike = toonMesh(new THREE.ConeGeometry(0.22, 0.75, 6), spikeMat, 0.04);
        const along = -HALF + (k + 0.5) * (SIZE / 11);
        const inward = horiz ? (i === 0 ? 1 : -1) : i === 2 ? 1 : -1;
        if (horiz) {
          spike.position.set(along, 0.7, (i === 0 ? -HALF : HALF) + 0.05 * inward);
          spike.rotation.x = (Math.PI / 2) * inward;
        } else {
          spike.position.set((i === 2 ? -HALF : HALF) + 0.05 * inward, 0.7, along);
          spike.rotation.z = (-Math.PI / 2) * inward;
        }
        this.scene.add(spike);
      }
    }
    // Corner pylons with blinking lights.
    const pylonMat = toonMaterial(0x2b3038);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const p = toonMesh(new THREE.BoxGeometry(1.4, 2.6, 1.4), pylonMat, 0.04);
        p.position.set(sx * (HALF + 0.5), 1.1, sz * (HALF + 0.5));
        this.scene.add(p);
        const lightMat = new THREE.MeshBasicMaterial({ color: T.pylonLight });
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.35, 1.0), lightMat);
        lamp.position.set(sx * (HALF + 0.5), 2.55, sz * (HALF + 0.5));
        this.scene.add(lamp);
        this.pylonLights.push(lightMat);
      }
  }

  /** Raised platform, outer floor, tiered stands with a crowd, floodlights with sweeping beams. */
  private buildStadium() {
    const T = this.theme;
    const plinth = toonMesh(new THREE.BoxGeometry(SIZE + 5, 1.6, SIZE + 5), toonMaterial(T.plinth), 0.02);
    plinth.position.y = -1.0;
    this.scene.add(plinth);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(SIZE + 5.2, 0.12, SIZE + 5.2), new THREE.MeshBasicMaterial({ color: T.trim }));
    trim.position.y = -0.25;
    this.scene.add(trim);
    const outer = new THREE.Mesh(new THREE.CircleGeometry(90, 48), toonMaterial(T.plinth));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -1.8;
    this.scene.add(outer);

    const tiers = 5;
    const crowdColors = [0xf2a93b, 0x3ddc97, 0xff5d5d, 0x4fa8ff, 0xc77dff, 0xf1ede4, 0x8ed1e6];
    const perTier = 110;
    this.crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 1.0, 0.7), new THREE.MeshToonMaterial({ color: 0xffffff }), tiers * perTier);
    const c = new THREE.Color();
    let n = 0;
    for (let i = 0; i < tiers; i++) {
      const r = 34 + i * 3.4;
      const top = -1.8 + 1.6 + i * 1.7;
      const mat = toonMaterial(T.stands[i % 2]);
      const riser = new THREE.Mesh(new THREE.CylinderGeometry(r, r, top + 1.8, 56, 1, true), mat);
      (riser.material as THREE.Material).side = THREE.DoubleSide;
      riser.position.y = (top - 1.8) / 2;
      const tread = new THREE.Mesh(new THREE.RingGeometry(r, r + 3.4, 56), mat);
      tread.rotation.x = -Math.PI / 2;
      tread.position.y = top;
      this.scene.add(riser, tread);
      for (let k = 0; k < perTier; k++) {
        const a = (k / perTier) * Math.PI * 2 + i * 0.13;
        const rr = r + 1.4 + Math.sin(k * 7.3 + i) * 0.5;
        const m = new THREE.Matrix4().makeRotationY(-a);
        m.setPosition(Math.cos(a) * rr, top + 0.5, Math.sin(a) * rr);
        this.crowd.setMatrixAt(n, m);
        this.crowdBase.push(m);
        this.crowdPhase.push(hash(k, i) * Math.PI * 2);
        this.crowd.setColorAt(n, c.set(crowdColors[(k * 5 + i * 3) % crowdColors.length]).multiplyScalar(0.75));
        n++;
      }
    }
    this.crowd.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.crowd.instanceMatrix.needsUpdate = true;
    if (this.crowd.instanceColor) this.crowd.instanceColor.needsUpdate = true;
    this.scene.add(this.crowd);

    // Floodlight towers + sweeping light beams.
    const pole = toonMaterial(0x3a424d);
    const lamp = new THREE.MeshBasicMaterial({ color: 0xfff1c8 });
    const beamGeo = new THREE.ConeGeometry(1, 1, 20, 1, true);
    beamGeo.translate(0, -0.5, 0); // apex at the origin, opening down −y
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const r = 54;
      const tower = toonMesh(new THREE.CylinderGeometry(0.5, 0.8, 26, 8), pole, 0.03);
      tower.position.set(Math.cos(a) * r, 11, Math.sin(a) * r);
      this.scene.add(tower);
      const head = new THREE.Mesh(new THREE.BoxGeometry(5, 2.4, 0.6), lamp);
      head.position.set(Math.cos(a) * r, 24.5, Math.sin(a) * r);
      head.lookAt(0, 0, 0);
      this.scene.add(head);
      const beam = new THREE.Mesh(
        beamGeo,
        new THREE.MeshBasicMaterial({
          color: 0xfff1c8,
          transparent: true,
          opacity: 0.07,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        }),
      );
      this.scene.add(beam);
      this.beams.push({ mesh: beam, from: head.position.clone(), phase: i * 1.7 });
    }
  }

  private buildLights() {
    const amb = this.theme.ambient;
    if (amb) this.scene.add(new THREE.HemisphereLight(amb.sky, amb.ground, amb.intensity));
    const a = this.theme.accent;
    if (!a) return;
    const l = new THREE.PointLight(a.color, a.intensity, 30, 1.5);
    l.position.set(0, 4, 0);
    this.scene.add(l);
  }

  private buildVat(sx: number, sy: number, rr: number) {
    const r = rr / CELL;
    const p = toWorld(sx, sy);
    // Steel rim and a dark sunken wall.
    const pool = this.theme.pool ?? { surface: 0x7ce654, emissive: 0x3fae22, bubble: 0xb8ff8a, steam: 0xd8ffd0, rim: 0x6b7280 };
    const rim = toonMesh(new THREE.TorusGeometry(r + 0.12, 0.2, 8, 36), toonMaterial(pool.rim), 0.03);
    rim.rotation.x = Math.PI / 2;
    rim.position.copy(p).setY(0.08);
    const pit = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.92, 0.3, 36, 1, true), toonMaterial(0x101410));
    (pit.material as THREE.Material).side = THREE.DoubleSide;
    pit.position.copy(p).setY(-0.1);
    // Glowing acid surface, slightly below floor level.
    const surface = new THREE.Mesh(
      new THREE.CircleGeometry(r, 36),
      toonMaterial(pool.surface, { emissive: pool.emissive }),
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.copy(p).setY(0.01); // just above the floor slab, or it hides the pool
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 1.6, 36),
      new THREE.MeshBasicMaterial({ color: pool.surface, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.copy(p).setY(0.02);
    this.scene.add(rim, pit, surface, glow);

    const bubbles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 8, 6), toonMaterial(pool.bubble, { emissive: pool.emissive }), 14);
    bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(bubbles);
    const steam: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 6),
        new THREE.MeshBasicMaterial({ color: pool.steam, transparent: true, opacity: 0.1, depthWrite: false }),
      );
      this.scene.add(s);
      steam.push(s);
    }
    this.vats.push({ surface, bubbles, steam, x: p.x, z: p.z, r, seed: this.vats.length * 3.7 });
  }

  /**
   * A press that drops in from above: the head waits out of view, and only the
   * floor shows it's there (a striped target ring with four lamps). During the
   * warning its shadow darkens and the lamps flash as it comes down; it slams,
   * then yanks back up out of sight.
   */
  private buildPress(sx: number, sy: number, rr: number, idx: number) {
    const r = rr / CELL;
    const p = toWorld(sx, sy);

    const head = new THREE.Group();
    head.add(toonMesh(new THREE.CylinderGeometry(r * 0.95, r * 0.95, 0.8, 12), toonMaterial(0x23272e), 0.04));
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.26, 24, 1, true), toonMaterial(0xffffff));
    const bandTex = stripes(0xf2c14e, 0x1d1f24);
    bandTex.repeat.set(8, 1);
    (band.material as THREE.MeshToonMaterial).map = bandTex;
    band.position.y = -0.18;
    head.add(band);
    const plate = toonMesh(new THREE.CylinderGeometry(r, r, 0.2, 12), toonMaterial(0xff8a3d), 0.03);
    plate.position.y = -0.48;
    head.add(plate);
    // A short piston stub above (the rest disappears out of view).
    head.add(toonMesh(new THREE.CylinderGeometry(0.35, 0.35, 6, 10), toonMaterial(0xc8ced6), 0.03).translateY(3.4));
    head.position.set(p.x, PRESS_HIGH, p.z);
    this.scene.add(head);

    // Its shadow on the floor: invisible at rest, darkening as the head comes down.
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(r, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(p.x, 0.025, p.z);
    this.scene.add(shadow);

    // Hazard-striped target ring with four lamps around it.
    const ringTex = stripes(0xf2c14e, 0x1d1f24);
    ringTex.repeat.set(3, 3);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.86, r, 40),
      new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, 0.03, p.z);
    this.scene.add(ring);
    const lights: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const m = new THREE.MeshBasicMaterial({ color: 0x551a0c });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), m);
      lamp.position.set(p.x + Math.cos(a) * (r + 0.35), 0.02, p.z + Math.sin(a) * (r + 0.35));
      this.scene.add(lamp);
      lights.push(m);
    }

    const mats = new Set<THREE.Material>();
    const outlines: THREE.Object3D[] = [];
    head.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.Material;
      if (m instanceof THREE.MeshBasicMaterial && m.side === THREE.BackSide) outlines.push(o);
      else mats.add(m);
    });
    this.presses.push({ head, shadow, lights, ring, idx, x: p.x, z: p.z, r, mats: [...mats], outlines, fade: 1 });
  }

  /**
   * Open ground instead of a stadium: the arena edge is a ring of stones, with
   * giant grass (or reeds), flowers, trees, clouds and sky life beyond it.
   */
  private buildOutdoors(kind: 'meadow' | 'pond') {
    const meadow = kind === 'meadow';
    const ground = new THREE.Mesh(new THREE.CircleGeometry(150, 64), toonMaterial(meadow ? 0x4f8f31 : 0x1a2618));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.06;
    this.scene.add(ground);
    if (!meadow) {
      // Dark water all around the stone bank.
      const water = new THREE.Mesh(new THREE.RingGeometry(HALF * 1.75, 150, 72), toonMaterial(0x0f2a44, { emissive: 0x061628 }));
      water.rotation.x = -Math.PI / 2;
      water.position.y = -0.03;
      this.scene.add(water);
    }

    // The edge: rounded stones along all four sides (the sim's walls).
    const perSide = 18;
    const stones = new THREE.InstancedMesh(new THREE.SphereGeometry(0.62, 10, 8), toonMaterial(0xffffff), perSide * 4 + 4);
    const stoneCols = meadow ? [0xc9c1b0, 0x9d978b, 0xb3a58c] : [0x5d6a57, 0x48553f, 0x6b7563];
    const c = new THREE.Color();
    let k = 0;
    const place = (x: number, z: number, i: number) => {
      const s = new THREE.Vector3(1 + hash(i, 1) * 0.45, 0.6 + hash(i, 2) * 0.35, 0.85 + hash(i, 3) * 0.3);
      this.m.compose(new THREE.Vector3(x, s.y * 0.3, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, hash(i, 4) * 6, 0)), s);
      stones.setMatrixAt(k, this.m);
      stones.setColorAt(k, c.set(stoneCols[i % stoneCols.length]));
      k++;
    };
    const off = HALF + 0.55;
    for (let i = 0; i < perSide; i++) {
      const a = -HALF + (i + 0.5) * (SIZE / perSide);
      place(a, -off, i);
      place(a, off, i + 50);
      place(-off, a, i + 100);
      place(off, a, i + 150);
    }
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ])
      place(sx * off, sz * off, 200 + k);
    stones.count = k;
    stones.instanceMatrix.needsUpdate = true;
    if (stones.instanceColor) stones.instanceColor.needsUpdate = true;
    this.scene.add(stones);

    // Giant grass blades (meadow) or reeds (pond) beyond the edge; they sway.
    const n = meadow ? 520 : 300;
    const blade = new THREE.ConeGeometry(meadow ? 0.16 : 0.09, 1, 4);
    blade.translate(0, 0.5, 0);
    const grass = new THREE.InstancedMesh(blade, toonMaterial(0xffffff), n);
    const greens = meadow ? [0x4f9e33, 0x6cbf45, 0x3f8a2a, 0x88d457] : [0x3f5f2a, 0x52703a, 0x2f4a22];
    const base: THREE.Matrix4[] = [];
    const phase: number[] = [];
    for (let i = 0; i < n; i++) {
      // Somewhere in a band just outside the arena.
      const ang = hash(i, 11) * Math.PI * 2;
      const reach = HALF + 1.4 + Math.pow(hash(i, 12), 1.6) * 16;
      const sq = Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
      const x = (Math.cos(ang) / sq) * reach;
      const z = (Math.sin(ang) / sq) * reach;
      const h = (meadow ? 1.6 : 2.6) + hash(i, 13) * (meadow ? 4.5 : 3.5);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((hash(i, 14) - 0.5) * 0.3, hash(i, 15) * 6, (hash(i, 16) - 0.5) * 0.3)),
        new THREE.Vector3(1, h, 1),
      );
      grass.setMatrixAt(i, m);
      grass.setColorAt(i, c.set(greens[i % greens.length]));
      base.push(m);
      phase.push(hash(i, 17) * Math.PI * 2);
    }
    grass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    this.scene.add(grass);
    this.sways.push({ mesh: grass, base, phase, amount: meadow ? 0.07 : 0.05 });

    if (meadow) {
      // Big flowers on stalks, peeking over the stones.
      const count = 34;
      const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.09, 1, 5).translate(0, 0.5, 0), toonMaterial(0x4f9e33), count);
      const heads = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 0.5, 0.18, 12), toonMaterial(0xffffff), count);
      const middles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 8, 6), toonMaterial(0xffb21a), count);
      const petals = [0xfffaf0, 0xffe14a, 0xff7eb6, 0xc9a4ff, 0xff8a3d];
      for (let i = 0; i < count; i++) {
        const ang = hash(i, 21) * Math.PI * 2;
        const reach = HALF + 2 + hash(i, 22) * 7;
        const sq = Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
        const x = (Math.cos(ang) / sq) * reach;
        const z = (Math.sin(ang) / sq) * reach;
        const h = 2.2 + hash(i, 23) * 3.5;
        stems.setMatrixAt(i, this.m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1)));
        const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5 - hash(i, 24) * 0.4, Math.atan2(-x, -z), 0, 'YXZ'));
        heads.setMatrixAt(i, this.m.compose(new THREE.Vector3(x, h, z), tilt, new THREE.Vector3(1, 1, 1)));
        heads.setColorAt(i, c.set(petals[i % petals.length]));
        middles.setMatrixAt(i, this.m.compose(new THREE.Vector3(x, h + 0.08, z), tilt, new THREE.Vector3(1, 0.5, 1)));
      }
      if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
      this.scene.add(stems, heads, middles);

      // Puffy clouds drifting round the sky, and a warm sun.
      for (let i = 0; i < 9; i++) {
        const g = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
        for (let j = 0; j < 5; j++) {
          const puff = new THREE.Mesh(new THREE.SphereGeometry(3 + hash(i, j) * 3, 10, 8), mat);
          puff.position.set((j - 2) * 3.2, hash(j, i) * 1.5, hash(i + j, 3) * 2);
          puff.scale.y = 0.6;
          g.add(puff);
        }
        const a = (i / 9) * Math.PI * 2;
        g.position.set(Math.cos(a) * (80 + hash(i, 5) * 40), 38 + hash(i, 6) * 18, Math.sin(a) * (80 + hash(i, 5) * 40));
        g.lookAt(0, g.position.y, 0);
        this.scene.add(g);
        this.clouds.push(g);
      }
      const sun = new THREE.Mesh(new THREE.CircleGeometry(9, 32), new THREE.MeshBasicMaterial({ color: 0xfff6c8, fog: false }));
      sun.position.set(-70, 95, -90);
      sun.lookAt(0, 0, 0);
      this.scene.add(sun);

      // Butterflies flitting over the field.
      const wingCols = [0xff9a1a, 0xffe14a, 0xffffff, 0x6fb7ff, 0xff7eb6, 0xb58cff, 0xff9a1a];
      for (let i = 0; i < wingCols.length; i++) {
        const obj = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({ color: wingCols[i], side: THREE.DoubleSide });
        const wings = [-1, 1].map((sd) => {
          const w = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.32).translate(0.21 * sd, 0, 0), mat);
          w.rotation.x = -Math.PI / 2;
          const pivot = new THREE.Mesh();
          pivot.add(w);
          obj.add(pivot);
          return pivot;
        });
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.22, 3, 6), new THREE.MeshBasicMaterial({ color: 0x2a2a2a }));
        body.rotation.x = Math.PI / 2;
        obj.add(body);
        this.scene.add(obj);
        this.flyers.push({ obj, wings, seed: i * 1.7, r: 6 + hash(i, 31) * 10, h: 1.6 + hash(i, 32) * 3 });
      }
    } else {
      // Lily pads (some in flower) floating on the water around the bank.
      for (let i = 0; i < 26; i++) {
        const r = 0.9 + hash(i, 41) * 1.1;
        const pad = new THREE.Mesh(new THREE.CircleGeometry(r, 20, 0.35, Math.PI * 2 - 0.35), toonMaterial(i % 3 ? 0x3f7a2c : 0x528f36));
        pad.rotation.set(-Math.PI / 2, 0, hash(i, 42) * 6);
        const ang = hash(i, 43) * Math.PI * 2;
        const reach = HALF * 1.85 + hash(i, 44) * 16;
        pad.position.set(Math.cos(ang) * reach, 0, Math.sin(ang) * reach);
        this.scene.add(pad);
        this.lilies.push(pad);
        if (hash(i, 45) > 0.7) {
          const bloom = toonMesh(new THREE.ConeGeometry(0.35, 0.4, 7), toonMaterial(0xffb3d1, { emissive: 0x40182a }), 0.03);
          bloom.position.copy(pad.position).setY(0.2);
          this.scene.add(bloom);
        }
      }
      // Moon and stars.
      const moon = new THREE.Mesh(new THREE.CircleGeometry(7, 32), new THREE.MeshBasicMaterial({ color: 0xf2f4ff, fog: false }));
      moon.position.set(60, 85, -100);
      moon.lookAt(0, 0, 0);
      this.scene.add(moon);
      const stars = new Float32Array(400 * 3);
      for (let i = 0; i < 400; i++) {
        const a = hash(i, 51) * Math.PI * 2;
        const e = 0.15 + hash(i, 52) * 1.3;
        stars[i * 3] = Math.cos(a) * Math.cos(e) * 160;
        stars[i * 3 + 1] = Math.sin(e) * 160;
        stars[i * 3 + 2] = Math.sin(a) * Math.cos(e) * 160;
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(stars, 3));
      this.scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.9, fog: false, transparent: true, opacity: 0.8 })));
    }

    // Trees on the horizon.
    const trunkMat = toonMaterial(meadow ? 0x7a5230 : 0x2a2018);
    const leafMat = toonMaterial(meadow ? 0x3f8a2a : 0x15261a);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + hash(i, 61) * 0.3;
      const r = 62 + hash(i, 62) * 30;
      const h = 8 + hash(i, 63) * 8;
      const trunk = toonMesh(new THREE.CylinderGeometry(0.9, 1.3, h, 7), trunkMat, 0.03);
      trunk.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      this.scene.add(trunk);
      for (let j = 0; j < 3; j++) {
        const leaf = toonMesh(new THREE.SphereGeometry(4 + hash(i, j) * 2.5, 10, 8), leafMat, 0.03);
        leaf.position.set(trunk.position.x + (j - 1) * 2.6, h + 1 + hash(j, i) * 2.5, trunk.position.z + (hash(i + j, 9) - 0.5) * 3);
        this.scene.add(leaf);
      }
    }
  }

  /** A mud puddle: an uneven brown patch with a wet sheen and slow bubbles. */
  private buildMud(sx: number, sy: number, rr: number) {
    const r = rr / CELL;
    const p = toWorld(sx, sy);
    const seed = this.muds.length * 5.3 + 1;
    const geo = new THREE.CircleGeometry(r, 40);
    const pos = geo.getAttribute('position');
    for (let i = 1; i < pos.count; i++) {
      const a = Math.atan2(pos.getY(i), pos.getX(i));
      const k = 1 + (hash(i, seed) - 0.5) * 0.12 + Math.sin(a * 3 + seed) * 0.07;
      pos.setXY(i, pos.getX(i) * k, pos.getY(i) * k);
    }
    const outer = new THREE.Mesh(geo, toonMaterial(0x6b4a2c));
    outer.rotation.x = -Math.PI / 2;
    outer.position.copy(p).setY(0.012);
    const inner = new THREE.Mesh(geo.clone().scale(0.72, 0.72, 1), toonMaterial(0x4a321d));
    inner.rotation.x = -Math.PI / 2;
    inner.position.copy(p).setY(0.018);
    const sheen = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.35, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false }),
    );
    sheen.rotation.x = -Math.PI / 2;
    sheen.scale.set(1.6, 0.6, 1);
    sheen.position.copy(p).add(new THREE.Vector3(-r * 0.2, 0.024, -r * 0.25));
    this.scene.add(outer, inner, sheen);
    // Clods of dirt splashed round the edge.
    const clodMat = toonMaterial(0x5a3d24);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + hash(i, seed) * 0.5;
      const clod = new THREE.Mesh(new THREE.SphereGeometry(0.16 + hash(seed, i) * 0.14, 7, 5), clodMat);
      clod.scale.y = 0.5;
      clod.position.copy(p).add(new THREE.Vector3(Math.cos(a) * r * 1.05, 0.04, Math.sin(a) * r * 1.05));
      this.scene.add(clod);
    }
    const blobs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 6), toonMaterial(0x6b4630), 6);
    blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(blobs);
    this.muds.push({ blobs, x: p.x, z: p.z, r, seed });
  }

  /** Outdoor life: swaying grass, butterflies, drifting clouds, mud bubbles, firefly glow. */
  private updateOutdoors(t: number) {
    for (const m of this.muds) {
      for (let i = 0; i < m.blobs.count; i++) {
        const life = (t * 0.3 + hash(i, m.seed)) % 1;
        const a = hash(i, m.seed + 1) * Math.PI * 2;
        const d = Math.sqrt(hash(i, m.seed + 2)) * m.r * 0.7;
        const s = life < 0.8 ? life / 0.8 : (1 - life) * 4;
        this.m.makeScale(s, s * 0.7, s).setPosition(m.x + Math.cos(a) * d, 0.03, m.z + Math.sin(a) * d);
        m.blobs.setMatrixAt(i, this.m);
      }
      m.blobs.instanceMatrix.needsUpdate = true;
    }
    if (this.frame % 2 === 0) {
      const rot = new THREE.Matrix4();
      for (const s of this.sways) {
        for (let i = 0; i < s.base.length; i++) {
          const sway = Math.sin(t * 1.4 + s.phase[i] + s.base[i].elements[12] * 0.15) * s.amount;
          rot.makeRotationZ(sway);
          this.m.multiplyMatrices(s.base[i], rot);
          s.mesh.setMatrixAt(i, this.m);
        }
        s.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    for (const f of this.flyers) {
      const a = t * 0.35 + f.seed;
      f.obj.position.set(Math.cos(a) * f.r + Math.sin(a * 2.3) * 2, f.h + Math.sin(t * 2.1 + f.seed) * 0.6, Math.sin(a) * f.r);
      f.obj.rotation.y = -a;
      const flap = 0.2 + Math.abs(Math.sin(t * 16 + f.seed)) * 1.1;
      f.wings[0].rotation.z = flap;
      f.wings[1].rotation.z = -flap;
    }
    for (const [i, g] of this.clouds.entries()) g.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.0006 * (1 + (i % 3) * 0.3));
    for (const [i, pad] of this.lilies.entries()) pad.position.y = 0.01 + Math.sin(t * 0.8 + i) * 0.03;
    if (this.theme.motes?.glow) (this.motes.material as THREE.PointsMaterial).opacity = 0.55 + Math.sin(t * 2.7) * 0.35;
  }

  update(sim: Sim, t: number, dt: number) {
    this.frame++;
    this.hypeLevel = Math.max(0.12, this.hypeLevel - dt * 0.35);

    // Molten seams flicker.
    if (this.seamMat) this.seamMat.emissiveIntensity = 0.75 + Math.sin(t * 2.3) * 0.15 + Math.sin(t * 7.1) * 0.05;
    // Pylon lights pulse; faster when the crowd is hyped.
    this.pylonLights.forEach((m, i) => {
      const on = Math.sin(t * (2 + this.hypeLevel * 6) + i * 1.6) > -0.2;
      m.color.set(this.theme.pylonLight).multiplyScalar(on ? 1 : 0.25);
    });

    // Acid vats: bubbles rise and pop, steam drifts up.
    for (const v of this.vats) {
      (v.surface.material as THREE.MeshToonMaterial).emissiveIntensity = 0.8 + Math.sin(t * 2 + v.seed) * 0.2;
      for (let i = 0; i < v.bubbles.count; i++) {
        const life = (t * 0.6 + hash(i, v.seed)) % 1;
        const a = hash(i, v.seed + 1) * Math.PI * 2;
        const d = Math.sqrt(hash(i, v.seed + 2)) * v.r * 0.85;
        const s = (0.4 + hash(i, v.seed + 3)) * (life < 0.85 ? life / 0.85 : (1 - life) * 6);
        this.m.makeScale(s, s, s).setPosition(v.x + Math.cos(a) * d, -0.05 + life * 0.25, v.z + Math.sin(a) * d);
        v.bubbles.setMatrixAt(i, this.m);
      }
      v.bubbles.instanceMatrix.needsUpdate = true;
      v.steam.forEach((s, i) => {
        const life = (t * 0.18 + i / v.steam.length) % 1;
        const a = i * 2.1 + v.seed;
        s.position.set(v.x + Math.cos(a) * v.r * 0.5, 0.2 + life * 3.5, v.z + Math.sin(a) * v.r * 0.5);
        s.scale.setScalar(0.6 + life * 1.8);
        (s.material as THREE.MeshBasicMaterial).opacity = 0.12 * Math.sin(life * Math.PI);
      });
    }

    // Presses: wait out of view, come down during the warning, slam, yank back up.
    for (const p of this.presses) {
      const h = sim.hazards[p.idx];
      if (h.kind !== 'stomper') continue;
      const warnStart = h.period - 1.2;
      const low = 0.65;
      let y = PRESS_HIGH;
      if (h.t < 0.12) y = low;
      else if (h.t < 0.8) y = low + (1 - Math.pow(1 - (h.t - 0.12) / 0.68, 3)) * (PRESS_HIGH - low);
      else if (h.t > warnStart) y = PRESS_HIGH - (PRESS_HIGH - 3.2) * Math.pow((h.t - warnStart) / 1.2, 2);
      const warn = stompWarning(h);
      const shudder = warn ? Math.sin(t * 60) * 0.04 : 0;
      p.head.position.set(p.x + shudder, y, p.z);
      p.head.visible = y < PRESS_HIGH - 0.1;
      const closeness = 1 - (y - low) / (PRESS_HIGH - low);
      (p.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, closeness) * 0.55;
      const blink = warn && Math.sin(t * 22) > 0;
      p.lights.forEach((m) => m.color.set(blink ? 0xff3b1a : 0x551a0c));
      (p.ring.material as THREE.MeshBasicMaterial).opacity = warn ? 0.6 + Math.sin(t * 22) * 0.3 : 0.4;
      // Slightly see-through while a bug is right underneath, so the slam doesn't hide the fight.
      const near = sim.bugs.some((b) => Math.hypot(b.pos.x / CELL - HALF - p.x, b.pos.y / CELL - HALF - p.z) < p.r + 1.5 + b.radius / CELL);
      p.fade += ((near && y < 6 ? 0.55 : 1) - p.fade) * Math.min(1, dt * 8);
      const solid = p.fade > 0.97;
      for (const m of p.mats) {
        // Opaque shaders force alpha to 1, so switching needs a rebuild (only on the flip).
        if (m.transparent === solid) {
          m.transparent = !solid;
          m.depthWrite = solid;
          m.needsUpdate = true;
        }
        m.opacity = p.fade;
      }
      for (const o of p.outlines) o.visible = solid;
    }

    // Sweeping floodlight beams.
    for (const b of this.beams) {
      const ang = t * 0.25 + b.phase;
      const target = new THREE.Vector3(Math.cos(ang) * HALF * 0.6, 0, Math.sin(ang * 1.3) * HALF * 0.6);
      const dir = target.clone().sub(b.from);
      const len = dir.length();
      b.mesh.position.copy(b.from);
      b.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
      b.mesh.scale.set(4.5, len, 4.5);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.05 + this.hypeLevel * 0.03;
    }

    // Dust motes drift.
    this.motes.rotation.y = t * 0.02;
    this.motes.position.y = Math.sin(t * 0.4) * 0.3;

    // Crowd bounces with excitement (every other frame is plenty).
    if (this.crowd && this.frame % 2 === 0) {
      const amp = 0.08 + this.hypeLevel * 0.55;
      const pos = new THREE.Vector3();
      for (let i = 0; i < this.crowdBase.length; i++) {
        const base = this.crowdBase[i];
        pos.setFromMatrixPosition(base);
        const hop = Math.max(0, Math.sin(t * (6 + this.hypeLevel * 5) + this.crowdPhase[i])) * amp;
        this.m.copy(base).setPosition(pos.x, pos.y + hop, pos.z);
        this.crowd.setMatrixAt(i, this.m);
      }
      this.crowd.instanceMatrix.needsUpdate = true;
    }
    this.updateOutdoors(t);
  }
}
