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

export type ArenaId = 'pit' | 'foundry' | 'hive' | 'meadow' | 'pond';

export const ARENA_NAMES: Record<ArenaId, string> = {
  pit: 'The Acid Pit',
  foundry: 'Stomper Foundry',
  hive: 'The Hive Ring',
  meadow: 'The Meadow',
  pond: 'Moonlit Pond',
};

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
  /** Team fights: more enemy bugs fighting alongside `build`. */
  team?: Teammate[];
  /** Team fights: ids of (earlier) opponents whose bugs fight on the player's side. */
  allies?: string[];
  /** An optional side boss off the main path. */
  optional?: boolean;
  /** Map position: x across (0..1) and the row within its zone (0 = the zone's entry, counting up). */
  map: { x: number; row: number };
};

/** Another bug in a team fight. */
export type Teammate = { build: Build; moves: MoveId[]; aggression: number };

const part = (id: string): Reward => ({ kind: 'part', id });
const move = (id: MoveId): Reward => ({ kind: 'move', id });

const RARITY_WEIGHT: Record<Rarity, number> = { common: 50, uncommon: 30, rare: 15, epic: 6 };
const ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic'];

/** Every part up to `maxTier`, weighted by rarity. */
function tierTable(maxTier: Rarity): LootEntry[] {
  const hi = ORDER.indexOf(maxTier);
  // Signature hardware (silk, diggers, cloak, laser…) only drops from the bugs that use it.
  return PARTS.filter((p) => ORDER.indexOf(p.rarity) <= hi && (!p.tag || p.tag === 'venom')).map((p) => ({ reward: part(p.id), weight: RARITY_WEIGHT[p.rarity] }));
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
  R: 'sensor-radar',
  n: 'sting-lance',
  C: 'head-octo',
  v: 'legs-weaver',
  S: 'abdomen-spinner',
  z: 'sting-laser',
  q: 'pinc-digger',
  t: 'horn-shock',
  i: 'armor-mirage',
  y: 'mand-proboscis',
};

const bug = (name: string, rows: string[]): Build => ({ name, placements: fromLayout(rows, L) });

export const STARTER_BUILD: Build = {
  name: 'Sprocket',
  placements: fromLayout(['.rmr.', '.lHl.', '.oT..', '.lAl.'], L),
};

