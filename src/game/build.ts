import { getPart, type Category, type PartDef } from './parts';

export const GRID_W = 5;
export const GRID_H = 7;
export const MAX_MASS = 150;

/**
 * One part placed on the build grid. Row 0 is the front of the bug.
 * `z` is the layer: 0 (default) sits on the grid; 1 is stacked on top of the
 * grid part in the same cell; −1 is slung underneath it (see STACK_TOP/UNDER).
 */
export type Layer = -1 | 0 | 1;
/**
 * Which way a weapon points, in quarter turns clockwise seen from above:
 * 0 front (default), 1 right, 2 back, 3 left.
 */
export type Facing = 0 | 1 | 2 | 3;
export type Placement = { x: number; y: number; partId: string; z?: Layer; r?: Facing };
export type Build = { name: string; placements: Placement[] };

export type PlacedPart = { x: number; y: number; z?: Layer; r?: Facing; part: PartDef };

/** Directions each weapon may point. Anything not listed only faces forward. */
export const FACINGS: Partial<Record<Category, readonly Facing[]>> = {
  horn: [0, 1, 2, 3],
  stinger: [0, 1, 2, 3],
  pincers: [0, 1, 3],
};
export const facingsFor = (c: Category): readonly Facing[] => FACINGS[c] ?? [0];
export const FACING_NAMES = ['front', 'right', 'back', 'left'] as const;

/**
 * The way a part at (x, y) should point: straight out from the body (away from
 * the thorax), or the nearest direction it's allowed to face.
 */
export function outwardFacing(placements: Placement[], x: number, y: number, c: Category): Facing {
  const allowed = facingsFor(c);
  if (allowed.length === 1) return allowed[0];
  const core = placements.filter((p) => !p.z && ['thorax', 'abdomen', 'head'].includes(getPart(p.partId).category));
  const ref = core.length ? core : placements.filter((p) => !p.z);
  const cx = ref.reduce((a, p) => a + p.x, 0) / Math.max(1, ref.length);
  const cy = ref.reduce((a, p) => a + p.y, 0) / Math.max(1, ref.length);
  const dx = x - cx;
  const dy = y - cy;
  const side: Facing = dx > 0 ? 1 : 3;
  const want: Facing = Math.abs(dy) >= Math.abs(dx) && Math.abs(dy) > 0.01 ? (dy < 0 ? 0 : 2) : Math.abs(dx) > 0.01 ? side : 0;
  if (allowed.includes(want)) return want;
  if (want === 2 && Math.abs(dx) > 0.01 && allowed.includes(side)) return side;
  return allowed.includes(0) ? 0 : allowed[0];
}

/** Parts that can be stacked on top of another part. */
export const STACK_TOP: readonly Category[] = ['wings', 'sensor', 'core'];
/** Parts that can be slung underneath another part. */
export const STACK_UNDER: readonly Category[] = ['core'];
/** Parts that something can be stacked on / slung under. */
export const STACK_BASES: readonly Category[] = ['head', 'thorax', 'abdomen', 'armor'];

/** Can `part` go in layer `z` (±1) of a cell whose grid part is `base`? */
export const canStack = (part: Category, base: Category, z: Layer = 1) =>
  STACK_BASES.includes(base) && (z === 1 ? STACK_TOP.includes(part) : z === -1 ? STACK_UNDER.includes(part) : false);

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
  /** Extra critical-hit chance from sensors (0..1, added to the base chance). */
  crit: number;
  /** -1..1: positive means the right side pushes harder (bug drifts left). */
  thrustBias: number;
  /** Highest it can fly (world px); 0 = can't fly. Needs lots of wing lift for its weight. */
  maxAlt: number;
};

/** Key of a grid cell (layer 0). */
export const key = (x: number, y: number) => `${x},${y}`;
/** Key of a placed part, including its layer. */
export const pkey = (p: { x: number; y: number; z?: number }) =>
  p.z === 1 ? `${p.x},${p.y},top` : p.z === -1 ? `${p.x},${p.y},under` : `${p.x},${p.y}`;

