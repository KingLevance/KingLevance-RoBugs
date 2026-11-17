/**
 * Garage editing helpers (pure): auto-attach a new part to a sensible slot,
 * move/swap parts, remove parts. Handles the stacking layer (z = 1).
 */
import { canStack, computeStats, GRID_H, GRID_W, key, MAX_MASS, resolve, type Layer, type Placement } from './build';
import { getPart, isBody, PARTS, type Category } from './parts';

const MID = (GRID_W - 1) / 2;
const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** A part's position: grid cell plus layer (1 = stacked on top, −1 = slung underneath). */
export type Slot = { x: number; y: number; z: Layer };

export const sameSlot = (a: Slot, b: Slot) => a.x === b.x && a.y === b.y && a.z === b.z;

export function partAt(placements: Placement[], x: number, y: number, z: Layer = 0) {
  return placements.find((p) => p.x === x && p.y === y && (p.z ?? 0) === z);
}

/** Can this part go in layer `z` (±1) of the cell at (x, y), with that slot free? */
export function stackSpot(placements: Placement[], partId: string, x: number, y: number, z: Layer = 1): boolean {
  const base = partAt(placements, x, y, 0);
  if (!base || partAt(placements, x, y, z)) return false;
  return canStack(getPart(partId).category, getPart(base.partId).category, z);
}

/**
 * Which layer a part dropped onto the grid part at (x, y) would go in, or null
 * if it can't stack there. Cores prefer underneath (protected); everything else goes on top.
 * A taken slot still counts (the drop swaps with what's there).
 */
export function dropLayer(placements: Placement[], partId: string, x: number, y: number): 1 | -1 | null {
  const base = partAt(placements, x, y, 0);
  if (!base) return null;
  const c = getPart(partId).category;
  const b = getPart(base.partId).category;
  const order: (1 | -1)[] = c === 'core' ? [-1, 1] : [1, -1];
  const allowed = order.filter((z) => canStack(c, b, z));
  return allowed.find((z) => !partAt(placements, x, y, z)) ?? allowed[0] ?? null;
}

