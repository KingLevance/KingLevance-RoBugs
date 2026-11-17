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

## Getting it on your iPhone

The app is built **unsigned** on GitHub's Mac runners, and you sideload it with Sideloadly or AltStore (they sign it with your Apple ID). Code changes then reach the phone **over the air** (EAS Update), so most changes don't need a new install.

### One-time setup
1. Create an access token at expo.dev → Account → Access tokens.
2. In this GitHub repo: Settings → Secrets and variables → Actions → New repository secret. Name: `EXPO_TOKEN`. Value: the token.
3. Actions → **Expo setup (one-time)** → Run workflow. This links the EAS project (owner `levances-team`) and commits the update URL into `app.json`.

### New .ipa (only after native changes)
Actions → **iOS sideload IPA** → Run workflow (~20–40 min). Download `RoBugs-unsigned.ipa` from the new Release (or the run's artifacts) and sideload it.
You need a new .ipa after: adding a native library, changing config plugins, the icon/splash, or other native `app.json` settings. **Bump `"version"` in `app.json` when you do**, because updates only go to builds with the same version.

### Over-the-air update (everything else)
Actions → **Publish OTA update** → Run workflow, with a short message. It typechecks, lints and runs tests, then publishes. The app checks for updates on launch and when it returns to the foreground, then shows "Update ready · Restart". Settings → *Check for updates* checks on demand and shows which version is running.
