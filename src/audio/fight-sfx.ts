/** Fight sounds: one sim event → its sound effect. */
import type { Sim, SimEvent } from '@/game/sim';

import { preloadSfx, sfx, type SfxId } from './audio';
import { MOVE_SFX } from './sounds';

/** Slight random pitch so repeated hits don't sound identical (cosmetic, not sim state). */
const vary = (spread = 0.12) => 1 - spread / 2 + Math.random() * spread;

export function playFightEvent(e: SimEvent, sim: Sim) {
  switch (e.type) {
    case 'hit':
      if (e.shielded) sfx('hit_shield', { gap: 70, rate: vary() });
      else if (e.counter) sfx('counter', { gap: 90 });
      else if (e.crit) sfx('hit_crit', { gap: 90 });
      else if (e.dmg >= 14) sfx('hit_heavy', { gap: 60, rate: vary() });
      else sfx('hit_light', { gap: 45, rate: vary(0.25), volume: e.by === null ? 0.6 : 1 });
      break;
    case 'dash':
      sfx('dash', { gap: 80, rate: vary() });
      break;
    case 'whiff':
      sfx('whiff', { gap: 60, rate: vary(0.3), volume: e.dodged ? 1 : 0.6 });
      break;
    case 'clash':
      sfx('clash', { gap: 150 });
      break;
    case 'stagger':
      sfx('stagger', { gap: 200 });
      break;
    case 'break':
      sfx('break', { gap: 120 });
      break;
    case 'crash':
      sfx('crash', { gap: 150 });
      break;
    case 'wall':
      sfx(e.spiked ? 'wall_spike' : 'wall', { gap: 150, rate: vary() });
      break;
    case 'ult-start':
      sfx('ult_charge', { gap: 300 });
      break;
    case 'ult-release':
      sfx(MOVE_SFX[e.move], { gap: 0 });
      sfx('ult_boom', { gap: 300 });
      break;
    case 'move':
      sfx(MOVE_SFX[e.move], { gap: 120, volume: sim.bugs[e.bug]?.team === 0 ? 1 : 0.8 });
      break;
    case 'erupt':
      sfx('erupt', { gap: 200 });
      break;
    case 'heal':
      if (e.amount >= 2) sfx('heal', { gap: 300, volume: 0.7 });
      break;
    case 'bolt':
      sfx('bolt', { gap: 250, rate: vary(0.1) });
      break;
    case 'reflect':
      sfx('reflect', { gap: 60, rate: vary(0.2) });
      break;
    case 'land':
      sfx('land', { gap: 120, rate: vary() });
      break;
    // ('arc' needs nothing extra: Chain Spark / Magnet Pull already play their move sound.)
  }
}

const FIGHT_SFX: SfxId[] = ['count', 'fight', 'hit_light', 'hit_heavy', 'hit_crit', 'hit_shield', 'break', 'crash', 'wall', 'ult_charge', 'ult_boom', 'ko', 'dash', 'whiff', 'clash', 'counter', 'stagger', 'overdrive'];

/** Warm up the common fight sounds plus the moves in play. */
export function preloadFight(sim: Sim) {
  const ids = sim.bugs.flatMap((b) => b.moves);
  const moves = ids.map((m) => MOVE_SFX[m]);
  const extra: SfxId[] = [];
  if (ids.includes('pounce') || ids.includes('dive-bomb')) extra.push('land');
  if (ids.includes('mirror-ward')) extra.push('reflect');
  if (sim.hazards.some((h) => h.kind === 'bolt')) extra.push('bolt');
  preloadSfx([...FIGHT_SFX, ...moves, ...extra]);
}
