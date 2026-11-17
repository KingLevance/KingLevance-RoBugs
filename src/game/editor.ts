/**
 * Garage editing helpers (pure): auto-attach a new part to a sensible slot,
 * move/swap parts, remove parts.
 */
import { computeStats, GRID_H, GRID_W, key, MAX_MASS, resolve, type Placement } from './build';
import { getPart, isBody, PARTS, type Category } from './parts';

const MID = (GRID_W - 1) / 2;
const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export function partAt(placements: Placement[], x: number, y: number) {
  return placements.find((p) => p.x === x && p.y === y);
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
export function rankSlots(placements: Placement[], partId: string): { x: number; y: number; score: number }[] {
  const c = getPart(partId).category;
  if (placements.length === 0) return [{ x: Math.round(MID), y: c === 'head' ? 1 : 2, score: 0 }];
  const byKey = new Map(placements.map((p) => [key(p.x, p.y), getPart(p.partId).category]));

  const body = placements.filter((p) => isBody(getPart(p.partId).category));
  const ys = (body.length ? body : placements).map((p) => p.y);
  const movers = placements.filter((p) => ['legs', 'wings'].includes(getPart(p.partId).category));
  const ctx: Ctx = {
    bodyTop: Math.min(...ys),
    headY: placements.find((p) => getPart(p.partId).category === 'head')?.y ?? Math.min(...ys),
    bodyMidY: ys.reduce((a, b) => a + b, 0) / ys.length,
    around: (x, y) => NEIGHBORS.map(([dx, dy]) => byKey.get(key(x + dx, y + dy))).filter((n): n is Category => !!n),
    lean: movers.filter((p) => p.x < MID).length - movers.filter((p) => p.x > MID).length,
  };

  const out: { x: number; y: number; score: number }[] = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (byKey.has(key(x, y)) || ctx.around(x, y).length === 0) continue;
      out.push({ x, y, score: preference(c, x, y, ctx) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Best empty slot for a new part: touching the existing build, in a spot that suits its category. */
export function autoPlace(placements: Placement[], partId: string): Placement | null {
  const best = rankSlots(placements, partId)[0];
  return best ? { x: best.x, y: best.y, partId } : null;
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

/** Move the part at `from` to `to`, swapping with whatever is there. */
export function movePart(placements: Placement[], from: { x: number; y: number }, to: { x: number; y: number }): Placement[] {
  if (from.x === to.x && from.y === to.y) return placements;
  return placements.map((p) => {
    if (p.x === from.x && p.y === from.y) return { ...p, x: to.x, y: to.y };
    if (p.x === to.x && p.y === to.y) return { ...p, x: from.x, y: from.y };
    return p;
  });
}

export function removeAt(placements: Placement[], x: number, y: number): Placement[] {
  return placements.filter((p) => !(p.x === x && p.y === y));
}
