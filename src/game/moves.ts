import type { Category, PartTag, Rarity } from './parts';

/** Proc-point gains. Tune here. Points reset every match. */
export const PROC = {
  max: 100,
  hitLanded: 4,
  armorAbsorb: 2,
  partBroken: 12,
  /** Points per 5 damage taken (comeback gain). */
  damageTakenPer5: 1,
  dodge: 6,
  /** Bonus on top of hitLanded when the hit is critical. */
  crit: 4,
} as const;

export const MOVE_SLOTS = 2;
export const ULT_SECONDS = 1.6;

export type MoveId =
  | 'mandible-crusher'
  | 'venom-barrage'
  | 'carapace-lock'
  | 'skitter-dash'
  | 'web-snare'
  | 'burrow-strike'
  | 'ghost-shell'
  | 'sunder-beam'
  | 'static-burst'
  | 'overclock'
  | 'gale-flap'
  | 'skewer'
  | 'blood-siphon';

export type MoveDef = {
  id: MoveId;
  name: string;
  description: string;
  rarity: Rarity;
  /** Theme colour for the banner stripe and charge aura. */
  color: string;
  cost: number;
  cooldown: number;
  ultimate: boolean;
  /**
   * Hardware that must still be attached: at least `count` parts of `category`
   * and/or carrying `tag`. `label` names it for the player ("a stinger").
   */
  requires: { category?: Category; tag?: PartTag; count: number; label: string };
};

