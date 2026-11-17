/**
 * Flexible joints: a little spring physics so a bug's parts sway, lag and
 * bounce instead of moving as one rigid block. Cosmetic only (renderer side,
 * never touches the sim).
 *
 * Each part hangs off its parent (the neighbour one step closer to the thorax,
 * or the part it's stacked on) through a damped spring. Every frame we measure
 * how each part's rest spot is accelerating in the world (the bug speeding up,
 * turning, flying, being knocked, being lifted by a move…) and push the spring
 * the other way, like inertia. A part's final displacement is its own spring
 * offset plus most of its parent's, so motion ripples out to the tips.
 */
import * as THREE from 'three';

import type { Category } from '@/game/parts';

/** How much each kind of part gives at its joint (0 = rigid). */
export const GIVE: Record<Category, number> = {
  thorax: 0.12,
  head: 0.45,
  abdomen: 0.6,
  legs: 0.75,
  wings: 1.1,
  sensor: 1.3,
  mandibles: 0.6,
  pincers: 0.6,
  stinger: 0.75,
  horn: 0.35,
  armor: 0.3,
  core: 0.55,
};

const STIFF = 210; // spring constant (1/s²): higher = snappier, less sway
const DAMP = 10; // damping (1/s): lower = more bounce
const CARRY = 0.8; // share of the parent's displacement a child inherits
const MAX_DISP = 0.38; // world units
const MAX_ACC = 260; // ignore teleports / first frames
const SUBSTEP = 1 / 120;

type Node = {
  root: THREE.Object3D;
  rest: THREE.Vector3;
  parent: number;
  give: number;
  off: THREE.Vector3;
  vel: THREE.Vector3;
  disp: THREE.Vector3;
  prevWorld: THREE.Vector3 | null;
  prevVel: THREE.Vector3;
  active: boolean;
};

const tmpW = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export class FlexRig {
  private nodes: Node[] = [];
  /** Parents before children. */
  private order: number[] = [];

  constructor(private pose: THREE.Object3D) {}

  /** Register a part. `rest` is its resting position in pose space; `parent` an earlier node index or −1. */
  add(root: THREE.Object3D, rest: THREE.Vector3, parent: number, give: number, depth: number) {
    this.nodes.push({
      root,
      rest: rest.clone(),
      parent,
      give: give * (1 + depth * 0.22),
      off: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      disp: new THREE.Vector3(),
      prevWorld: null,
      prevVel: new THREE.Vector3(),
      active: true,
    });
    return this.nodes.length - 1;
  }

  /** Call after all add()s: fixes the update order (parents first). */
  finalize() {
    const depth = (i: number): number => (this.nodes[i].parent < 0 ? 0 : 1 + depth(this.nodes[i].parent));
    this.order = this.nodes.map((_, i) => i).sort((a, b) => depth(a) - depth(b));
  }

  deactivate(i: number) {
    if (this.nodes[i]) this.nodes[i].active = false;
  }

  /** Current displacement of a part from its rest spot (pose space). */
  displacement(i: number) {
    return this.nodes[i]?.disp ?? tmpV.set(0, 0, 0);
  }

  /** Kick a part (pose-space direction, roughly world units/s). */
  impulse(i: number, dir: THREE.Vector3, strength: number) {
    const n = this.nodes[i];
    if (!n?.active) return;
    n.vel.addScaledVector(dir, strength * n.give);
    // The parent feels a bit of it too.
    if (n.parent >= 0) this.nodes[n.parent].vel.addScaledVector(dir, strength * 0.35 * this.nodes[n.parent].give);
  }

  update(dt: number) {
    if (dt <= 0) return;
    this.pose.updateWorldMatrix(true, false);
    this.pose.getWorldQuaternion(tmpQ).invert();

    for (const i of this.order) {
      const n = this.nodes[i];
      if (!n.active) continue;
      // How is this part's rest spot accelerating in the world?
      tmpW.copy(n.rest).applyMatrix4(this.pose.matrixWorld);
      if (!n.prevWorld) {
        n.prevWorld = tmpW.clone();
        continue;
      }
      tmpV.copy(tmpW).sub(n.prevWorld).divideScalar(dt);
      tmpA.copy(tmpV).sub(n.prevVel).divideScalar(dt);
      n.prevWorld.copy(tmpW);
      n.prevVel.copy(tmpV);
      if (tmpA.length() > MAX_ACC) tmpA.setLength(MAX_ACC);
      tmpA.applyQuaternion(tmpQ); // into pose space

      // Spring + damper, pushed against the acceleration (inertia).
      let left = Math.min(dt, 0.1);
      while (left > 1e-6) {
        const h = Math.min(SUBSTEP, left);
        left -= h;
        n.vel.x += (-STIFF * n.off.x - DAMP * n.vel.x - tmpA.x * n.give) * h;
        n.vel.y += (-STIFF * n.off.y - DAMP * n.vel.y - tmpA.y * n.give) * h;
        n.vel.z += (-STIFF * n.off.z - DAMP * n.vel.z - tmpA.z * n.give) * h;
        n.off.addScaledVector(n.vel, h);
      }

      // Inherit most of the parent's sway so it ripples out to the tips.
      n.disp.copy(n.off);
      const p = n.parent >= 0 ? this.nodes[n.parent] : null;
      if (p?.active) n.disp.addScaledVector(p.disp, CARRY);
      if (n.disp.length() > MAX_DISP) n.disp.setLength(MAX_DISP);

      n.root.position.copy(n.rest).add(n.disp);
      // Lean the part into its sway a little.
      n.root.rotation.x = n.disp.z * 0.9;
      n.root.rotation.z = -n.disp.x * 0.9;
    }
  }
}
