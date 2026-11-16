# RoBugs — Game Design Doc (v0.1, prototype)

> Build a bug. Break a bug.

RoBugs is an original mobile game. You collect robotic bug parts, snap them onto a grid to build your own robo-bug, then fight it in hazard-filled arenas. Winning earns new parts and rarer upgrades.

## 1. Core loop

```
Garage (build) → Arena (fight 1v1 vs AI) → Rewards (new parts) → Garage …
```

1. **Build** — place parts on a 5×7 grid. Your layout sets weight, speed, handling, armor and attacks.
2. **Fight** — drive with a thumbstick. Weapons fire on their own when an enemy part is in their cone and reach. Parts get knocked off one by one.
3. **Earn** — win to get parts up to the opponent's rarity tier and unlock the next challenger. A loss still gives one common salvage part.

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

## 6. AI

A simple steering AI (`aiInput` in `sim.ts`):
- **Melee builds** charge in and aim a little ahead of where the target is going.
- **Ranged builds** kite: they back off when close and hold still to aim at mid range.
- **Hurt, low-aggression** bugs circle instead of charging.
- **All AI bugs** steer around acid and charging stompers and stay away from walls.

Opponent ladder: Rustmite → Needlewisp → Snapclaw → Ironback → Queen Vexa (boss). Each one is a fixed hand-made build.

## 7. Progression

- New players start with a starter inventory and the *Sprocket* build.
- **Win**: 2 parts rolled up to the opponent's rarity tier (weights: common 50 / uncommon 30 / rare 15 / epic 6). The **first win** against an opponent also gives one guaranteed part at their top tier.
- **Loss**: 1 common salvage part.
- Beating an opponent unlocks the next one. You can rematch any opponent you've unlocked to farm parts.
- Saves are stored on the device (SQLite key-value store on native, localStorage on web).

## 8. Prototype scope (what exists now)

- 2D top-down, simple geometric sprites (coloured part tiles), no audio.
- Hub, Garage, and Arena screens; single-player ladder of 5 opponents across 3 arenas.
- Headless balance script: `npx tsx scripts/simulate.ts`.

## 9. Open decisions (for the owner)

1. **2D vs 3D.** The prototype is 2D top-down (React Native views). That's quick to iterate and fine for phones. 3D (e.g. via `expo-gl` / three.js / a native engine) would look better, but it means more art work and harder performance tuning. *Suggestion: lock in the build/damage design in 2D first.*
2. **Campaign vs PvP.** The prototype is a single-player ladder. Async PvP (fight AI-piloted copies of other players' bugs) is cheap to add because builds are just data. Real-time PvP needs servers and netcode.
3. **Art style.** Options: clean "toy robot" vector look; gritty junkyard scrap-bots; or bioluminescent neon insects. This decides part silhouettes and the palette.
4. **Controls.** Right now it's a thumbstick plus auto-fire. Alternatives: tap-to-move, manual fire buttons per weapon group, or a "boost" ability.
5. **Part orientation.** Parts can't be rotated yet. Do we want rotatable or mirrored parts (e.g. a rear stinger that faces backward)?
6. **Grid size and shape.** Currently 5×7. Should it grow with progression (a chassis upgrade)?
7. **Economy.** Should there be scrap or currency to craft or upgrade parts, or only drops? Duplicates currently just stack.
8. **Monetisation.** None, premium, or cosmetic-only? (No pay-to-win is assumed.)
9. **Balance.** The numbers are first-pass. Melee mirror matches decide too much on who loses their weapon first, Needlewisp is easier than its ladder slot suggests, and fights often go to time.
