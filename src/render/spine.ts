/**
 * A bendy spine for a bug (cosmetic, renderer only). Each row of grid parts is
 * a segment; between neighbouring rows there's a springy joint. Turning makes
 * the rear segments lag and swing out (and the front lead a little), walking
 * adds a side-to-side sway and an up-and-down ripple that travels down the
 * body, and hits knock the joints so the body wobbles.
 *
 * Pose space: −z is the front; rows are distinct z values of the part rest spots.
 */
const K = 55; // joint stiffness (1/s²)
const D = 7.5; // joint damping (1/s)
const LAG = 0.085; // rear bend per rad/s of turning
const LEAD = 0.03; // front bend per rad/s of turning
const MAX_BEND = 0.42; // radians per joint

type Joint = { z: number; b: number; vb: number; behind: boolean; k: number };

export class Spine {
  private rows: number[];
  private pivot: number;
  private joints: Joint[] = [];
  private walk = 0;
  private speed = 0;
  private air = 0;
  private t = 0;

  constructor(rowZs: number[], pivotZ: number) {
    this.rows = [...new Set(rowZs.map((z) => Math.round(z * 100) / 100))].sort((a, b) => a - b);
    const pz = Math.round(pivotZ * 100) / 100;
    this.pivot = Math.max(0, this.rows.indexOf(pz));
    for (let j = 0; j < this.rows.length - 1; j++) {
      const behind = j >= this.pivot;
      // Distance (in joints) from the pivot: outer joints swing more.
      const k = behind ? j - this.pivot + 1 : this.pivot - j;
      this.joints.push({ z: (this.rows[j] + this.rows[j + 1]) / 2, b: 0, vb: 0, behind, k });
    }
  }

  private rowOf(z: number) {
    let best = 0;
    for (let i = 1; i < this.rows.length; i++) if (Math.abs(this.rows[i] - z) < Math.abs(this.rows[best] - z)) best = i;
    return best;
  }

  /**
   * @param yawRate how fast the bug is turning (rad/s, the pose's rotation.y rate)
   * @param walk walk-cycle phase; @param speed 0..1; @param air 0..1 flying
   */
  update(dt: number, yawRate: number, walk: number, speed: number, air: number, t: number) {
    if (dt <= 0) return;
    this.walk = walk;
    this.speed = speed;
    this.air = air;
    this.t = t;
    const h = Math.min(dt, 0.05);
    for (const [j, jt] of this.joints.entries()) {
      // Turning: rear lags (bends against the turn), front leads; plus a walking sway.
      let target = jt.behind ? -yawRate * LAG : yawRate * LEAD;
      target += Math.sin(walk * 0.5 - j * 1.1) * 0.08 * speed * (jt.behind ? 1 : 0.5);
      target += Math.sin(t * 2.4 - j * 0.9) * 0.05 * air;
      target = Math.max(-MAX_BEND, Math.min(MAX_BEND, target));
      jt.vb += (K * (target - jt.b) - D * jt.vb) * h;
      jt.b = Math.max(-MAX_BEND * 1.4, Math.min(MAX_BEND * 1.4, jt.b + jt.vb * h));
    }
  }

  /** Knock the joint nearest pose-space z sideways (amount > 0 pushes that end toward +x), e.g. on a hit. */
  kick(z: number, amount: number) {
    let best: Joint | null = null;
    for (const j of this.joints) if (!best || Math.abs(j.z - z) < Math.abs(best.z - z)) best = j;
    // A positive bend swings the rear toward +x but the front toward −x.
    if (best) best.vb += best.behind ? amount : -amount;
  }

  /**
   * Where a rest spot (pose space x, z) ends up with the spine bent, plus the
   * extra yaw/pitch/lift for a part sitting there.
   */
  transform(x: number, z: number) {
    const k = this.rowOf(z);
    let px = x;
    let pz = z;
    let yaw = 0;
    // Apply the joints between this row and the pivot, outermost first.
    const order: number[] = [];
    if (k > this.pivot) for (let j = k - 1; j >= this.pivot; j--) order.push(j);
    else if (k < this.pivot) for (let j = k; j < this.pivot; j++) order.push(j);
    for (const j of order) {
      const jt = this.joints[j];
      const c = Math.cos(jt.b);
      const s = Math.sin(jt.b);
      const dz = pz - jt.z;
      const nx = px * c + dz * s;
      pz = -px * s + dz * c + jt.z;
      px = nx;
      yaw += jt.b;
    }
    // A ripple travelling from head to tail as it walks (and a slow swim in the air).
    const ph = this.walk - k * 0.9;
    const lift = Math.sin(ph) * 0.035 * this.speed + Math.sin(this.t * 2.4 - k * 0.8) * 0.04 * this.air;
    const pitch = Math.cos(ph) * 0.06 * this.speed;
    return { x: px, z: pz, lift, yaw, pitch };
  }
}
