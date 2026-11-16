import { PARTS, type Rarity } from './parts';

const ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic'];
const WEIGHT: Record<Rarity, number> = { common: 50, uncommon: 30, rare: 15, epic: 6 };

function pick(maxTier: Rarity, minTier: Rarity = 'common'): string {
  const lo = ORDER.indexOf(minTier);
  const hi = ORDER.indexOf(maxTier);
  const pool = PARTS.filter((p) => {
    const r = ORDER.indexOf(p.rarity);
    return r >= lo && r <= hi;
  });
  const total = pool.reduce((a, p) => a + WEIGHT[p.rarity], 0);
  let roll = Math.random() * total;
  for (const p of pool) {
    roll -= WEIGHT[p.rarity];
    if (roll <= 0) return p.id;
  }
  return pool[pool.length - 1].id;
}

/**
 * Win: two parts up to the opponent's tier, plus a guaranteed top-tier part
 * the first time you beat them. Loss: one common salvage part.
 */
export function rollRewards(won: boolean, tier: Rarity, firstClear: boolean): string[] {
  if (!won) return [pick('common')];
  const out = [pick(tier), pick(tier)];
  if (firstClear) out.push(pick(tier, tier));
  return out;
}
