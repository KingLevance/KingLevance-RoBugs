/**
 * Headless balance check: validates every build and runs AI-vs-AI matches.
 * Also asserts determinism (same seed → same result).
 * Run with: npx tsx scripts/simulate.ts
 */
import { computeStats, resolve, validateBuild } from '../src/game/build';
import { OPPONENTS, STARTER_BUILD, STARTER_MOVES } from '../src/game/opponents';
import { aiInput, createSim, step, STEP, type Fighter } from '../src/game/sim';

const builds = [STARTER_BUILD, ...OPPONENTS.map((o) => o.build)];
for (const b of builds) {
  const s = computeStats(resolve(b.placements));
  const errs = validateBuild(b.placements);
  console.log(
    `${b.name.padEnd(12)} mass ${s.mass} power ${s.powerDraw}/${s.powerSupply} speed ${s.topSpeed.toFixed(0)} turn ${s.turnRate.toFixed(2)} hp ${s.totalHp} dps ${s.dps.toFixed(1)}`,
    errs.length ? `INVALID: ${errs.join('; ')}` : 'ok',
  );
  if (errs.length) process.exitCode = 1;
}

const player: Fighter = { build: STARTER_BUILD, moves: STARTER_MOVES };

function run(oppIndex: number, seed: number) {
  const opp = OPPONENTS[oppIndex];
  const sim = createSim(player, { build: opp.build, moves: opp.moves }, opp.arena, seed);
  while (!sim.over) step(sim, STEP, [aiInput(sim, 0, 0.7), aiInput(sim, 1, opp.aggression)]);
  const ults = sim.events.filter((e) => e.type === 'ult-release').length;
  return { winner: sim.winner, time: sim.time, ults, hash: `${sim.winner}:${sim.time.toFixed(4)}:${sim.rng}` };
}

const a = run(1, 1234);
const b = run(1, 1234);
console.log(a.hash === b.hash ? 'determinism ok' : `DETERMINISM BROKEN ${a.hash} vs ${b.hash}`);
if (a.hash !== b.hash) process.exitCode = 1;

const N = 40;
OPPONENTS.forEach((opp, i) => {
  let w = 0;
  let l = 0;
  let t = 0;
  let ults = 0;
  for (let k = 0; k < N; k++) {
    const r = run(i, k * 7919 + 1);
    if (r.winner === 0) w++;
    else if (r.winner === 1) l++;
    t += r.time;
    ults += r.ults;
  }
  console.log(`Starter vs ${opp.name.padEnd(11)} W${w} L${l} D${N - w - l} avg ${(t / N).toFixed(1)}s ults/match ${(ults / N).toFixed(1)}`);
});
