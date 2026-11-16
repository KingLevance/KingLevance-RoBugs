/**
 * Headless balance check: validates every build and runs AI-vs-AI matches.
 * Run with: npx tsx scripts/simulate.ts
 */
import { computeStats, resolve, validateBuild } from '../src/game/build';
import { OPPONENTS, STARTER_BUILD } from '../src/game/opponents';
import { aiInput, createSim, step } from '../src/game/sim';

const builds = [STARTER_BUILD, ...OPPONENTS.map((o) => o.build)];
for (const b of builds) {
  const s = computeStats(resolve(b.placements));
  const errs = validateBuild(b.placements);
  console.log(
    `${b.name.padEnd(12)} mass ${s.mass} power ${s.powerDraw}/${s.powerSupply} speed ${s.topSpeed.toFixed(0)} turn ${s.turnRate.toFixed(2)} hp ${s.totalHp} dps ${s.dps.toFixed(1)}`,
    errs.length ? `INVALID: ${errs.join('; ')}` : 'ok',
  );
}

const N = 40;
for (const opp of OPPONENTS) {
  let w = 0;
  let l = 0;
  let totalT = 0;
  for (let i = 0; i < N; i++) {
    const sim = createSim(STARTER_BUILD, opp.build, opp.arena);
    while (!sim.over) step(sim, 1 / 30, [aiInput(sim, 0, 0.7), aiInput(sim, 1, opp.aggression)]);
    if (sim.winner === 0) w++;
    else if (sim.winner === 1) l++;
    totalT += sim.time;
  }
  console.log(`Starter vs ${opp.name.padEnd(11)} W${w} L${l} D${N - w - l} avg ${(totalT / N).toFixed(1)}s`);
}
