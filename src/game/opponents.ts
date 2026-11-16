import type { Build, Placement } from './build';
import type { Rarity } from './parts';

/**
 * Build a placement list from an ASCII layout. Each row is GRID_W chars.
 * Legend maps a char to a part id; '.' is empty.
 */
export function fromLayout(rows: string[], legend: Record<string, string>): Placement[] {
  const out: Placement[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== '.' && legend[ch]) out.push({ x, y, partId: legend[ch] });
    });
  });
  return out;
}

export type ArenaId = 'pit' | 'foundry' | 'hive';

export type Opponent = {
  name: string;
  blurb: string;
  arena: ArenaId;
  /** Highest rarity this tier can award. */
  rewardTier: Rarity;
  aggression: number;
  build: Build;
};

const L = {
  H: 'head-scout',
  V: 'head-visor',
  T: 'thorax-tin',
  B: 'thorax-chitin',
  A: 'abdomen-tin',
  K: 'abdomen-tank',
  l: 'legs-spindle',
  s: 'legs-strider',
  g: 'legs-crawler',
  w: 'wings-foil',
  G: 'wings-glass',
  m: 'mand-gnash',
  M: 'mand-shear',
  d: 'sting-dart',
  p: 'pinc-clamp',
  P: 'pinc-vise',
  h: 'horn-nub',
  D: 'horn-drill',
  r: 'armor-hex',
  c: 'armor-ceramic',
  X: 'armor-aegis',
  o: 'core-cell',
  O: 'core-fusion',
  e: 'sensor-antenna',
};

export const STARTER_BUILD: Build = {
  name: 'Sprocket',
  placements: fromLayout(['.rmr.', '.lHl.', '.oT..', '.lAl.'], L),
};

export const OPPONENTS: Opponent[] = [
  {
    name: 'Rustmite',
    blurb: 'A wobbly scrap crawler. Good for warming up.',
    arena: 'pit',
    rewardTier: 'uncommon',
    aggression: 0.5,
    build: { name: 'Rustmite', placements: fromLayout(['..m..', '.lHl.', '.lTo.', '..A..'], L) },
  },
  {
    name: 'Needlewisp',
    blurb: 'A flitting dart-spitter that keeps its distance.',
    arena: 'pit',
    rewardTier: 'rare',
    aggression: 0.35,
    build: { name: 'Needlewisp', placements: fromLayout(['..d..', '.eHe.', '.wTw.', '.lAl.', '.oAo.', '..d..'], L) },
  },
  {
    name: 'Snapclaw',
    blurb: 'Wide pincers and a stubborn shell.',
    arena: 'foundry',
    rewardTier: 'uncommon',
    aggression: 0.7,
    build: { name: 'Snapclaw', placements: fromLayout(['.pHp.', '.rTr.', '.lTl.', '.lAo.'], L) },
  },
  {
    name: 'Ironback',
    blurb: 'Slow, plated, and it hits like a press.',
    arena: 'foundry',
    rewardTier: 'rare',
    aggression: 0.8,
    build: { name: 'Ironback', placements: fromLayout(['.PhP.', 'rBVBr', 'sBOBs', '.KKK.', '.s.s.'], L) },
  },
  {
    name: 'Queen Vexa',
    blurb: 'Hive champion. Drill horn, shear jaws, glass wings.',
    arena: 'hive',
    rewardTier: 'epic',
    aggression: 0.9,
    build: {
      name: 'Queen Vexa',
      placements: fromLayout(['.MDM.', 'cBVBc', 'GBOBG', 'gKoKg', '.g.g.'], L),
    },
  },
];

/** Parts every new player owns. */
export const STARTER_INVENTORY: Record<string, number> = {
  'head-scout': 1,
  'thorax-tin': 2,
  'abdomen-tin': 1,
  'legs-spindle': 4,
  'mand-gnash': 1,
  'pinc-clamp': 1,
  'armor-hex': 2,
  'core-cell': 1,
  'sensor-antenna': 1,
};