export const OPPONENTS: Opponent[] = [
  // ── The Scrapyard ──────────────────────────────────────────────
  {
    id: 'rustmite',
    name: 'Rustmite',
    blurb: 'A wobbly scrap crawler. Good for warming up.',
    arena: 'pit',
    aggression: 0.5,
    build: bug('Rustmite', ['..m..', '.lHl.', '.lTo.', '..A..']),
    moves: [],
    boss: false,
    guaranteed: [move('carapace-lock'), part('armor-ceramic')],
    lootTable: tierTable('uncommon'),
    unlockedBy: [],
    map: { x: 0.5, row: 0 },
  },
  {
    id: 'needlewisp',
    name: 'Needlewisp',
    blurb: 'A flitting dart-spitter that keeps its distance.',
    arena: 'meadow',
    aggression: 0.35,
    build: bug('Needlewisp', ['..d..', '.eHe.', '.wTw.', '.lAl.', '.oAo.']),
    moves: ['venom-barrage', 'skitter-dash'],
    boss: false,
    guaranteed: [part('sting-dart'), move('venom-barrage')],
    lootTable: [...tierTable('uncommon'), { reward: part('wings-foil'), weight: 40 }],
    unlockedBy: ['rustmite'],
    map: { x: 0.25, row: 1 },
  },
  {
    id: 'snapclaw',
    name: 'Snapclaw',
    blurb: 'Wide pincers and a stubborn shell.',
    arena: 'foundry',
    aggression: 0.7,
    build: bug('Snapclaw', ['.pHp.', '.rTr.', '.lTl.', '.lAo.']),
    moves: ['carapace-lock'],
    boss: false,
    guaranteed: [move('skitter-dash'), part('legs-strider'), part('legs-strider')],
    lootTable: tierTable('rare'),
    unlockedBy: ['rustmite'],
    map: { x: 0.75, row: 1 },
  },
  {
    id: 'scrapjaw',
    name: 'Old Scrapjaw',
    blurb: 'Optional. A battered veteran that has out-bitten every newcomer. Teaches Overclock.',
    arena: 'pit',
    aggression: 0.75,
    build: bug('Old Scrapjaw', ['.mh..', '.rHr.', '.lTo.', '.lAl.']),
    moves: ['mandible-crusher', 'skitter-dash'],
    boss: true,
    optional: true,
    guaranteed: [move('overclock'), part('head-octo'), part('core-cell')],
    lootTable: [...tierTable('rare'), { reward: part('head-octo'), weight: 20 }, { reward: part('core-cell'), weight: 20 }],
    unlockedBy: ['snapclaw'],
    map: { x: 0.8, row: 2 },
  },
  {
    id: 'ironback',
    name: 'Ironback',
    blurb: 'Foundry boss. Slow, plated, and it hits like a press. Farmable.',
    arena: 'foundry',
    aggression: 0.8,
    build: bug('Ironback', ['.PhP.', 'rBVBr', 'sBOBs', '.KKK.', '.s.s.']),
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
    map: { x: 0.42, row: 2 },
  },

  // ── The Undergrowth ────────────────────────────────────────────
  {
    id: 'silkjaw',
    name: 'Silkjaw',
    blurb: 'An eight-eyed weaver. Its webs pin you down while its jaws go to work.',
    arena: 'meadow',
    aggression: 0.75,
    build: bug('Silkjaw', ['.mMm.', '.vCv.', '.oBo.', '.vSv.']),
    moves: ['web-snare', 'mandible-crusher'],
    boss: false,
    guaranteed: [move('web-snare'), part('abdomen-spinner'), part('legs-weaver'), part('legs-weaver')],
    lootTable: [...tierTable('rare'), { reward: part('legs-weaver'), weight: 25 }, { reward: part('abdomen-spinner'), weight: 15 }],
    unlockedBy: ['ironback'],
    map: { x: 0.5, row: 0 },
  },
  {
    id: 'lattice',
    name: 'Mother Lattice',
    blurb: 'Optional. The great weaver at the heart of the web. Six legs of pure spite.',
    arena: 'meadow',
    aggression: 0.95,
    build: bug('Mother Lattice', ['.MCM.', 'vBOBv', 'vKSKv', 'vcocv']),
    moves: ['web-snare', 'mandible-crusher', 'skitter-dash'],
    boss: true,
    optional: true,
    guaranteed: [part('legs-weaver'), part('legs-weaver'), part('armor-aegis'), part('mand-shear')],
    lootTable: [...tierTable('epic'), { reward: part('legs-weaver'), weight: 30 }, { reward: part('head-octo'), weight: 20 }, { reward: part('abdomen-spinner'), weight: 15 }],
    unlockedBy: ['silkjaw'],
    map: { x: 0.17, row: 0 },
  },
  {
    id: 'gravelgrub',
    name: 'Gravelgrub',
    blurb: 'It vanishes under the floor, then the floor comes up to meet you.',
    arena: 'meadow',
    aggression: 0.8,
    build: bug('Gravelgrub', ['.qHq.', 'rBOBr', 'sKKKs', '.s.s.']),
    moves: ['burrow-strike', 'carapace-lock'],
    boss: false,
    guaranteed: [move('burrow-strike'), part('pinc-digger'), part('pinc-digger')],
    lootTable: [...tierTable('rare'), { reward: part('pinc-digger'), weight: 25 }],
    unlockedBy: ['silkjaw'],
    map: { x: 0.2, row: 1 },
  },
  {
    id: 'arcfly',
    name: 'Arcfly',
    blurb: 'A crackling flyer. Gets close, stuns you, and blows you into the acid.',
    arena: 'pond',
    aggression: 0.85,
    build: bug('Arcfly', ['.MtM.', '.eHe.', 'wBOBw', 'sAoAs']),
    moves: ['static-burst', 'gale-flap', 'skitter-dash'],
    boss: false,
    guaranteed: [move('static-burst'), move('gale-flap'), part('horn-shock'), part('wings-foil'), part('wings-foil')],
    lootTable: [...tierTable('rare'), { reward: part('horn-shock'), weight: 20 }, { reward: part('wings-foil'), weight: 30 }],
    unlockedBy: ['silkjaw'],
    map: { x: 0.8, row: 1 },
  },
  {
    id: 'bloodgnat',
    name: 'Bloodgnat',
    blurb: 'A whining mosquito-bot. Every bite it lands patches it up, so finish it fast.',
    arena: 'pond',
    aggression: 0.9,
    build: bug('Bloodgnat', ['.MyM.', 'ceHec', 'GBOBG', 'sKoKs', '.s.s.']),
    moves: ['blood-siphon', 'overclock'],
    boss: false,
    guaranteed: [move('blood-siphon'), part('mand-proboscis')],
    lootTable: [...tierTable('rare'), { reward: part('mand-proboscis'), weight: 20 }, { reward: part('wings-glass'), weight: 6 }],
    unlockedBy: ['silkjaw'],
    map: { x: 0.5, row: 1 },
  },
  {
    id: 'vexa',
    name: 'Queen Vexa',
    blurb: 'Hive champion. Drill horn, shear jaws, glass wings. Farmable boss.',
    arena: 'hive',
    aggression: 0.8,
    build: bug('Queen Vexa', ['.mhM.', 'rBVBr', 'GBOBG', '.gog.']),
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
    unlockedBy: ['gravelgrub', 'arcfly', 'bloodgnat'],
    map: { x: 0.5, row: 2 },
  },

  // ── The Deep Hive (team fights) ────────────────────────────────
  {
    id: 'twins',
    name: 'Rivet & Ratchet',
    blurb: 'Two-on-two. The scrapyard twins never fight alone. Bring a second bug from your garage (or borrow Snapclaw).',
    arena: 'foundry',
    aggression: 0.75,
    build: bug('Rivet', ['.PHP.', 'cBOBc', '.sKs.', '.s.s.']),
    moves: ['carapace-lock'],
    team: [{ build: bug('Ratchet', ['.MHM.', '.sBs.', '.oKo.', '.s.s.']), moves: ['mandible-crusher'], aggression: 0.85 }],
    allies: ['snapclaw'],
    boss: false,
    guaranteed: [part('legs-crawler'), part('legs-crawler'), part('thorax-chitin')],
    lootTable: tierTable('rare'),
    unlockedBy: ['vexa'],
    map: { x: 0.5, row: 0 },
  },
  {
    id: 'glimmer',
    name: 'Glimmer',
    blurb: 'Now you see it. Then you really don’t, until its jaws are already shut.',
    arena: 'pond',
    aggression: 0.8,
    build: bug('Glimmer', ['.MVM.', 'iBOBi', 'gKoKg', '.g.g.']),
    moves: ['ghost-shell', 'mandible-crusher'],
    boss: false,
    guaranteed: [move('ghost-shell'), part('armor-mirage')],
    lootTable: [...tierTable('epic'), { reward: part('armor-mirage'), weight: 20 }],
    unlockedBy: ['twins'],
    map: { x: 0.27, row: 1 },
  },
  {
    id: 'nullshade',
    name: 'Nullshade',
    blurb: 'Optional. An assassin nobody has seen twice. Cloak, laser, and a very short fight.',
    arena: 'foundry',
    aggression: 0.9,
    build: bug('Nullshade', ['.MzM.', 'iBVBi', 'gOKOg', '.g.g.']),
    moves: ['ghost-shell', 'sunder-beam', 'mandible-crusher'],
    boss: true,
    optional: true,
    guaranteed: [part('sting-lance'), part('armor-mirage'), part('head-visor')],
    lootTable: [...tierTable('epic'), { reward: part('armor-mirage'), weight: 20 }, { reward: part('sting-lance'), weight: 14 }, { reward: part('sting-laser'), weight: 14 }],
    unlockedBy: ['glimmer'],
    map: { x: 0.15, row: 2 },
  },
  {
    id: 'lenswing',
    name: 'Lenswing',
    blurb: 'Hovers out of reach and carves you up with light.',
    arena: 'pit',
    aggression: 0.45,
    build: bug('Lenswing', ['.zVz.', 'RBOBR', 'GcAcG', '.o.o.']),
    moves: ['sunder-beam', 'gale-flap', 'carapace-lock'],
    boss: false,
    guaranteed: [move('sunder-beam'), part('sting-laser'), part('sensor-radar')],
    lootTable: [...tierTable('epic'), { reward: part('sting-laser'), weight: 18 }, { reward: part('sensor-radar'), weight: 14 }],
    unlockedBy: ['twins'],
    map: { x: 0.73, row: 1 },
  },
  {
    id: 'tunnelkings',
    name: 'The Tunnel Kings',
    blurb: 'Two-on-two. One digs, one bites. Bring a partner bug (or borrow Silkjaw).',
    arena: 'foundry',
    aggression: 0.85,
    build: bug('Burrowbane', ['.qVq.', 'sBOBs', '.KKK.', '.s.s.']),
    moves: ['burrow-strike'],
    team: [{ build: bug('Grubjaw', ['.MHM.', 'cBOBc', '.sKs.', '.s.s.']), moves: ['mandible-crusher', 'skitter-dash'], aggression: 0.9 }],
    allies: ['silkjaw'],
    boss: false,
    guaranteed: [part('abdomen-tank'), part('core-fusion')],
    lootTable: [...tierTable('epic'), { reward: part('pinc-digger'), weight: 15 }],
    unlockedBy: ['glimmer', 'lenswing'],
    map: { x: 0.5, row: 2 },
  },
  {
    id: 'hiveguard',
    name: 'The Hive Guard',
    blurb: 'Three-on-three. The Empress’s finest. Bring your squad (or borrow Ironback and Arcfly).',
    arena: 'hive',
    aggression: 0.85,
    build: bug('Hive Warden', ['.PHP.', 'cBOBc', '.sKs.', '.s.s.']),
    moves: ['carapace-lock'],
    team: [
      { build: bug('Stingwing', ['..n..', '.eVe.', '.GBG.', '.oOo.', '..A..']), moves: ['venom-barrage'], aggression: 0.4 },
      { build: bug('Shellback', ['.mHm.', 'XBOBX', 'sKoKs', '.s.s.']), moves: ['mandible-crusher', 'carapace-lock'], aggression: 0.85 },
    ],
    allies: ['ironback', 'arcfly'],
    boss: true,
    guaranteed: [part('horn-drill'), part('armor-aegis')],
    lootTable: [...tierTable('epic'), { reward: part('horn-drill'), weight: 10 }, { reward: part('sting-lance'), weight: 10 }],
    unlockedBy: ['tunnelkings'],
    map: { x: 0.5, row: 3 },
  },
  {
    id: 'kalyx',
    name: 'Empress Kalyx',
    blurb: 'Three-on-three finale. Web, beam and jaws, with two royal guards. Bring your best squad (or borrow Glimmer and Lenswing). Farmable.',
    arena: 'hive',
    aggression: 0.95,
    build: bug('Empress Kalyx', ['.MzM.', 'cBVBc', 'GBOBG', 'vKOKv', '.vSv.']),
    moves: ['sunder-beam', 'web-snare', 'mandible-crusher', 'carapace-lock'],
    team: [
      { build: bug('Royal Guard', ['.PHP.', 'XBOBX', 'sKoKs', '.s.s.']), moves: ['carapace-lock'], aggression: 0.9 },
      { build: bug('Royal Lancer', ['.MDM.', '.sHs.', 'cBOBc', '.oKo.']), moves: ['mandible-crusher'], aggression: 0.9 },
    ],
    allies: ['glimmer', 'lenswing'],
    boss: true,
    guaranteed: [part('mand-shear'), part('wings-glass'), part('sting-laser')],
    lootTable: [
      ...tierTable('epic'),
      { reward: part('sting-laser'), weight: 12 },
      { reward: part('armor-mirage'), weight: 12 },
      { reward: part('legs-weaver'), weight: 12 },
      { reward: part('horn-drill'), weight: 10 },
      { reward: part('sting-lance'), weight: 10 },
      { reward: part('wings-glass'), weight: 10 },
    ],
    unlockedBy: ['hiveguard'],
    map: { x: 0.5, row: 4 },
  },
];

