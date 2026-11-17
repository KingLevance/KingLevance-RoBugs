# RoBugs — Game Design Doc (v0.2)

> Build a bug. Break a bug.

RoBugs is an original 3D mobile game. You collect robotic bug parts, snap them onto a grid to build your own robo-bug, then fight it in hazard-filled arenas. Winning earns new parts and rarer upgrades.

## 0. Decided (Nov 2026)

| Topic | Decision |
|---|---|
| Dimension | **3D.** `expo-gl` + `three`; the sim stays 2D on the arena floor plane and the renderer lifts it into 3D. |
| Art style | Cartoony and chunky: rounded toy-robot parts, bright colours, toon shading and bold outlines. All our own designs. Every catalog part has its own model. Parts animate: a walking gait tied to distance travelled, body bob and lean into turns, jaws and claws that snap when they strike, flapping wings, swaying antennae. |
| Joint physics | Parts hang off their neighbours through damped springs (`src/render/flex.ts`, cosmetic only, so the sim stays deterministic). Parts lag and bounce when the bug accelerates, turns, flies, is hit, or is lifted by a move; the sway ripples out to the tips (legs, wings, antennae), and struts stretch to follow. |
| UI style | Chunky "workshop" look: Lilita One display font for titles, buttons and numbers; raised buttons with a lip that presses down; rounded panels with a lit top edge. The hub shows your bug turning on a lit pedestal (live 3D), a next-fight card with the opponent's portrait, and Garage/Campaign tiles. The campaign map uses rendered opponent portraits as nodes (black silhouettes while locked, a ✓ when beaten, a crown on bosses). Results open with a pop-in VICTORY/DEFEAT title over the opponent's portrait. |
| Part models | Rounded toon shapes with outlines and a soft rim light, all built from primitives and small procedural textures. Legs have an armoured upper segment and a knee that folds as the foot lifts (and tucks up in flight). Wings have veined, gradient membranes; foil wings are beetle wing cases that lift open so the membranes can beat. Heads blink or sweep a visor scanner; vents, fluids and cores glow. |
| Garage feedback | The selected part gets a bright amber outline, a bobbing arrow and a soft glow while the rest of the bug dims; a SELECTED chip on the editor names it with Remove / ✕. A status bar pinned under the 3D editor always shows what the bug STILL NEEDS (red) or ✓ READY TO FIGHT with a Fight button (green). |
| Readability | Rarity is shown in the UI only (coloured frame, 1–4 pips and a printed label on bin tiles), never on the 3D models. Part chips use renders of the real 3D models. In fights, teams are marked subtly: a thin faint ring under each bug and a small pointer over the player's. |
| Main mode | **Single-player campaign**: a map of opponents with guaranteed first-clear drops and farmable bosses. |
| Signature moves | Equippable, unlockable moves that **auto-proc** and play a short cutscene. See §6. |
| Controls | **Fights are autonomous.** Your bug's AI plays to its build: melee charges, ranged kites, hurt bugs circle. The player's skill is in building and choosing moves. A 1×/2× speed toggle is available while watching. |
| Garage | **3D editor.** The bug is shown exactly as it looks in the arena. Drag empty space to spin the view; Angle/Top/Side/Front buttons jump to preset views (eye-level views zoom to the bug). Drag a part to move it (swaps if the slot is taken), drag it off the grid to remove it, and tap a part in the bin to auto-attach it to a sensible slot. |
| Teaching | The garage explains itself. Each part kind has a plain-language label (thorax = "middle body", abdomen = "tail body"), a "what it does" and a "where it goes" line (`src/game/guide.ts`). Selecting a part lights up its best slots in green (`rankSlots`). A checklist shows what the bug still needs. The bin is grouped into Body / Movement / Weapons / Power & defense. **Auto-build** assembles a legal, mirrored bug from the player's best parts. |
| Hit feedback | Every hit emits a sim event. The renderer reacts: the struck part pops, the victim flinches away and the attacker follows through, sparks fly (blue if shielded, orange for heavy hits), and a part breaking gets a shockwave, a burst in its colour, a beat of hit-stop and a camera shake. Floating damage numbers and "X BROKEN!" callouts are drawn as an overlay (gold for damage you deal, red for damage you take). |
| Flight | Bugs whose wing lift is high enough for their weight fly (`BugStats.maxAlt`, up to ~3 cells). Flyers cruise high (over acid and out of reach of ground jaws), dive to the enemy's height to strike, and climb out. **Wing stamina** (2–5 s depending on lift) forces them to land and recover, which is the window to punish them. Losing wings mid-air means falling, and a hard landing does crash damage to the underside and legs. Melee reach and darts are 3D; bugs at different heights don't collide. |
| Arena presentation | Each arena has its own theme (`src/render/arena.ts`, procedural textures, no assets): **Acid Pit** has rusty riveted plates and sunken bubbling, steaming acid vats; **Stomper Foundry** has tread-plate steel with glowing molten seams and hydraulic presses that drop in from above (a darkening shadow and blinking floor lamps warn before the slam); **Hive Ring** has a honeycomb floor in amber. All three get hazard-striped borders and bumper walls with rails, corner pylon lights, a sky dome, sweeping floodlight beams, dust motes, and a crowd that cheers when parts break, crashes happen or ultimates land. Presses fade to see-through when a bug is underneath. Raised arena platform inside a stadium bowl (tiered stands, crowd, floodlights). The fight camera is a three-quarter view from behind the player's bug looking at the opponent; it swings round as they circle and pulls back and up as they separate or fly. |
| Stacking | Wings, sensors and **power cores** can stack **on top of** a head, thorax, tail body or armor plate (`z = 1`). **Cores** can instead be **slung underneath** (`z = -1`): hidden from weapons while the part above survives, but acid and crash landings hit them first. The part above rides higher. One part per layer per tile. Drop a stackable part onto such a part to mount it; tapping one in the bin stacks wings on the thorax and antennae on the head by default. Stacked parts move with their base, drop into the tile if the base is removed, and fall off in a fight when the base breaks. |
| PvP | **Later phase.** The sim is already deterministic (seeded RNG, fixed 60 Hz step, input-driven, no rendering) so async/online PvP can be added without a rewrite. |

