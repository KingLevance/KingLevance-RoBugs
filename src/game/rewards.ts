import type { LootEntry, Opponent, Reward } from './opponents';
import { PARTS } from './parts';

export type MatchRewards = { guaranteed: Reward[]; rolled: Reward[] };

function roll(table: LootEntry[], rng: () => number): Reward {
  const total = table.reduce((a, e) => a + e.weight, 0);
  let r = rng() * total;
  for (const e of table) {
    r -= e.weight;
    if (r <= 0) return e.reward;
  }
  return table[table.length - 1].reward;
}

const SALVAGE: LootEntry[] = PARTS.filter((p) => p.rarity === 'common').map((p) => ({ reward: { kind: 'part', id: p.id }, weight: 1 }));

/**
 * Win: the opponent's guaranteed drops on first clear, plus rolls on its
 * loot table (2 for normal opponents, 3 for bosses — repeatable).
 * Loss: one common salvage part. Forfeit: nothing at all.
 */
export function rollMatchRewards(
  opp: Opponent,
  won: boolean,
  firstClear: boolean,
  forfeited = false,
  rng: () => number = Math.random,
): MatchRewards {
  if (forfeited) return { guaranteed: [], rolled: [] };
  if (!won) return { guaranteed: [], rolled: [roll(SALVAGE, rng)] };
  const rolls = opp.boss ? 3 : 2;
  return {
    guaranteed: firstClear ? opp.guaranteed : [],
    rolled: Array.from({ length: rolls }, () => roll(opp.lootTable, rng)),
  };
}
