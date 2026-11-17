/**
 * A whole bug as one display model (no grid, no physics): used by the hub's
 * showcase and the opponent portrait renderer. Same stacking rules as the
 * garage: grid parts, parts stacked on top, and cores slung underneath.
 */
import * as THREE from 'three';

import { GRID_W, type Placement } from '@/game/build';
import { getPart } from '@/game/parts';

import { adjacentPairs, buildConnector, buildPart, seatHeight, stackOffset, UNDER_LIFT, UNDER_SCALE, type AnimCtx, type PartModel } from './models';

export type BugModel = {
  root: THREE.Group;
  animate: (c: AnimCtx) => void;
  /** Radius of the bug's footprint (for framing). */
  radius: number;
};

export function buildBugModel(placements: Placement[]): BugModel {
  const root = new THREE.Group();
  const models: PartModel[] = [];
  if (!placements.length) return { root, animate: () => {}, radius: 1 };
  const cx = placements.reduce((a, p) => a + p.x, 0) / placements.length;
  const cy = placements.reduce((a, p) => a + p.y, 0) / placements.length;
  const midX = (GRID_W - 1) / 2;
  const pos = (x: number, y: number) => new THREE.Vector3(x - cx, 0, y - cy);
  const key = (x: number, y: number) => `${x},${y}`;

  const ground = placements.filter((p) => !p.z);
  const lifted = new Set(placements.filter((p) => p.z === -1).map((p) => key(p.x, p.y)));
  const lift = (p: Placement) => (lifted.has(key(p.x, p.y)) ? UNDER_LIFT : 0);
  for (const [i, j] of adjacentPairs(ground)) {
    const a = ground[i];
    const b = ground[j];
    const c = buildConnector(getPart(a.partId).category, getPart(b.partId).category);
    c.update(pos(a.x, a.y).setY(lift(a)), pos(b.x, b.y).setY(lift(b)));
    root.add(c.obj);
  }
  const tops = new Map<string, number>();
  for (const p of [...ground, ...placements.filter((q) => q.z)]) {
    const m = buildPart(p.partId, p.z ? 0 : Math.sign(p.x - midX), p.y);
    m.root.position.copy(pos(p.x, p.y));
    m.root.rotation.y = -(p.r ?? 0) * (Math.PI / 2); // weapon facing
    if (!p.z) {
      m.root.position.y = lift(p);
      tops.set(key(p.x, p.y), seatHeight(m) + lift(p));
    } else if (p.z === 1) {
      m.root.position.y = stackOffset(m, tops.get(key(p.x, p.y)) ?? 0.9);
    } else {
      m.root.scale.setScalar(UNDER_SCALE);
      m.root.position.y = 0.02;
    }
    root.add(m.root);
    models.push(m);
  }
  const radius = Math.max(...placements.map((p) => Math.hypot(p.x - cx, p.y - cy))) + 0.9;
  return {
    root,
    radius,
    animate: (c) => {
      for (const m of models) m.animate(c);
    },
  };
}
