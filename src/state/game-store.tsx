import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';

import type { Build, Placement } from '@/game/build';
import { OPPONENTS, STARTER_BUILD, STARTER_INVENTORY } from '@/game/opponents';
import { rollRewards } from '@/game/rewards';

import { loadString, saveString } from './storage';

const SAVE_KEY = 'robugs.save.v1';

export type SaveData = {
  inventory: Record<string, number>;
  build: Build;
  wins: number;
  losses: number;
  /** Index into OPPONENTS of the next challenger. */
  ladder: number;
  /** Highest opponent index ever beaten (-1 = none). */
  cleared: number;
};

const FRESH: SaveData = {
  inventory: STARTER_INVENTORY,
  build: STARTER_BUILD,
  wins: 0,
  losses: 0,
  ladder: 0,
  cleared: -1,
};

function load(): SaveData {
  const raw = loadString(SAVE_KEY);
  if (!raw) return FRESH;
  try {
    return { ...FRESH, ...(JSON.parse(raw) as Partial<SaveData>) };
  } catch {
    return FRESH;
  }
}

type GameStore = SaveData & {
  setPlacements: (placements: Placement[]) => void;
  setBugName: (name: string) => void;
  /** Records a match result, grants rewards and returns the part ids won. */
  recordResult: (won: boolean) => string[];
  selectOpponent: (index: number) => void;
  resetSave: () => void;
};

const GameContext = createContext<GameStore | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<SaveData>(load);

  const update = useCallback((fn: (d: SaveData) => SaveData) => {
    setData((prev) => {
      const next = fn(prev);
      saveString(SAVE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const recordResult = useCallback(
    (won: boolean) => {
      const opp = OPPONENTS[data.ladder];
      const rewards = rollRewards(won, opp.rewardTier, won && data.ladder > data.cleared);
      update((d) => {
        const inventory = { ...d.inventory };
        for (const id of rewards) inventory[id] = (inventory[id] ?? 0) + 1;
        return {
          ...d,
          inventory,
          wins: d.wins + (won ? 1 : 0),
          losses: d.losses + (won ? 0 : 1),
          cleared: won ? Math.max(d.cleared, d.ladder) : d.cleared,
          ladder: won ? Math.min(d.ladder + 1, OPPONENTS.length - 1) : d.ladder,
        };
      });
      return rewards;
    },
    [data.ladder, data.cleared, update],
  );

  const value = useMemo<GameStore>(
    () => ({
      ...data,
      setPlacements: (placements) => update((d) => ({ ...d, build: { ...d.build, placements } })),
      setBugName: (name) => update((d) => ({ ...d, build: { ...d.build, name } })),
      recordResult,
      selectOpponent: (index) =>
        update((d) => ({ ...d, ladder: Math.max(0, Math.min(index, d.cleared + 1, OPPONENTS.length - 1)) })),
      resetSave: () => update(() => FRESH),
    }),
    [data, recordResult, update],
  );

  return <GameContext value={value}>{children}</GameContext>;
}

export function useGame(): GameStore {
  const ctx = use(GameContext);
  if (!ctx) throw new Error('useGame must be used inside GameProvider');
  return ctx;
}
