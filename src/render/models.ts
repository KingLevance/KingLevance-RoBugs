/**
 * Part models: chunky rounded toon shapes with inverted-hull outlines and a
 * soft rim light, built from primitives and small procedural textures (no
 * external assets). Every catalog part has its own look, and every model
 * animates from a small context (walk cycle, speed, attacks, flight).
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
    const data = new Uint8Array([105, 105, 105, 255, 180, 180, 180, 255, 255, 255, 255, 255]);
    gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

/** Adds a soft fresnel rim (edges catch light) to a toon material. */
function addRim(m: THREE.MeshToonMaterial, strength: number) {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float facing = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
        float rim = smoothstep(0.62, 0.92, 1.0 - facing);
        totalEmissiveRadiance += mix(diffuseColor.rgb, vec3(1.0), 0.55) * rim * ${strength.toFixed(3)};
      }`,
    );
  };
  m.customProgramCacheKey = () => `rim${strength.toFixed(3)}`;
}

export function toonMaterial(
  color: THREE.ColorRepresentation,
  opts: {
    emissive?: THREE.ColorRepresentation;
    transparent?: boolean;
    opacity?: number;
    rim?: number;
    map?: THREE.Texture;
    side?: THREE.Side;
  } = {},
) {
  const m = new THREE.MeshToonMaterial({
    color,
    gradientMap: toonGradient(),
    emissive: opts.emissive ?? 0x000000,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    map: opts.map ?? null,
    side: opts.side ?? THREE.FrontSide,
  });
  if (opts.transparent) m.depthWrite = false;
  if (opts.rim) addRim(m, opts.rim);
  return m;
}

const HIGHLIGHT = new THREE.MeshBasicMaterial({ color: 0xffb23f, side: THREE.BackSide });

/** Swap a part model's black outlines for bright amber ones (selection highlight), or back. */
export function setHighlight(root: THREE.Object3D, on: boolean) {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (on && o.material === OUTLINE) {
      o.material = HIGHLIGHT;
      // Fatter hull so the highlight reads at a glance.
      o.userData.hullScale = o.scale.clone();
      o.scale.multiplyScalar(1.06);
    } else if (!on && o.material === HIGHLIGHT) {
      o.material = OUTLINE;
      if (o.userData.hullScale) o.scale.copy(o.userData.hullScale as THREE.Vector3);
    }
  });
}

/**
 * Fade a whole model for cloaking (1 = solid). Outlines vanish while faded.
 * Only for models whose materials aren't shared with other models (part models).
 */
export function setGhost(root: THREE.Object3D, alpha: number) {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.material === OUTLINE || o.material === HIGHLIGHT) {
      o.visible = alpha > 0.95;
      return;
    }
    const m = o.material as THREE.Material;
    const base = (m.userData.solid ??= { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite }) as {
      transparent: boolean;
      opacity: number;
      depthWrite: boolean;
    };
    const fade = alpha < 0.999;
    if (m.transparent !== (fade || base.transparent)) {
      m.transparent = fade || base.transparent;
      m.needsUpdate = true;
    }
    m.depthWrite = fade ? false : base.depthWrite;
    m.opacity = base.opacity * alpha;
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
const ball = (r: number) => geo(`sp:${r}`, () => new THREE.SphereGeometry(r, 14, 10));
/** Ellipsoid with radii rx, ry, rz. */
const ellip = (rx: number, ry: number, rz: number) =>
  geo(`el:${rx}:${ry}:${rz}`, () => new THREE.SphereGeometry(1, 16, 12).scale(rx, ry, rz));
/** Upper half of an ellipsoid (flat side down at y = 0). */
const dome = (rx: number, ry: number, rz: number) =>
  geo(`do:${rx}:${ry}:${rz}`, () => new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(rx, ry, rz));
const cone = (r: number, h: number, seg = 8) => geo(`co:${r}:${h}:${seg}`, () => new THREE.ConeGeometry(r, h, seg));
const cyl = (rt: number, rb: number, h: number, seg = 12) =>
  geo(`cy:${rt}:${rb}:${h}:${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
const torus = (r: number, tube: number, arc = Math.PI * 2) =>
  geo(`to:${r}:${tube}:${arc.toFixed(3)}`, () => new THREE.TorusGeometry(r, tube, 6, 16, arc));
/** Capsule along +y that tapers from radius r0 (bottom) to r1 (top); `len` is the straight part. */
const taperGeo = (r0: number, r1: number, len: number) =>
  geo(`tp:${r0}:${r1}:${len.toFixed(3)}`, () => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 4; i++) {
      const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.cos(a) * r0, -len / 2 + Math.sin(a) * r0));
    }
    for (let i = 0; i <= 4; i++) {
      const a = (i / 4) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * r1), len / 2 + Math.sin(a) * r1));
    }
    return new THREE.LatheGeometry(pts, 10);
  });

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

/** A rounded limb between two points, tapering from radius r0 at `a` to r1 at `b`. */
function seg(a: THREE.Vector3, b: THREE.Vector3, r0: number, mat: THREE.Material, r1 = r0, outline = OUTLINE_W) {
  const len = a.distanceTo(b);
  const m = shape(taperGeo(r0, r1, len), mat, outline);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  return m;
}

/** A smooth tapered chain through `pts` (radius r0 at the start to r1 at the end). */
function chain(pts: THREE.Vector3[], r0: number, r1: number, mat: THREE.Material, outline = OUTLINE_W) {
  const g = new THREE.Group();
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const ra = THREE.MathUtils.lerp(r0, r1, i / n);
    const rb = THREE.MathUtils.lerp(r0, r1, (i + 1) / n);
    g.add(seg(pts[i], pts[i + 1], ra, mat, rb, outline));
  }
  return g;
}

const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number) => {
  o.position.set(x, y, z);
  return o;
};

/** Point the +y axis of `o` along `dir`. */
const aim = <T extends THREE.Object3D>(o: T, dir: THREE.Vector3) => {
  o.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
  return o;
};

// ── Procedural textures ─────────────────────────────────────────────

const lin = (c: number) => Math.round(Math.pow(c / 255, 2.2) * 255);

/**
 * Wing membrane: a colour gradient from root to tip, darker veins fanning out
 * from the root, cross-veins (cells) and a dark rim. Values are written
 * linear so they look right without an sRGB texture format.
 */
const wingTex = new Map<string, THREE.DataTexture>();
function wingTexture(kind: 'foil' | 'glass') {
  let tex = wingTex.get(kind);
  if (tex) return tex;
  const W = 128;
  const H = 64;
  const data = new Uint8Array(W * H * 4);
  const [root, tip] =
    kind === 'glass'
      ? [
          [150, 235, 255],
          [214, 160, 255],
        ]
      : [
          [255, 214, 150],
          [255, 160, 110],
        ];
  const veins = kind === 'glass' ? 7 : 5;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const v = y / (H - 1) - 0.5;
      // Fan of veins from the root (u = 0, v = 0).
      const ang = Math.atan2(v, u + 0.08);
      const fan = Math.abs(Math.sin(ang * veins * 1.6));
      let vein = fan < 0.1 + u * 0.03 ? 1 : 0;
      // Cross veins: arcs around the root.
      const rr = Math.hypot(u, v * 1.6);
      if (Math.abs(Math.sin(rr * (kind === 'glass' ? 22 : 14))) < 0.09 && u > 0.12) vein = Math.max(vein, 0.7);
      // Leading edge (front, v < 0) is a thick vein.
      if (v > 0.4) vein = 1;
      const k = Math.min(1, u * 1.1);
      const c = root.map((r, i) => r + (tip[i] - r) * k);
      const shade = vein ? 0.45 : 1;
      const o = (y * W + x) * 4;
      data[o] = lin(c[0] * shade);
      data[o + 1] = lin(c[1] * shade);
      data[o + 2] = lin(c[2] * shade);
      data[o + 3] = vein ? 235 : kind === 'glass' ? 125 : 150;
    }
  tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  wingTex.set(kind, tex);
  return tex;
}

/** Flat insect-wing outline in the x/z plane: root at the origin, reaching out along +x, leading edge toward −z. */
function wingGeo(len: number, width: number, key: string) {
  return geo(`wing:${key}:${len}:${width}`, () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0.04 * width);
    s.bezierCurveTo(len * 0.25, width * 0.55, len * 0.75, width * 0.62, len, width * 0.18);
    s.bezierCurveTo(len * 1.04, 0, len * 0.9, -width * 0.32, len * 0.6, -width * 0.36);
    s.bezierCurveTo(len * 0.3, -width * 0.4, len * 0.1, -width * 0.25, 0, -0.04 * width);
    s.closePath();
    const g = new THREE.ShapeGeometry(s, 16);
    // Shape y → −z (leading edge forward), and UVs normalised to the outline's bounds.
    g.rotateX(-Math.PI / 2);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), 1 - (pos.getZ(i) - bb.min.z) / (bb.max.z - bb.min.z));
    }
    uv.needsUpdate = true;
    return g;
  });
}

/** A coil spring along +y, centred on the origin: radius r, wire radius `wire`, height h. */
const helix = (r: number, wire: number, h: number, turns: number) =>
  geo(`hx:${r}:${wire}:${h}:${turns}`, () => {
    const n = Math.ceil(turns * 12);
    const pts = Array.from({ length: n + 1 }, (_, i) => {
      const u = i / n;
      const ang = u * turns * Math.PI * 2;
      return V(Math.cos(ang) * r, (u - 0.5) * h, Math.sin(ang) * r);
    });
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.ceil(turns * 14), wire, 6, false);
  });

/**
 * Honeycomb: wax-coloured hexagon cells with dark walls, tiling seamlessly
 * around a sphere's u (10 cells across). Written linear like the wing texture.
 */
