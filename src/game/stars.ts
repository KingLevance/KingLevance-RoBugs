/**
 * Campaign star ratings. A win earns 1 star, plus one for each challenge met:
 * finishing with at least half your side's integrity, and winning fast.
 */
import type { Opponent } from './opponents';

export const MAX_STARS = 3;
/** Share of your side's total integrity you must finish with for the "tough" star. */
export const STAR_HP = 0.5;

/** Seconds to beat for the "fast" star: longer for bosses and team fights. */
export function starTime(o: Opponent) {
  return (o.team?.length ?? 0) > 0 ? 70 : o.boss ? 60 : 45;
}

export type StarCheck = { label: string; ok: boolean };

/** The three star challenges for an opponent (as labels), given how a win went. */
export function rateWin(o: Opponent, hpLeft: number, time: number): { stars: number; checks: StarCheck[] } {
  const checks: StarCheck[] = [
    { label: 'Win', ok: true },
    { label: `Keep ${Math.round(STAR_HP * 100)}% integrity`, ok: hpLeft >= STAR_HP },
    { label: `Win in under ${starTime(o)}s`, ok: time < starTime(o) },
  ];
  return { stars: checks.filter((c) => c.ok).length, checks };
}

/** The star challenges for an opponent, unrated (for the campaign sheet). */
export function starGoals(o: Opponent) {
  return rateWin(o, 0, Infinity).checks.map((c) => c.label);
}
