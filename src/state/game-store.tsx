import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';

import type { Build, Placement } from '@/game/build';
import { MOVE_SLOTS, type MoveId } from '@/game/moves';
import { getOpponent, OPPONENTS, STARTER_BUILD, STARTER_INVENTORY, STARTER_MOVES } from '@/game/opponents';
import { rollMatchRewards, type MatchRewards } from '@/game/rewards';

import { loadString, saveString } from './storage';

const SAVE_KEY = 'robugs.save.v2';

export type LastResult = {
  opponentId: string;
  winner: 0 | 1 | null;
  forfeited: boolean;
  firstClear: boolean;
  rewards: MatchRewards;
};

export type SaveData = {
  inventory: Record<string, number>;
  build: Build;
  /** Signature moves owned. */
  moves: MoveId[];
  /** Equipped moves, in slot order (max MOVE_SLOTS). */
  equipped: MoveId[];
  wins: number;
  losses: number;
  /** Opponent ids beaten at least once. */
  cleared: string[];
  /** Opponent selected on the campaign map. */
  selected: string;
  lastResult: LastResult | null;
};

const FRESH: SaveData = {
  inventory: STARTER_INVENTORY,
  build: STARTER_BUILD,
  moves: STARTER_MOVES,
  equipped: STARTER_MOVES.slice(0, MOVE_SLOTS),
  wins: 0,
  losses: 0,
  cleared: [],
  selected: OPPONENTS[0].id,
  lastResult: null,
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
  toggleEquip: (id: MoveId) => void;
  /** Records a match result, grants rewards and stores them as `lastResult`. */
  recordResult: (opponentId: string, winner: 0 | 1 | null, forfeited?: boolean) => void;
  selectOpponent: (id: string) => void;
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
    (opponentId: string, winner: 0 | 1 | null, forfeited = false) => {
      const opp = getOpponent(opponentId);
      const won = winner === 0;
      const firstClear = won && !data.cleared.includes(opponentId);
      const rewards = rollMatchRewards(opp, won, firstClear, forfeited);
      update((d) => {
        const inventory = { ...d.inventory };
        const moves = [...d.moves];
        for (const r of [...rewards.guaranteed, ...rewards.rolled]) {
          if (r.kind === 'part') inventory[r.id] = (inventory[r.id] ?? 0) + 1;
          else if (!moves.includes(r.id as MoveId)) moves.push(r.id as MoveId);
        }
        return {
          ...d,
          inventory,
          moves,
          wins: d.wins + (won ? 1 : 0),
          losses: d.losses + (winner === 1 ? 1 : 0),
          cleared: won && !d.cleared.includes(opponentId) ? [...d.cleared, opponentId] : d.cleared,
          lastResult: { opponentId, winner, forfeited, firstClear, rewards },
        };
      });
    },
    [data.cleared, update],
  );

  const value = useMemo<GameStore>(
    () => ({
      ...data,
      setPlacements: (placements) => update((d) => ({ ...d, build: { ...d.build, placements } })),
      setBugName: (name) => update((d) => ({ ...d, build: { ...d.build, name } })),
      toggleEquip: (id) =>
        update((d) => {
          if (d.equipped.includes(id)) return { ...d, equipped: d.equipped.filter((m) => m !== id) };
          if (d.equipped.length >= MOVE_SLOTS) return { ...d, equipped: [...d.equipped.slice(1), id] };
          return { ...d, equipped: [...d.equipped, id] };
        }),
      recordResult,
      selectOpponent: (id) => update((d) => ({ ...d, selected: id })),
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