export function resolve(placements: Placement[]): PlacedPart[] {
  return placements.map((p) => {
    const part = getPart(p.partId);
    const r = p.r && facingsFor(part.category).includes(p.r) ? p.r : 0;
    return { x: p.x, y: p.y, z: p.z ?? 0, r, part };
  });
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
  let crit = 0;
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
    crit += part.crit ?? 0;
    if (part.category === 'sensor') {
      reach += part.rarity === 'common' ? 0.1 : 0.2;
      crit += part.rarity === 'common' ? 0.04 : 0.07;
    }
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
    crit: Math.min(0.15, crit),
    thrustBias,
    maxAlt: flightCeiling(lift, mass),
  };
}

/** World px of altitude a bug can reach for a given wing lift and mass. */
export function flightCeiling(lift: number, mass: number) {
  if (mass <= 0) return 0;
  const k = lift / mass - 0.16;
  return k <= 0.02 ? 0 : Math.min(70, k * 230);
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
 * orthogonal neighbours, plus anything stacked on / slung under a part in that group.
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
    if (base && best.has(key(p.x, p.y)) && canStack(p.part.category, base.part.category, p.z)) out.add(pkey(p));
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
  const badStack = parts.filter(
    (p) => p.z && !(ground.get(key(p.x, p.y)) && canStack(p.part.category, ground.get(key(p.x, p.y))!.part.category, p.z)),
  );
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

// ── Parts across bugs ───────────────────────────────────────────────
// Every part you own can sit on one bug at a time: a bug can use what you own
// minus what your other bugs are using.

/** What bug `index` may use: everything owned minus what the other bugs use (can go negative). */
export function availableFor(inventory: Record<string, number>, bugs: { placements: Placement[] }[], index: number) {
  const out: Record<string, number> = { ...inventory };
  bugs.forEach((b, i) => {
    if (i !== index) for (const p of b.placements) out[p.partId] = (out[p.partId] ?? 0) - 1;
  });
  return out;
}

/** Parts bug `index` uses that it can't have because other bugs are using them: part id → how many. */
export function shortParts(inventory: Record<string, number>, bugs: { placements: Placement[] }[], index: number) {
  const avail = availableFor(inventory, bugs, index);
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(usage(bugs[index]?.placements ?? []))) {
    const over = n - Math.max(0, avail[id] ?? 0);
    if (over > 0) out[id] = over;
  }
  return out;
}

/** Ready to fight: a valid build, and none of its parts are claimed by another bug. */
export function bugReady(inventory: Record<string, number>, bugs: { placements: Placement[] }[], index: number) {
  const b = bugs[index];
  return !!b && validateBuild(b.placements).length === 0 && Object.keys(shortParts(inventory, bugs, index)).length === 0;
}

/** Plain-language problems for bug `index`: build errors first, then parts held by other bugs. */
export function bugProblems(inventory: Record<string, number>, bugs: (Build & { placements: Placement[] })[], index: number): string[] {
  const b = bugs[index];
  if (!b) return [];
  const out = validateBuild(b.placements);
  for (const [id, n] of Object.entries(shortParts(inventory, bugs, index))) {
    const holder = bugs.find((o, i) => i !== index && o.placements.some((p) => p.partId === id));
    out.push(`${n > 1 ? `${n}× ` : ''}${getPart(id).name} ${n > 1 ? 'are' : 'is'} on ${holder?.name || 'another bug'}`);
  }
  return out;
}

/** Keep only the placements that `avail` covers (in order); the rest are left off. */
export function fitToParts(placements: Placement[], avail: Record<string, number>) {
  const left = { ...avail };
  const kept: Placement[] = [];
  for (const p of placements) {
    if ((left[p.partId] ?? 0) <= 0) continue;
    left[p.partId]--;
    kept.push(p);
  }
  return { kept, dropped: placements.length - kept.length };
}
