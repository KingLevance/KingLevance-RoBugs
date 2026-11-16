import { getPart, type Category, type PartDef } from './parts';

export const GRID_W = 5;
export const GRID_H = 7;
export const MAX_MASS = 150;

/** One part placed on the build grid. Row 0 is the front of the bug. */
export type Placement = { x: number; y: number; partId: string };
export type Build = { name: string; placements: Placement[] };

export type PlacedPart = { x: number; y: number; part: PartDef };

export type BugStats = {
  mass: number;
  powerSupply: number;
  powerDraw: number;
  thrust: number;
  lift: number;
  /** World px per second at full throttle. */
  topSpeed: number;
  /** Radians per second. */
  turnRate: number;
  totalHp: number;
  dps: number;
  /** Multiplier on weapon range from sensors. */
  reach: number;
  /** -1..1: positive means the right side pushes harder (bug drifts left). */
  thrustBias: number;
};

export const key = (x: number, y: number) => `${x},${y}`;

export function resolve(placements: Placement[]): PlacedPart[] {
  return placements.map((p) => ({ x: p.x, y: p.y, part: getPart(p.partId) }));
}

export function computeStats(parts: PlacedPart[]): BugStats {
  let mass = 0;
  let powerSupply = 0;
  let powerDraw = 0;
  let thrust = 0;
  let lift = 0;
  let grip = 1.2;
  let totalHp = 0;
  let dps = 0;
  let reach = 1;
  let left = 0;
  let right = 0;
  const midX = (GRID_W - 1) / 2;

  for (const { x, part } of parts) {
    mass += part.mass;
    if (part.power < 0) powerSupply += -part.power;
    else powerDraw += part.power;
    thrust += part.thrust ?? 0;
    lift += part.lift ?? 0;
    grip += part.grip ?? 0;
    totalHp += part.hp;
    if (part.weapon) dps += part.weapon.damage / part.weapon.cooldown;
    if (part.category === 'sensor') reach += part.rarity === 'common' ? 0.1 : 0.2;
    if (part.category === 'legs') {
      if (x < midX) left += part.thrust ?? 0;
      else if (x > midX) right += part.thrust ?? 0;
    }
  }

  const effMass = Math.max(mass * 0.6, mass - lift, 1);
  const topSpeed = Math.min(240, (thrust / effMass) * 60);
  const turnRate = Math.max(0.8, Math.min(5, (grip * 40) / effMass));
  const legTotal = left + right;
  const thrustBias = legTotal > 0 ? (right - left) / legTotal : 0;

  return {
    mass,
    powerSupply,
    powerDraw,
    thrust,
    lift,
    topSpeed,
    turnRate,
    totalHp,
    dps,
    reach: Math.min(1.4, reach),
    thrustBias,
  };
}

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * Returns the set of cell keys still structurally attached to the bug:
 * the largest connected group of parts that contains a thorax.
 * Parts link to any orthogonal neighbour, so a weapon bolted onto an
 * armor plate falls off when that plate is destroyed.
 */
export function connectedKeys(parts: PlacedPart[]): Set<string> {
  const byKey = new Map(parts.map((p) => [key(p.x, p.y), p]));
  const seen = new Set<string>();
  let best = new Set<string>();

  for (const start of parts) {
    const startKey = key(start.x, start.y);
    if (start.part.category !== 'thorax' || seen.has(startKey)) continue;
    const group = new Set<string>([startKey]);
    const queue = [startKey];
    seen.add(startKey);
    while (queue.length) {
      const [cx, cy] = queue.pop()!.split(',').map(Number);
      for (const [dx, dy] of NEIGHBORS) {
        const k = key(cx + dx, cy + dy);
        if (byKey.has(k) && !seen.has(k)) {
          seen.add(k);
          group.add(k);
          queue.push(k);
        }
      }
    }
    if (group.size > best.size) best = group;
  }
  return best;
}

export function countCategory(parts: PlacedPart[], c: Category) {
  return parts.filter((p) => p.part.category === c).length;
}

export function validateBuild(placements: Placement[]): string[] {
  const parts = resolve(placements);
  const errors: string[] = [];
  const heads = countCategory(parts, 'head');
  if (heads !== 1) errors.push(heads === 0 ? 'Needs a head' : 'Only one head allowed');
  if (countCategory(parts, 'thorax') < 1) errors.push('Needs at least one thorax');
  if (countCategory(parts, 'core') < 1) errors.push('Needs a power core');

  const connected = connectedKeys(parts);
  const loose = parts.filter((p) => !connected.has(key(p.x, p.y)));
  if (loose.length) errors.push(`${loose.length} part(s) not connected to a thorax`);

  const s = computeStats(parts);
  if (s.thrust <= 0) errors.push('Needs legs or wings to move');
  if (s.powerDraw > s.powerSupply) errors.push(`Over power budget (${s.powerDraw}/${s.powerSupply})`);
  if (s.mass > MAX_MASS) errors.push(`Over weight limit (${s.mass}/${MAX_MASS})`);
  return errors;
}

/** Count of each part id used by a build. */
export function usage(placements: Placement[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of placements) out[p.partId] = (out[p.partId] ?? 0) + 1;
  return out;
}
