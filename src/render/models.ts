/**
 * Part models: chunky rounded toon shapes with inverted-hull outlines, built
 * from primitives (no external assets). Every catalog part has its own look,
 * and every model animates from a small context (walk cycle, speed, attacks).
 *
 * Local space: −z is the bug's front, +y up, one grid cell = 1 unit, floor at y = 0.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import { CATEGORY_COLOR, getPart, type Category } from '@/game/parts';

const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x111318, side: THREE.BackSide });
const OUTLINE_W = 0.035;
const UP = new THREE.Vector3(0, 1, 0);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

let gradient: THREE.DataTexture | null = null;
function toonGradient() {
  if (!gradient) {
    const data = new Uint8Array([110, 110, 110, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
    gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

export function toonMaterial(
  color: THREE.ColorRepresentation,
  opts: { emissive?: THREE.ColorRepresentation; transparent?: boolean; opacity?: number } = {},
) {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: toonGradient(),
    emissive: opts.emissive ?? 0x000000,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  });
}

/** A toon mesh plus its black outline shell (uniform-scale hull; used for arena props). */
export function toonMesh(geo: THREE.BufferGeometry, mat: THREE.Material, outline = 0.06) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, mat));
  if (outline > 0) {
    const o = new THREE.Mesh(geo, OUTLINE);
    o.scale.setScalar(1 + outline * 2);
    g.add(o);
  }
  return g;
}

// ── Shared geometry cache (materials are per part, geometry is shared) ──

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    g.computeBoundingBox();
    geoCache.set(key, g);
  }
  return g;
}

const rbox = (w: number, h: number, d: number, r = 0.1) =>
  geo(`rb:${w}:${h}:${d}:${r}`, () => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)));
