# RoBugs

Build a robotic bug from snap-together parts, then battle it in hazard-filled arenas.

- Design doc: [`docs/GDD.md`](docs/GDD.md)
- Conventions for contributors and AI agents: [`AGENTS.md`](AGENTS.md)

## Run it

```bash
npm install
npx expo start      # scan the QR code with Expo Go, or press w for web
```

## Checks

```bash
npx expo lint
npx tsc --noEmit
npx tsx scripts/simulate.ts   # headless balance check
```
