/**
 * Sound effects and music (expo-audio).
 *
 * - `sfx(id)` plays a clip from a small pool of voices per sound, so hits can
 *   overlap; a minimum gap per sound keeps busy team fights from turning into
 *   noise.
 * - `useMusic(track)` sets a screen's music when it's focused; tracks loop
 *   and crossfade.
 * - Music and effects can each be switched off in Settings (stored on the
 *   device, separate from the save so "Reset save" keeps them).
 *
 * The audio session follows the phone's silent switch and mixes with other
 * apps' audio.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useFocusEffect } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { loadString, saveString } from '@/state/storage';

import { MUSIC, SFX, type SfxId, type TrackId } from './sounds';

export type { SfxId, TrackId } from './sounds';

const PREFS_KEY = 'robugs.audio.v1';
const MUSIC_VOLUME = 0.42;
const SFX_VOLUME = 0.9;
const MAX_VOICES = 3;

type Prefs = { music: boolean; sfx: boolean };

function readPrefs(): Prefs {
  try {
    const raw = loadString(PREFS_KEY);
    if (raw) return { music: true, sfx: true, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    // Fall through to defaults.
  }
  return { music: true, sfx: true };
}

let prefs = readPrefs();
const listeners = new Set<() => void>();

let sessionReady = false;
function ensureSession() {
  if (sessionReady) return;
  sessionReady = true;
  setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers', shouldPlayInBackground: false }).catch(() => {});
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    // Browsers block audio until the first tap: start the wanted track then.
    const unlock = () => {
      if (wanted && prefs.music) startTrack(wanted, false);
    };
    document.addEventListener('pointerdown', unlock);
  }
}

// ---------------------------------------------------------------- effects

type Voice = { player: AudioPlayer; busyUntil: number };
const pools = new Map<SfxId, Voice[]>();
const lastPlayed = new Map<SfxId, number>();

function voiceFor(id: SfxId, now: number): Voice {
  let pool = pools.get(id);
  if (!pool) {
    pool = [];
    pools.set(id, pool);
  }
  const free = pool.find((v) => v.busyUntil <= now);
  if (free) return free;
  if (pool.length < MAX_VOICES) {
    const v = { player: createAudioPlayer(SFX[id].src), busyUntil: 0 };
    pool.push(v);
    return v;
  }
  // All busy: steal the one that started first.
  return pool.reduce((a, b) => (a.busyUntil <= b.busyUntil ? a : b));
}

/**
 * Play a sound effect.
 * - `volume`: multiplier on the clip's mix level.
 * - `rate`: playback speed (also shifts pitch), for variety.
 * - `gap`: minimum ms between two plays of this sound (default 40).
 */
export function sfx(id: SfxId, opts: { volume?: number; rate?: number; gap?: number } = {}) {
  if (!prefs.sfx) return;
  ensureSession();
  const now = Date.now();
  if (now - (lastPlayed.get(id) ?? -1e9) < (opts.gap ?? 40)) return;
  lastPlayed.set(id, now);
  const rate = opts.rate ?? 1;
  const v = voiceFor(id, now);
  v.busyUntil = now + (SFX[id].dur * 1000) / rate + 30;
  try {
    const p = v.player;
    p.volume = Math.min(1, SFX[id].vol * (opts.volume ?? 1) * SFX_VOLUME);
    if (p.playbackRate !== rate) {
      p.shouldCorrectPitch = false;
      p.setPlaybackRate(rate);
    }
    void p.seekTo(0).catch(() => {});
    p.play();
  } catch {
    // Audio is decoration: never let it break the game.
  }
}

/** Create the voices for these sounds ahead of time (avoids a delay on first play). */
export function preloadSfx(ids: SfxId[]) {
  if (!prefs.sfx) return;
  ensureSession();
  for (const id of ids) if (!pools.get(id)?.length) pools.set(id, [{ player: createAudioPlayer(SFX[id].src), busyUntil: 0 }]);
}

// ---------------------------------------------------------------- music

const tracks = new Map<TrackId, AudioPlayer>();
let current: TrackId | null = null;
let wanted: TrackId | null = null;
const fades = new Map<AudioPlayer, ReturnType<typeof setInterval>>();

function fade(p: AudioPlayer, to: number, ms: number, then?: () => void) {
  const prev = fades.get(p);
  if (prev) clearInterval(prev);
  const from = p.volume;
  const t0 = Date.now();
  const id = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / ms);
    try {
      p.volume = from + (to - from) * k;
    } catch {
      // Player gone.
    }
    if (k >= 1) {
      clearInterval(id);
      fades.delete(p);
      then?.();
    }
  }, 40);
  fades.set(p, id);
}

function startTrack(id: TrackId, restart: boolean) {
  let p = tracks.get(id);
  if (!p) {
    p = createAudioPlayer(MUSIC[id]);
    p.loop = true;
    p.volume = 0;
    tracks.set(id, p);
  }
  try {
    if (restart) void p.seekTo(0).catch(() => {});
    if (!p.playing) p.play();
  } catch {
    return;
  }
  fade(p, MUSIC_VOLUME, 600);
}

function stopTrack(id: TrackId) {
  const p = tracks.get(id);
  if (!p) return;
  fade(p, 0, 450, () => {
    try {
      if (current !== id) p.pause();
    } catch {
      // Player gone.
    }
  });
}

/**
 * Switch the music. `restart` starts the track from the top (fights);
 * otherwise a track that was paused carries on where it left off.
 */
export function setMusic(id: TrackId | null, restart = false) {
  wanted = id;
  ensureSession();
  if (!prefs.music) return;
  if (current && current !== id) stopTrack(current);
  current = id;
  if (id) startTrack(id, restart);
}

/** Set this screen's music whenever it gains focus. */
export function useMusic(id: TrackId | null, restart = false) {
  useFocusEffect(
    useCallback(() => {
      setMusic(id, restart);
    }, [id, restart]),
  );
}

// ---------------------------------------------------------------- settings

export function getAudioPrefs() {
  return prefs;
}

export function setAudioPref(key: keyof Prefs, on: boolean) {
  prefs = { ...prefs, [key]: on };
  saveString(PREFS_KEY, JSON.stringify(prefs));
  if (key === 'music') {
    if (on) {
      current = null;
      setMusic(wanted);
    } else if (current) {
      stopTrack(current);
      current = null;
    }
  }
  for (const l of listeners) l();
}

export function useAudioPrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getAudioPrefs,
    getAudioPrefs,
  );
}
