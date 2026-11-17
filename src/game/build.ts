import { getPart, type Category, type PartDef } from './parts';

export const GRID_W = 5;
export const GRID_H = 7;
export const MAX_MASS = 150;

/**
 * One part placed on the build grid. Row 0 is the front of the bug.
 * `z` is the layer: 0 (default) sits on the grid; 1 is stacked on top of the
 * layer-0 part in the same cell (only STACKABLE parts, only on STACK_BASES).
 */
export type Placement = { x: number; y: number; partId: string; z?: 0 | 1 };
export type Build = { name: string; placements: Placement[] };

export type PlacedPart = { x: number; y: number; z?: 0 | 1; part: PartDef };

/** Parts that can be stacked on top of another part. */
export const STACKABLE: readonly Category[] = ['wings', 'sensor'];
/** Parts that something can be stacked on. */
export const STACK_BASES: readonly Category[] = ['head', 'thorax', 'abdomen', 'armor'];

export const canStack = (top: Category, base: Category) => STACKABLE.includes(top) && STACK_BASES.includes(base);

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

/** Key of a grid cell (layer 0). */
export const key = (x: number, y: number) => `${x},${y}`;
/** Key of a placed part, including its layer. */
export const pkey = (p: { x: number; y: number; z?: number }) => (p.z ? `${p.x},${p.y},top` : `${p.x},${p.y}`);

export function resolve(placements: Placement[]): PlacedPart[] {
  return placements.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0, part: getPart(p.partId) }));
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
 * Returns the set of part keys (see `pkey`) still structurally attached to the
 * bug: the largest group of grid parts that contains a thorax, linked through
 * orthogonal neighbours, plus anything stacked on a part in that group.
 * So a weapon bolted onto an armor plate falls off when that plate is destroyed,
 * and wings stacked on a thorax fall off when the thorax goes.
 */
export function connectedKeys(parts: PlacedPart[]): Set<string> {
  const ground = parts.filter((p) => !p.z);
  const byKey = new Map(ground.map((p) => [key(p.x, p.y), p]));
  const seen = new Set<string>();
  let best = new Set<string>();

  for (const start of ground) {
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
  const out = new Set(best);
  for (const p of parts) {
    if (!p.z) continue;
    const base = byKey.get(key(p.x, p.y));
    if (base && best.has(key(p.x, p.y)) && canStack(p.part.category, base.part.category)) out.add(pkey(p));
  }
  return out;
}

export function countCategory(parts: PlacedPart[], c: Category) {
  return parts.filter((p) => p.part.category === c).length;
}

export function validateBuild(placements: Placement[]): string[] {
  const parts = resolve(placements);
  const errors: string[] = [];
  const heads = countCategory(parts, 'head');
  if (heads !== 1) errors.push(heads === 0 ? 'Needs a head' : 'Only one head allowed');
  if (countCategory(parts, 'thorax') < 1) errors.push('Needs a middle body segment (a thorax)');
  if (countCategory(parts, 'core') < 1) errors.push('Needs a power core');

  const ground = new Map(parts.filter((p) => !p.z).map((p) => [key(p.x, p.y), p]));
  const badStack = parts.filter((p) => p.z && !(ground.get(key(p.x, p.y)) && canStack(p.part.category, ground.get(key(p.x, p.y))!.part.category)));
  if (badStack.length) errors.push(`${badStack[0].part.name} can't stack there`);

  const connected = connectedKeys(parts);
  const loose = parts.filter((p) => !connected.has(pkey(p)) && !badStack.includes(p));
  if (loose.length) errors.push(loose.length === 1 ? "1 part isn't touching the rest of the bug" : `${loose.length} parts aren't touching the rest of the bug`);

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
