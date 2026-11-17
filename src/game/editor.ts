/**
 * Garage editing helpers (pure): auto-attach a new part to a sensible slot,
 * move/swap parts, remove parts.
 */
import { GRID_H, GRID_W, key, type Placement } from './build';
import { getPart, isBody, type Category } from './parts';

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

/** How much a part of this category likes a given empty cell (higher = better). */
function preference(c: Category, x: number, y: number, bodyTop: number, bodyMidY: number): number {
  const side = Math.abs(x - MID);
  switch (c) {
    case 'head':
      return -side * 10 - y * 3;
    case 'thorax':
    case 'abdomen':
      return -side * 10 + (c === 'abdomen' ? y : -Math.abs(y - bodyMidY));
    case 'mandibles':
    case 'pincers':
    case 'horn':
    case 'stinger':
      return -y * 6 - side * 2 + (y <= bodyTop ? 4 : 0);
    case 'legs':
    case 'wings':
      return side * 6 - Math.abs(y - bodyMidY) * 2;
    case 'armor':
      return side * 3 - y;
    case 'core':
    case 'sensor':
      return -side * 2 - Math.abs(y - bodyMidY);
  }
}

/** Best empty slot for a new part: touching the existing build, in a spot that suits its category. */
export function autoPlace(placements: Placement[], partId: string): Placement | null {
  const c = getPart(partId).category;
  const taken = new Set(placements.map((p) => key(p.x, p.y)));
  if (placements.length === 0) return { x: Math.round(MID), y: c === 'head' ? 1 : 2, partId };

  const body = placements.filter((p) => isBody(getPart(p.partId).category));
  const ys = (body.length ? body : placements).map((p) => p.y);
  const bodyTop = Math.min(...ys);
  const bodyMidY = ys.reduce((a, b) => a + b, 0) / ys.length;

  let best: { x: number; y: number; score: number } | null = null;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (taken.has(key(x, y))) continue;
      const touching = NEIGHBORS.some(([dx, dy]) => taken.has(key(x + dx, y + dy)));
      if (!touching) continue;
      const score = preference(c, x, y, bodyTop, bodyMidY);
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  return best ? { x: best.x, y: best.y, partId } : null;
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