export function inGrid(x: number, y: number) {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

type Ctx = {
  bodyTop: number;
  bodyMidY: number;
  /** Row of the head (or the front of the body if there's no head yet). */
  headY: number;
  /** Categories of the parts orthogonally next to a cell. */
  around: (x: number, y: number) => Category[];
  /** Legs + wings left of the spine minus right of it. */
  lean: number;
};

/** Score for stacking a part (row) on a base (column); compare with ground scores (~0–15). */
const STACK_FIT: Partial<Record<Category, Partial<Record<Category, number>>>> = {
  wings: { thorax: 16, abdomen: 9, armor: 2, head: -60 },
  sensor: { head: 16, armor: 4, thorax: 2, abdomen: -2 },
  core: { abdomen: 4, thorax: 3, armor: 2, head: -8 },
};
/** Same, for slinging a part underneath. */
const UNDER_FIT: Partial<Record<Category, Partial<Record<Category, number>>>> = {
  core: { thorax: 13, abdomen: 12, armor: 8, head: 4 },
};

const VALUABLE: Category[] = ['core', 'mandibles', 'pincers', 'stinger', 'legs'];

/** How much a part of this category likes a given empty cell (higher = better). */
function preference(c: Category, x: number, y: number, ctx: Ctx): number {
  const side = Math.abs(x - MID);
  const near = ctx.around(x, y);
  const touchesBody = near.some(isBody);
  switch (c) {
    case 'head':
      return -side * 10 - y * 3;
    case 'thorax':
      // Down the spine, behind the head, as close to it as possible.
      return -side * 10 - (y <= ctx.headY ? 20 : 0) - Math.abs(y - (ctx.headY + 1));
    case 'abdomen':
      return -side * 10 - (y <= ctx.headY ? 20 : 0) + y;
    case 'horn':
      return -y * 6 - side * 5 + (y < ctx.headY ? 4 : 0);
    case 'mandibles':
    case 'pincers':
    case 'stinger':
      return -y * 6 - side * 2 + (y < ctx.headY ? 4 : 0);
    case 'legs':
    case 'wings': {
      // On the sides, next to the body, and on whichever side has fewer so the bug stays balanced.
      const balance = x < MID ? -ctx.lean : x > MID ? ctx.lean : 0;
      return (side > 0 ? 6 : 0) + (touchesBody ? 3 : 0) - Math.abs(y - ctx.bodyMidY) * 2 + balance * 2 - (y <= ctx.headY ? 5 : 0);
    }
    case 'armor':
      // On the outside, in front of or beside something worth protecting.
      return side * 2 - y * 1.5 + near.filter((n) => VALUABLE.includes(n)).length * 3;
    case 'core':
      // On the spine at the rear keeps the sides free for legs; otherwise beside the body.
      return near.length * 2 + (touchesBody ? 3 : 0) + (side === 0 ? 4 : -side * 2) + y * 0.5 - (y <= ctx.headY ? 8 : 0);
    case 'sensor':
      // Beside the head.
      return -Math.abs(y - ctx.headY) * 2 - Math.abs(side - 1) * 3 + (touchesBody ? 1 : 0);
  }
}

/**
 * Every empty slot touching the build, best first, for a part of this kind.
 * Used for auto-attach and for the green "good spot" hints in the garage.
 */
export function rankSlots(placements: Placement[], partId: string): (Slot & { score: number })[] {
  const c = getPart(partId).category;
  if (placements.length === 0) return [{ x: Math.round(MID), y: c === 'head' ? 1 : 2, z: 0, score: 0 }];
  const ground = placements.filter((p) => !p.z);
  const byKey = new Map(ground.map((p) => [key(p.x, p.y), getPart(p.partId).category]));

  const body = ground.filter((p) => isBody(getPart(p.partId).category));
  const ys = (body.length ? body : ground).map((p) => p.y);
  const movers = ground.filter((p) => ['legs', 'wings'].includes(getPart(p.partId).category));
  const ctx: Ctx = {
    bodyTop: Math.min(...ys),
    headY: ground.find((p) => getPart(p.partId).category === 'head')?.y ?? Math.min(...ys),
    bodyMidY: ys.reduce((a, b) => a + b, 0) / ys.length,
    around: (x, y) => NEIGHBORS.map(([dx, dy]) => byKey.get(key(x + dx, y + dy))).filter((n): n is Category => !!n),
    lean: movers.filter((p) => p.x < MID).length - movers.filter((p) => p.x > MID).length,
  };

  const out: (Slot & { score: number })[] = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (byKey.has(key(x, y)) || ctx.around(x, y).length === 0) continue;
      out.push({ x, y, z: 0, score: preference(c, x, y, ctx) });
    }
  }
  // Stacking: wings belong on the thorax's back, antennae on the head, cores slung underneath.
  for (const b of ground) {
    const base = getPart(b.partId).category;
    for (const [z, table] of [
      [1, STACK_FIT],
      [-1, UNDER_FIT],
    ] as const) {
      if (!stackSpot(placements, partId, b.x, b.y, z)) continue;
      const fit = table[c]?.[base] ?? 0;
      if (fit > -50) out.push({ x: b.x, y: b.y, z, score: fit });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Best empty slot for a new part: touching the existing build, in a spot that suits its category. */
export function autoPlace(placements: Placement[], partId: string): Placement | null {
  const best = rankSlots(placements, partId)[0];
  if (!best) return null;
  return best.z ? { x: best.x, y: best.y, z: best.z, partId } : { x: best.x, y: best.y, partId };
}

const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3 } as const;

/**
 * Assemble a sensible, legal bug from an inventory: best head/body/core first,
 * then mirrored legs, weapons up front, armor, sensors and wings, for as long as
 * the power and weight budgets allow.
 */
export function autoBuild(inventory: Record<string, number>): Placement[] {
  const left = { ...inventory };
  const best = (cats: Category[]) =>
    PARTS.filter((p) => cats.includes(p.category) && (left[p.id] ?? 0) > 0).sort(
      (a, b) => RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity],
    )[0];

  let build: Placement[] = [];
  const fits = (next: Placement[]) => {
    const s = computeStats(resolve(next));
    return s.powerDraw <= s.powerSupply && s.mass <= MAX_MASS;
  };
  /** Add the best owned part of these kinds. `force` skips the budget check (frame parts). */
  const add = (cats: Category[], force = false) => {
    const part = best(cats);
    if (!part) return false;
    const spot = autoPlace(build, part.id);
    if (!spot) return false;
    const next = [...build, spot];
    if (!force && !fits(next)) return false;
    build = next;
    left[part.id]--;
    return true;
  };

  add(['head'], true);
  add(['thorax'], true);
  add(['abdomen'], true);
  add(['core'], true);
  const weapons: Category[] = ['mandibles', 'pincers', 'stinger', 'horn'];
  // Two of everything that should be mirrored; weapons and armor interleaved so neither starves.
  const plan: Category[][] = [
    ['legs'], ['legs'], weapons, ['core'], ['legs'], ['legs'], weapons, ['armor'], ['armor'],
    ['sensor'], ['wings'], ['wings'], weapons, ['armor'], ['armor'], ['core'], ['sensor'],
  ];
  for (const cats of plan) add(cats);
  // Legs and wings must come in pairs: drop an unmatched one.
  for (const c of ['legs', 'wings'] as Category[]) {
    const mine = build.filter((p) => getPart(p.partId).category === c);
    const l = mine.filter((p) => p.x < MID);
    const r = mine.filter((p) => p.x > MID);
    if (l.length !== r.length && mine.length > 1) {
      const extra = (l.length > r.length ? l : r).pop()!;
      build = build.filter((p) => p !== extra);
    }
  }
  return build;
}

