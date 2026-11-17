/**
 * Arena dressing: everything around the fight that isn't a bug. Each arena has
 * its own theme (floor, walls, hazards, lights, sky, stadium colours), built
 * from primitives and procedural textures (no image assets, works on native).
 *
 *   pit      The Acid Pit:   rusty riveted scrapyard plates, sunken bubbling acid vats
 *   foundry  Stomper Foundry: dark tread-plate steel with glowing molten seams, hydraulic presses
 *   hive     The Hive Ring:  honeycomb floor in amber and gold, wax walls
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
};

// ── Dressing ────────────────────────────────────────────────────────

type Vat = { surface: THREE.Mesh; bubbles: THREE.InstancedMesh; steam: THREE.Mesh[]; x: number; z: number; r: number; seed: number };
type Press = {
  head: THREE.Group;
  rod: THREE.Object3D;
  lights: THREE.MeshBasicMaterial[];
  ring: THREE.Mesh;
  idx: number;
  x: number;
  z: number;
  r: number;
  /** Fades out when a bug is underneath, so the fight stays visible. */
  mats: THREE.Material[];
  outlines: THREE.Object3D[];
  fade: number;
};

export class ArenaDressing {
  private theme: Theme;
  private vats: Vat[] = [];
  private presses: Press[] = [];
  private seamMat: THREE.MeshToonMaterial | null = null;
  private pylonLights: THREE.MeshBasicMaterial[] = [];
  private beams: { mesh: THREE.Mesh; from: THREE.Vector3; phase: number }[] = [];
  private motes: THREE.Points;
  private crowd!: THREE.InstancedMesh;
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
    this.buildWalls(sim.spikedWalls);
    this.buildStadium();
    this.buildLights();
    sim.hazards.forEach((h, idx) => (h.kind === 'acid' ? this.buildVat(h.x, h.y, h.r) : this.buildPress(h.x, h.y, h.r, idx)));