## 1. Core loop

```
Garage (build + equip moves) → Campaign map → 3D Arena (1v1 vs AI) → Rewards (guaranteed + rolled) → Garage …
```

1. **Build** — place parts on a 5×7 grid. Your layout sets weight, speed, handling, armor and attacks.
2. **Fight** — after a 3-2-1-FIGHT! countdown, which starts once the arena has drawn its first frames (the bugs hold still while the camera swoops down from a high orbit), watch your bug fight on its own; its AI plays to the build. Weapons fire on their own when an enemy part is in their cone and reach. Basic actions fill your **proc meter**, and equipped signature moves fire on their own when they make sense. Parts get knocked off one by one.
3. **Earn** — first clears give guaranteed parts and moves. Bosses can be re-fought for rolls on their loot table. A loss still gives one common salvage part.

## 2. Parts

Each part takes one grid cell. Row 0 is the front of the bug.

| Category | Role | Key stats |
|---|---|---|
| **Head** | Cockpit. Exactly one per bug. | HP, grip |
| **Thorax** | Core frame. Lose every thorax → you're out. | HP (high) |
| **Abdomen** | Rear body segment, extra mounting area. | HP |
| **Legs** | Main drive and grip. Left/right balance matters. | thrust, grip |
| **Wings** | Speed burst plus lift, which offsets mass. Fragile. | thrust, lift |
| **Mandibles** | Front biting weapon. Short reach, steady damage. | dmg, cooldown, arc |
| **Pincers** | Wide-sweep crushing claws. | dmg, wide arc |
| **Stinger** | Ranged: fires darts. | dmg, long reach, narrow arc |
| **Horn** | Ram weapon. Bonus damage from closing speed. | ramBonus |
| **Armor** | High-HP plate. Put it on the edges to shield inner parts. | HP |
| **Power core** | Supplies power. Lose every core → you shut down. | power supply |
| **Sensor** | Better turning and +10–20% weapon reach. | grip, reach |

**Rarities:** common (grey), uncommon (green), rare (blue), epic (purple). Higher rarities are separate, stronger parts (e.g. *Gnasher Jaws* → *Shearfang Jaws*), not just stat multipliers.

There are 26 parts right now (`src/game/parts.ts`).

## 3. Stats and budgets

Stats come from the parts still attached to the bug (`computeStats`):

- **Mass** = Σ mass. **Effective mass** = max(60% of mass, mass − lift).
- **Top speed** = thrust ÷ effective mass × 60 (capped).
- **Turn rate** = (1.2 + Σ grip) × 40 ÷ effective mass.
- **Thrust bias**: legs left of centre vs right of centre. If one side is weaker, the bug pulls to that side. This matters once legs get shot off.
- **Reach**: sensors add 10% or 20% weapon range (max ×1.4).