export function getOpponent(id: string): Opponent {
  return OPPONENTS.find((o) => o.id === id) ?? OPPONENTS[0];
}

/** Everyone fighting on each side of an opponent's match (the player's own bug is added by the caller). */
export function lineup(o: Opponent): { allies: Teammate[]; enemies: Teammate[] } {
  return {
    allies: (o.allies ?? []).map((id) => {
      const a = getOpponent(id);
      return { build: a.build, moves: a.moves, aggression: a.aggression };
    }),
    enemies: [{ build: o.build, moves: o.moves, aggression: o.aggression }, ...(o.team ?? [])],
  };
}

/** How many of your other bugs can join you against this opponent (0 for a 1v1). */
export function allySlots(o: Opponent) {
  return o.team?.length ?? 0;
}

/**
 * Your side in a team fight: your own squad bugs first, and any slots you
 * can't fill are covered by the opponents you've beaten (`o.allies`), "borrowed".
 */
export function alliesFor(o: Opponent, squad: Teammate[]): { allies: Teammate[]; borrowed: string[] } {
  const slots = allySlots(o);
  const mine = squad.slice(0, slots);
  const borrowed = (o.allies ?? []).slice(0, slots - mine.length);
  return {
    allies: [
      ...mine,
      ...borrowed.map((id) => {
        const a = getOpponent(id);
        return { build: a.build, moves: a.moves, aggression: a.aggression };
      }),
    ],
    borrowed,
  };
}

