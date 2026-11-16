# RoBugs — agent guide

RoBugs is an **original** mobile game: players snap robotic bug parts together on a grid, then fight the result in a top-down arena. See `docs/GDD.md` for the design.

## Ground rules

- **Everything must be original.** Our own names, art, parts and look. Never copy assets, names, part designs or UI from Robocraft, BattleBots, or any other existing game/show.
- The owner often works **from a phone**. Keep updates short, and **commit + push often** so nothing is lost.
- Do not open a pull request unless asked.
- Open design questions live in `docs/GDD.md` → *Open decisions*. Don't silently decide them; note assumptions there.

## Stack

Expo (SDK 58) + React Native + **Expo Router** + TypeScript (strict). React Compiler is on.

### Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. Before writing code that touches an Expo, EAS or React Native API:

1. Read the major version of `expo` in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, start at https://docs.expo.dev/llms.txt and follow its links. Never answer from memory.
4. If the docs host is unreachable, read the installed package's types in `node_modules/<pkg>/build/*.d.ts` instead of guessing.

### Commands

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn add — picks SDK-compatible versions
npx expo start              # dev server (press w for web)
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx tsx scripts/simulate.ts # headless balance check: validates builds, runs AI-vs-AI matches
npx expo-doctor             # diagnose dependency/config issues
```

If the Expo API is blocked by the network (`HTTP Proxy Network Error: Forbidden`), prefix with `EXPO_OFFLINE=1`.

**Run lint and typecheck before declaring any task done.** After changing parts, opponents or sim numbers, also run the balance script.

## Project layout

```
src/app/            Expo Router routes only (every file is a screen)
  _layout.tsx       Stack navigator + GameProvider
  index.tsx         Hub: your bug, next challenger, ladder
  garage.tsx        Grid builder, parts bin, budget meters
  arena.tsx         Fight screen: render loop, joystick, results/rewards
src/game/           Pure TypeScript game logic — no React imports
  parts.ts          Part catalog (stats, rarity, colors)
  build.ts          Grid, stat calculation, validation, connectivity
  sim.ts            Arena simulation, damage model, hazards, AI, render snapshot
  opponents.ts      Starter build/inventory and the AI ladder
  rewards.ts        Loot rolls
src/state/          Save data (React context) + platform storage
src/components/     Shared UI
src/constants/      Theme tokens
scripts/            Dev tools (not shipped)
docs/GDD.md         Game design doc
```

Keep game rules in `src/game/` (testable headlessly) and keep screens thin.

## Rules

- Routes live in `src/app/`; keep non-route code out of it. Import `Link`/`router` from `expo-router`.
- Never create or edit `ios/` / `android/` by hand (Continuous Native Generation). Configure native behaviour via `app.json` and config plugins.
- Prefer Expo modules over third-party libraries. Adding a native library means Expo Go may no longer work → development build.
- Persistence uses `expo-sqlite/kv-store` on native and `localStorage` on web (`src/state/storage*.ts`).
