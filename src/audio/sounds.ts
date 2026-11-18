/**
 * The game's sounds. Every file is synthesized by `scripts/make-audio.mjs`
 * (run it again after changing a sound there). `dur` is the clip length in
 * seconds (for voice pooling); `vol` balances each clip in the mix.
 */
import type { MoveId } from '@/game/moves';

export const SFX = {
  tap: { src: require('@/assets/audio/sfx/tap.wav'), dur: 0.06, vol: 0.45 },
  snap: { src: require('@/assets/audio/sfx/snap.wav'), dur: 0.16, vol: 0.8 },
  unsnap: { src: require('@/assets/audio/sfx/unsnap.wav'), dur: 0.14, vol: 0.6 },
  count: { src: require('@/assets/audio/sfx/count.wav'), dur: 0.2, vol: 0.6 },
  fight: { src: require('@/assets/audio/sfx/fight.wav'), dur: 1.1, vol: 0.9 },
  hit_light: { src: require('@/assets/audio/sfx/hit_light.wav'), dur: 0.16, vol: 0.55 },
  hit_heavy: { src: require('@/assets/audio/sfx/hit_heavy.wav'), dur: 0.34, vol: 0.5 },
  hit_crit: { src: require('@/assets/audio/sfx/hit_crit.wav'), dur: 0.6, vol: 0.7 },
  hit_shield: { src: require('@/assets/audio/sfx/hit_shield.wav'), dur: 0.4, vol: 0.6 },
  break: { src: require('@/assets/audio/sfx/break.wav'), dur: 0.7, vol: 0.75 },
  crash: { src: require('@/assets/audio/sfx/crash.wav'), dur: 0.55, vol: 0.45 },
  wall: { src: require('@/assets/audio/sfx/wall.wav'), dur: 0.3, vol: 0.6 },
  wall_spike: { src: require('@/assets/audio/sfx/wall_spike.wav'), dur: 0.45, vol: 0.6 },
  erupt: { src: require('@/assets/audio/sfx/erupt.wav'), dur: 0.8, vol: 0.75 },
  heal: { src: require('@/assets/audio/sfx/heal.wav'), dur: 0.55, vol: 0.5 },
  ult_charge: { src: require('@/assets/audio/sfx/ult_charge.wav'), dur: 1.25, vol: 0.9 },
  ult_boom: { src: require('@/assets/audio/sfx/ult_boom.wav'), dur: 1.6, vol: 0.6 },
  ko: { src: require('@/assets/audio/sfx/ko.wav'), dur: 1.3, vol: 0.7 },
  win: { src: require('@/assets/audio/sfx/win.wav'), dur: 2.0, vol: 0.6 },
  lose: { src: require('@/assets/audio/sfx/lose.wav'), dur: 1.9, vol: 0.7 },
  star: { src: require('@/assets/audio/sfx/star.wav'), dur: 0.45, vol: 0.7 },
  reward: { src: require('@/assets/audio/sfx/reward.wav'), dur: 0.7, vol: 0.7 },
  m_crush: { src: require('@/assets/audio/sfx/m_crush.wav'), dur: 0.4, vol: 0.45 },
  m_venom: { src: require('@/assets/audio/sfx/m_venom.wav'), dur: 0.55, vol: 0.9 },
  m_lock: { src: require('@/assets/audio/sfx/m_lock.wav'), dur: 0.5, vol: 0.7 },
  m_dash: { src: require('@/assets/audio/sfx/m_dash.wav'), dur: 0.4, vol: 0.75 },
  m_web: { src: require('@/assets/audio/sfx/m_web.wav'), dur: 0.45, vol: 0.9 },
  m_burrow: { src: require('@/assets/audio/sfx/m_burrow.wav'), dur: 0.85, vol: 0.9 },
  m_ghost: { src: require('@/assets/audio/sfx/m_ghost.wav'), dur: 1.0, vol: 0.8 },
  m_beam: { src: require('@/assets/audio/sfx/m_beam.wav'), dur: 1.1, vol: 0.65 },
  m_static: { src: require('@/assets/audio/sfx/m_static.wav'), dur: 0.65, vol: 1 },
  m_overclock: { src: require('@/assets/audio/sfx/m_overclock.wav'), dur: 0.85, vol: 0.6 },
  m_gale: { src: require('@/assets/audio/sfx/m_gale.wav'), dur: 0.75, vol: 0.9 },
  m_siphon: { src: require('@/assets/audio/sfx/m_siphon.wav'), dur: 0.75, vol: 0.75 },
} as const;
export type SfxId = keyof typeof SFX;

export const MUSIC = {
  hub: require('@/assets/audio/music/hub.mp3'),
  garage: require('@/assets/audio/music/garage.mp3'),
  battle: require('@/assets/audio/music/battle.mp3'),
  boss: require('@/assets/audio/music/boss.mp3'),
} as const;
export type TrackId = keyof typeof MUSIC;

/** Each signature move's sound. */
export const MOVE_SFX: Record<MoveId, SfxId> = {
  'mandible-crusher': 'm_crush',
  'venom-barrage': 'm_venom',
  'carapace-lock': 'm_lock',
  'skitter-dash': 'm_dash',
  'web-snare': 'm_web',
  'burrow-strike': 'm_burrow',
  'ghost-shell': 'm_ghost',
  'sunder-beam': 'm_beam',
  'static-burst': 'm_static',
  overclock: 'm_overclock',
  'gale-flap': 'm_gale',
  'blood-siphon': 'm_siphon',
};
