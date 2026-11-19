/**
 * Headless balance check. Validates every build, asserts determinism, then
 * plays the whole campaign in order with an auto-built player bug that grows
 * with the rewards it would have earned (guaranteed drops + a few loot rolls).
 * Run with: npx tsx scripts/simulate.ts
 */
import { computeStats, resolve, validateBuild, type Build } from '../src/game/build';
import { autoBuild } from '../src/game/editor';
import { getMove, meetsRequirement, MOVE_SLOTS, type MoveId } from '../src/game/moves';
import { fightSize, lineup, OPPONENTS, ZONES, zoneStars, STARTER_BUILD, STARTER_INVENTORY, STARTER_MOVES, type Opponent } from '../src/game/opponents';
import { getPart } from '../src/game/parts';
import { rollMatchRewards } from '../src/game/rewards';
import { rateWin } from '../src/game/stars';
import { aiInput, createTeamSim, step, STEP, teamHp, type Fighter } from '../src/game/sim';

const builds: Build[] = [STARTER_BUILD, ...OPPONENTS.flatMap((o) => [o.build, ...(o.team ?? []).map((t) => t.build)])];
for (const b of builds) {
  const s = computeStats(resolve(b.placements));
  const errs = validateBuild(b.placements);
  console.log(
    `${b.name.padEnd(15)} mass ${String(s.mass).padStart(3)} power ${s.powerDraw}/${s.powerSupply} speed ${s.topSpeed.toFixed(0)} turn ${s.turnRate.toFixed(2)} hp ${s.totalHp} dps ${s.dps.toFixed(1)}`,
    errs.length ? `INVALID: ${errs.join('; ')}` : 'ok',
  );
  if (errs.length) process.exitCode = 1;
}

function run(opp: Opponent, player: Fighter, seed: number) {
  const { allies, enemies } = lineup(opp);
  const sim = createTeamSim([player, ...allies], enemies, opp.arena, seed);
  let solo = 0;
  let seen = 0;
  while (!sim.over) {
    step(
      sim,
      STEP,
      sim.bugs.map((_, i) => aiInput(sim, i)),
    );
    // Wall hits with no enemy nearby = the bug drove into the wall itself.
    for (; seen < sim.events.length; seen++) {
      const e = sim.events[seen];
      if (e.type !== 'wall') continue;
      const me = sim.bugs[e.bug];
      const near = sim.bugs.some((b) => b.team !== me.team && Math.hypot(b.pos.x - me.pos.x, b.pos.y - me.pos.y) < (b.radius + me.radius) * 1.4);
      if (!near) solo++;
    }
  }
  const hits = sim.events.filter((e) => e.type === 'hit' && e.by !== null);
  return {
    winner: sim.winner,
    time: sim.time,
    hpLeft: teamHp(sim, 0),
    solo,
    casts: sim.events.filter((e) => (e.type === 'ult-release' || e.type === 'move') && e.bug === 0).length,
    crits: hits.filter((e) => e.type === 'hit' && e.crit).length,
    hits: hits.length,
    ev: Object.fromEntries(['whiff', 'dash', 'clash', 'stagger'].map((t) => [t, sim.events.filter((e) => e.type === t).length])) as Record<string, number>,
    dodged: sim.events.filter((e) => e.type === 'whiff' && e.dodged).length,
    counters: hits.filter((e) => e.type === 'hit' && e.counter).length,
    timeout: sim.time >= 90,
    hash: `${sim.winner}:${sim.time.toFixed(4)}:${sim.rng}`,
  };
}

/** The moves an auto-player would equip: the priciest ones its build can actually use. */
function pickMoves(owned: MoveId[], build: Build): MoveId[] {
  const parts = build.placements.map((p) => getPart(p.partId));
  return owned
    .filter((id) => meetsRequirement(getMove(id), parts))
    .sort((a, b) => getMove(b).cost - getMove(a).cost)
    .slice(0, MOVE_SLOTS);
}

const starter: Fighter = { build: STARTER_BUILD, moves: STARTER_MOVES };
const finale = OPPONENTS[OPPONENTS.length - 1];
const a = run(finale, starter, 1234);
const b = run(finale, starter, 1234);
console.log(a.hash === b.hash ? 'determinism ok' : `DETERMINISM BROKEN ${a.hash} vs ${b.hash}`);
if (a.hash !== b.hash) process.exitCode = 1;

