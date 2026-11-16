# RoBugs — agent guide

RoBugs is an **original** 3D mobile game: players snap robotic bug parts together on a grid, equip auto-proc signature moves, then fight through a campaign of AI opponents. See `docs/GDD.md` for the design.

## Ground rules

- **Everything must be original.** Our own names, art, parts and look. Never copy assets, names, part designs or UI from Robocraft, BattleBots, or any other existing game/show.
- The owner often works **from a phone**. Keep updates short, and **commit + push often** so nothing is lost.
- Do not open a pull request unless asked.
- Open design questions live in `docs/GDD.md` → *Open decisions*. Don't silently decide them; note assumptions there.

## Stack

Expo (SDK 58) + React Native + **Expo Router** + TypeScript (strict). React Compiler is on. 3D via `expo-gl` + `three` (renderer in `src/render/`).

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
  index.tsx         Hub: your bug, campaign shortcut
  campaign.tsx      Campaign map: nodes, unlocks, first-clear rewards, Fight
  garage.tsx        Grid builder, parts bin, budget meters, move equip
  arena.tsx         Fight screen: GLView + render loop, HUD, joystick, UltBanner
  rewards.tsx       Match results: guaranteed + rolled drops
src/game/           Pure TypeScript game logic — no React, no three
  parts.ts          Part catalog (stats, rarity, colors)
  build.ts          Grid, stat calculation, validation, connectivity
  moves.ts          Signature moves + PROC (proc-point) constants table
  sim.ts            Deterministic arena sim: damage, hazards, moves/ults, AI, HUD summary
  opponents.ts      Starter kit, opponents, loot tables, campaign map data
  rewards.ts        Loot rolls (guaranteed + weighted table)
src/render/         three.js only — reads sim state, never writes it
  models.ts         Toon voxel part models with outlines
  scene.ts          ArenaRenderer: scene, camera (incl. ult cutscene camera), VFX
src/state/          Save data (React context) + platform storage
src/components/     Shared UI (UltBanner, joystick, reward chips…)
src/constants/      Theme tokens
scripts/            Dev tools (not shipped)
docs/GDD.md         Game design doc
```

Keep game rules in `src/game/` (testable headlessly) and keep screens thin.

### Determinism (PvP-ready)

The sim must stay deterministic: fixed `STEP`, seeded RNG via `rand(sim)` only (never `Math.random` in `src/game/sim.ts`), all input via `step()`. `scripts/simulate.ts` checks this. Renderer code may use `Math.random` for cosmetics.

### Browser testing

`EXPO_OFFLINE=1 CI=1 npx expo start --web` — note `CI=1` disables file watching, so restart it (with `--clear`) after edits. Headless Chromium needs `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` for WebGL. In dev on web, the arena exposes the live sim as `globalThis.__robugsSim` for tests.

## Rules

- Routes live in `src/app/`; keep non-route code out of it. Import `Link`/`router` from `expo-router`.
- Never create or edit `ios/` / `android/` by hand (Continuous Native Generation). Configure native behaviour via `app.json` and config plugins.
- Prefer Expo modules over third-party libraries. Adding a native library means Expo Go may no longer work → development build.
- Persistence uses `expo-sqlite/kv-store` on native and `localStorage` on web (`src/state/storage*.ts`).
