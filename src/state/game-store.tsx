import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';

import type { Build, Placement } from '@/game/build';
import { MOVE_SLOTS, type MoveId } from '@/game/moves';
import { getOpponent, OPPONENTS, STARTER_BUILD, STARTER_INVENTORY, STARTER_MOVES } from '@/game/opponents';
import { rollMatchRewards, type MatchRewards } from '@/game/rewards';
import { rateWin, type StarCheck } from '@/game/stars';

import { loadString, saveString } from './storage';

const SAVE_KEY = 'robugs.save.v2';

export type LastResult = {
  opponentId: string;
  winner: 0 | 1 | null;
  forfeited: boolean;
  firstClear: boolean;
  rewards: MatchRewards;
  /** Stars earned this fight (0 on a loss) and which challenges were met. */
  stars: number;
  checks: StarCheck[];
  /** Stars on this fight before this result. */
  prevBest: number;
};

/** One bug in your garage: its build and the moves it has equipped. */
export type SavedBug = Build & { equipped: MoveId[] };

/** Most bugs you can keep in the garage. */
export const MAX_BUGS = 6;

export type SaveData = {
  inventory: Record<string, number>;
  /** Every bug in your garage. They share your parts inventory (each is a blueprint). */
  bugs: SavedBug[];
  /** Index of the bug you're editing and lead into battle. */
  active: number;
  /** Indices of the bugs that join you in team fights, in order. */
  squad: number[];
  /** Signature moves owned. */
  moves: MoveId[];
  wins: number;
  losses: number;
  /** Opponent ids beaten at least once. */
  cleared: string[];
  /** Best stars earned on each opponent (1–3). */
  stars: Record<string, number>;
  /** Opponent selected on the campaign map. */
  selected: string;
  lastResult: LastResult | null;
};

const FRESH: SaveData = {
  inventory: STARTER_INVENTORY,
  bugs: [{ ...STARTER_BUILD, equipped: STARTER_MOVES.slice(0, MOVE_SLOTS) }],
  active: 0,
  squad: [],
  moves: STARTER_MOVES,
  wins: 0,
  losses: 0,
  cleared: [],
  stars: {},
  selected: OPPONENTS[0].id,
  lastResult: null,
};

function load(): SaveData {
  const raw = loadString(SAVE_KEY);
  if (!raw) return FRESH;
  try {
    const saved = JSON.parse(raw) as Partial<SaveData> & { build?: Build; equipped?: MoveId[] };
    // Older saves had a single `build` + `equipped`: that becomes your first bug.
    const bugs = saved.bugs?.length ? saved.bugs : saved.build ? [{ ...saved.build, equipped: saved.equipped ?? [] }] : FRESH.bugs;
    const { build: _b, equipped: _e, ...rest } = saved;
    const active = Math.min(Math.max(0, rest.active ?? 0), bugs.length - 1);
    // Clears from before stars existed count as 1 star.
    const stars = { ...Object.fromEntries((rest.cleared ?? []).map((id) => [id, 1])), ...(rest.stars ?? {}) };
    return { ...FRESH, ...rest, stars, bugs, active, squad: (rest.squad ?? []).filter((i) => i < bugs.length && i !== active) };
  } catch {
    return FRESH;
  }
}

/** A fresh name that isn't taken yet: "Bug 2", "Bug 3"… */
function newName(bugs: SavedBug[]) {
  for (let n = bugs.length + 1; ; n++) if (!bugs.some((b) => b.name === `Bug ${n}`)) return `Bug ${n}`;
}

