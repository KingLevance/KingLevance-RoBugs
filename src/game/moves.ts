import type { Rarity } from './parts';

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

export const ULT_SECONDS = 1.6;
/** After any ultimate, nobody can fire another for this long (keeps the cutscenes special). */
export const ULT_LULL = 10;

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
  /** Ultimates only: charge (proc points) it needs and spends. Other moves are free and just roll `chance`. */
  cost: number;
  cooldown: number;
  ultimate: boolean;
  /** Chance per check (twice a second, while it's off cooldown and the moment is right) that it goes off. */
  chance: number;
};

export const MOVES: readonly MoveDef[] = [
  {
    id: 'mandible-crusher',
    name: 'Mandible Crusher',
    description: 'Lunges and clamps down with every jaw: a huge bite across several enemy parts.',
    rarity: 'uncommon',
    color: '#FF4D5E',
    cost: 60,
    cooldown: 10,
    ultimate: true,
    chance: 0.5,
  },
  {
    id: 'venom-barrage',
    name: 'Venom Barrage',
    description: 'Swings its stinger onto the target and fires a fan of seven heavy venom darts.',
    rarity: 'rare',
    color: '#B65BE0',
    cost: 55,
    cooldown: 10,
    ultimate: true,
    chance: 0.5,
  },
  {
    id: 'carapace-lock',
    name: 'Carapace Lock',
    description: 'Seals every plate: takes 55% less damage for 3 seconds. Fires when you are getting hammered.',
    rarity: 'uncommon',
    color: '#4FA8FF',
    cost: 0,
    cooldown: 16,
    ultimate: false,
    chance: 0.5,
  },
  {
    id: 'skitter-dash',
    name: 'Skitter Dash',
    description: 'A quick sidestep with a moment of invulnerability. Dodges stompers and big hits.',
    rarity: 'common',
    color: '#3DDC97',
    cost: 0,
    cooldown: 5,
    ultimate: false,
    chance: 0.35,
  },
  {
    id: 'web-snare',
    name: 'Web Snare',
    description: 'Spits a glob of silk. A webbed enemy crawls at a third of its speed and cannot fly for 3.5 seconds.',
    rarity: 'uncommon',
    color: '#E8E6DA',
    cost: 0,
    cooldown: 9,
    ultimate: false,
    chance: 0.35,
  },
  {
    id: 'burrow-strike',
    name: 'Burrow Strike',
    description: 'Digs under the arena, untouchable, tunnels to the enemy and erupts beneath it: heavy damage to its underside and legs, and it gets tossed.',
    rarity: 'rare',
    color: '#C98B4A',
    cost: 0,
    cooldown: 12,
    ultimate: false,
    chance: 0.35,
  },
  {
    id: 'ghost-shell',
    name: 'Ghost Shell',
    description: 'Turns invisible for 4.5 seconds. Enemies lose track of you, and your first strike out of hiding is a guaranteed critical hit.',
    rarity: 'rare',
    color: '#9BE8E0',
    cost: 0,
    cooldown: 14,
    ultimate: false,
    chance: 0.35,
  },
  {
    id: 'sunder-beam',
    name: 'Sunder Beam',
    description: 'Overcharges the lens and fires a beam that cuts straight through the enemy, hitting every part in its path.',
    rarity: 'epic',
    color: '#5CF2FF',
    cost: 65,
    cooldown: 12,
    ultimate: true,
    chance: 0.5,
  },
  {
    id: 'static-burst',
    name: 'Static Burst',
    description: 'A ring of electricity: nearby enemies are stunned for 1.3 seconds and lose charge on their move meter.',
    rarity: 'rare',
    color: '#FFE14D',
    cost: 0,
    cooldown: 10,
    ultimate: false,
    chance: 0.35,
  },
  {
    id: 'overclock',
    name: 'Overclock',
    description: 'Runs the cores hot for 5 seconds: moves a third faster and attacks half again as fast.',
    rarity: 'uncommon',
    color: '#FF9A2E',
    cost: 0,
    cooldown: 14,
    ultimate: false,
    chance: 0.35,
  },
  {
    id: 'gale-flap',
    name: 'Gale Flap',
    description: 'A blast of wind that hurls nearby enemies back and knocks flyers out of the air.',
    rarity: 'common',
    color: '#BFE9FF',
    cost: 0,
    cooldown: 8,
    ultimate: false,
    chance: 0.35,
  },
  {
    id: 'skewer',
    name: 'Skewer',
    description: 'The tail whips over the top and drives into the enemy\'s body, past its armor: heavy damage to its thorax, and it staggers.',
    rarity: 'epic',
    color: '#B6F23C',
    cost: 0,
    cooldown: 12,
    ultimate: false,
    chance: 0.35,
  },
  {
    id: 'blood-siphon',
    name: 'Blood Siphon',
    description: 'Latches on and drinks for 2.4 seconds: drains the nearest enemy part and pours it all back into your own damaged parts.',
    rarity: 'rare',
    color: '#E8323F',
    cost: 0,
    cooldown: 11,
    ultimate: false,
    chance: 0.35,
  },
];

/**
 * Moves are part of the parts that carry them (`PartDef.move`). The moves a set of parts
 * carries, in catalog order, with how many carriers each has (more carriers, more procs).
 */
export function movesOf(parts: { move?: MoveId }[]): { id: MoveId; carriers: number }[] {
  const n = new Map<MoveId, number>();
  for (const p of parts) if (p.move) n.set(p.move, (n.get(p.move) ?? 0) + 1);
  return MOVES.filter((m) => n.has(m.id)).map((m) => ({ id: m.id, carriers: n.get(m.id)! }));
}

/** Proc chance per check for a move with this many carriers (each extra carrier adds 25%, up to 75%). */
export function procChance(id: MoveId, carriers: number) {
  return Math.min(0.75, getMove(id).chance * (1 + 0.25 * Math.max(0, carriers - 1)));
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
