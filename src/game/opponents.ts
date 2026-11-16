import type { Build, Placement } from './build';
import type { MoveId } from './moves';
import { PARTS, type Rarity } from './parts';

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

export const ARENA_NAMES: Record<ArenaId, string> = { pit: 'The Acid Pit', foundry: 'Stomper Foundry', hive: 'The Hive Ring' };

export type Reward = { kind: 'part' | 'move'; id: string };
export type LootEntry = { reward: Reward; weight: number };

export type Opponent = {
  id: string;
  name: string;
  blurb: string;
  arena: ArenaId;
  aggression: number;
  build: Build;
  moves: MoveId[];
  /** Bosses roll their loot table several times per win and are meant to be farmed. */
  boss: boolean;
  /** Given once, on first clear. */
  guaranteed: Reward[];
  /** Weighted, repeatable rolls on every win. */
  lootTable: LootEntry[];
  /** Campaign map: unlocked when ANY of these opponents is cleared (empty = open from the start). */
  unlockedBy: string[];
  /** Map position, 0..1 in both axes (y = 0 is the top of the map). */
  map: { x: number; y: number };
};

const part = (id: string): Reward => ({ kind: 'part', id });
const move = (id: MoveId): Reward => ({ kind: 'move', id });

const RARITY_WEIGHT: Record<Rarity, number> = { common: 50, uncommon: 30, rare: 15, epic: 6 };
const ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic'];

/** Every part up to `maxTier`, weighted by rarity. */
function tierTable(maxTier: Rarity): LootEntry[] {
  const hi = ORDER.indexOf(maxTier);
  return PARTS.filter((p) => ORDER.indexOf(p.rarity) <= hi).map((p) => ({ reward: part(p.id), weight: RARITY_WEIGHT[p.rarity] }));
}

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
    id: 'rustmite',
    name: 'Rustmite',
    blurb: 'A wobbly scrap crawler. Good for warming up.',
    arena: 'pit',
    aggression: 0.5,
    build: { name: 'Rustmite', placements: fromLayout(['..m..', '.lHl.', '.lTo.', '..A..'], L) },
    moves: [],
    boss: false,
    guaranteed: [move('carapace-lock'), part('armor-ceramic')],
    lootTable: tierTable('uncommon'),
    unlockedBy: [],
    map: { x: 0.5, y: 0.9 },
  },
  {
    id: 'needlewisp',
    name: 'Needlewisp',
    blurb: 'A flitting dart-spitter that keeps its distance.',
    arena: 'pit',
    aggression: 0.35,
    build: { name: 'Needlewisp', placements: fromLayout(['..d..', '.eHe.', '.wTw.', '.lAl.', '.oAo.', '..d..'], L) },
    moves: ['venom-barrage', 'skitter-dash'],
    boss: false,
    guaranteed: [part('sting-dart'), move('venom-barrage')],
    lootTable: [...tierTable('uncommon'), { reward: part('wings-foil'), weight: 40 }],
    unlockedBy: ['rustmite'],
    map: { x: 0.22, y: 0.66 },
  },
  {
    id: 'snapclaw',
    name: 'Snapclaw',
    blurb: 'Wide pincers and a stubborn shell.',
    arena: 'foundry',
    aggression: 0.7,
    build: { name: 'Snapclaw', placements: fromLayout(['.pHp.', '.rTr.', '.lTl.', '.lAo.'], L) },
    moves: ['carapace-lock'],
    boss: false,
    guaranteed: [move('skitter-dash'), part('legs-strider'), part('legs-strider')],
    lootTable: tierTable('rare'),
    unlockedBy: ['rustmite'],
    map: { x: 0.78, y: 0.66 },
  },
  {
    id: 'ironback',
    name: 'Ironback',
    blurb: 'Foundry boss. Slow, plated, and it hits like a press. Farmable.',
    arena: 'foundry',
    aggression: 0.8,
    build: { name: 'Ironback', placements: fromLayout(['.PhP.', 'rBVBr', 'sBOBs', '.KKK.', '.s.s.'], L) },
    moves: ['carapace-lock'],
    boss: true,
    guaranteed: [part('core-fusion'), part('pinc-vise')],
    lootTable: [
      ...tierTable('rare'),
      // Signature drops
      { reward: part('armor-aegis'), weight: 12 },
      { reward: part('head-visor'), weight: 10 },
      { reward: part('pinc-vise'), weight: 8 },
    ],
    unlockedBy: ['needlewisp', 'snapclaw'],
    map: { x: 0.5, y: 0.42 },
  },
  {
    id: 'vexa',
    name: 'Queen Vexa',
    blurb: 'Hive champion. Drill horn, shear jaws, glass wings. Farmable boss.',
    arena: 'hive',
    aggression: 0.9,
    build: {
      name: 'Queen Vexa',
      placements: fromLayout(['.MDM.', 'cBVBc', 'GBOBG', 'gKoKg', '.g.g.'], L),
    },
    moves: ['mandible-crusher', 'carapace-lock'],
    boss: true,
    guaranteed: [part('wings-glass'), part('mand-shear')],
    lootTable: [
      ...tierTable('epic'),
      // Signature drops
      { reward: part('horn-drill'), weight: 8 },
      { reward: part('sting-lance'), weight: 6 },
      { reward: part('wings-glass'), weight: 8 },
      { reward: move('mandible-crusher'), weight: 4 },
    ],
    unlockedBy: ['ironback'],
    map: { x: 0.5, y: 0.12 },
  },
];

export function getOpponent(id: string): Opponent {
  return OPPONENTS.find((o) => o.id === id) ?? OPPONENTS[0];
}

export function isUnlocked(o: Opponent, cleared: string[]) {
  return o.unlockedBy.length === 0 || o.unlockedBy.some((id) => cleared.includes(id));
}

/** Moves every new player owns, and what's equipped at the start. */
export const STARTER_MOVES: MoveId[] = ['mandible-crusher'];

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