    // Dust motes drifting in the floodlights.
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
      new THREE.PointsMaterial({ color: 0xfff1c8, size: 0.09, transparent: true, opacity: 0.5, depthWrite: false }),
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
    const rim = toonMesh(new THREE.TorusGeometry(r + 0.12, 0.2, 8, 36), toonMaterial(0x6b7280), 0.03);
    rim.rotation.x = Math.PI / 2;
    rim.position.copy(p).setY(0.08);
    const pit = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.92, 0.3, 36, 1, true), toonMaterial(0x101410));
    (pit.material as THREE.Material).side = THREE.DoubleSide;
    pit.position.copy(p).setY(-0.1);
    // Glowing acid surface, slightly below floor level.
    const surface = new THREE.Mesh(
      new THREE.CircleGeometry(r, 36),
      toonMaterial(0x7ce654, { emissive: 0x3fae22 }),
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.copy(p).setY(-0.06);
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 1.6, 36),
      new THREE.MeshBasicMaterial({ color: 0x7ce654, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.copy(p).setY(0.02);
    this.scene.add(rim, pit, surface, glow);

    const bubbles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 8, 6), toonMaterial(0xb8ff8a, { emissive: 0x4fbf2a }), 14);
    bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(bubbles);
    const steam: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xd8ffd0, transparent: true, opacity: 0.1, depthWrite: false }),
      );
      this.scene.add(s);
      steam.push(s);
    }
    this.vats.push({ surface, bubbles, steam, x: p.x, z: p.z, r, seed: this.vats.length * 3.7 });
  }

  private buildPress(sx: number, sy: number, rr: number, idx: number) {
    const r = rr / CELL;
    const p = toWorld(sx, sy);
    const rig = new THREE.Group();
    this.scene.add(rig);
    const steel = toonMaterial(0x4b5563);
    const dark = toonMaterial(0x23272e);
    // Gantry: two pillars and a crossbeam.
    for (const d of [-1, 1]) {
      const pillar = toonMesh(new THREE.BoxGeometry(0.7, 9, 0.7), steel, 0.04);
      pillar.position.set(p.x + d * (r + 0.9), 4.5, p.z);
      rig.add(pillar);
    }
    const beam = toonMesh(new THREE.BoxGeometry(2 * r + 2.6, 0.9, 1.1), steel, 0.04);
    beam.position.set(p.x, 9.2, p.z);
    rig.add(beam);
    // Warning lights on the beam.
    const lights: THREE.MeshBasicMaterial[] = [];
    for (const d of [-1, 1]) {
      const m = new THREE.MeshBasicMaterial({ color: 0x551a0c });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), m);
      lamp.position.set(p.x + d * (r + 0.9), 9.8, p.z);
      rig.add(lamp);
      lights.push(m);
    }
    // Hydraulic rod + press head (with a hazard band).
    const rod = toonMesh(new THREE.CylinderGeometry(0.35, 0.35, 1, 12), toonMaterial(0xc8ced6), 0.03);
    rig.add(rod);
    const head = new THREE.Group();
    head.add(toonMesh(new THREE.CylinderGeometry(r * 0.95, r * 0.95, 1.1, 10), dark, 0.04));
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.3, 24, 1, true), toonMaterial(0xffffff));
    const bandTex = stripes(0xf2c14e, 0x1d1f24);
    bandTex.repeat.set(8, 1);
    (band.material as THREE.MeshToonMaterial).map = bandTex;
    band.position.y = -0.3;
    head.add(band);
    const plate = toonMesh(new THREE.CylinderGeometry(r, r, 0.25, 10), toonMaterial(0xff8a3d), 0.03);
    plate.position.y = -0.65;
    head.add(plate);
    head.position.set(p.x, 5.6, p.z);
    rig.add(head);
    // Hazard-striped target ring on the floor.
    const ringTex = stripes(0xf2c14e, 0x1d1f24);
    ringTex.repeat.set(3, 3);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.82, r, 40),
      new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, 0.03, p.z);
    this.scene.add(ring);
    // Everything in the rig can fade; outline shells just hide while faded.
    const mats = new Set<THREE.Material>();
    const outlines: THREE.Object3D[] = [];
    rig.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.Material;
      if (m instanceof THREE.MeshBasicMaterial && m.side === THREE.BackSide) outlines.push(o);
      else mats.add(m);
    });
    this.presses.push({ head, rod, lights, ring, idx, x: p.x, z: p.z, r, mats: [...mats], outlines, fade: 1 });
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

    // Presses: the head rides the stomper cycle; rod stretches from the beam; lights flash on warning.
    for (const p of this.presses) {
      const h = sim.hazards[p.idx];
      if (h.kind !== 'stomper') continue;
      const warnStart = h.period - 1.2;
      let y = 5.6;
      if (h.t < 0.5) y = 0.95 + (h.t / 0.5) * 4.65;
      else if (h.t > warnStart) y = 5.6 + ((h.t - warnStart) / 1.2) * 1.4;
      const shudder = stompWarning(h) ? Math.sin(t * 60) * 0.05 : 0;
      p.head.position.set(p.x + shudder, y, p.z);
      const top = 8.8;
      const len = Math.max(0.1, top - (y + 0.55));
      p.rod.position.set(p.x, y + 0.55 + len / 2, p.z);
      p.rod.scale.set(1, len, 1);
      const warn = stompWarning(h);
      const blink = warn && Math.sin(t * 22) > 0;
      p.lights.forEach((m) => m.color.set(blink ? 0xff3b1a : 0x551a0c));
      // See-through while a bug is near, so the press never hides the fight.
      const near = sim.bugs.some((b) => Math.hypot(b.pos.x / CELL - HALF - p.x, b.pos.y / CELL - HALF - p.z) < p.r + 3 + b.radius / CELL);
      p.fade += ((near ? 0.25 : 1) - p.fade) * Math.min(1, dt * 6);
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
      (p.ring.material as THREE.MeshBasicMaterial).opacity = warn ? 0.6 + Math.sin(t * 22) * 0.3 : 0.45;
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
    if (this.frame % 2 === 0) {
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
  }
}