**Budgets (hard limits; you can't fight while over them):**
- **Power**: total power draw ≤ total core supply.
- **Weight**: mass ≤ 150.
- **Structure**: every part must connect to a thorax through neighbouring parts. You need exactly 1 head, at least 1 thorax, at least 1 core, and some legs or wings.

On top of the hard cap, weight is a soft trade-off: heavier bugs are slower and turn worse.

## 4. Damage model

- Every part has its own HP.
- A strike hits the enemy part nearest the weapon, or a random part right next to it. Damage varies ±20% (× a global `DAMAGE_SCALE`). Outer parts, especially armor, soak hits for the parts inside.
- When a part hits 0 HP it's destroyed. Then a **connectivity check** runs: anything no longer linked to the main thorax group **breaks off**. Lose the plate your jaws were bolted to and the jaws go too.
- Stats are recalculated live. Lose legs and you slow down and pull to one side. Lose a weapon and that attack is gone. Lose wings and you lose speed.
- **Knockout**: no core left, or no thorax left.
- **Time limit** is 90 s. After that the judges pick whoever has the most remaining integrity (HP %).
- **Collisions**: bugs push each other by mass. Hard rams hurt both bugs at the contact point, scaled by the mass ratio.

## 5. Arenas and hazards

| Arena | Hazards |
|---|---|
| **The Acid Pit** | Two acid pools (damage over time to random parts); padded walls |
| **Stomper Foundry** | Central stomper (glows before it slams, then hits the 3 nearest parts hard); acid in the corners; **spiked walls** (hitting a wall fast damages the part that hits it) |
| **The Hive Ring** | Two stompers out of sync, central acid, spiked walls |

## 6. Signature moves

Moves are unlocked like parts (from drops) and **equipped** in the Garage. There are **2 slots**.

**Auto-proc.** The player never presses a button. A bug fires an equipped move when all of these are true:
1. the move is off cooldown,
2. the bug has enough **proc points** (PP) for it,
3. the bug still has the parts the move needs (e.g. *Mandible Crusher* needs living mandibles; break them off and the move is dead), and
4. the move's **judgement** says now is a good time (target in reach and in front, heavy damage just taken, etc.).

**Proc points** (one constants table, `PROC` in `src/game/moves.ts`, max 100, reset every match):

| Action | PP |
|---|---|
| Land a basic hit | +4 |
| Hit absorbed by your armor | +2 |
| Break an enemy part | +12 |
| Take damage | +1 per 5 dmg (comeback) |
| Survive a stomper / dodge (Skitter) | +6 |

**Critical hits** (`CRIT` in `sim.ts`): weapon hits (jaws, pincers, horns, stinger darts; not hazards, collisions or move volleys) can crit for ×1.6 damage. Chance = 6% base, +6% from the victim's side or +12% from behind, plus sensors (+4% Feeler Antennae, +7% Echo Array, capped at +15%), max 35%. Crits give +4 extra proc, a beat of hit-stop and shake, an orange flash, ring and sparks, and a big orange **CRIT n!** number. Flanking AI therefore pays off. The garage shows each build's crit chance. About 8–11% of hits crit in the balance script.

**Ultimates** (`isUltimate(id)`) play a cutscene:
- **Sim:** casting sets `sim.ult = { id, caster, t, dur: ULT_SECONDS (1.6) }`. While it's set, the rest of the world is frozen and the caster can't be hurt. At `t ≥ dur` the move lands with hit-stop, screen shake and a white flash.
- **Choreography (renderer only, `ArenaRenderer.poseCine` / `releaseFx`):** each move has its own charge-up and payoff, followed by a 0.8 s follow-through that keeps the cinematic camera and plays the impact in brief slow motion (`timeScale`, which only paces the screen's sim loop, so the sim stays deterministic).
  - **Mandible Crusher:** drops low with jaws spread wide, draws back shuddering while red energy streams into the jaws, then lunges (speed streaks) and the jaws slam shut: red and white bite flash, double shockwave and sparks. Camera: low front three-quarter pushing in, then cuts to a side shot framing both bugs for the bite.
  - **Venom Barrage:** plants wide and pulses venom into a growing orb at the stinger (creeping back with each pulse); on release, a muzzle flash, recoil kick and seven glowing darts with tails. Camera: over the shoulder, looking down the barrel at the target.
  - **Carapace Lock:** hunkers down, tucks its legs and spins a full turn while blue plates stream in and a faceted shell closes around it; the shell then holds (pulsing) for as long as the shield lasts. Camera: circles the bug.
  - **Skitter Dash** (not an ultimate): a puff of dust and green speed streaks.
- **Focus:** the background fades into fog around the caster. *(A true depth-of-field blur pass is a TODO.)*
- **UI (`UltBanner`):** letterbox bars (~13% of screen height each), and the move name slams in from the right on a skewed stripe in the move's colour, drifts, then flies out left. The HUD hides while it plays.
- **Charge VFX:** a ring at the caster's feet in the move's colour and sparks streaming into the weapon (or onto the shell).

Starting moves: **Mandible Crusher** (mandibles; heavy multi-part bite), **Venom Barrage** (stinger; fan of darts), **Carapace Lock** (armor; 4 s damage shield), **Skitter Dash** (legs; small, non-ultimate side-dodge).

## 7. AI

Fights are autonomous, and both bugs use the same driver (`aiInput` in `sim.ts`). It's a small deterministic state machine per bug:

- **Target choice:** it picks the enemy part most worth breaking, favouring valuable, damaged, outer parts (cores, weapons, legs over armor).
- **Approach:** it heads for the side of the enemy where that part sits. If it's in front of the enemy's melee weapons, it **circles round to the flank** first. Nimble builds (better turning or speed than the enemy) flank harder.
- **Strike:** it dives at the target part, leading it by its own travel time, which cuts off kiters.
- **Retreat:** after a flurry, or when losing the melee trade, it peels away on an arc, switches sides and re-engages, possibly on a new target.

Build-driven styles:
- **Rammers** (horns) back off for a run-up, then charge.
- **Snipers** (only ranged weapons) orbit at range and turn in to shoot when a stinger is ready.
- **Heavies** (≥1.3× the enemy's mass) set up so their push drives the enemy into acid or stompers.
- **Unarmed bugs** run.

All bugs use **context steering**: every frame they score 16 directions by how well each matches where they want to go, minus the danger along it (walls, with only getting closer counting; acid near the floor; presses about to slam). They also ease off the throttle to turn on the spot when pointed at danger. Retreats, rammer run-ups and sniper orbits pick the side with more open floor; a missed charge pulls out before the wall; a bug wedged on a wall breaks out toward the middle; and the skitter dash never dashes into a wall. On spiked arenas, a bug at least as heavy as its foe tries to get between the foe and the middle so it can pin it against the spikes. `npm test` reports wall hits per match and how many were self-inflicted (target: ~0). Move judgement is shared too: both bugs auto-proc their signature moves.

Measured with `scripts/simulate.ts` and an ad-hoc behaviour probe: about 5–7 clashes per match, and roughly half of all hits land on the sides or rear.

## 8. Campaign and loot

The campaign map (`src/game/campaign.ts`) is a path of nodes. Each node unlocks when its `requires` nodes are cleared.

Each opponent has:
- `guaranteed: Reward[]` — given **once**, on first clear (parts or moves).
- `lootTable: { reward, weight }[]` — **weighted rolls, repeatable.** Normal opponents roll once per win. **Bosses** (`boss: true`) roll 3 times per win and can be farmed; their tables include their **signature parts and moves** at low weight.
- A loss gives one common salvage part. **Forfeiting gives nothing.**

A `Reward` is `{ kind: 'part' | 'move', id }`.

Saves are stored on the device (SQLite key-value store on native, localStorage on web).

## 9. Determinism (for future PvP)

- Fixed 60 Hz timestep and a seeded RNG (`mulberry32`) stored in sim state. The sim never calls `Math.random`.
- Every input comes in through `step(sim, dt, inputs)`, and the AI is a pure function of sim state.
- Rendering only reads sim state. A match can be replayed from `(seed, builds, input log)`.

## 10. Roadmap

1. **Milestone 1 (current):** garage, campaign map with a farmable boss, 3D arena with per-part damage, proc meter, auto-proc signature moves with cutscenes, rewards screen.
2. Art pass: hand-made voxel models per part, arena dressing, audio.
3. Async PvP: fight AI-piloted snapshots of other players' builds (needs a backend).
4. Real-time PvP (netcode, server-side sim).

## 11. Open decisions (for the owner)

1. **Pre-fight tactics.** Should players get light control over the autonomous AI, such as an aggressive/defensive stance or a target-priority setting?
2. **Part orientation.** Parts can't be rotated yet. Do we want rotatable or mirrored parts (e.g. a rear-facing stinger)?
3. **Grid size and shape.** Currently 5×7. Should it grow with progression?
4. **Economy.** Should there be scrap or currency to craft or upgrade parts? Duplicates currently just stack.
5. **Monetisation.** None, premium, or cosmetic-only? (No pay-to-win is assumed.)
6. **Move slots.** 2 for now. Should more unlock through the campaign?
7. **Balance.** First-pass numbers. Fights often go to time, and melee mirror matches can snowball.