/** "1v1", "2v2" or "3v3". */
export function fightSize(o: Opponent) {
  const n = 1 + (o.team?.length ?? 0);
  return `${n}v${n}`;
}

/**
 * Campaign zones, in play order. Entering a zone (its first stop) needs
 * `starsToEnter` stars earned in the zone before it, so a player has to
 * do well, not just scrape through, before moving on.
 */
export type ZoneId = 'scrapyard' | 'undergrowth' | 'hive';
export type Zone = { id: ZoneId; name: string; stops: string[]; starsToEnter: number };
export const ZONES: Zone[] = [
  { id: 'scrapyard', name: 'The Scrapyard', stops: ['rustmite', 'needlewisp', 'snapclaw', 'scrapjaw', 'ironback'], starsToEnter: 0 },
  { id: 'undergrowth', name: 'The Undergrowth', stops: ['silkjaw', 'lattice', 'gravelgrub', 'arcfly', 'bloodgnat', 'vexa'], starsToEnter: 9 },
  { id: 'hive', name: 'The Deep Hive', stops: ['twins', 'glimmer', 'nullshade', 'lenswing', 'tunnelkings', 'hiveguard', 'kalyx'], starsToEnter: 12 },
];

export function zoneIndex(o: Opponent) {
  return Math.max(0, ZONES.findIndex((z) => z.stops.includes(o.id)));
}