/**
 * Drop the part at `from` onto grid cell `to`. Stackable parts dropped on a part
 * that accepts them go on top (swapping with anything already stacked there).
 * Otherwise parts swap on the grid, and stacked parts travel with their base.
 * Returns null if the drop isn't allowed.
 */
export function movePart(placements: Placement[], from: Slot, to: { x: number; y: number }): { placements: Placement[]; at: Slot } | null {
  const moving = partAt(placements, from.x, from.y, from.z);
  if (!moving) return null;
  const sameCell = from.x === to.x && from.y === to.y;

  // Stack on (or under) the part there? Swaps with anything already in that slot.
  const base = partAt(placements, to.x, to.y, 0);
  const layer = base && !sameCell ? dropLayer(placements.filter((p) => p !== moving), moving.partId, to.x, to.y) : null;
  if (layer) {
    const occupant = partAt(placements, to.x, to.y, layer);
    // The occupant takes the mover's old place, if it can go there.
    if (occupant && from.z) {
      const fromBase = partAt(placements, from.x, from.y, 0);
      if (!fromBase || !canStack(getPart(occupant.partId).category, getPart(fromBase.partId).category, from.z)) return null;
    }
    const at: Slot = { x: to.x, y: to.y, z: layer };
    const next = placements.map((p) => {
      if (p === moving) return { ...p, x: to.x, y: to.y, z: layer };
      if (p === occupant) return { ...p, x: from.x, y: from.y, z: from.z ? from.z : undefined };
      return p;
    });
    // (Stackable parts are never bases themselves, so `moving` carries nothing along.)
    return { placements: next, at };
  }

  if (sameCell) return from.z ? null : { placements, at: from };
  const at: Slot = { x: to.x, y: to.y, z: 0 };

  if (from.z) {
    // A stacked part coming down onto the grid: only into an empty cell.
    if (base) return null;
    return { placements: placements.map((p) => (p === moving ? { ...p, x: to.x, y: to.y, z: undefined } : p)), at };
  }

  // Grid part ↔ grid part swap; each takes its stacked part along.
  return {
    placements: placements.map((p) => {
      if (p.x === from.x && p.y === from.y) return { ...p, x: to.x, y: to.y };
      if (p.x === to.x && p.y === to.y) return { ...p, x: from.x, y: from.y };
      return p;
    }),
    at,
  };
}

/**
 * Remove a part. If it was a grid part, whatever was stacked on it drops into its
 * cell (the part on top first; a part slung underneath drops if the top was empty,
 * otherwise it goes back to the bin too).
 */
export function removeAt(placements: Placement[], slot: Slot): Placement[] {
  const target = partAt(placements, slot.x, slot.y, slot.z);
  let rest = placements.filter((p) => p !== target);
  if (slot.z) return rest;
  const top = partAt(rest, slot.x, slot.y, 1);
  const under = partAt(rest, slot.x, slot.y, -1);
  const drop = top ?? under;
  if (top && under) rest = rest.filter((p) => p !== under);
  return rest.map((p) => (p === drop ? { ...p, z: undefined } : p));
}

/** Flip a stacked part between on top and underneath (if it's allowed and the other slot is free). */
export function flipLayer(placements: Placement[], slot: Slot): { placements: Placement[]; at: Slot } | null {
  if (!slot.z) return null;
  const part = partAt(placements, slot.x, slot.y, slot.z);
  const base = partAt(placements, slot.x, slot.y, 0);
  const z = (slot.z === 1 ? -1 : 1) as Layer;
  if (!part || !base || partAt(placements, slot.x, slot.y, z)) return null;
  if (!canStack(getPart(part.partId).category, getPart(base.partId).category, z)) return null;
  return { placements: placements.map((p) => (p === part ? { ...p, z } : p)), at: { ...slot, z } };
}
