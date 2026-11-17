import type { Category, Rarity } from './parts';

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

export type MoveId = 'mandible-crusher' | 'venom-barrage' | 'carapace-lock' | 'skitter-dash';

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
  /** Parts that must still be attached (any one of the listed categories, at least `count`). */
  requires: { category: Category; count: number };
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
    requires: { category: 'mandibles', count: 1 },
  },
  {
    id: 'venom-barrage',
    name: 'Venom Barrage',
    description: 'Fires a fan of seven heavy venom darts. Needs a stinger.',
    rarity: 'rare',
    color: '#B65BE0',
    cost: 55,
    cooldown: 10,
    ultimate: true,
    requires: { category: 'stinger', count: 1 },
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
    requires: { category: 'armor', count: 1 },
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
    requires: { category: 'legs', count: 2 },
  },
];

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
