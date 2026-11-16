/**
 * Chunky voxel-style part models: toon shading with an inverted-hull outline.
 * All shapes are built from primitives, no external assets.
 */
import * as THREE from 'three';

import { CATEGORY_COLOR, type Category } from '@/game/parts';

const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x111318, side: THREE.BackSide });

let gradient: THREE.DataTexture | null = null;
function toonGradient() {
  if (!gradient) {
    const data = new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]);
    gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

export function toonMaterial(color: THREE.ColorRepresentation, opts: { emissive?: THREE.ColorRepresentation; transparent?: boolean; opacity?: number } = {}) {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: toonGradient(),
    emissive: opts.emissive ?? 0x000000,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  });
}

/** A toon mesh plus its black outline shell. */
export function toonMesh(geo: THREE.BufferGeometry, mat: THREE.Material, outline = 0.06) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(geo, mat);
  g.add(m);
  if (outline > 0) {
    const o = new THREE.Mesh(geo, OUTLINE);
    o.scale.setScalar(1 + outline * 2);
    g.add(o);
  }
  return g;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

export type PartModel = {
  root: THREE.Group;
  /** The material to tint for hit flashes and wear. */
  mat: THREE.MeshToonMaterial;
  base: THREE.Color;
  /** Optional idle animation (time, attack pulse 0..1). */
  animate?: (t: number) => void;
};

/**
 * Build the model for a part. Local space: −z is the bug's front, +y up,
 * one grid cell = 1 unit. `side` is −1/0/+1 for parts left/centre/right of the spine.
 */