let hexTex: THREE.DataTexture | null = null;
function hexTexture() {
  if (hexTex) return hexTex;
  const W = 160;
  const H = 80;
  const N = 10; // cells around
  const M = 3; // lattice periods pole to pole
  const data = new Uint8Array(W * H * 4);
  const ry = Math.sqrt(3);
  const nx = 1 / Math.hypot(1, ry);
  const ny = ry / Math.hypot(1, ry);
  const mod = (a: number, b: number) => a - b * Math.floor(a / b);
  const hexDist = (x: number, y: number) => Math.max(Math.abs(x) * nx + Math.abs(y) * ny, Math.abs(x));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = (x / W) * N;
      const py = (y / H) * M * ry;
      const ax = mod(px, 1) - 0.5;
      const ay = mod(py, ry) - ry / 2;
      const bx = mod(px - 0.5, 1) - 0.5;
      const by = mod(py - ry / 2, ry) - ry / 2;
      const [gx, gy] = ax * ax + ay * ay < bx * bx + by * by ? [ax, ay] : [bx, by];
      const e = hexDist(gx, gy); // 0 at the cell centre, 0.5 at its wall
      const wall = e > 0.41;
      const c = wall ? [120, 66, 24] : [255 - e * 120, 196 - e * 110, 92 - e * 80];
      const o = (y * W + x) * 4;
      data[o] = lin(c[0]);
      data[o + 1] = lin(c[1]);
      data[o + 2] = lin(c[2]);
      data[o + 3] = 255;
    }
  hexTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  hexTex.wrapS = THREE.RepeatWrapping;
  hexTex.magFilter = THREE.LinearFilter;
  hexTex.minFilter = THREE.LinearMipmapLinearFilter;
  hexTex.generateMipmaps = true;
  hexTex.needsUpdate = true;
  return hexTex;
}

/**
 * A stiff, swept metal blade (thin extruded plate) in the x/z plane reaching out
 * along +x with a sharp tip; leading edge toward −z. Centred on its bounds so
 * the outline hull is even; `offset` is where the root (origin) ended up.
 */
function bladeGeo(len: number, width: number) {
  const g = geo(`blade:${len}:${width}`, () => {
    const s = new THREE.Shape();
    s.moveTo(0, width * 0.42);
    s.lineTo(len * 0.42, width * 0.5);
    s.lineTo(len, width * 0.06); // tip
    s.lineTo(len * 0.62, -width * 0.18);
    s.lineTo(len * 0.5, -width * 0.42); // trailing notch
    s.lineTo(len * 0.28, -width * 0.3);
    s.lineTo(0, -width * 0.5);
    s.closePath();
    const e = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: false });
    e.rotateX(-Math.PI / 2);
    e.computeBoundingBox();
    const c = e.boundingBox!.getCenter(new THREE.Vector3());
    e.translate(-c.x, -c.y, -c.z);
    e.userData.offset = c;
    return e;
  });
  return { g, offset: g.userData.offset as THREE.Vector3 };
}

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
  'mand-proboscis': 2,
  'sting-lance': 1,
  'pinc-vise': 1,
  'horn-drill': 1,
  'armor-ceramic': 1,
  'armor-aegis': 2,
  'core-fusion': 1,
  'sensor-radar': 1,
  'head-octo': 2,
  'abdomen-spinner': 2,
  'legs-weaver': 3,
  'pinc-digger': 2,
  'armor-mirage': 3,
  'sting-laser': 2,
  'horn-shock': 2,
  'sting-tail': 3,
  'pinc-grip': 3,
  'head-coil': 3,
  'head-mirror': 4,
  'thorax-anvil': 2,
  'abdomen-hive': 3,
  'abdomen-smog': 4,
  'legs-hopper': 4,
  'wings-blade': 2,
  'horn-gavel': 3,
  'sting-needle': 4,
  'armor-thorn': 4,
  'core-lodestone': 2,
  'sensor-beacon': 2,
};