/** Stars earned across a zone's stops. */
export function zoneStars(zone: Zone, stars: Record<string, number>) {
  return zone.stops.reduce((a, id) => a + (stars[id] ?? 0), 0);
}

/**
 * The star gate in front of a stop, if it's a zone's entry (reached from the
 * zone before): how many stars the previous zone needs and how many you have.
 */
export function starGate(o: Opponent, stars: Record<string, number>) {
  const i = zoneIndex(o);
  if (i === 0) return null;
  const zone = ZONES[i];
  if (!o.unlockedBy.some((id) => !zone.stops.includes(id))) return null;
  const prev = ZONES[i - 1];
  return { zone, prev, need: zone.starsToEnter, have: zoneStars(prev, stars), met: zoneStars(prev, stars) >= zone.starsToEnter };
}

/** The path to a stop is open: it's a starting stop or a neighbour is cleared. */
export function pathOpen(o: Opponent, cleared: string[]) {
  return o.unlockedBy.length === 0 || o.unlockedBy.some((id) => cleared.includes(id));
}

/** Playable: the path is open and any zone star gate is met. Stops you've already beaten always stay open. */
export function isUnlocked(o: Opponent, cleared: string[], stars: Record<string, number>) {
  if (cleared.includes(o.id)) return true;
  return pathOpen(o, cleared) && (starGate(o, stars)?.met ?? true);
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