export const MOVES: readonly MoveDef[] = [
  {
    id: 'mandible-crusher',
    name: 'Mandible Crusher',
    description: 'Lunges and clamps down with every jaw: a huge bite across several enemy parts. Needs mandibles.',
    rarity: 'uncommon',
    color: '#FF4D5E',
    cost: 60,
    cooldown: 10,
    ultimate: true,
    requires: { category: 'mandibles', count: 1, label: 'mandibles' },
  },
  {
    id: 'venom-barrage',
    name: 'Venom Barrage',
    description: 'Swings its stinger onto the target and fires a fan of seven heavy venom darts. Needs a venom stinger.',
    rarity: 'rare',
    color: '#B65BE0',
    cost: 55,
    cooldown: 10,
    ultimate: true,
    requires: { tag: 'venom', count: 1, label: 'a venom stinger' },
  },
  {
    id: 'carapace-lock',
    name: 'Carapace Lock',
    description: 'Seals every plate: takes 70% less damage for 4 seconds. Fires when you are getting hammered. Needs armor.',
    rarity: 'uncommon',
    color: '#4FA8FF',
    cost: 50,
    cooldown: 14,
    ultimate: true,
    requires: { category: 'armor', count: 1, label: 'armor' },
  },
  {
    id: 'skitter-dash',
    name: 'Skitter Dash',
    description: 'A quick sidestep with a moment of invulnerability. Dodges stompers and big hits. Needs 2+ legs.',
    rarity: 'common',
    color: '#3DDC97',
    cost: 20,
    cooldown: 5,
    ultimate: false,
    requires: { category: 'legs', count: 2, label: '2 sets of legs' },
  },
  {
    id: 'web-snare',
    name: 'Web Snare',
    description: 'Spits a glob of silk. A webbed enemy crawls at a third of its speed and cannot fly for 3.5 seconds. Needs a Silk Spinneret.',
    rarity: 'uncommon',
    color: '#E8E6DA',
    cost: 30,
    cooldown: 9,
    ultimate: false,
    requires: { tag: 'silk', count: 1, label: 'a Silk Spinneret' },
  },
  {
    id: 'burrow-strike',
    name: 'Burrow Strike',
    description: 'Digs under the arena, untouchable, tunnels to the enemy and erupts beneath it: heavy damage to its underside and legs, and it gets tossed. Needs Mole Diggers.',
    rarity: 'rare',
    color: '#C98B4A',
    cost: 45,
    cooldown: 12,
    ultimate: false,
    requires: { tag: 'dig', count: 1, label: 'Mole Diggers' },
  },
  {
    id: 'ghost-shell',
    name: 'Ghost Shell',
    description: 'Turns invisible for 4.5 seconds. Enemies lose track of you, and your first strike out of hiding is a guaranteed critical hit. Needs a Mirage Plate.',
    rarity: 'rare',
    color: '#9BE8E0',
    cost: 35,
    cooldown: 14,
    ultimate: false,
    requires: { tag: 'cloak', count: 1, label: 'a Mirage Plate' },
  },
  {
    id: 'sunder-beam',
    name: 'Sunder Beam',
    description: 'Overcharges the lens and fires a beam that cuts straight through the enemy, hitting every part in its path. Needs a Prism Cutter.',
    rarity: 'epic',
    color: '#5CF2FF',
    cost: 65,
    cooldown: 12,
    ultimate: true,
    requires: { tag: 'laser', count: 1, label: 'a Prism Cutter' },
  },
  {
    id: 'static-burst',
    name: 'Static Burst',
    description: 'A ring of electricity: nearby enemies are stunned for 1.3 seconds and lose charge on their move meter. Needs Tesla Prongs.',
    rarity: 'rare',
    color: '#FFE14D',
    cost: 35,
    cooldown: 10,
    ultimate: false,
    requires: { tag: 'shock', count: 1, label: 'Tesla Prongs' },
  },
  {
    id: 'overclock',
    name: 'Overclock',
    description: 'Runs the cores hot for 5 seconds: moves a third faster and attacks half again as fast. Needs 2 power cores.',
    rarity: 'uncommon',
    color: '#FF9A2E',
    cost: 40,
    cooldown: 14,
    ultimate: false,
    requires: { category: 'core', count: 2, label: '2 power cores' },
  },
  {
    id: 'gale-flap',
    name: 'Gale Flap',
    description: 'A blast of wind that hurls nearby enemies back and knocks flyers out of the air. Needs wings.',
    rarity: 'common',
    color: '#BFE9FF',
    cost: 25,
    cooldown: 8,
    ultimate: false,
    requires: { category: 'wings', count: 1, label: 'wings' },
  },
  {
    id: 'skewer',
    name: 'Skewer',
    description: 'The tail whips over the top and drives into the enemy\'s body, past its armor: heavy damage to its thorax, and it staggers. Needs a Barbed Tail.',
    rarity: 'epic',
    color: '#B6F23C',
    cost: 45,
    cooldown: 12,
    ultimate: false,
    requires: { tag: 'scorpion', count: 1, label: 'a Barbed Tail' },
  },
  {
    id: 'blood-siphon',
    name: 'Blood Siphon',
    description: 'Latches on and drinks for 2.4 seconds: drains the nearest enemy part and pours it all back into your own damaged parts. Needs a Siphon Proboscis.',
    rarity: 'rare',
    color: '#E8323F',
    cost: 35,
    cooldown: 11,
    ultimate: false,
    requires: { tag: 'drain', count: 1, label: 'a Siphon Proboscis' },
  },
];

/** Does a set of (still attached) parts satisfy a move's hardware requirement? */
export function meetsRequirement(m: MoveDef, parts: { category: Category; tag?: PartTag }[]) {
  const r = m.requires;
  return parts.filter((p) => (!r.category || p.category === r.category) && (!r.tag || p.tag === r.tag)).length >= r.count;
}

const MOVE_INDEX = Object.fromEntries(MOVES.map((m) => [m.id, m])) as Record<MoveId, MoveDef>;

export function getMove(id: string): MoveDef {
  const m = MOVE_INDEX[id as MoveId];
  if (!m) throw new Error(`Unknown move ${id}`);
  return m;
}

export function isMoveId(id: string): id is MoveId {
  return id in MOVE_INDEX;
}

export function isUltimate(id: string) {
  return getMove(id).ultimate;
}