const STEEL = 0x9aa6b4;
const GUNMETAL = 0x3a424d;
const IVORY = 0xf2ead8;
const RIM = 0.32;

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
    const m = toonMaterial(color, { rim: opts.transparent ? 0 : RIM, ...opts });
    mats.push({ m, base: m.color.clone(), em: m.emissive.clone() });
    return m;
  };
  const main = mat(baseColor);
  const dark = mat(baseColor.clone().multiplyScalar(0.55));
  const light = mat(baseColor.clone().lerp(new THREE.Color(0xffffff), 0.4));
  const gun = mat(GUNMETAL);
  const steel = mat(STEEL);
  const sides = side === 0 ? [-1, 1] : [side];
  /** Little steel bolt heads. */
  const bolt = (x: number, y: number, z: number, r = 0.045) => root.add(at(new THREE.Mesh(ball(r), steel), x, y, z));
  let animate: PartModel['animate'] = () => {};

  switch (def.category) {
    case 'head': {
      const skull = new THREE.Group();
      skull.add(at(shape(rbox(0.7, 0.26, 0.66, 0.1), dark), 0, 0.38, 0.02)); // jaw plate
      const glow = mat(0xa8dcff, { emissive: 0x2a8cff });
      const blinkers: THREE.Object3D[] = [];
      let octoLens: THREE.MeshToonMaterial | null = null;
      if (look === 0) {
        skull.add(at(shape(ellip(0.42, 0.3, 0.4), main), 0, 0.6, 0.02)); // cranium
        skull.add(at(shape(rbox(0.74, 0.1, 0.24, 0.05), light, 0.025), 0, 0.84, -0.2)); // brow
        for (const d of [-1, 1]) {
          const eye = new THREE.Group();
          eye.add(shape(ball(0.16), mat(0xf6fbff), 0.03));
          eye.add(at(new THREE.Mesh(ball(0.1), glow), 0, 0, -0.08)); // iris
          eye.add(at(new THREE.Mesh(ball(0.05), OUTLINE), 0, 0, -0.15)); // pupil
          eye.add(at(new THREE.Mesh(ball(0.028), new THREE.MeshBasicMaterial({ color: 0xffffff })), -0.04, 0.05, -0.17));
          eye.position.set(0.21 * d, 0.68, -0.28);
          eye.rotation.y = -0.25 * d;
          skull.add(eye);
          blinkers.push(eye);
          for (let i = 0; i < 3; i++) skull.add(at(shape(rbox(0.04, 0.05, 0.16, 0.02), gun, 0), 0.4 * d, 0.5, -0.08 + i * 0.1)); // cheek vents
        }
        // Mouth grille.
        skull.add(at(shape(rbox(0.4, 0.14, 0.12, 0.05), gun, 0.025), 0, 0.42, -0.34));
        for (let i = -1; i <= 1; i++) skull.add(at(new THREE.Mesh(rbox(0.07, 0.03, 0.04, 0.01), light), i * 0.11, 0.42, -0.41));
      } else if (look === 1) {
        skull.add(at(shape(ellip(0.4, 0.3, 0.46), main), 0, 0.6, 0.04)); // helmet
        skull.add(at(shape(ellip(0.36, 0.13, 0.24), mat(0xc9f6ff, { emissive: 0x15b5cf }), 0.03), 0, 0.64, -0.24)); // wraparound visor
        const scan = new THREE.Mesh(ball(0.06), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        scan.position.set(0, 0.66, -0.47);
        skull.add(scan);
        blinkers.push(scan);
        skull.add(at(shape(rbox(0.08, 0.26, 0.6, 0.04), light, 0.025), 0, 0.92, 0.06)); // crest fin
        for (const d of [-1, 1]) {
          skull.add(at(shape(cyl(0.09, 0.11, 0.08, 12), gun, 0.02).rotateZ(Math.PI / 2), 0.41 * d, 0.6, 0.06)); // ear caps
          skull.add(seg(V(0.43 * d, 0.62, 0.06), V(0.5 * d, 0.86, 0.2), 0.025, steel, 0.015, 0));
        }
      } else if (look === 3) {
        // Coil crown: a slate dome wearing a copper ring, a coiled spire and spark-tipped prongs.
        const copper = mat(0xd9844a);
        const spark = mat(0xe6ffff, { emissive: 0x19d6ff });
        skull.add(at(shape(ellip(0.4, 0.3, 0.42), mat(0x56677a)), 0, 0.6, 0.02));
        for (const d of [-1, 1]) {
          skull.add(at(shape(cyl(0.12, 0.12, 0.08, 14), gun, 0.02).rotateX(Math.PI / 2), 0.17 * d, 0.64, -0.33)); // eye socket
          skull.add(at(new THREE.Mesh(ball(0.085), spark), 0.17 * d, 0.64, -0.37)); // glowing eye
        }
        skull.add(at(shape(torus(0.3, 0.05), copper, 0.02).rotateX(Math.PI / 2), 0, 0.82, 0.02)); // crown ring
        skull.add(at(shape(cyl(0.05, 0.08, 0.1, 10), gun, 0.02), 0, 0.92, 0.02));
        skull.add(at(shape(helix(0.08, 0.025, 0.26, 4), copper, 0.015), 0, 1.06, 0.02)); // coil spire
        const tips: THREE.Object3D[] = [];
        const top = at(new THREE.Mesh(ball(0.065), spark), 0, 1.24, 0.02);
        skull.add(top);
        tips.push(top);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const [x, z] = [Math.cos(a) * 0.3, Math.sin(a) * 0.3 + 0.02];
          skull.add(seg(V(x, 0.82, z), V(x * 1.25, 1.0, z * 1.25), 0.03, copper, 0.02, 0.02));
          const tip = at(new THREE.Mesh(ball(0.045), spark), x * 1.27, 1.03, z * 1.27);
          skull.add(tip);
          tips.push(tip);
        }
        blinkers.push(...tips);
        octoLens = spark;
      } else if (look === 4) {
        // Mirror crown: a faceted, polished silver head ringed by angled mirror panels.
        const silver = mat(0xdfe7f0, { emissive: 0x0d2a44, rim: 0.7 });
        const face = mat(0xb8d4ec, { emissive: 0x1d5f99, rim: 0.7 });
        const gem = geo('mirror-head', () => new THREE.IcosahedronGeometry(0.42, 0).scale(1, 0.72, 1));
        skull.add(at(shape(gem, silver), 0, 0.62, 0.02));
        // Narrow eye slit of two diamond lenses.
        const eyeGem = geo('mirror-eye', () => new THREE.OctahedronGeometry(0.08, 0).scale(1.4, 0.7, 0.6));
        for (const d of [-1, 1]) skull.add(at(shape(eyeGem, mat(0x9fdcff, { emissive: 0x2f9cff }), 0.02), 0.14 * d, 0.6, -0.34));
        const crown = new THREE.Group();
        crown.position.set(0, 0.86, 0.02);
        const panel = rbox(0.16, 0.2, 0.04, 0.02);
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          const p = shape(panel, i % 2 ? silver : face, 0.02);
          p.position.set(Math.sin(a) * 0.24, 0.06, Math.cos(a) * 0.24);
          p.rotation.set(0, a, 0);
          p.rotateX(0.35); // flare outward
          crown.add(p);
        }
        skull.add(crown);
        blinkers.push(crown);
        octoLens = face;
      } else {
        // Spider head: a low dome, eight glowing lenses in two rows, and a pair of fangs.
        skull.add(at(shape(ellip(0.42, 0.27, 0.42), main), 0, 0.58, 0.04));
        skull.add(at(shape(rbox(0.5, 0.08, 0.2, 0.04), dark, 0.02), 0, 0.5, -0.34));
        const lens = mat(0xffd9d9, { emissive: 0xff3b3b });
        const spots: [number, number, number, number][] = [
          [0.1, 0.72, -0.37, 0.085],
          [0.27, 0.68, -0.3, 0.06],
          [0.09, 0.84, -0.26, 0.05],
          [0.24, 0.8, -0.2, 0.045],
        ];
        for (const d of [-1, 1]) {
          for (const [x, y, z, r] of spots) skull.add(at(shape(ball(r), lens, 0.02), x * d, y, z));
          // Fangs.
          skull.add(chain([V(0.12 * d, 0.44, -0.36), V(0.14 * d, 0.34, -0.5), V(0.06 * d, 0.24, -0.54)], 0.06, 0.02, mat(IVORY), 0.02));
        }
        octoLens = lens;
      }
      skull.add(at(shape(cyl(0.16, 0.2, 0.18, 10), gun, 0.02).rotateX(Math.PI / 2), 0, 0.46, 0.38)); // neck socket
      root.add(skull);
      animate = ({ t, speed }) => {
        skull.rotation.y = Math.sin(t * 0.9 + row) * 0.08 * (1 - speed * 0.6);
        skull.rotation.x = Math.sin(t * 1.7 + row) * 0.025 - speed * 0.05;
        glow.emissiveIntensity = 0.85 + Math.sin(t * 4) * 0.2;
        if (look === 0) {
          // Blink every few seconds.
          const b = (t + row * 0.7) % 3.4;
          const open = b < 0.12 ? Math.abs(b - 0.06) / 0.06 : 1;
          for (const e of blinkers) e.scale.y = 0.15 + 0.85 * open;
        } else if (look === 1) {
          blinkers[0].position.x = Math.sin(t * 2.2 + row) * 0.26; // visor scanner sweeps
        } else if (look === 3 && octoLens) {
          // Sparks crackle: each tip flickers and jitters on its own beat.
          octoLens.emissiveIntensity = 0.7 + Math.abs(Math.sin(t * 19 + row)) * 0.8;
          blinkers.forEach((s, i) => s.scale.setScalar(0.75 + Math.abs(Math.sin(t * (13 + i * 3.7) + i)) * 0.55));
        } else if (look === 4 && octoLens) {
          blinkers[0].rotation.y = t * 0.6 + row; // the mirror ring turns, throwing glints
          octoLens.emissiveIntensity = 0.6 + Math.max(0, Math.sin(t * 2.4 + row)) * 0.7;
        } else if (octoLens) {
          octoLens.emissiveIntensity = 0.7 + Math.sin(t * 3 + row) * 0.35; // the eyes smoulder
        }
      };
      break;
    }

    case 'thorax': {
      const body = new THREE.Group();
      body.add(at(shape(rbox(0.9, 0.36, 0.9, 0.14), gun), 0, 0.42, 0)); // chassis
      const shell = new THREE.Group();
      shell.position.y = 0.56;
      body.add(shell);
      const vents: THREE.MeshToonMaterial[] = [];
      const ventMat = mat(0xffb070, { emissive: 0xff6a1a });
      vents.push(ventMat);
      if (look === 0) {
        shell.add(shape(dome(0.48, 0.36, 0.48), main));
        shell.add(at(new THREE.Mesh(torus(0.46, 0.035), dark), 0, 0.02, 0).rotateX(Math.PI / 2)); // seam
        shell.add(at(shape(rbox(0.4, 0.08, 0.4, 0.04), dark, 0.02), 0, 0.33, 0)); // hatch
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) shell.add(at(new THREE.Mesh(ball(0.04), steel), 0.15 * sx, 0.37, 0.15 * sz));
      } else if (look === 2) {
        // Anvil: a blocky iron waist under a wide, polished top face with a horn out front.
        const iron = mat(0x4a5059);
        const face = mat(0x99a2ad);
        shell.add(at(shape(rbox(0.6, 0.18, 0.6, 0.05), iron), 0, 0.06, 0.02)); // waist
        shell.add(at(shape(rbox(0.94, 0.2, 0.66, 0.06), iron), 0, 0.24, 0.04)); // block
        shell.add(at(shape(rbox(0.84, 0.05, 0.56, 0.02), face, 0.02), 0, 0.35, 0.04)); // worn top face
        const horn = shape(cone(0.15, 0.36, 10), face, 0.025);
        horn.rotation.x = -Math.PI / 2; // tapering forward
        shell.add(at(horn, 0, 0.27, -0.44));
        shell.add(at(shape(rbox(0.3, 0.14, 0.12, 0.03), iron, 0.02), 0, 0.26, 0.42)); // heel
        for (const d of [-1, 1]) {
          for (const z of [-0.18, 0.04, 0.26]) shell.add(at(new THREE.Mesh(ball(0.035), steel), 0.475 * d, 0.24, z)); // rivets
          shell.add(at(shape(rbox(0.06, 0.16, 0.5, 0.02), dark, 0.02), 0.31 * d, 0.06, 0.02)); // side straps
        }
      } else {
        // Overlapping chitin plates with a ridge of spines down the middle.
        [-0.22, 0.04, 0.28].forEach((z, i) => {
          shell.add(at(shape(dome(0.47 - i * 0.03, 0.34 - i * 0.04, 0.26), i % 2 ? light : main), 0, -0.02 * i, z));
        });
        for (let i = 0; i < 3; i++) shell.add(at(shape(cone(0.05, 0.16, 6), light, 0.02), 0, 0.38 - i * 0.04, -0.2 + i * 0.24));
        for (const d of [-1, 1]) shell.add(aim(at(shape(cone(0.07, 0.24, 6), dark, 0.02), 0.42 * d, 0.1, -0.2), V(d, 0.6, -0.2)));
      }
      for (const d of [-1, 1])
        for (let i = 0; i < 3; i++) body.add(at(new THREE.Mesh(rbox(0.03, 0.05, 0.12, 0.012), ventMat), 0.455 * d, 0.42, -0.16 + i * 0.16)); // glowing side vents
      root.add(body);
      animate = ({ t, walk, speed }) => {
        // (The iron anvil doesn't breathe; it just settles with each stride.)
        if (look === 2) shell.position.y = 0.56 - Math.abs(Math.sin(walk + row)) * 0.015 * speed;
        else {
          const s = 1 + Math.sin(t * 2 + row) * 0.015;
          shell.scale.set(s, 1 + Math.sin(t * 2 + row) * 0.03, s);
        }
        for (const v of vents) v.emissiveIntensity = 0.6 + speed * 0.6 + Math.sin(t * 5 + row) * 0.25;
      };
      break;
    }

    case 'abdomen': {
      const segs: THREE.Group[] = [];
      const rows = (
        [
          [
            [0.44, 0.3, 0.22, -0.26],
            [0.4, 0.28, 0.2, 0.04],
            [0.31, 0.23, 0.18, 0.31],
          ],
          [
            [0.46, 0.32, 0.28, -0.18],
            [0.38, 0.28, 0.24, 0.24],
          ],
          [
            [0.36, 0.3, 0.22, -0.3],
            [0.48, 0.4, 0.38, 0.08],
          ],
          [
            [0.3, 0.24, 0.2, -0.3],
            [0.46, 0.42, 0.42, 0.08],
          ],
          [
            [0.3, 0.22, 0.18, -0.32],
            [0.46, 0.38, 0.4, 0.06],
          ],
        ] as [number, number, number, number][][]
      )[look];
      // Segment skins (alternating front to back) and the stripe band colour.
      const rubber = look === 4 ? mat(0x5d4f69) : null;
      const rubberDark = look === 4 ? mat(0x40364b) : null;
      const [skins, bandMat]: [THREE.Material[], THREE.Material | null] =
        look === 3
          ? [[mat(0x6e4626), mat(0xffffff, { map: hexTexture() })], null]
          : rubber && rubberDark
            ? [[rubberDark, rubber], mat(0x8b7b98)]
            : [[main, dark], light];
      rows.forEach(([rx, ry, rz, z], i) => {
        const s = new THREE.Group();
        s.add(at(shape(ellip(rx, ry, rz), skins[i % 2]), 0, 0.52 - i * 0.02, 0));
        if (bandMat) {
          const band = at(new THREE.Mesh(torus(1, 0.035 / rx), bandMat), 0, 0.52 - i * 0.02, rz * 0.45);
          band.scale.set(rx * 0.9, ry * 0.9, rx * 0.9);
          s.add(band); // stripe band hugging the segment
        }
        s.position.z = z;
        root.add(s);
        segs.push(s);
      });
      const tipMat = mat(0xfff0c0, { emissive: 0xffa21f });
      const tip = new THREE.Mesh(ball(0.07), tipMat);
      if (look < 3) segs[segs.length - 1].add(at(tip, 0, 0.5, rows[rows.length - 1][2] + 0.04));
      const drones: THREE.Object3D[] = [];
      const puffs: THREE.Object3D[] = [];
      if (look === 3) {
        // Hive: a honeycomb nest with glowing entrances; drones buzz around it.
        const big = segs[1];
        const [rx, ry, rz] = rows[1];
        const lip = mat(0x5a3518);
        const holes: [number, number, number, number][] = [
          [0.2, 0.25, -0.75, 0.09],
          [-0.6, 0.45, -0.4, 0.07],
          [0.85, 0.05, 0.2, 0.075],
          [-0.75, -0.25, 0.45, 0.065],
          [0.15, 0.6, 0.7, 0.06],
        ];
        for (const [ux, uy, uz, r] of holes) {
          const k = 1 / Math.hypot(ux / rx, uy / ry, uz / rz);
          const n = V(ux / (rx * rx), uy / (ry * ry), uz / (rz * rz)).normalize();
          const hole = new THREE.Group();
          hole.add(shape(cyl(r, r * 1.2, 0.06, 12), lip, 0.015));
          hole.add(at(new THREE.Mesh(ellip(r * 0.8, 0.02, r * 0.8), tipMat), 0, 0.03, 0));
          aim(hole, n);
          big.add(at(hole, ux * k, 0.5 + uy * k, uz * k));
        }
        big.add(at(shape(cyl(0.12, 0.16, 0.1, 10), lip, 0.02), 0, 0.93, 0)); // hanging stem
        const droneMat = mat(0xffd23f);
        const wingMat = mat(0xffffff, { transparent: true, opacity: 0.7 });
        for (let i = 0; i < 3; i++) {
          const dr = new THREE.Group();
          dr.add(shape(ellip(0.045, 0.04, 0.055), droneMat, 0.018));
          dr.add(at(new THREE.Mesh(ellip(0.047, 0.012, 0.015), OUTLINE), 0, 0.005, 0.01)); // stripe
          for (const d of [-1, 1]) dr.add(at(new THREE.Mesh(ellip(0.045, 0.008, 0.025), wingMat), 0.04 * d, 0.045, 0.01));
          big.add(dr);
          drones.push(dr);
        }
      }
      if (look === 4) {
        // Smog bladder: a rubbery sac with a vent nozzle at the back that coughs smoke.
        const big = segs[1];
        const rz = rows[1][2];
        const nozzle = new THREE.Group();
        nozzle.add(shape(cyl(0.08, 0.11, 0.14, 12), gun, 0.02));
        nozzle.add(at(shape(cyl(0.13, 0.09, 0.08, 12), steel, 0.02), 0, 0.1, 0)); // flared mouth
        nozzle.add(at(new THREE.Mesh(cyl(0.085, 0.085, 0.02, 12), OUTLINE), 0, 0.14, 0));
        nozzle.rotation.x = 0.75; // up and back
        big.add(at(nozzle, 0, 0.8, rz * 0.62));
        big.add(at(shape(cyl(0.05, 0.06, 0.08, 8), steel, 0.02), 0.14, 0.88, -0.06)); // fill valve
        for (const d of [-1, 1]) big.add(at(shape(ellip(0.07, 0.05, 0.1), rubberDark ?? dark, 0.02), 0.3 * d, 0.72, 0.06)); // patches
        const smoke = mat(0x9a94a3, { transparent: true, opacity: 0.6 });
        for (let i = 0; i < 3; i++) {
          const p = new THREE.Mesh(ball(0.09), smoke);
          big.add(p);
          puffs.push(p);
        }
      }
      if (look === 2) {
        // Spider abdomen: a big bulb with a silk nozzle and a strand of silk at the back.
        const silk = mat(0xf4f1e6, { emissive: 0x8a8672 });
        const big = segs[1];
        const nozzle = shape(cone(0.13, 0.26, 8), gun, 0.02);
        nozzle.rotation.x = Math.PI / 2;
        big.add(at(nozzle, 0, 0.42, 0.44));
        big.add(at(new THREE.Mesh(ball(0.07), silk), 0, 0.42, 0.58));
        for (const d of [-1, 1]) big.add(at(shape(ellip(0.1, 0.07, 0.16), silk, 0.02), 0.22 * d, 0.82, 0.02)); // pale markings
        big.add(at(shape(ellip(0.09, 0.06, 0.12), silk, 0.02), 0, 0.88, -0.16));
      }
      let fluid: THREE.Object3D[] = [];
      let fluidMat: THREE.MeshToonMaterial | null = null;
      if (look === 1) {
        // Glass fuel tanks with glowing fluid.
        const glass = mat(0xdff7ff, { transparent: true, opacity: 0.35 });
        fluidMat = mat(0x8dffb5, { emissive: 0x1fcf6a });
        fluid = [];
        for (const d of [-1, 1]) {
          const tank = new THREE.Group();
          tank.add(new THREE.Mesh(cyl(0.12, 0.12, 0.62, 14), glass).rotateX(Math.PI / 2));
          const f = new THREE.Mesh(cyl(0.095, 0.095, 0.56, 12), fluidMat).rotateX(Math.PI / 2);
          tank.add(f);
          fluid.push(f);
          for (const z of [-0.33, 0.33]) tank.add(at(shape(cyl(0.14, 0.14, 0.06, 14), steel, 0.02).rotateX(Math.PI / 2), 0, 0, z));
          tank.position.set(0.4 * d, 0.84, 0.02);
          root.add(tank);
        }
      }
      animate = ({ t, walk, speed }) => {
        segs.forEach((s, i) => {
          const wag = Math.sin(walk - i * 0.7) * 0.1 * speed + Math.sin(t * 1.3 - i * 0.6 + row) * 0.035;
          s.rotation.y = wag * (i + 1) * 0.6;
          s.position.x = wag * (i + 1) * 0.06;
          s.scale.y = 1 + Math.sin(t * 2.2 - i * 0.8 + row) * 0.03; // breathing
        });
        tipMat.emissiveIntensity = 0.6 + Math.max(0, Math.sin(t * 3 + row)) * 0.8;
        drones.forEach((dr, i) => {
          // Lazy orbits around the nest, bobbing and wobbling.
          const a = t * (1.1 + i * 0.25) + i * 2.1 + row;
          dr.position.set(Math.cos(a) * (0.58 + i * 0.04), 0.62 + Math.sin(t * 3.1 + i * 1.7) * 0.12 + i * 0.06, 0.02 + Math.sin(a) * 0.55);
          dr.rotation.y = -a;
          dr.rotation.z = Math.sin(t * 23 + i) * 0.15;
        });
        if (look === 4) {
          // The bladder slowly inflates and deflates; smoke puffs drift out of the vent and fade.
          const big = segs[1];
          const s = 1 + Math.sin(t * 1.6 + row) * 0.07;
          big.scale.set(s, s * (1 + Math.sin(t * 2.2 + row) * 0.03), s);
          puffs.forEach((p, i) => {
            const k = (t * 0.6 + i / puffs.length + row * 0.37) % 1;
            p.position.set(Math.sin(i * 2.4 + t) * 0.04, 0.96 + k * 0.3, 0.38 + k * 0.3);
            p.scale.setScalar(Math.sin(k * Math.PI) * (0.7 + k * 0.9));
          });
        }
        if (fluidMat) {
          fluidMat.emissiveIntensity = 0.6 + Math.sin(t * 2.5) * 0.25;
          fluid.forEach((f, i) => (f.rotation.y = Math.sin(t * 3 + i) * 0.06 * (1 + speed * 3))); // slosh
        }
      };
      break;
    }

    case 'legs': {
      // Hip housing with a motor drum per side.
      root.add(at(shape(rbox(0.46, 0.3, 0.62, 0.13), main), 0, 0.5, 0));
      root.add(at(shape(rbox(0.3, 0.08, 0.5, 0.04), dark, 0.02), 0, 0.68, 0));
      const joint = look === 2 ? mat(0xe2dccd) : steel;
      const [r, reach, drop] = [
        [0.06, 0.66, 0.46],
        [0.052, 0.78, 0.46],
        [0.085, 0.58, 0.46],
        [0.045, 0.98, 0.46],
        [0.058, 0.74, 0.46],
      ][look];
      const arch = look === 3; // spider legs: knee held high above the body
      const legs: { hip: THREE.Group; knee: THREE.Group; d: number; phase: number }[] = [];
      const hopperMat = look === 4 ? mat(0x8cc152) : main;
      const springMat = look === 4 ? mat(0xe3a03c) : steel;
      for (const d of sides) {
        for (const dz of [-0.2, 0.2]) {
          root.add(at(shape(cyl(0.11, 0.11, 0.1, 12), gun, 0.02).rotateZ(Math.PI / 2), 0.25 * d, 0.5, dz)); // motor drum
          const hip = new THREE.Group();
          hip.position.set(0.24 * d, 0.5, dz);
          // Spring hoppers: the rear leg is a big grasshopper leg, knee folded high and back.
          const hop = look === 4 && dz > 0;
          const kneeAt = hop ? V(reach * 0.42 * d, 0.4, 0.24) : V(reach * (arch ? 0.42 : 0.55) * d, arch ? 0.78 : 0.3, dz * (arch ? 0.7 : 0.4));
          const footAt = hop ? V(reach * d, -drop, -0.04) : V(reach * d, -drop, dz * (arch ? 1.7 : 0.9));
          // Femur: armoured, chunky; a light plate on top.
          hip.add(seg(V(0, 0, 0), kneeAt, r * (hop ? 1.9 : 1.35), look === 4 ? hopperMat : main, r * (hop ? 1.2 : 1.05)));
          if (hop) {
            // Chevron ridges along the drumstick femur.
            for (const k of [0.3, 0.5, 0.7]) {
              const p = kneeAt.clone().multiplyScalar(k);
              hip.add(aim(at(new THREE.Mesh(torus(r * (1.95 - k * 0.8), 0.016), dark), p.x, p.y, p.z), kneeAt).rotateX(Math.PI / 2));
            }
          } else if (look !== 1) hip.add(seg(V(0.05 * d, 0.07, 0), kneeAt.clone().multiplyScalar(0.8).add(V(0, 0.07, 0)), r * 0.6, light, r * 0.5, 0));
          if (look === 1) hip.add(seg(V(0.12 * d, -0.04, 0), V(reach * 0.45 * d, 0.12, dz * 0.35), r * 0.45, steel, r * 0.45, 0)); // piston
          const knee = new THREE.Group();
          knee.position.copy(kneeAt);
          knee.add(shape(ball(r * 1.55), joint, 0.025));
          const foot = footAt.clone().sub(kneeAt);
          // Tibia: slimmer, darker, ending in a foot.
          knee.add(seg(V(0, 0, 0), foot, r * 1.0, dark, r * 0.55));
          if (look === 4) {
            // A coil spring sheathing the shin (the rear one is long and fat), and a flat foot pad.
            const coil = shape(helix(r * (hop ? 1.9 : 1.6), 0.018, foot.length() * (hop ? 0.5 : 0.36), hop ? 6 : 4), springMat, 0.015);
            aim(coil, foot);
            knee.add(at(coil, foot.x * (hop ? 0.4 : 0.3), foot.y * (hop ? 0.4 : 0.3), foot.z * (hop ? 0.4 : 0.3)));
            const pad = shape(ellip(0.09, 0.035, 0.13), joint, 0.02);
            knee.add(at(pad, foot.x + 0.02 * d, foot.y - 0.02, foot.z - 0.03));
          } else if (look === 2) {
            for (const k of [-1, 1]) {
              const claw = shape(cone(0.05, 0.2, 6), joint, 0.02);
              aim(claw, V(0.5 * d, -1, k * 0.6));
              knee.add(at(claw, foot.x + 0.04 * d, foot.y - 0.02, foot.z + k * 0.05));
            }
          } else {
            const toe = shape(cone(r * 0.8, 0.14, 6), joint, 0.02);
            aim(toe, V(0.2 * d, -1, 0));
            knee.add(at(toe, foot.x, foot.y - 0.02, foot.z));
          }
          hip.add(knee);
          root.add(hip);
          legs.push({ hip, knee, d, phase: (row % 2 ? Math.PI : 0) + (d > 0 ? Math.PI : 0) + (dz > 0 ? Math.PI / 2 : 0) });
        }
      }
      animate = ({ t, walk, speed, air }) =>
        legs.forEach(({ hip, knee, d, phase }, i) => {
          const p = walk + phase;
          const ground = 1 - air;
          const swing = Math.max(0, Math.cos(p)) * speed * ground; // foot in the air
          hip.rotation.y = Math.sin(p) * 0.5 * speed * d * ground + Math.sin(t * 3 + i) * 0.08 * air;
          hip.rotation.z = d * (swing * 0.3 + Math.sin(t * 1.6 + i * 1.3) * 0.02 * (1 - speed) + air * 0.55);
          // The knee folds to lift the foot on the swing, and tucks right up in flight.
          knee.rotation.z = d * (swing * 0.35 + air * 0.9);
        });
      break;
    }

    case 'wings': {
      // On the grid (beside the body) the wing stands on a shoulder mount leaning into the
      // body, so it's anchored rather than hovering; stacked on a body part it sits right on it.
      const onGrid = side !== 0;
      const hubX = onGrid ? -0.12 * side : 0;
      const hubY = onGrid ? 0.78 : 0.82;
      if (onGrid) {
        root.add(at(shape(rbox(0.42, 0.46, 0.56, 0.14), gun), hubX * 0.6, 0.44, 0.02)); // shoulder
        root.add(at(shape(rbox(0.3, 0.08, 0.44, 0.04), dark, 0.02), hubX * 0.6, 0.66, 0.02));
        for (const dz of [-0.16, 0.16]) bolt(hubX * 0.6 + 0.2 * side, 0.5, dz);
      }
      root.add(at(shape(rbox(0.38, 0.24, 0.56, 0.1), dark), hubX, hubY, 0));
      if (!onGrid) root.add(at(shape(rbox(0.56, 0.08, 0.66, 0.04), gun, 0.02), 0, hubY - 0.12, 0)); // saddle on the body
      for (const d of sides) root.add(at(shape(cyl(0.1, 0.1, 0.09, 12), steel, 0.02).rotateZ(Math.PI / 2), hubX + 0.17 * d, hubY + 0.1, -0.04));
      const glassy = look === 1;
      const blade = look === 2;
      const film = mat(0xffffff, { transparent: true, opacity: 1, map: wingTexture(glassy ? 'glass' : 'foil'), side: THREE.DoubleSide });
      const strut = mat(glassy ? 0x7fcbe6 : baseColor.clone().multiplyScalar(0.6));
      const caseMat = mat(new THREE.Color(0x2f6f8f));
      type Wing = { g: THREE.Group; d: number; k: number };
      const wings: Wing[] = [];
      const shells: { g: THREE.Group; d: number }[] = [];
      // Razor wings: three stiff, overlapping metal blades per side, fanned and swept back.
      const bladeMat = mat(0xc3d0de, { rim: 0.6, side: THREE.DoubleSide });
      const edgeMat = mat(0xf4fbff, { emissive: 0x3a6f8c });
      for (const d of sides) {
        if (blade) {
          const pivot = new THREE.Group();
          pivot.position.set(hubX + 0.16 * d, hubY + 0.14, 0.02);
          [
            [1.5, 0.34, 0, 0.03],
            [1.2, 0.3, 0.3, 0.0],
            [0.9, 0.26, 0.58, -0.03],
          ].forEach(([len, w, sweep, y], k) => {
            const fan = new THREE.Group();
            const { g, offset } = bladeGeo(len, w);
            const plate = shape(g, k === 1 ? strut : bladeMat, 0.025);
            plate.position.copy(offset);
            fan.add(plate);
            fan.add(seg(V(0.02, 0.03, -w * 0.42), V(len * 0.42, 0.03, -w * 0.5), 0.018, edgeMat, 0.012, 0)); // honed edge
            fan.add(seg(V(len * 0.42, 0.03, -w * 0.5), V(len * 0.98, 0.03, -w * 0.06), 0.012, edgeMat, 0.006, 0));
            fan.position.y = y;
            fan.rotation.y = -sweep * d;
            if (d < 0) fan.scale.x = -1;
            pivot.add(fan);
          });
          pivot.add(shape(cyl(0.07, 0.07, 0.16, 10), gun, 0.02).rotateX(Math.PI / 2)); // blade root clamp
          root.add(pivot);
          wings.push({ g: pivot, d, k: 0 });
          continue;
        }
        (glassy ? [-0.12, 0.18] : [0.02]).forEach((dz, k) => {
          const pivot = new THREE.Group();
          pivot.position.set(hubX + 0.16 * d, hubY + 0.14, dz);
          const len = glassy ? (k === 0 ? 1.65 : 1.4) : 1.5;
          const w = new THREE.Mesh(wingGeo(len, glassy ? 0.58 : 0.7, glassy ? 'g' : 'f'), film);
          if (d < 0) w.scale.x = -1;
          w.renderOrder = 2;
          pivot.add(w);
          pivot.add(seg(V(0, 0, -0.03), V(len * 0.92 * d, 0.0, -0.12), 0.026, strut, 0.012, 0)); // leading-edge spar
          pivot.rotation.y = d * (glassy ? (k === 0 ? -0.08 : 0.32) : -0.05);
          root.add(pivot);
          wings.push({ g: pivot, d, k });
        });
        if (!glassy) {
          // Beetle wing-case: a hard shell that lifts open to let the membrane beat.
          // Lies along the body like a real beetle's, covering the folded membrane.
          const hinge = new THREE.Group();
          hinge.position.set(hubX + 0.06 * d, hubY + 0.08, -0.3);
          const shell = shape(ellip(0.3, 0.14, 0.62), caseMat);
          shell.position.set(0.24 * d, 0, 0.5);
          hinge.add(shell);
          hinge.add(at(new THREE.Mesh(ellip(0.08, 0.03, 0.46), light), 0.3 * d, 0.11, 0.5)); // sheen stripe
          hinge.add(at(new THREE.Mesh(ellip(0.25, 0.03, 0.05), caseMat), 0.24 * d, -0.02, 1.08)); // rolled tip
          root.add(hinge);
          shells.push({ g: hinge, d });
        }
      }
      animate = ({ t, speed, air }) => {
        const beat = Math.max(speed * 0.7, air);
        const rate = 8 + beat * 48;
        const amp = 0.1 + beat * 0.42;
        for (const { g, d, k } of wings) {
          const s = Math.sin(t * rate + k * 1.3);
          g.rotation.z = d * (0.2 + s * amp);
          g.rotation.x = Math.cos(t * rate + k * 1.3) * 0.18 * beat; // figure-eight twist
          if (blade) {
            // Stiff blades: a shallow, snappy beat with no twist; at rest they fold back along the body.
            const open = Math.min(1, beat * 1.6 + 0.1);
            g.rotation.z = d * (0.12 + s * amp * 0.8 - (1 - open) * 0.12);
            g.rotation.x = 0;
            g.rotation.y = d * -(0.15 + (1 - open) * 0.55);
            continue;
          }
          // Foil membranes fold back under the cases at rest.
          if (!glassy) {
            const open = Math.min(1, beat * 1.6 + 0.08);
            g.rotation.y = d * (-0.05 - (1 - open) * 1.05);
            g.scale.setScalar(0.7 + open * 0.3);
          }
        }
        for (const { g, d } of shells) {
          const open = Math.min(1, beat * 1.5);
          g.rotation.z = d * open * 0.75;
          g.rotation.x = -open * 0.35;
        }
      };
      break;
    }

    case 'mandibles': {
      if (look === 2) {
        // Mosquito proboscis: a fleshy sheath, a long needle with a blood tube that glows as it drinks.
        root.add(at(shape(ellip(0.3, 0.22, 0.26), dark), 0, 0.5, 0.26));
        for (const d of [-1, 1]) root.add(at(shape(ellip(0.1, 0.08, 0.12), main, 0.02), 0.2 * d, 0.56, 0.12)); // palps
        const blood = mat(0xff8f8f, { emissive: 0xc8102e });
        const needle = new THREE.Group();
        needle.position.set(0, 0.5, 0.06);
        needle.add(chain([V(0, 0, 0), V(0, -0.02, -0.4), V(0, -0.06, -0.8)], 0.1, 0.06, main));
        for (let i = 0; i < 4; i++) needle.add(at(new THREE.Mesh(torus(0.095 - i * 0.008, 0.022), dark), 0, -0.01 - i * 0.012, -0.12 - i * 0.18));
        const tube = seg(V(0, 0.05, -0.05), V(0, 0.0, -0.78), 0.035, blood, 0.03, 0);
        needle.add(tube);
        const tip = shape(cone(0.04, 0.42, 6), steel, 0.02);
        tip.rotation.x = -Math.PI / 2 - 0.08;
        needle.add(at(tip, 0, -0.08, -1.0));
        root.add(needle);
        animate = ({ t, attack }) => {
          needle.position.z = 0.06 - attack * 0.22; // stab
          needle.rotation.x = Math.sin(t * 2.2 + row) * 0.04 + attack * 0.06;
          blood.emissiveIntensity = 0.5 + Math.max(0, Math.sin(t * 7)) * 0.4 + attack * 1.5; // pumping
        };
        break;
      }
      root.add(at(shape(rbox(0.6, 0.32, 0.36, 0.12), dark), 0, 0.5, 0.28));
      root.add(at(shape(rbox(0.36, 0.12, 0.1, 0.04), gun, 0.02), 0, 0.5, 0.08)); // mouth recess
      for (const d of [-1, 1]) bolt(0.22 * d, 0.68, 0.3);
      const tooth = mat(IVORY);
      const len = look === 1 ? 0.95 : 0.76;
      const jaws: { g: THREE.Group; d: number }[] = [];
      for (const d of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(0.2 * d, 0.5, 0.16);
        // A sickle: sweeps out, then hooks in to the tip.
        const pts = [V(0, 0, 0), V(0.14 * d, 0.02, -len * 0.35), V(0.12 * d, 0.01, -len * 0.7), V(-0.06 * d, 0, -len)];
        pivot.add(chain(pts, 0.11, 0.045, main));
        const tip = shape(cone(0.05, 0.16, 6), look === 1 ? steel : tooth, 0.02);
        aim(tip, V(-0.6 * d, 0, -1));
        pivot.add(at(tip, -0.1 * d, 0, -len - 0.05));
        // Serrated inner edge.
        for (let i = 0; i < (look === 1 ? 4 : 3); i++) {
          const z = -len * (0.3 + i * 0.16);
          const tth = new THREE.Mesh(cone(0.04, 0.13, 5), look === 1 ? steel : tooth);
          aim(tth, V(-d, 0, -0.3));
          pivot.add(at(tth, (0.07 - i * 0.03) * d, 0, z));
        }
        if (look === 1) pivot.add(seg(V(0.06 * d, 0.06, -len * 0.2), V(0.1 * d, 0.06, -len * 0.75), 0.03, steel, 0.02, 0)); // blade spine
        root.add(pivot);
        jaws.push({ g: pivot, d });
      }
      animate = ({ t, attack }) =>
        jaws.forEach(({ g, d }) => {
          const open = 0.26 + Math.sin(t * 2.6 + row) * 0.1;
          g.rotation.y = -d * (open * (1 - attack) - 0.32 * attack);
        });
      break;
    }

    case 'pincers': {
      root.add(at(shape(rbox(0.62, 0.32, 0.36, 0.12), dark), 0, 0.5, 0.26));
      // (3 = scorpion gripper: half again as big, with a toothed finger.)
      const big = look === 1 ? 1.2 : look === 3 ? 1.5 : 1;
      const claws: { g: THREE.Group; finger: THREE.Group; d: number }[] = [];
      for (const d of [-1, 1]) {
        const wrist = V(0.36 * d, 0.5, -0.18);
        root.add(seg(V(0.22 * d, 0.5, 0.2), wrist, 0.1 * big, main, 0.085 * big));
        if (look === 1) {
          root.add(seg(V(0.2 * d, 0.62, 0.16), V(0.32 * d, 0.6, -0.12), 0.035, steel, 0.035, 0.02)); // hydraulic ram
          root.add(at(shape(rbox(0.12, 0.12, 0.18, 0.04), gun, 0.02), 0.2 * d, 0.64, 0.2));
        }
        const claw = new THREE.Group();
        claw.position.copy(wrist);
        claw.add(shape(ball(0.12 * big), steel, 0.025));
        // The moving finger (dactyl) on a hinge.
        const finger = new THREE.Group();
        finger.position.set(-0.06 * d, 0, -0.3 * big);
        if (look === 2) {
          // Mole digger: a broad shovel paw tipped with digging claws.
          claw.add(at(shape(rbox(0.34, 0.12, 0.34, 0.05), main), 0.04 * d, -0.02, -0.26));
          claw.add(at(shape(rbox(0.36, 0.06, 0.2, 0.03), steel, 0.02), 0.04 * d, -0.06, -0.48));
          for (let i = -1; i <= 1; i++) {
            const nail = shape(cone(0.05, 0.22, 5), mat(IVORY), 0.02);
            nail.rotation.x = -Math.PI / 2 - 0.25;
            claw.add(at(nail, (0.04 + i * 0.12) * d, -0.08, -0.64));
          }
        } else {
          // Palm and the fixed finger.
          claw.add(at(shape(ellip(0.16 * big, 0.13 * big, 0.2 * big), main), 0.04 * d, 0, -0.2 * big));
          claw.add(chain([V(0.1 * d, 0, -0.3 * big), V(0.1 * d, 0, -0.48 * big), V(0.0, 0, -0.62 * big)], 0.075 * big, 0.03 * big, main));
          finger.add(chain([V(0, 0, 0), V(-0.06 * d, 0, -0.18 * big), V(0.0, 0, -0.32 * big)], 0.06 * big, 0.025 * big, light));
          if (look === 1 || look === 3) for (let i = 0; i < 3; i++) finger.add(at(new THREE.Mesh(cone(0.025, 0.07, 4), steel), -0.0 * d, 0, -0.08 - i * 0.08).rotateZ((Math.PI / 2) * d));
        }
        claw.add(finger);
        root.add(claw);
        claws.push({ g: claw, finger, d });
      }
      animate = ({ t, attack }) =>
        claws.forEach(({ g, finger, d }) => {
          const open = 0.35 + Math.sin(t * 2 + d + row) * 0.15;
          finger.rotation.y = d * (open * (1 - attack) - 0.1 * attack);
          g.rotation.y = -d * (0.12 - attack * 0.25);
          if (look === 2) g.rotation.x = Math.sin(t * 5 + d) * 0.06 - attack * 0.5; // scooping swipe
        });
      break;
    }

    case 'stinger': {
      if (look === 4) {
        // Needle gun: a four-barrel needle launcher on a stinger mount, fed from a glowing drum.
        const charge = mat(0xf0dcff, { emissive: 0xa04ae0 });
        const dart = mat(0xf2fbff, { emissive: 0x6fd2ff });
        root.add(at(shape(rbox(0.46, 0.2, 0.44, 0.08), dark), 0, 0.38, 0.18)); // socket
        root.add(at(shape(rbox(0.16, 0.2, 0.16, 0.05), gun, 0.02), 0, 0.52, 0.18)); // post
        const gunGroup = new THREE.Group();
        gunGroup.position.set(0, 0.66, 0.06);
        gunGroup.add(at(shape(cyl(0.2, 0.2, 0.26, 14), main).rotateX(Math.PI / 2), 0, 0, 0.12)); // drum
        gunGroup.add(at(new THREE.Mesh(torus(0.205, 0.03), charge), 0, 0, 0.12)); // charge band
        gunGroup.add(at(shape(cyl(0.16, 0.16, 0.06, 14), gun, 0.02).rotateX(Math.PI / 2), 0, 0, 0.28)); // back cap
        const cluster = new THREE.Group();
        cluster.add(at(shape(cyl(0.13, 0.15, 0.12, 12), gun, 0.02).rotateX(Math.PI / 2), 0, 0, -0.04)); // breech
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const [x, y] = [Math.cos(a) * 0.075, Math.sin(a) * 0.075];
          cluster.add(seg(V(x, y, -0.06), V(x, y, -0.66), 0.035, steel, 0.03, 0.02));
          cluster.add(at(new THREE.Mesh(ball(0.028), dart), x, y, -0.68)); // loaded dart
        }
        for (const z of [-0.3, -0.58]) cluster.add(at(new THREE.Mesh(torus(0.115, 0.028), dark), 0, 0, z)); // barrel clamps
        gunGroup.add(cluster);
        root.add(gunGroup);
        let spin = 0;
        let last = 0;
        animate = ({ t, attack }) => {
          // The barrels spin up while firing and recoil with each dart.
          spin += (t - last) * (0.6 + attack * 14);
          last = t;
          cluster.rotation.z = spin;
          cluster.position.z = attack * 0.14;
          gunGroup.rotation.x = Math.sin(t * 1.4 + row) * 0.04 + attack * 0.06;
          dart.emissiveIntensity = 0.6 + Math.sin(t * 7) * 0.25 + attack * 1.8;
          charge.emissiveIntensity = 0.55 + Math.sin(t * 2 + row) * 0.2 + attack;
        };
        break;
      }
      if (look === 3) {
        // Scorpion tail: fat armored segments arching up and over the body, ending in a venom bulb and a barb.
        const venom = mat(0xd8ff7a, { emissive: 0x7fd61a });
        root.add(at(shape(rbox(0.5, 0.2, 0.44, 0.08), dark), 0, 0.4, 0.16)); // socket
        const tail = new THREE.Group();
        tail.position.set(0, 0.46, 0.18);
        tail.scale.setScalar(1.22);
        const pts = [V(0, 0, 0), V(0, 0.4, 0.2), V(0, 0.82, 0.22), V(0, 1.2, 0.04), V(0, 1.42, -0.32), V(0, 1.44, -0.72)];
        for (let i = 0; i < pts.length - 1; i++) {
          const r0 = 0.2 - i * 0.022;
          tail.add(seg(pts[i], pts[i + 1], r0, i % 2 ? light : main, r0 - 0.03));
          tail.add(at(shape(ball(r0 * 0.78), steel, 0.02), pts[i + 1].x, pts[i + 1].y, pts[i + 1].z)); // joint
        }
        const tip = pts[pts.length - 1];
        tail.add(at(new THREE.Mesh(ellip(0.17, 0.16, 0.2), venom), tip.x, tip.y - 0.02, tip.z - 0.12));
        const barb = shape(cone(0.075, 0.42, 6), mat(IVORY), 0.02);
        barb.rotation.x = -Math.PI / 2 - 0.75; // forward and down
        tail.add(at(barb, tip.x, tip.y - 0.2, tip.z - 0.36));
        root.add(tail);
        animate = ({ t, attack }) => {
          // Rears back through the wind-up, then whips over the top.
          tail.rotation.x = Math.sin(t * 1.3 + row) * 0.05 - attack * (attack > 0 ? 0.85 : 0.3);
          tail.rotation.z = Math.sin(t * 0.9 + row) * 0.04;
          venom.emissiveIntensity = 0.6 + Math.sin(t * 3 + row) * 0.2 + Math.max(0, attack) * 1.5;
        };
        break;
      }
      // Venom gland: glass bulb with glowing fluid inside and banding.
      const glass = mat(0xf1dcff, { transparent: true, opacity: 0.3 });
      const venom = look === 2 ? mat(0xb8fbff, { emissive: 0x19c8e0 }) : mat(0xe6a6ff, { emissive: 0xa23ee0 });
      root.add(at(new THREE.Mesh(ellip(0.25, 0.22, 0.29), venom), 0, 0.52, 0.2));
      root.add(at(new THREE.Mesh(ellip(0.3, 0.27, 0.34), glass), 0, 0.52, 0.2));
      for (const z of [0.04, 0.36]) root.add(at(new THREE.Mesh(torus(0.26, 0.035), look === 2 ? steel : dark), 0, 0.52, z));
      root.add(at(shape(rbox(0.36, 0.14, 0.2, 0.05), gun, 0.02), 0, 0.33, 0.2)); // cradle
      const glow = look === 2 ? mat(0xe9feff, { emissive: 0x3fe6ff }) : mat(0xf6d9ff, { emissive: 0xc06cff });
      const barrel = new THREE.Group();
      if (look === 0) {
        barrel.add(chain([V(0, 0, 0.02), V(0, 0, -0.35), V(0, 0, -0.72)], 0.15, 0.05, main));
        for (let i = 0; i < 3; i++) barrel.add(at(new THREE.Mesh(torus(0.13 - i * 0.03, 0.03), dark), 0, 0, -0.12 - i * 0.2));
        const needle = shape(cone(0.05, 0.22, 6), steel, 0.02);
        needle.rotation.x = -Math.PI / 2;
        barrel.add(at(needle, 0, 0, -0.86));
        barrel.add(at(new THREE.Mesh(ball(0.05), glow), 0, 0, -0.98));
      } else if (look === 1) {
        barrel.add(seg(V(0, 0, 0.02), V(0, 0, -0.95), 0.075, main, 0.06));
        for (let i = 0; i < 4; i++) barrel.add(at(new THREE.Mesh(torus(0.13 - i * 0.012, 0.032), glow), 0, 0, -0.22 - i * 0.2));
        for (const d of [-1, 1]) barrel.add(seg(V(0.09 * d, 0, -0.86), V(0.04 * d, 0, -1.14), 0.03, steel, 0.018, 0));
        barrel.add(at(new THREE.Mesh(ball(0.045), glow), 0, 0, -1.1));
      } else {
        // Laser: a stubby emitter tube with focusing rings and a glowing lens.
        barrel.add(shape(cyl(0.13, 0.15, 0.62, 12), gun).rotateX(Math.PI / 2).translateY(-0.3));
        for (let i = 0; i < 3; i++) barrel.add(at(new THREE.Mesh(torus(0.17, 0.03), steel), 0, 0, -0.12 - i * 0.2));
        barrel.add(at(shape(cyl(0.19, 0.16, 0.1, 14), steel, 0.02).rotateX(Math.PI / 2), 0, 0, -0.66));
        barrel.add(at(new THREE.Mesh(ball(0.13), glow), 0, 0, -0.7));
        for (const d of [-1, 1]) barrel.add(seg(V(0.16 * d, 0.02, -0.05), V(0.16 * d, 0.02, -0.55), 0.025, steel, 0.025, 0)); // cooling rails
      }
      barrel.position.set(0, 0.54, -0.06);
      root.add(barrel);
      animate = ({ t, attack }) => {
        barrel.position.z = -0.06 + attack * 0.2;
        barrel.rotation.x = Math.sin(t * 1.4 + row) * 0.04;
        glow.emissiveIntensity = 0.7 + Math.sin(t * 6) * 0.3 + attack * 1.6;
        venom.emissiveIntensity = 0.55 + Math.sin(t * 2 + row) * 0.2 + attack;
      };
      break;
    }

    case 'horn': {
      root.add(at(shape(rbox(0.62, 0.42, 0.54, 0.14), dark), 0, 0.46, 0.14));
      root.add(at(shape(rbox(0.66, 0.1, 0.2, 0.04), gun, 0.02), 0, 0.36, -0.1)); // bumper lip
      for (const d of [-1, 1]) bolt(0.24 * d, 0.68, 0.3);
      const horn = new THREE.Group();
      const spin = new THREE.Group();
      horn.add(spin);
      let sparkMat: THREE.MeshToonMaterial | null = null;
      let sparkOrb: THREE.Mesh | null = null;
      if (look === 0) {
        // A curved beetle horn that sweeps forward and up.
        const pts = [V(0, 0, 0), V(0, 0.04, -0.3), V(0, 0.16, -0.56), V(0, 0.38, -0.74), V(0, 0.62, -0.78)];
        horn.add(chain(pts, 0.17, 0.035, mat(IVORY)));
        for (let i = 0; i < 3; i++) horn.add(at(new THREE.Mesh(torus(0.155 - i * 0.025, 0.025), dark), 0, 0.03 + i * 0.05, -0.12 - i * 0.16).rotateX(-0.15 - i * 0.3));
        horn.position.set(0, 0.58, -0.06);
      } else if (look === 1) {
        // Drill bit with a spiral flute.
        spin.add(at(shape(cone(0.3, 1.0, 12), steel), 0, 0.5, 0));
        const flute = mat(0x5b6574);
        for (let i = 0; i < 14; i++) {
          const y = 0.08 + i * 0.062;
          const rr = 0.29 * (1 - (y - 0.0) / 1.0) + 0.02;
          const a = i * 0.9;
          const b = new THREE.Mesh(rbox(0.07, 0.05, 0.12, 0.02), flute);
          b.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
          b.rotation.y = -a;
          spin.add(b);
        }
        horn.add(at(shape(cyl(0.3, 0.32, 0.12, 14), main), 0, 0.02, 0)); // chuck
        horn.position.set(0, 0.56, -0.12);
        horn.rotation.x = -Math.PI / 2 + 0.12;
      } else if (look === 3) {
        // Gavel: a stout handle ending in a crosswise mallet head with brass bands.
        const wood = mat(0x9a6a43);
        const iron = mat(0x5a626d);
        const brass = mat(0xd9a84a);
        horn.add(seg(V(0, 0, 0.02), V(0, 0.1, -0.5), 0.08, wood, 0.065));
        horn.add(at(new THREE.Mesh(torus(0.085, 0.025), brass), 0, 0.01, -0.06)); // ferrule
        const head = new THREE.Group();
        head.position.set(0, 0.12, -0.6);
        head.add(shape(cyl(0.16, 0.16, 0.5, 16), iron).rotateZ(Math.PI / 2));
        for (const d of [-1, 1]) {
          head.add(at(new THREE.Mesh(torus(0.165, 0.03), brass), 0.17 * d, 0, 0).rotateY(Math.PI / 2)); // bands
          head.add(at(shape(cyl(0.13, 0.13, 0.05, 16), steel, 0.02).rotateZ(Math.PI / 2), 0.27 * d, 0, 0)); // striking faces
        }
        horn.add(head);
        horn.position.set(0, 0.6, -0.04);
      } else {
        // Tesla prongs: two coiled rods with a spark jumping between the tips.
        for (const d of [-1, 1]) {
          horn.add(seg(V(0.17 * d, 0, 0), V(0.11 * d, 0.06, -0.72), 0.06, steel, 0.028));
          for (let i = 0; i < 4; i++) horn.add(at(new THREE.Mesh(torus(0.075 - i * 0.008, 0.022), main), (0.165 - i * 0.012) * d, 0.012 * i, -0.12 - i * 0.13));
          horn.add(at(shape(ball(0.05), steel, 0.02), 0.11 * d, 0.06, -0.74));
        }
        sparkMat = mat(0xfff7c2, { emissive: 0xffd21f });
        sparkOrb = new THREE.Mesh(ball(0.07), sparkMat);
        horn.add(at(sparkOrb, 0, 0.06, -0.74));
        horn.position.set(0, 0.58, -0.06);
      }
      root.add(horn);
      animate = ({ t, speed, attack }) => {
        if (look === 1) spin.rotation.y = t * (6 + speed * 18 + attack * 20);
        horn.position.z = (look === 1 ? -0.12 : -0.06) - attack * 0.12;
        if (look === 0) horn.rotation.x = -attack * 0.25;
        if (look === 3) horn.rotation.x = 0.14 + Math.sin(t * 1.5 + row) * 0.03 - attack * 0.6; // raised, then brought down hard
        if (sparkMat && sparkOrb) {
          // The spark flickers and jumps about between the prongs.
          sparkMat.emissiveIntensity = 0.6 + Math.abs(Math.sin(t * 23 + row)) * 0.7 + attack * 2;
          sparkOrb.scale.setScalar(0.7 + Math.abs(Math.sin(t * 17)) * 0.6 + attack);
          sparkOrb.position.x = Math.sin(t * 31) * 0.05;
        }
      };
      break;
    }

    case 'armor': {
      if (look === 0) {
        root.add(at(shape(cyl(0.56, 0.58, 0.36, 6), main), 0, 0.4, 0));
        root.add(at(shape(cyl(0.44, 0.5, 0.1, 6), light, 0.02), 0, 0.62, 0));
        root.add(at(shape(cyl(0.16, 0.18, 0.08, 6), dark, 0.02), 0, 0.7, 0));
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
          bolt(Math.cos(a) * 0.42, 0.6, Math.sin(a) * 0.42, 0.035);
        }
      } else if (look === 1) {
        const tile = mat(0xe9edf2);
        root.add(at(shape(rbox(1.0, 0.24, 1.0, 0.08), gun), 0, 0.34, 0));
        for (const sx of [-1, 1])
          for (const sz of [-1, 1]) root.add(at(shape(rbox(0.44, 0.16, 0.44, 0.07), tile, 0.025), 0.23 * sx, 0.52, 0.23 * sz));
        root.add(at(shape(rbox(0.22, 0.08, 0.22, 0.04), main, 0.02), 0, 0.62, 0));
      } else if (look === 2) {
        const stripeA = mat(0xf2c14e);
        const stripeB = mat(0x22252b);
        root.add(at(shape(rbox(1.0, 0.68, 1.0, 0.14), main), 0, 0.48, 0));
        root.add(at(shape(rbox(0.6, 0.12, 0.6, 0.06), light, 0.025), 0, 0.85, 0)); // raised boss
        // Hazard-striped bumper across the front.
        const bumper = new THREE.Group();
        for (let i = 0; i < 7; i++) bumper.add(at(new THREE.Mesh(rbox(0.15, 0.2, 0.3, 0.03), i % 2 ? stripeB : stripeA), -0.45 + i * 0.15, 0, 0));
        bumper.add(at(new THREE.Mesh(rbox(1.08, 0.22, 0.26, 0.06), OUTLINE), 0, 0, 0.03));
        root.add(at(bumper, 0, 0.46, -0.45));
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) bolt(0.36 * sx, 0.83, 0.36 * sz, 0.06);
      } else if (look === 4) {
        // Thornback: a mossy plate bristling with short, green-tipped thorns on dark bosses.
        const bark = mat(0x4c5946);
        const thorn = mat(0xa6e36c, { emissive: 0x1c3a0a });
        root.add(at(shape(rbox(1.0, 0.28, 1.0, 0.1), bark), 0, 0.36, 0));
        root.add(at(shape(rbox(0.86, 0.08, 0.86, 0.04), dark, 0.02), 0, 0.53, 0));
        const spines: THREE.Object3D[] = [];
        const spots: [number, number, number][] = [
          [0, 0, 1.2],
          [-0.3, -0.3, 0.9],
          [0.3, -0.3, 1],
          [-0.3, 0.3, 1],
          [0.3, 0.3, 0.9],
          [0, -0.34, 0.8],
          [0, 0.34, 0.85],
          [-0.34, 0, 0.8],
          [0.34, 0, 0.85],
        ];
        for (const [x, z, sc] of spots) {
          root.add(at(shape(ball(0.07), gun, 0.02), x, 0.57, z));
          const sp = shape(cone(0.06, 0.24, 6), thorn, 0.02);
          aim(sp, V(x * 0.7, 1, z * 0.7));
          sp.scale.setScalar(sc);
          root.add(at(sp, x, 0.56 + 0.11 * sc, z));
          spines.push(sp);
        }
        const base = spines.map((sp) => sp.position.clone());
        animate = ({ t, attack }) =>
          spines.forEach((sp, i) => {
            // A springy quiver, and a jab outward when struck.
            const k = Math.sin(t * 9 + i * 1.7 + row) * 0.012 + Math.max(0, attack) * 0.08;
            sp.position.copy(base[i]).addScaledVector(UP, k);
          });
      } else {
        // Mirage plate: a dark slab studded with light-bending crystal facets.
        root.add(at(shape(rbox(1.0, 0.26, 1.0, 0.09), gun), 0, 0.35, 0));
        const facets = [mat(0x9ff3ee, { emissive: 0x1e9c95 }), mat(0xd7b8ff, { emissive: 0x7044c4 }), mat(0xbfe6ff, { emissive: 0x2f7fc0 })];
        const gem = geo('mirage', () => new THREE.OctahedronGeometry(0.24, 0).scale(1, 0.55, 1));
        const spots: [number, number, number][] = [
          [-0.24, -0.24, 1.1],
          [0.24, -0.22, 0.9],
          [0, 0.02, 1.35],
          [-0.26, 0.26, 0.95],
          [0.26, 0.26, 1.05],
        ];
        spots.forEach(([x, z, sc], i) => {
          const f = shape(gem, facets[i % 3], 0.02);
          f.scale.setScalar(sc);
          f.rotation.y = i * 0.9;
          root.add(at(f, x, 0.56 + (sc - 0.9) * 0.08, z));
        });
        animate = ({ t }) => facets.forEach((m, i) => (m.emissiveIntensity = 0.55 + Math.sin(t * 2.2 + i * 2.1 + row) * 0.45)); // shimmer
      }
      break;
    }

    case 'core': {
      const hot = look === 1 ? new THREE.Color(0xff9a3d) : look === 2 ? new THREE.Color(0x4f9dff) : baseColor;
      root.add(at(shape(cyl(0.44, 0.48, 0.22, 14), gun), 0, 0.3, 0));
      root.add(at(new THREE.Mesh(torus(0.4, 0.04), steel), 0, 0.42, 0).rotateX(Math.PI / 2));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) root.add(seg(V(0.29 * sx, 0.4, 0.29 * sz), V(0.27 * sx, 0.98, 0.27 * sz), 0.035, steel, 0.03, 0.02));
      root.add(at(shape(torus(0.31, 0.05), gun, 0.02).rotateX(Math.PI / 2), 0, 1.0, 0)); // open cap ring
      const glass = mat(look === 2 ? 0xe3f0ff : 0xe8fff4, { transparent: true, opacity: 0.25 });
      root.add(at(new THREE.Mesh(cyl(0.3, 0.3, 0.56, 16), glass), 0, 0.71, 0));
      const glow = mat(hot.clone().lerp(new THREE.Color(0xffffff), 0.25), { emissive: hot });
      let crystal: THREE.Object3D;
      if (look === 2) {
        // Lodestone: a horseshoe magnet (red body, silver poles) hanging in a soft blue field.
        const red = mat(0xe0443e);
        const pole = mat(0xe6ecf3, { rim: 0.6 });
        crystal = new THREE.Group();
        crystal.add(at(shape(torus(0.15, 0.07, Math.PI), red, 0.02), 0, 0.04, 0));
        for (const d of [-1, 1]) {
          crystal.add(at(shape(cyl(0.07, 0.07, 0.1, 10), red, 0.02), 0.15 * d, -0.01, 0));
          crystal.add(at(shape(cyl(0.071, 0.071, 0.1, 10), pole, 0.02), 0.15 * d, -0.11, 0));
        }
        root.add(at(new THREE.Mesh(ball(0.24), mat(0x9fd0ff, { emissive: 0x2f7fff, transparent: true, opacity: 0.3 })), 0, 0.7, 0)); // field haze
      } else {
        crystal = shape(
          geo(`gem:${look}`, () => (look === 1 ? new THREE.IcosahedronGeometry(0.2, 0) : new THREE.OctahedronGeometry(0.22, 0))),
          glow,
          0.025,
        );
      }
      root.add(crystal);
      const rings = [0, 1].slice(0, look === 1 ? 2 : 1).map(() => {
        const halo = new THREE.Mesh(torus(0.27, 0.022), glow);
        root.add(halo);
        return halo;
      });
      animate = ({ t }) => {
        crystal.position.y = 0.7 + Math.sin(t * 3 + row) * 0.04;
        // (The magnet sways on the spot, poles down, rather than spinning.)
        crystal.rotation.y = look === 2 ? -0.75 + Math.sin(t * 1.2 + row) * 0.45 : t * 1.5;
        if (look === 2) crystal.rotation.x = 0.5; // leaning back, poles to the front
        rings.forEach((h, i) => {
          h.position.y = 0.7;
          h.rotation.set(Math.PI / 2 + Math.sin(t * 2 + i * 2) * 0.5, t * (1 + i), i * 1.2);
        });
        glow.emissiveIntensity = 0.8 + Math.sin(t * 6 + row) * 0.3;
      };
      break;
    }

    case 'sensor': {
      root.add(at(shape(rbox(0.44, 0.22, 0.44, 0.1), dark), 0, 0.42, 0));
      root.add(at(shape(cyl(0.14, 0.18, 0.1, 12), gun, 0.02), 0, 0.57, 0));
      if (look === 0) {
        const tipMat = mat(0xd8ecff, { emissive: 0x4f8fff });
        const stalks: { g: THREE.Group; d: number }[] = [];
        for (const d of [-1, 1]) {
          const stalk = new THREE.Group();
          stalk.position.set(0.08 * d, 0.6, -0.02);
          // Beaded, gently curved insect antenna.
          const n = 8;
          const pts = Array.from({ length: n }, (_, i) => {
            const k = i / (n - 1);
            return V((0.04 + k * 0.28) * d, Math.sin(k * 1.9) * 0.62, -k * 0.5);
          });
          stalk.add(chain(pts, 0.035, 0.018, main, 0.02));
          pts.forEach((p, i) => i % 2 && stalk.add(at(new THREE.Mesh(ball(0.05 - i * 0.004), light), p.x, p.y, p.z)));
          stalk.add(at(new THREE.Mesh(ellip(0.06, 0.05, 0.09), tipMat), 0.33 * d, 0.6, -0.54));
          root.add(stalk);
          stalks.push({ g: stalk, d });
        }
        animate = ({ t, speed }) => {
          stalks.forEach(({ g, d }) => {
            // Swept back by speed, with a springy twitch at the tips.
            g.rotation.x = Math.sin(t * 2.1 + d + row) * 0.12 + speed * 0.4 + Math.sin(t * 9 + d) * 0.03 * speed;
            g.rotation.z = Math.sin(t * 1.5 + d * 2) * 0.1;
          });
          tipMat.emissiveIntensity = 0.6 + Math.sin(t * 3 + row) * 0.4;
        };
      } else if (look === 2) {
        // Beacon: one tall stalk carrying a caged yellow lamp with a turning reflector.
        root.add(seg(V(0, 0.6, 0), V(0, 1.0, 0), 0.045, steel));
        root.add(at(new THREE.Mesh(torus(0.06, 0.02), dark), 0, 0.8, 0).rotateX(Math.PI / 2)); // collar
        const lamp = mat(0xfff3a6, { emissive: 0xffbe1a });
        const head = new THREE.Group();
        head.position.y = 1.02;
        head.add(shape(cyl(0.13, 0.15, 0.06, 14), gun, 0.02)); // base
        head.add(at(shape(cyl(0.06, 0.08, 0.16, 12), lamp, 0.02), 0, 0.12, 0)); // bulb
        head.add(at(new THREE.Mesh(ball(0.06), lamp), 0, 0.2, 0));
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          head.add(seg(V(Math.cos(a) * 0.12, 0.02, Math.sin(a) * 0.12), V(Math.cos(a) * 0.12, 0.27, Math.sin(a) * 0.12), 0.015, steel, 0.015, 0)); // cage bars
        }
        head.add(at(shape(cone(0.16, 0.1, 14), gun, 0.02), 0, 0.32, 0)); // hood
        head.add(at(new THREE.Mesh(ball(0.03), steel), 0, 0.38, 0));
        const reflector = new THREE.Group();
        reflector.position.y = 0.14;
        // A half-shell mirror behind the bulb that swings the light round.
        reflector.add(new THREE.Mesh(geo('beacon-shell', () => new THREE.CylinderGeometry(0.1, 0.1, 0.2, 12, 1, true, 0, Math.PI)), mat(0xc0c8d2, { side: THREE.DoubleSide })));
        head.add(reflector);
        root.add(head);
        animate = ({ t }) => {
          reflector.rotation.y = t * 4 + row;
          // Two quick blinks per sweep.
          lamp.emissiveIntensity = 0.5 + (Math.sin(t * 8 + row) > 0.6 ? 1.3 : 0) + Math.max(0, Math.sin(t * 4 + row)) * 0.3;
        };
      } else {
        root.add(seg(V(0, 0.6, 0), V(0, 0.92, 0), 0.05, steel));
        const dish = new THREE.Group();
        dish.position.y = 0.98;
        // Parabolic dish (lathe), feed horn and a blinking lamp.
        const bowlGeo = geo('dish', () => {
          const pts: THREE.Vector2[] = [];
          for (let i = 0; i <= 8; i++) {
            const x = 0.02 + (i / 8) * 0.36;
            pts.push(new THREE.Vector2(x, x * x * 1.3));
          }
          return new THREE.LatheGeometry(pts, 18);
        });
        const bowl = new THREE.Group();
        bowl.add(new THREE.Mesh(bowlGeo, mat(baseColor, { side: THREE.DoubleSide })));
        bowl.add(at(new THREE.Mesh(torus(0.38, 0.025), light), 0, 0.18, 0).rotateX(Math.PI / 2));
        bowl.add(seg(V(0, 0, 0), V(0, 0.28, 0), 0.02, steel, 0.02, 0));
        bowl.rotation.x = -Math.PI / 2 + 0.55;
        dish.add(bowl);
        const lamp = mat(0xffffff, { emissive: 0x7fb3ff });
        const lampMesh = at(new THREE.Mesh(ball(0.05), lamp), 0, 0.24, -0.14);
        dish.add(lampMesh);
        root.add(dish);
        animate = ({ t }) => {
          dish.rotation.y = t * 1.8 + row;
          lamp.emissiveIntensity = Math.sin(t * 8) > 0 ? 1.5 : 0.25;
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
