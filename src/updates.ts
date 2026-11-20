/**
 * Over-the-air updates (EAS Update).
 *
 * - Checks ~4 s after launch and whenever the app comes back to the
 *   foreground (at most once per 10 min), and downloads in the background.
 * - Once an update is downloaded, `useUpdateReady()` turns true and the
 *   UpdateBanner offers a restart.
 * - Does nothing on web, in development, or when updates aren't configured.
 */
import * as Updates from 'expo-updates';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { stopAllAudio } from '@/audio/audio';

const LAUNCH_DELAY_MS = 4000;
const THROTTLE_MS = 10 * 60 * 1000;

export const updatesActive = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled;

let lastCheck = 0;
let checking = false;

export type CheckResult = 'disabled' | 'none' | 'downloaded' | 'error';

/** Check for an update and download it if there is one. */
export async function checkForUpdate(force = false): Promise<CheckResult> {
  if (!updatesActive) return 'disabled';
  const now = Date.now();
  if (checking || (!force && now - lastCheck < THROTTLE_MS)) return 'none';
  checking = true;
  lastCheck = now;
  try {
    const res = await Updates.checkForUpdateAsync();
    if (!res.isAvailable) return 'none';
    const fetched = await Updates.fetchUpdateAsync();
    return fetched.isNew ? 'downloaded' : 'none';
  } catch {
    return 'error';
  } finally {
    checking = false;
  }
}

/** Mount once at the root: schedules launch + foreground checks. */
export function useBackgroundUpdates() {
  useEffect(() => {
    if (!updatesActive) return;
    const t = setTimeout(() => void checkForUpdate(true), LAUNCH_DELAY_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void checkForUpdate();
    });
    return () => {
      clearTimeout(t);
      sub.remove();
    };
  }, []);
}

/** True once an update has been downloaded and is waiting for a restart. */
export function useUpdateReady(): boolean {
  const { isUpdatePending } = Updates.useUpdates();
  return updatesActive && isUpdatePending;
}

/** Restart into the downloaded update. Saves are synchronous, but give any pending state flush a beat. */
export async function applyUpdate() {
  if (!updatesActive) return;
  // Native audio players survive the reload: stop them, or the old music plays under the new.
  stopAllAudio();
  await new Promise((r) => setTimeout(r, 250));
  await Updates.reloadAsync();
}

/** Human-readable description of the code that's running right now. */
export function runningVersion(): string {
  if (Platform.OS === 'web') return 'web build';
  if (__DEV__) return 'development build';
  const runtime = Updates.runtimeVersion ?? 'unknown';
  if (!Updates.isEnabled) return `v${runtime} (updates off)`;
  if (Updates.isEmbeddedLaunch || !Updates.createdAt) return `v${runtime} · as installed`;
  return `v${runtime} · update of ${Updates.createdAt.toLocaleDateString()} ${Updates.createdAt.toLocaleTimeString()}`;
}
