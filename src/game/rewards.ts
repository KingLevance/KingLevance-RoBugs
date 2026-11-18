import type { LootEntry, Opponent, Reward } from './opponents';
import { PARTS } from './parts';

/** `bonus`: the one-off reward for reaching 3 stars on a fight for the first time. */
export type MatchRewards = { guaranteed: Reward[]; rolled: Reward[]; bonus: Reward[] };

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
/** 3-star bonus pool for opponents whose own table has nothing rare: any plain (untagged) rare part. */
const RARE_POOL: LootEntry[] = PARTS.filter((p) => p.rarity === 'rare' && !p.tag).map((p) => ({ reward: { kind: 'part', id: p.id }, weight: 1 }));

/** Rarity rank of a reward (moves count as rare). */
function tier(r: Reward) {
  if (r.kind === 'move') return 2;
  const p = PARTS.find((x) => x.id === r.id);
  return p ? { common: 0, uncommon: 1, rare: 2, epic: 3 }[p.rarity] : 0;
}

/**
 * Lean a loot table toward rarer drops: at 1 star it's unchanged; each extra
 * star scales rare/epic weights up and common weights down.
 */
export function weighByStars(table: LootEntry[], stars: number): LootEntry[] {
  const s = Math.max(0, stars - 1);
  const k = [1 - 0.25 * s, 1, 1 + 0.6 * s, 1 + 0.9 * s];
  return table.map((e) => ({ reward: e.reward, weight: e.weight * Math.max(0.1, k[tier(e.reward)]) }));
}

/**
 * Win: the opponent's guaranteed drops on first clear, plus rolls on its loot
 * table (2 for normal opponents, 3 for bosses; +1 at 3 stars), leaning rarer
 * with more stars. Reaching 3 stars on a fight for the first time adds a bonus
 * roll that's always rare or better.
 * Loss: one common salvage part. Forfeit: nothing at all.
 */
export function rollMatchRewards(
  opp: Opponent,
  won: boolean,
  firstClear: boolean,
  forfeited = false,
  rng: () => number = Math.random,
  stars = 1,
  firstThreeStar = false,
): MatchRewards {
  if (forfeited) return { guaranteed: [], rolled: [], bonus: [] };
  if (!won) return { guaranteed: [], rolled: [roll(SALVAGE, rng)], bonus: [] };
  const rolls = (opp.boss ? 3 : 2) + (stars >= 3 ? 1 : 0);
  const table = weighByStars(opp.lootTable, stars);
  const own = opp.lootTable.filter((e) => tier(e.reward) >= 2);
  const rare = own.length ? own : RARE_POOL;
  return {
    guaranteed: firstClear ? opp.guaranteed : [],
    rolled: Array.from({ length: rolls }, () => roll(table, rng)),
    bonus: firstThreeStar && rare.length ? [roll(rare, rng)] : [],
  };
}