const ball = (r: number) => geo(`sp:${r}`, () => new THREE.SphereGeometry(r, 12, 9));
const cone = (r: number, h: number, seg = 8) => geo(`co:${r}:${h}:${seg}`, () => new THREE.ConeGeometry(r, h, seg));
const cyl = (rt: number, rb: number, h: number, seg = 10) =>
  geo(`cy:${rt}:${rb}:${h}:${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
const torus = (r: number, tube: number) => geo(`to:${r}:${tube}`, () => new THREE.TorusGeometry(r, tube, 6, 14));

/** Mesh + outline whose thickness is even on every axis (works for flat or long shapes). */
function shape(g: THREE.BufferGeometry, mat: THREE.Material, outline = OUTLINE_W) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(g, mat));
  if (outline > 0) {
    const size = g.boundingBox!.getSize(new THREE.Vector3());
    const o = new THREE.Mesh(g, OUTLINE);
    o.scale.set(1 + (2 * outline) / size.x, 1 + (2 * outline) / size.y, 1 + (2 * outline) / size.z);
    group.add(o);
  }
  return group;
}

/** A rounded limb between two points. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, outline = OUTLINE_W) {
  const len = a.distanceTo(b);
  const g = geo(`cap:${r}:${len.toFixed(3)}`, () => new THREE.CapsuleGeometry(r, len, 2, 8));
  const m = shape(g, mat, outline);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  return m;
}

const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number) => {
  o.position.set(x, y, z);
  return o;
};

// ── Model API ───────────────────────────────────────────────────────

export type AnimCtx = {
  /** Seconds, free-running. */
  t: number;
  /** Walk-cycle phase in radians; advances with distance travelled. */
  walk: number;
  /** 0 (standing) .. 1 (full speed). */
  speed: number;
  /** 1 at the instant this part's weapon fires, decaying to 0. */
  attack: number;
  /** 0 on the ground .. 1 flying: legs tuck up, wings beat hard. */
  air: number;
};

export const IDLE: Omit<AnimCtx, 't'> = { walk: 0, speed: 0, attack: 0, air: 0 };

export type PartModel = {
  root: THREE.Group;
  animate: (c: AnimCtx) => void;
  /** wear 0..1 (1 = pristine) darkens the part; flash whites it out; glow adds a soft highlight. */
  tint: (wear: number, flash: boolean, glow?: number) => void;
};

/** Which look each catalog part uses within its category (0 = basic). */
const LOOK: Record<string, number> = {
  'head-visor': 1,
  'thorax-chitin': 1,
  'abdomen-tank': 1,
  'legs-strider': 1,
  'legs-crawler': 2,
  'wings-glass': 1,
  'mand-shear': 1,
  'sting-lance': 1,
  'pinc-vise': 1,
  'horn-drill': 1,
  'armor-ceramic': 1,
  'armor-aegis': 2,
  'core-fusion': 1,
  'sensor-radar': 1,
};

const STEEL = 0x8c98a6;
const GUNMETAL = 0x3a424d;

/**
 * Build the model for a catalog part.
 * @param side −1/0/+1: left of the spine, on it, or right of it (decides which way legs/wings face)
 * @param row grid row, used to stagger the walking gait
 */
export function buildPart(partId: string, side: number, row = 0): PartModel {
  const def = getPart(partId);
  const look = LOOK[partId] ?? 0;
  const root = new THREE.Group();
  const baseColor = new THREE.Color(CATEGORY_COLOR[def.category]);

  const mats: { m: THREE.MeshToonMaterial; base: THREE.Color; em: THREE.Color }[] = [];
  const mat = (color: THREE.ColorRepresentation, opts: Parameters<typeof toonMaterial>[1] = {}) => {
    const m = toonMaterial(color, opts);
    mats.push({ m, base: m.color.clone(), em: m.emissive.clone() });
    return m;
  };
  const main = mat(baseColor);
  const dark = mat(baseColor.clone().multiplyScalar(0.55));
  const light = mat(baseColor.clone().lerp(new THREE.Color(0xffffff), 0.35));
  const sides = side === 0 ? [-1, 1] : [side];
  let animate: PartModel['animate'] = () => {};

  switch (def.category) {
    case 'head': {
      const skull = new THREE.Group();
      skull.add(at(shape(rbox(0.8, 0.58, 0.78, 0.2), main), 0, 0.58, 0));
      skull.add(at(shape(rbox(0.56, 0.34, 0.3, 0.12), dark), 0, 0.47, -0.42)); // snout
      skull.add(at(shape(rbox(0.5, 0.2, 0.2, 0.08), mat(GUNMETAL), 0), 0, 0.42, 0.42)); // neck
      const glow = mat(0x9fd4ff, { emissive: 0x2a8cff });
      if (look === 0) {
        for (const d of [-1, 1]) {
          skull.add(at(shape(ball(0.15), glow, 0.03), 0.25 * d, 0.72, -0.3));
          skull.add(at(new THREE.Mesh(ball(0.07), OUTLINE), 0.27 * d, 0.74, -0.42)); // pupil
        }
      } else {
        const visor = mat(0xbff3ff, { emissive: 0x19c2d8 });
        skull.add(at(shape(rbox(0.74, 0.17, 0.2, 0.08), visor, 0.03), 0, 0.7, -0.33));
        skull.add(at(shape(rbox(0.1, 0.22, 0.5, 0.05), light), 0, 0.92, 0.02)); // crest
      }
      root.add(skull);
      animate = ({ t, speed }) => {
        skull.rotation.y = Math.sin(t * 0.9 + row) * 0.07 * (1 - speed * 0.6);
        skull.rotation.x = Math.sin(t * 1.7 + row) * 0.02 - speed * 0.05;
        glow.emissiveIntensity = 0.8 + Math.sin(t * 4) * 0.2;
      };
      break;
    }

    case 'thorax': {
      const body = new THREE.Group();
      body.add(at(shape(rbox(0.94, 0.68, 0.94, 0.2), main), 0, 0.58, 0));
      body.add(at(shape(rbox(0.56, 0.1, 0.56, 0.05), dark, 0.02), 0, 0.95, 0)); // hatch
      const bolt = mat(STEEL);
      for (const d of [-1, 1]) body.add(at(new THREE.Mesh(ball(0.07), bolt), 0.3 * d, 0.97, -0.3));
      if (look === 1) {
        for (const d of [-1, 1]) {
          body.add(at(shape(rbox(0.16, 0.16, 0.8, 0.07), light), 0.4 * d, 0.9, 0)); // shoulder ridge
          body.add(at(shape(cyl(0.06, 0.06, 0.3, 8), bolt, 0.02), 0.2 * d, 1.02, 0.3)); // exhaust
        }
      }
      root.add(body);
      animate = ({ t }) => {
        const s = 1 + Math.sin(t * 2 + row) * 0.012;
        body.scale.set(s, 1 + Math.sin(t * 2 + row) * 0.02, s);
      };
      break;
    }

    case 'abdomen': {
      const segs: THREE.Group[] = [];
      const rows: [number, number, number, number][] =
        look === 0
          ? [
              [0.86, 0.6, 0.36, -0.3],
              [0.78, 0.54, 0.34, 0.02],
              [0.6, 0.44, 0.32, 0.32],
            ]
          : [
              [0.92, 0.66, 0.5, -0.22],
              [0.84, 0.6, 0.46, 0.24],
            ];
      rows.forEach(([w, h, d, z], i) => {
        const seg = new THREE.Group();
        seg.add(at(shape(rbox(w, h, d, 0.16), i % 2 ? dark : main), 0, 0.52 - i * 0.02, 0));
        seg.position.z = z;
        root.add(seg);
        segs.push(seg);
      });
      if (look === 1) {
        const tank = mat(STEEL);
        for (const d of [-1, 1]) {
          const t = shape(cyl(0.13, 0.13, 0.7, 10), tank);
          t.rotation.x = Math.PI / 2;
          root.add(at(t, 0.4 * d, 0.82, 0.02));
        }
      }
      animate = ({ t, walk, speed }) =>
        segs.forEach((s, i) => {
          const wag = Math.sin(walk - i * 0.7) * 0.1 * speed + Math.sin(t * 1.3 - i * 0.6 + row) * 0.03;
          s.rotation.y = wag * (i + 1) * 0.6;
          s.position.x = wag * (i + 1) * 0.06;
        });
      break;
    }

    case 'legs': {
      const joint = mat(look === 2 ? 0xd9d4c7 : STEEL);
      const r = [0.055, 0.08, 0.065][look];
      root.add(at(shape(rbox(0.44, 0.3, 0.6, 0.12), main), 0, 0.5, 0));
      const hips: { g: THREE.Group; d: number; phase: number }[] = [];
      for (const d of sides) {
        for (const dz of [-0.2, 0.2]) {
          const hip = new THREE.Group();
          hip.position.set(0.16 * d, 0.5, dz);
          const knee = V(0.42 * d, 0.3, dz * 0.4);
          const foot = V(0.66 * d, -0.46, dz * 0.9);
          hip.add(limb(V(0, 0, 0), knee, r, dark));
          hip.add(at(new THREE.Mesh(ball(r * 1.45), joint), knee.x, knee.y, knee.z));
          hip.add(limb(knee, foot, r * 0.85, dark));
          if (look === 1) hip.add(limb(V(0.2 * d, 0.02, dz * 0.2), V(0.5 * d, -0.1, dz * 0.6), r * 0.45, joint, 0)); // piston
          if (look === 2) {
            const claw = shape(cone(0.07, 0.22, 6), joint, 0.02);
            claw.rotation.z = Math.PI + 0.5 * d;
            hip.add(at(claw, foot.x - 0.04 * d, foot.y + 0.02, foot.z));
          } else {
            hip.add(at(new THREE.Mesh(ball(r * 1.3), joint), foot.x, foot.y + 0.02, foot.z));
          }
          root.add(hip);
          hips.push({ g: hip, d, phase: (row % 2 ? Math.PI : 0) + (d > 0 ? Math.PI : 0) + (dz > 0 ? Math.PI / 2 : 0) });
        }
      }
      animate = ({ t, walk, speed, air }) =>
        hips.forEach(({ g, d, phase }, i) => {
          const p = walk + phase;
          const ground = 1 - air;
          g.rotation.y = Math.sin(p) * 0.5 * speed * d * ground + Math.sin(t * 3 + i) * 0.08 * air; // sweep, or dangle in the air
          const lift = Math.max(0, Math.cos(p)) * speed * ground;
          g.rotation.z = d * (lift * 0.32 + Math.sin(t * 1.6 + i * 1.3) * 0.02 * (1 - speed) + air * 0.75); // tuck up when flying
        });
      break;
    }

    case 'wings': {
      root.add(at(shape(rbox(0.34, 0.26, 0.5, 0.1), dark), 0, 0.82, 0));
      const film = mat(look === 1 ? 0xd4f6ff : baseColor, { transparent: true, opacity: look === 1 ? 0.55 : 0.72 });
      const vein = mat(look === 1 ? 0x9fdcf0 : baseColor.clone().multiplyScalar(0.7));
      const pivots: { g: THREE.Group; d: number; k: number }[] = [];
      const wingGeo = geo('wing', () => new THREE.SphereGeometry(0.5, 12, 8).scale(1.5, 0.04, 0.72));
      for (const d of sides) {
        (look === 1 ? [-0.14, 0.2] : [0]).forEach((dz, k) => {
          const pivot = new THREE.Group();
          pivot.position.set(0.14 * d, 0.95, dz);
          const wing = new THREE.Mesh(wingGeo, film);
          wing.position.x = 0.72 * d;
          wing.scale.setScalar(k === 1 ? 0.75 : 1);
          pivot.add(wing);
          pivot.add(limb(V(0, 0, -0.2), V(1.3 * d * (k === 1 ? 0.75 : 1), 0, -0.14), 0.03, vein, 0));
          pivot.rotation.y = d * (k === 1 ? -0.5 : -0.12);
          root.add(pivot);
          pivots.push({ g: pivot, d, k });
        });
      }
      animate = ({ t, speed, air }) =>
        pivots.forEach(({ g, d, k }) => {
          const beat = Math.max(speed, air);
          const rate = 9 + beat * 46;
          const amp = 0.12 + beat * 0.38;
          g.rotation.z = d * (0.22 + Math.sin(t * rate + k * 0.9) * amp);
        });
      break;
    }

    case 'mandibles': {
      root.add(at(shape(rbox(0.56, 0.3, 0.34, 0.1), dark), 0, 0.5, 0.28));
      const tooth = mat(0xf2ede0);
      const len = look === 1 ? 0.92 : 0.74;
      const jaws: { g: THREE.Group; d: number }[] = [];
      for (const d of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(0.2 * d, 0.5, 0.18);
        const elbow = V(0.14 * d, 0, -len * 0.5);
        const tip = V(-0.04 * d, 0, -len);
        pivot.add(limb(V(0, 0, 0), elbow, 0.1, main));
        pivot.add(limb(elbow, tip, 0.075, main));
        const fang = shape(cone(0.075, 0.2, 6), tooth, 0.02);
        fang.rotation.set(-Math.PI / 2, 0, 0.5 * d);
        pivot.add(at(fang, tip.x - 0.05 * d, 0, tip.z - 0.06));
        if (look === 1) {
          for (let i = 0; i < 3; i++) {
            const t = new THREE.Mesh(cone(0.045, 0.14, 5), tooth);
            t.rotation.z = (Math.PI / 2) * d;
            pivot.add(at(t, 0.02 * d - i * 0.02 * d, 0, -len * (0.5 + i * 0.16)));
          }
        }
        root.add(pivot);
        jaws.push({ g: pivot, d });
      }
      animate = ({ t, attack }) =>
        jaws.forEach(({ g, d }) => {
          const open = 0.26 + Math.sin(t * 2.6 + row) * 0.1;
          g.rotation.y = -d * (open * (1 - attack) - 0.3 * attack);
        });
      break;
    }

    case 'pincers': {
      root.add(at(shape(rbox(0.6, 0.32, 0.36, 0.1), dark), 0, 0.5, 0.26));
      const big = look === 1 ? 1.2 : 1;
      const claws: { g: THREE.Group; d: number }[] = [];
      for (const d of [-1, 1]) {
        const wrist = V(0.36 * d, 0.5, -0.2);
        root.add(limb(V(0.22 * d, 0.5, 0.2), wrist, 0.1 * big, main));
        if (look === 1) root.add(at(shape(rbox(0.16, 0.2, 0.3, 0.06), mat(STEEL), 0.02), 0.38 * d, 0.66, 0.02)); // hydraulics
        const claw = new THREE.Group();
        claw.position.copy(wrist);
        claw.add(at(new THREE.Mesh(ball(0.13 * big), dark), 0, 0, 0));
        claw.add(limb(V(0, 0, 0), V(0.12 * d, 0, -0.34 * big), 0.085 * big, main));
        claw.add(limb(V(0.12 * d, 0, -0.34 * big), V(-0.08 * d, 0, -0.56 * big), 0.07 * big, main));
        claw.add(limb(V(-0.04 * d, 0, -0.06), V(-0.14 * d, 0, -0.36 * big), 0.06 * big, light));
        root.add(claw);
        claws.push({ g: claw, d });
      }
      animate = ({ t, attack }) =>
        claws.forEach(({ g, d }) => {
          const open = 0.3 + Math.sin(t * 2 + d + row) * 0.12;
          g.rotation.y = -d * (open * (1 - attack) - 0.35 * attack);
        });
      break;
    }

    case 'stinger': {
      const bulb = shape(geo('bulb', () => new THREE.SphereGeometry(0.3, 12, 9).scale(1, 0.85, 1.15)), dark);
      root.add(at(bulb, 0, 0.5, 0.2));
      const glow = mat(0xf0c8ff, { emissive: 0xb65be0 });
      const barrel = new THREE.Group();
      if (look === 0) {
        const c = shape(cone(0.17, 0.85, 8), main);
        c.rotation.x = -Math.PI / 2;
        barrel.add(at(c, 0, 0, -0.42));
        barrel.add(at(new THREE.Mesh(ball(0.06), glow), 0, 0, -0.86));
      } else {
        barrel.add(limb(V(0, 0, 0), V(0, 0, -0.95), 0.07, main));
        for (let i = 0; i < 3; i++) {
          const ring = new THREE.Mesh(torus(0.14 - i * 0.02, 0.035), glow);
          barrel.add(at(ring, 0, 0, -0.3 - i * 0.24));
        }
        for (const d of [-1, 1]) barrel.add(limb(V(0.1 * d, 0, -0.85), V(0.04 * d, 0, -1.12), 0.03, mat(STEEL), 0));
      }
      barrel.position.set(0, 0.54, -0.02);
      root.add(barrel);
      animate = ({ t, attack }) => {
        barrel.position.z = -0.02 + attack * 0.2;
        barrel.rotation.x = Math.sin(t * 1.4 + row) * 0.04;
        glow.emissiveIntensity = 0.7 + Math.sin(t * 6) * 0.3 + attack * 1.5;
      };
      break;
    }

    case 'horn': {
      root.add(at(shape(rbox(0.62, 0.42, 0.54, 0.14), dark), 0, 0.46, 0.14));
      const horn = new THREE.Group();
      const spin = new THREE.Group();
      horn.add(spin);
      if (look === 0) {
        spin.add(at(shape(cone(0.27, 0.8, 8), main), 0, 0.4, 0));
        spin.add(at(new THREE.Mesh(torus(0.2, 0.05), dark), 0, 0.12, 0).rotateX(Math.PI / 2));
      } else {
        spin.add(at(shape(cone(0.3, 1.0, 10), main), 0, 0.5, 0));
        const ridge = mat(STEEL);
        for (let i = 0; i < 4; i++) {
          const ring = new THREE.Mesh(torus(0.27 - i * 0.065, 0.035), ridge);
          ring.rotation.set(Math.PI / 2 + 0.3, 0, 0);
          spin.add(at(ring, 0, 0.1 + i * 0.2, 0));
        }
      }
      horn.position.set(0, 0.56, -0.08);
      horn.rotation.x = -Math.PI / 2 + (look === 0 ? 0.35 : 0.12);
      root.add(horn);
      animate = ({ t, speed, attack }) => {
        if (look === 1) spin.rotation.y = t * (6 + speed * 18 + attack * 20);
        horn.position.z = -0.08 - attack * 0.12;
      };
      break;
    }

    case 'armor': {
      if (look === 0) {
        root.add(at(shape(cyl(0.56, 0.56, 0.42, 6), main), 0, 0.42, 0));
        root.add(at(shape(cyl(0.36, 0.4, 0.1, 6), dark, 0.02), 0, 0.67, 0));
      } else if (look === 1) {
        const trim = mat(0x9aa7b8);
        root.add(at(shape(rbox(1.0, 0.3, 1.0, 0.1), main), 0, 0.36, 0));
        root.add(at(shape(rbox(0.82, 0.22, 0.82, 0.09), trim), 0, 0.6, 0));
        root.add(at(shape(rbox(0.5, 0.12, 0.5, 0.05), main, 0.02), 0, 0.76, 0));
      } else {
        const rivet = mat(STEEL);
        root.add(at(shape(rbox(1.0, 0.72, 1.0, 0.14), main), 0, 0.5, 0));
        root.add(at(shape(rbox(1.06, 0.2, 0.3, 0.08), dark), 0, 0.5, -0.42)); // bumper
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) root.add(at(new THREE.Mesh(ball(0.08), rivet), 0.34 * sx, 0.88, 0.34 * sz));
      }
      break;
    }

    case 'core': {
      const hot = look === 1 ? new THREE.Color(0xff9a3d) : baseColor;
      root.add(at(shape(cyl(0.44, 0.48, 0.24, 10), mat(GUNMETAL)), 0, 0.32, 0));
      const post = mat(STEEL);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) root.add(limb(V(0.3 * sx, 0.4, 0.3 * sz), V(0.3 * sx, 0.78, 0.3 * sz), 0.035, post, 0));
      const glow = mat(hot.clone().lerp(new THREE.Color(0xffffff), 0.25), { emissive: hot });
      const crystal = shape(
        geo(`gem:${look}`, () => (look === 1 ? new THREE.IcosahedronGeometry(0.26, 0) : new THREE.OctahedronGeometry(0.3, 0))),
        glow,
        0.025,
      );
      root.add(crystal);
      const halo = new THREE.Mesh(torus(0.36, 0.03), glow);
      halo.visible = look === 1;
      root.add(halo);
      animate = ({ t }) => {
        crystal.position.y = 0.74 + Math.sin(t * 3 + row) * 0.04;
        crystal.rotation.y = t * 1.5;
        halo.position.y = 0.74;
        halo.rotation.set(Math.PI / 2 + Math.sin(t * 2) * 0.4, t, 0);
        glow.emissiveIntensity = 0.75 + Math.sin(t * 6 + row) * 0.3;
      };
      break;
    }

    case 'sensor': {
      root.add(at(shape(rbox(0.44, 0.24, 0.44, 0.1), dark), 0, 0.42, 0));
      if (look === 0) {
        const stalks: { g: THREE.Group; d: number }[] = [];
        for (const d of [-1, 1]) {
          const stalk = new THREE.Group();
          stalk.position.set(0.12 * d, 0.52, -0.05);
          const bend = V(0.1 * d, 0.42, -0.14);
          const tip = V(0.3 * d, 0.72, -0.42);
          stalk.add(limb(V(0, 0, 0), bend, 0.04, main, 0.025));
          stalk.add(limb(bend, tip, 0.03, main, 0.025));
          stalk.add(at(shape(ball(0.09), light, 0.025), tip.x, tip.y, tip.z));
          root.add(stalk);
          stalks.push({ g: stalk, d });
        }
        animate = ({ t, speed }) =>
          stalks.forEach(({ g, d }) => {
            g.rotation.x = Math.sin(t * 2.1 + d + row) * 0.1 + speed * 0.35;
            g.rotation.z = Math.sin(t * 1.5 + d * 2) * 0.08;
          });
      } else {
        root.add(limb(V(0, 0.5, 0), V(0, 0.95, 0), 0.05, mat(STEEL)));
        const dish = new THREE.Group();
        dish.position.y = 1.0;
        const bowl = shape(cyl(0.36, 0.1, 0.16, 12), main);
        bowl.rotation.x = -Math.PI / 2 + 0.5;
        dish.add(at(bowl, 0, 0.06, -0.06));
        const lamp = mat(0xffffff, { emissive: 0x7fb3ff });
        dish.add(at(new THREE.Mesh(ball(0.06), lamp), 0, 0.14, -0.2));
        root.add(dish);
        animate = ({ t }) => {
          dish.rotation.y = t * 1.8 + row;
          lamp.emissiveIntensity = Math.sin(t * 8) > 0 ? 1.4 : 0.3;
        };
      }
      break;
    }
  }

  const white = new THREE.Color(0xffffff);
  const tint: PartModel['tint'] = (wear, flash, glow = 0) => {
    const k = 0.45 + 0.55 * wear;
    for (const { m, base, em } of mats) {
      m.color.copy(base).multiplyScalar(k);
      if (flash) m.emissive.copy(white).multiplyScalar(0.9);
      else m.emissive.copy(em).addScalar(glow);
    }
  };

  return { root, animate, tint };
}

// ── Connectors: the frame that joins neighbouring parts ─────────────

/** Height at which a part's frame mount sits. */
const MOUNT_Y: Partial<Record<Category, number>> = { wings: 0.8, core: 0.34, sensor: 0.42, armor: 0.42 };
const BODY: Category[] = ['head', 'thorax', 'abdomen'];

let frameMat: THREE.MeshToonMaterial | null = null;
let collarMat: THREE.MeshToonMaterial | null = null;

/** A frame strut between two parts that stretches and bends to follow them. */
export type Connector = {
  obj: THREE.Group;
  /** Re-seat the strut between two part roots (positions in the parent's space). */
  update: (aPos: THREE.Vector3, bPos: THREE.Vector3) => void;
};

const Y_AXIS = V(0, 1, 0);
const fromP = new THREE.Vector3();
const toP = new THREE.Vector3();
const dirP = new THREE.Vector3();

/**
 * A strut between neighbouring parts A and B. Body-to-body links are a thick
 * spine with a collar; everything else is a slimmer strut. Call `update` with
 * the two parts' current root positions (it adds each part's mount height),
 * every frame if the parts move.
 */
export function buildConnector(a: Category, b: Category): Connector {
  frameMat ??= toonMaterial(GUNMETAL);
  collarMat ??= toonMaterial(STEEL);
  const spine = BODY.includes(a) && BODY.includes(b);
  const r = spine ? 0.2 : 0.1;
  const restLen = 0.8;
  const obj = new THREE.Group();
  const strut = new THREE.Group();
  strut.add(shape(geo(`cap:${r}:${restLen}`, () => new THREE.CapsuleGeometry(r, restLen, 2, 8)), frameMat));
  const collar = new THREE.Mesh(torus(spine ? 0.24 : 0.13, 0.05), collarMat);
  obj.add(strut, collar);
  const ya = MOUNT_Y[a] ?? 0.5;
  const yb = MOUNT_Y[b] ?? 0.5;
  return {
    obj,
    update(aPos, bPos) {
      const A = fromP.set(aPos.x, aPos.y + ya, aPos.z);
      const B = toP.set(bPos.x, bPos.y + yb, bPos.z);
      dirP.copy(B).sub(A);
      const len = dirP.length() || 1;
      dirP.divideScalar(len);
      // Span the middle 80% of the gap.
      strut.position.copy(A).addScaledVector(dirP, len * 0.5);
      strut.quaternion.setFromUnitVectors(Y_AXIS, dirP);
      strut.scale.set(1, (len * 0.8) / restLen, 1);
      collar.position.copy(strut.position);
      collar.quaternion.setFromUnitVectors(V(0, 0, 1), dirP);
    },
  };
}

/** Every orthogonally adjacent pair in a set of grid cells, as index pairs (each pair once). */
export function adjacentPairs(cells: { x: number; y: number }[]): [number, number][] {
  const index = new Map(cells.map((c, i) => [`${c.x},${c.y}`, i]));
  const out: [number, number][] = [];
  cells.forEach((c, i) => {
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ]) {
      const j = index.get(`${c.x + dx},${c.y + dy}`);
      if (j !== undefined) out.push([i, j]);
    }
  });
  return out;
}

/** Top surface of a grid part's model (where stacked parts sit). Ignores thin bits like antennae. */
export function seatHeight(model: PartModel): number {
  model.animate({ t: 0, ...IDLE });
  const y0 = model.root.position.y;
  model.root.position.y = 0;
  model.root.updateMatrixWorld(true);
  let top = 0;
  model.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry.boundingBox) return;
    const size = o.geometry.boundingBox.getSize(new THREE.Vector3());
    if (Math.min(size.x, size.z) < 0.3) return;
    top = Math.max(top, new THREE.Box3().setFromObject(o).max.y);
  });
  model.root.position.y = y0;
  model.root.updateMatrixWorld(true);
  return top || 0.9;
}

/** Y offset that rests a stacked model's underside on a surface at height `seat`. */
export function stackOffset(model: PartModel, seat: number): number {
  model.animate({ t: 0, ...IDLE });
  const y0 = model.root.position.y;
  model.root.position.y = 0;
  model.root.updateMatrixWorld(true);
  const bottom = new THREE.Box3().setFromObject(model.root).min.y;
  model.root.position.y = y0;
  return seat - bottom - 0.04;
}

/** How far a grid part rides up when a part is slung underneath it. */
export const UNDER_LIFT = 0.42;
/** Scale of a part slung underneath. */
export const UNDER_SCALE = 0.55;