// Seeded RNG for the loot the auto-player picks up along the way.
let seed = 99;
const rng = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const N = 30;
const inventory: Record<string, number> = { ...STARTER_INVENTORY };
const owned: MoveId[] = [...STARTER_MOVES];
let selfWalls = 0;
const best: Record<string, number> = {};
/** Average stars per win (a typical single clear). */
const typical: Record<string, number> = {};
for (const o of OPPONENTS) {
  const n = ZONES.filter((z) => z.stops.includes(o.id)).length;
  if (n !== 1) throw new Error(`${o.id} is in ${n} campaign zones (expected 1)`);
}
console.log('\nCampaign run (auto-built player bug, gaining each stop\'s rewards):');
for (const opp of OPPONENTS) {
  const build: Build = { name: 'Player', placements: autoBuild(inventory) };
  const errs = validateBuild(build.placements);
  const player: Fighter = { build, moves: pickMoves(owned, build) };
  let w = 0;
  let l = 0;
  let t = 0;
  let casts = 0;
  let crits = 0;
  let hits = 0;
  const stars = [0, 0, 0];
  const feel = { whiff: 0, dodged: 0, dash: 0, clash: 0, stagger: 0, counters: 0, timeout: 0 };
  for (let k = 0; k < N; k++) {
    const r = run(opp, player, k * 7919 + 1);
    if (r.winner === 0) {
      w++;
      const st = rateWin(opp, r.hpLeft, r.time).stars;
      stars[st - 1]++;
      best[opp.id] = Math.max(best[opp.id] ?? 0, st);
    }
    else if (r.winner === 1) l++;
    t += r.time;
    casts += r.casts;
    crits += r.crits;
    hits += r.hits;
    selfWalls += r.solo;
    feel.whiff += r.ev.whiff;
    feel.dash += r.ev.dash;
    feel.clash += r.ev.clash;
    feel.stagger += r.ev.stagger;
    feel.dodged += r.dodged;
    feel.counters += r.counters;
    feel.timeout += r.timeout ? 1 : 0;
  }
  typical[opp.id] = w ? (stars[0] + 2 * stars[1] + 3 * stars[2]) / w : 0;
  const s = computeStats(resolve(build.placements));
  console.log(
    `${(opp.optional ? '(opt) ' : '') + opp.name}`.padEnd(22),
    fightSize(opp),
    `W${String(w).padStart(2)} L${String(l).padStart(2)} D${N - w - l}`.padEnd(12),
    `avg ${(t / N).toFixed(0).padStart(2)}s`,
    `★1/2/3 ${stars.join('/')}`.padEnd(14),
    `moves/match ${(casts / N).toFixed(1)}`,
    `crits ${((crits / Math.max(1, hits)) * 100).toFixed(0)}%`,
    `| hits ${(hits / N).toFixed(0)} miss ${(feel.whiff / N).toFixed(0)} dodge ${(feel.dodged / N).toFixed(1)} ctr ${(feel.counters / N).toFixed(1)} clash ${(feel.clash / N).toFixed(1)} stag ${(feel.stagger / N).toFixed(1)} t/o ${feel.timeout}`,
    `| player hp ${s.totalHp} dps ${s.dps.toFixed(0)} [${player.moves.join(', ')}]`,
    errs.length ? `PLAYER BUILD INVALID: ${errs[0]}` : '',
  );
  // Clear it: guaranteed drops plus the rolls from a couple of wins.
  for (const first of [true, false]) {
    const rewards = rollMatchRewards(opp, true, first, false, rng);
    for (const r of [...rewards.guaranteed, ...rewards.rolled, ...rewards.bonus]) {
      if (r.kind === 'part') inventory[r.id] = (inventory[r.id] ?? 0) + 1;
      else if (!owned.includes(r.id as MoveId)) owned.push(r.id as MoveId);
    }
  }
}
for (let i = 1; i < ZONES.length; i++) {
  const have = zoneStars(ZONES[i - 1], best);
  console.log(`gate ${ZONES[i].name}: needs ★${ZONES[i].starsToEnter} from ${ZONES[i - 1].name}, auto-player best ★${have}, typical one clear each ★${zoneStars(ZONES[i - 1], typical).toFixed(1)} (of ${ZONES[i - 1].stops.length * 3})`);
}
console.log(`self-inflicted wall hits per match: ${(selfWalls / (N * OPPONENTS.length)).toFixed(2)}`);