export function buildPart(category: Category, side: number): PartModel {
  const base = new THREE.Color(CATEGORY_COLOR[category]);
  const mat = toonMaterial(base);
  const root = new THREE.Group();
  const dark = toonMaterial(new THREE.Color(CATEGORY_COLOR[category]).multiplyScalar(0.55));
  let animate: PartModel['animate'];

  switch (category) {
    case 'head': {
      root.add(toonMesh(box(0.86, 0.7, 0.86), mat).translateY(0.5));
      const eyeMat = toonMaterial(0x1b1f27, { emissive: 0x2a8cff });
      for (const sx of [-0.22, 0.22]) {
        const eye = toonMesh(box(0.22, 0.2, 0.08), eyeMat, 0.03);
        eye.position.set(sx, 0.62, -0.45);
        root.add(eye);
      }
      break;
    }
    case 'thorax':
      root.add(toonMesh(box(0.94, 0.8, 0.94), mat).translateY(0.5));
      root.add(toonMesh(box(0.6, 0.12, 0.6), dark, 0.04).translateY(0.96));
      break;
    case 'abdomen': {
      root.add(toonMesh(box(0.9, 0.62, 0.92), mat).translateY(0.42));
      const stripe = toonMesh(box(0.92, 0.14, 0.2), dark, 0.03);
      stripe.position.set(0, 0.5, 0.15);
      root.add(stripe);
      break;
    }
    case 'legs': {
      root.add(toonMesh(box(0.42, 0.36, 0.42), mat).translateY(0.42));
      const dirs = side === 0 ? [-1, 1] : [side];
      const legs: THREE.Group[] = [];
      for (const d of dirs) {
        for (const dz of [-0.22, 0.22]) {
          const leg = new THREE.Group();
          const upper = toonMesh(box(0.55, 0.12, 0.12), dark, 0.04);
          upper.position.set(0.28 * d, 0.1, 0);
          upper.rotation.z = 0.5 * d;
          const lower = toonMesh(box(0.12, 0.45, 0.12), dark, 0.04);
          lower.position.set(0.55 * d, -0.1, 0);
          leg.add(upper, lower);
          leg.position.set(0, 0.42, dz);
          root.add(leg);
          legs.push(leg);
        }
      }
      animate = (t) => legs.forEach((l, i) => (l.position.y = 0.42 + Math.sin(t * 14 + i * 1.7) * 0.05));
      break;
    }
    case 'wings': {
      const wingMat = toonMaterial(base, { transparent: true, opacity: 0.75 });
      const pivot = new THREE.Group();
      const wing = toonMesh(box(1.3, 0.05, 0.75), wingMat, 0.03);
      wing.position.x = 0.55 * (side || 1);
      pivot.add(wing);
      pivot.position.y = 0.95;
      root.add(pivot);
      root.add(toonMesh(box(0.3, 0.3, 0.3), dark, 0.04).translateY(0.8));
      animate = (t) => (pivot.rotation.z = Math.sin(t * 40) * 0.35 * (side || 1));
      break;
    }
    case 'mandibles': {
      const jaws: THREE.Group[] = [];
      for (const d of [-1, 1]) {
        const pivot = new THREE.Group();
        const jaw = toonMesh(box(0.18, 0.2, 0.7), mat, 0.05);
        jaw.position.set(0, 0, -0.3);
        const tip = toonMesh(box(0.28, 0.2, 0.14), mat, 0.05);
        tip.position.set(-0.08 * d, 0, -0.62);
        pivot.add(jaw, tip);
        pivot.position.set(0.24 * d, 0.45, 0.2);
        root.add(pivot);
        jaws.push(pivot);
      }
      animate = (t) => jaws.forEach((j, i) => (j.rotation.y = (i === 0 ? -1 : 1) * (0.25 + Math.max(0, Math.sin(t * 5)) * 0.35)));
      break;
    }
    case 'stinger': {
      const cone = new THREE.ConeGeometry(0.22, 0.95, 6);
      const s = toonMesh(cone, mat);
      s.rotation.x = -Math.PI / 2;
      s.position.set(0, 0.5, -0.25);
      root.add(s);
      root.add(toonMesh(box(0.5, 0.4, 0.5), dark, 0.04).translateY(0.45).translateZ(0.2));
      break;
    }
    case 'pincers': {
      for (const d of [-1, 1]) {
        const arm = toonMesh(box(0.2, 0.22, 0.6), mat, 0.05);
        arm.position.set(0.3 * d, 0.45, -0.1);
        const claw = toonMesh(box(0.42, 0.24, 0.2), mat, 0.05);
        claw.position.set(0.17 * d, 0.45, -0.45);
        root.add(arm, claw);
      }
      break;
    }
    case 'horn': {
      const cone = new THREE.ConeGeometry(0.3, 1.05, 4);
      const h = toonMesh(cone, mat);
      h.rotation.x = -Math.PI / 2 - 0.25;
      h.position.set(0, 0.62, -0.3);
      root.add(h);
      root.add(toonMesh(box(0.6, 0.45, 0.6), dark, 0.04).translateY(0.4));
      break;
    }
    case 'armor':
      root.add(toonMesh(box(1.0, 0.55, 1.0), mat).translateY(0.42));
      root.add(toonMesh(box(0.7, 0.1, 0.7), dark, 0.03).translateY(0.74));
      break;
    case 'core': {
      root.add(toonMesh(box(0.8, 0.3, 0.8), dark).translateY(0.25));
      const glowMat = toonMaterial(base, { emissive: base.clone().multiplyScalar(0.8) });
      const cell = toonMesh(box(0.5, 0.5, 0.5), glowMat, 0.05);
      cell.position.y = 0.65;
      root.add(cell);
      animate = (t) => {
        cell.rotation.y = t * 1.5;
        glowMat.emissiveIntensity = 0.6 + Math.sin(t * 6) * 0.4;
      };
      break;
    }
    case 'sensor': {
      root.add(toonMesh(box(0.4, 0.3, 0.4), dark, 0.04).translateY(0.3));
      for (const d of [-1, 1]) {
        const stalk = toonMesh(new THREE.CylinderGeometry(0.04, 0.04, 0.8, 5), mat, 0.04);
        stalk.position.set(0.12 * d, 0.75, -0.15);
        stalk.rotation.x = -0.5;
        stalk.rotation.z = -0.3 * d;
        const ball = toonMesh(new THREE.SphereGeometry(0.1, 8, 6), mat, 0.05);
        ball.position.set(0.25 * d, 1.08, -0.38);
        root.add(stalk, ball);
      }
      break;
    }
  }
  return { root, mat, base, animate };
}