type GameStore = SaveData & {
  /** The active bug's build (the one in the garage and leading into battle). */
  build: Build;
  /** The active bug's equipped moves, in slot order (max MOVE_SLOTS). */
  equipped: MoveId[];
  setPlacements: (placements: Placement[]) => void;
  setBugName: (name: string) => void;
  toggleEquip: (id: MoveId) => void;
  /** Switch which bug you're editing / leading. */
  selectBug: (index: number) => void;
  /** Add a bug: an empty frame, or a copy of an existing one. Returns false if the garage is full. */
  addBug: (copyOf?: number) => boolean;
  deleteBug: (index: number) => void;
  /** Add or remove a bug from your team-fight squad. */
  toggleSquad: (index: number) => void;
  /** Records a match result, grants rewards and stores them as `lastResult`. */
  recordResult: (opponentId: string, winner: 0 | 1 | null, forfeited?: boolean, perf?: { hp: number; time: number }) => void;
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
    (opponentId: string, winner: 0 | 1 | null, forfeited = false, perf = { hp: 0, time: Infinity }) => {
      const opp = getOpponent(opponentId);
      const won = winner === 0 && !forfeited;
      const firstClear = won && !data.cleared.includes(opponentId);
      const rating = won ? rateWin(opp, perf.hp, perf.time) : { stars: 0, checks: [] };
      // A save from before stars counts an old clear as 1 star.
      const prevBest = data.stars?.[opponentId] ?? (data.cleared.includes(opponentId) ? 1 : 0);
      const rewards = rollMatchRewards(opp, won, firstClear, forfeited, Math.random, rating.stars, rating.stars >= 3 && prevBest < 3);
      update((d) => {
        const inventory = { ...d.inventory };
        const moves = [...d.moves];
        for (const r of [...rewards.guaranteed, ...rewards.rolled, ...rewards.bonus]) {
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
          stars: won ? { ...d.stars, [opponentId]: Math.max(prevBest, rating.stars) } : d.stars,
          lastResult: { opponentId, winner, forfeited, firstClear, rewards, stars: rating.stars, checks: rating.checks, prevBest },
        };
      });
    },
    [data.cleared, data.stars, update],
  );

  const value = useMemo<GameStore>(() => {
    /** Change the active bug. */
    const edit = (fn: (b: SavedBug) => SavedBug) =>
      update((d) => ({ ...d, bugs: d.bugs.map((b, i) => (i === d.active ? fn(b) : b)) }));
    const bug = data.bugs[data.active];
    return {
      ...data,
      build: { name: bug.name, placements: bug.placements },
      equipped: bug.equipped,
      setPlacements: (placements) => edit((b) => ({ ...b, placements })),
      setBugName: (name) => edit((b) => ({ ...b, name })),
      toggleEquip: (id) =>
        edit((b) => {
          if (b.equipped.includes(id)) return { ...b, equipped: b.equipped.filter((m) => m !== id) };
          if (b.equipped.length >= MOVE_SLOTS) return { ...b, equipped: [...b.equipped.slice(1), id] };
          return { ...b, equipped: [...b.equipped, id] };
        }),
      selectBug: (index) =>
        update((d) => (index < 0 || index >= d.bugs.length ? d : { ...d, active: index, squad: d.squad.filter((i) => i !== index) })),
      addBug: (copyOf) => {
        if (data.bugs.length >= MAX_BUGS) return false;
        update((d) => {
          const src = copyOf !== undefined ? d.bugs[copyOf] : undefined;
          const fresh: SavedBug = src
            ? { ...src, name: `${src.name} II`.slice(0, 18), placements: [...src.placements], equipped: [...src.equipped] }
            : { name: newName(d.bugs), placements: [], equipped: [] };
          return { ...d, bugs: [...d.bugs, fresh], active: d.bugs.length };
        });
        return true;
      },
      deleteBug: (index) =>
        update((d) => {
          if (d.bugs.length <= 1) return d;
          const bugs = d.bugs.filter((_, i) => i !== index);
          const shift = (i: number) => (i > index ? i - 1 : i);
          const active = index === d.active ? 0 : shift(d.active);
          return { ...d, bugs, active, squad: d.squad.filter((i) => i !== index).map(shift).filter((i) => i !== active) };
        }),
      toggleSquad: (index) =>
        update((d) => {
          if (index === d.active) return d;
          if (d.squad.includes(index)) return { ...d, squad: d.squad.filter((i) => i !== index) };
          // Keep the two most recently picked.
          return { ...d, squad: [...d.squad, index].slice(-2) };
        }),
      recordResult,
      selectOpponent: (id) => update((d) => ({ ...d, selected: id })),
      resetSave: () => update(() => FRESH),
    };
  }, [data, recordResult, update]);

  return <GameContext value={value}>{children}</GameContext>;
}

export function useGame(): GameStore {
  const ctx = use(GameContext);
  if (!ctx) throw new Error('useGame must be used inside GameProvider');
  return ctx;
}
