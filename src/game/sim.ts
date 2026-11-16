/**
 * 2D top-down arena simulation. Pure TypeScript, no React — the arena
 * screen calls `step()` every frame and renders `snapshot()`.
 */
import { computeStats, connectedKeys, key, resolve, type Build, type BugStats } from './build';
import type { ArenaId } from './opponents';
import { CATEGORY_COLOR, CATEGORY_GLYPH, type PartDef } from './parts';

export const CELL = 22;
export const ARENA_SIZE = 600;
export const MATCH_SECONDS = 90;
/** Global damage multiplier — lower = longer fights. */
export const DAMAGE_SCALE = 0.8;

export type Vec = { x: number; y: number };

export type SimPart = {
  x: number;
  y: number;
  /** Offset from bug center in local space (−y is forward). */
  lx: number;
  ly: number;
  part: PartDef;
  hp: number;
  alive: boolean;
  cooldown: number;
  flash: number;
};

export type Bug = {
  name: string;
  parts: SimPart[];
  pos: Vec;
  vel: Vec;
  heading: number;
  stats: BugStats;
  radius: number;
  maxHp: number;
  dead: boolean;
  hazardTimer: number;
};

export type Hazard =
  | { kind: 'acid'; x: number; y: number; r: number }
  | { kind: 'stomper'; x: number; y: number; r: number; period: number; t: number };

export type Projectile = { x: number; y: number; vx: number; vy: number; damage: number; owner: number; ttl: number };
export type Effect = { x: number; y: number; ttl: number; color: string; size: number };

export type Sim = {
  bugs: [Bug, Bug];
  hazards: Hazard[];
  spikedWalls: boolean;
  projectiles: Projectile[];
  effects: Effect[];
  time: number;
  over: boolean;
  /** 0 = player, 1 = opponent, null = draw. */
  winner: 0 | 1 | null;
  log: string[];
};

/** Desired movement direction in world space; magnitude (0..1) is throttle. */
export type Input = { x: number; y: number };

const STOMP_WARN = 1.2;

export function forward(h: number): Vec {
  return { x: Math.cos(h), y: Math.sin(h) };
}

export function partWorld(bug: Bug, p: SimPart): Vec {
  const c = Math.cos(bug.heading);
  const s = Math.sin(bug.heading);
  // right = (-s, c), forward = (c, s); local −y is forward
  return { x: bug.pos.x - s * p.lx - c * p.ly, y: bug.pos.y + c * p.lx - s * p.ly };
}

function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function makeBug(build: Build, pos: Vec, heading: number): Bug {
  const placed = resolve(build.placements);
  const cx = placed.reduce((a, p) => a + p.x, 0) / placed.length;
  const cy = placed.reduce((a, p) => a + p.y, 0) / placed.length;
  const parts: SimPart[] = placed.map((p) => ({
    x: p.x,
    y: p.y,
    lx: (p.x - cx) * CELL,
    ly: (p.y - cy) * CELL,
    part: p.part,
    hp: p.part.hp,
    alive: true,
    cooldown: 0.5,
    flash: 0,
  }));
  const bug: Bug = {
    name: build.name,
    parts,
    pos,
    vel: { x: 0, y: 0 },
    heading,
    stats: computeStats(placed),
    radius: 0,
    maxHp: parts.reduce((a, p) => a + p.hp, 0),
    dead: false,
    hazardTimer: 0,
  };
  refresh(bug);
  return bug;
}

function arenaHazards(arena: ArenaId): { hazards: Hazard[]; spikedWalls: boolean } {
  const m = ARENA_SIZE / 2;
  switch (arena) {
    case 'pit':
      return {
        spikedWalls: false,
        hazards: [
          { kind: 'acid', x: 150, y: m, r: 50 },
          { kind: 'acid', x: 450, y: m, r: 50 },
        ],
      };
    case 'foundry':
      return {
        spikedWalls: true,
        hazards: [
          { kind: 'stomper', x: m, y: m, r: 70, period: 6, t: 0 },
          { kind: 'acid', x: 110, y: 110, r: 45 },
          { kind: 'acid', x: 490, y: 490, r: 45 },
        ],
      };
    case 'hive':
      return {
        spikedWalls: true,
        hazards: [
          { kind: 'stomper', x: 170, y: m, r: 60, period: 5, t: 0 },
          { kind: 'stomper', x: 430, y: m, r: 60, period: 5, t: 2.5 },
          { kind: 'acid', x: m, y: m, r: 40 },
        ],
      };
  }
}

export function createSim(player: Build, opponent: Build, arena: ArenaId): Sim {
  const { hazards, spikedWalls } = arenaHazards(arena);
  return {
    bugs: [
      makeBug(player, { x: ARENA_SIZE / 2, y: ARENA_SIZE - 90 }, -Math.PI / 2),
      makeBug(opponent, { x: ARENA_SIZE / 2, y: 90 }, Math.PI / 2),
    ],
    hazards,
    spikedWalls,
    projectiles: [],
    effects: [],
    time: 0,
    over: false,
    winner: null,
    log: [],
  };
}

/** Recompute derived stats after parts are lost. */
function refresh(bug: Bug) {
  const alive = bug.parts.filter((p) => p.alive);
  bug.stats = computeStats(alive.map((p) => ({ x: p.x, y: p.y, part: p.part })));
  bug.radius = alive.reduce((m, p) => Math.max(m, Math.hypot(p.lx, p.ly)), 0) + CELL * 0.5;
  const hasCore = alive.some((p) => p.part.category === 'core');
  const hasThorax = alive.some((p) => p.part.category === 'thorax');
  if (!hasCore || !hasThorax) bug.dead = true;
}

function nearestPart(bug: Bug, at: Vec): { p: SimPart; w: Vec; d: number } | null {
  let best: { p: SimPart; w: Vec; d: number } | null = null;
  for (const p of bug.parts) {
    if (!p.alive) continue;
    const w = partWorld(bug, p);
    const d = Math.hypot(w.x - at.x, w.y - at.y);
    if (!best || d < best.d) best = { p, w, d };
  }
  return best;
}

/** A strike lands on the nearest part, or a random neighbour of it. */
function strikeTarget(bug: Bug, at: Vec): SimPart | null {
  const near = nearestPart(bug, at);
  if (!near) return null;
  const options = bug.parts.filter((p) => {
    if (!p.alive) return false;
    const w = partWorld(bug, p);
    return Math.hypot(w.x - at.x, w.y - at.y) <= near.d + CELL * 1.1;
  });
  return options[Math.floor(Math.random() * options.length)] ?? near.p;
}

function damagePart(sim: Sim, bug: Bug, p: SimPart, dmg: number) {
  if (!p.alive || bug.dead) return;
  dmg *= DAMAGE_SCALE * (0.8 + Math.random() * 0.4);
  p.hp -= dmg;
  p.flash = 0.15;
  const w = partWorld(bug, p);
  sim.effects.push({ x: w.x, y: w.y, ttl: 0.25, color: '#FFE08A', size: 6 + Math.min(dmg, 20) * 0.6 });
  if (p.hp > 0) return;

  p.alive = false;
  sim.effects.push({ x: w.x, y: w.y, ttl: 0.6, color: CATEGORY_COLOR[p.part.category], size: 26 });
  sim.log.push(`${bug.name} lost ${p.part.name}!`);

  // Anything no longer connected to the body falls off.
  const alive = bug.parts.filter((q) => q.alive);
  const keep = connectedKeys(alive.map((q) => ({ x: q.x, y: q.y, part: q.part })));
  for (const q of alive) {
    if (!keep.has(key(q.x, q.y))) {
      q.alive = false;
      const qw = partWorld(bug, q);
      sim.effects.push({ x: qw.x, y: qw.y, ttl: 0.6, color: CATEGORY_COLOR[q.part.category], size: 22 });
      sim.log.push(`${bug.name}'s ${q.part.name} broke off!`);
    }
  }
  refresh(bug);
  if (bug.dead) sim.log.push(`${bug.name} is disabled!`);
}

function damageNear(sim: Sim, bug: Bug, at: Vec, dmg: number) {
  const hit = nearestPart(bug, at);
  if (hit) damagePart(sim, bug, hit.p, dmg);
}

function hpFraction(bug: Bug) {
  return bug.parts.reduce((a, p) => a + (p.alive ? Math.max(0, p.hp) : 0), 0) / bug.maxHp;
}

function stepBug(sim: Sim, i: 0 | 1, input: Input, dt: number) {
  const bug = sim.bugs[i];
  const enemy = sim.bugs[i === 0 ? 1 : 0];
  if (bug.dead) {
    bug.vel.x *= 0.9;
    bug.vel.y *= 0.9;
    return;
  }
  const s = bug.stats;
  const throttle = Math.min(1, Math.hypot(input.x, input.y));
  let align = 0;
  if (throttle > 0.05) {
    const want = Math.atan2(input.y, input.x);
    const d = angleDiff(bug.heading, want);
    const turn = Math.sign(d) * Math.min(Math.abs(d), s.turnRate * dt);
    bug.heading += turn;
    align = Math.max(0, Math.cos(angleDiff(bug.heading, want)));
  }
  // Lopsided legs make the bug pull to one side.
  bug.heading -= s.thrustBias * 1.4 * throttle * dt;

  const f = forward(bug.heading);
  const speed = s.topSpeed * throttle * (0.3 + 0.7 * align);
  const k = Math.min(1, 5 * dt);
  bug.vel.x += (f.x * speed - bug.vel.x) * k;
  bug.vel.y += (f.y * speed - bug.vel.y) * k;

  // Weapons fire automatically when an enemy part is inside their cone and reach.
  if (!enemy.dead) {
    for (const p of bug.parts) {
      const w = p.part.weapon;
      if (!p.alive || !w) continue;
      p.cooldown -= dt;
      if (p.cooldown > 0) continue;
      const wp = partWorld(bug, p);
      const target = nearestPart(enemy, wp);
      if (!target) continue;
      const reach = w.range * s.reach + CELL * 0.5;
      if (target.d > reach) continue;
      const toward = Math.atan2(target.w.y - wp.y, target.w.x - wp.x);
      if (target.d > CELL && Math.abs(angleDiff(bug.heading, toward)) > w.arc) continue;
      p.cooldown = w.cooldown;
      if (w.projectileSpeed) {
        const dx = target.w.x - wp.x;
        const dy = target.w.y - wp.y;
        const n = Math.hypot(dx, dy) || 1;
        sim.projectiles.push({
          x: wp.x,
          y: wp.y,
          vx: (dx / n) * w.projectileSpeed,
          vy: (dy / n) * w.projectileSpeed,
          damage: w.damage,
          owner: i,
          ttl: (reach * 1.3) / w.projectileSpeed,
        });
      } else {
        let dmg = w.damage;
        if (w.ramBonus) {
          const closing = (bug.vel.x - enemy.vel.x) * Math.cos(toward) + (bug.vel.y - enemy.vel.y) * Math.sin(toward);
          dmg += Math.max(0, closing) * w.ramBonus;
        }
        damagePart(sim, enemy, strikeTarget(enemy, wp) ?? target.p, dmg);
      }
    }
  }

  bug.pos.x += bug.vel.x * dt;
  bug.pos.y += bug.vel.y * dt;

  // Walls
  const r = bug.radius * 0.8;
  const walls: [number, number, Vec][] = [
    [bug.pos.x - r, bug.vel.x, { x: 0, y: bug.pos.y }],
    [ARENA_SIZE - (bug.pos.x + r), -bug.vel.x, { x: ARENA_SIZE, y: bug.pos.y }],
    [bug.pos.y - r, bug.vel.y, { x: bug.pos.x, y: 0 }],
    [ARENA_SIZE - (bug.pos.y + r), -bug.vel.y, { x: bug.pos.x, y: ARENA_SIZE }],
  ];
  walls.forEach(([gap, vInto, wallPt], wi) => {
    if (gap >= 0) return;
    const impact = Math.max(0, -vInto);
    if (wi < 2) {
      bug.pos.x += wi === 0 ? -gap : gap;
      bug.vel.x *= -0.4;
    } else {
      bug.pos.y += wi === 2 ? -gap : gap;
      bug.vel.y *= -0.4;
    }
    if (sim.spikedWalls && impact > 40) damageNear(sim, bug, wallPt, 4 + impact * 0.06);
  });

  // Hazards
  bug.hazardTimer -= dt;
  for (const h of sim.hazards) {
    const d = Math.hypot(bug.pos.x - h.x, bug.pos.y - h.y);
    if (h.kind === 'acid' && d < h.r && bug.hazardTimer <= 0) {
      bug.hazardTimer = 0.5;
      const alive = bug.parts.filter((p) => p.alive);
      const victim = alive[Math.floor(Math.random() * alive.length)];
      if (victim) damagePart(sim, bug, victim, 5);
    }
  }
}

function stepStompers(sim: Sim, dt: number) {
  for (const h of sim.hazards) {
    if (h.kind !== 'stomper') continue;
    const before = h.t;
    h.t = (h.t + dt) % h.period;
    if (h.t < before) {
      // Slam! Damage the three nearest parts of any bug under it.
      sim.effects.push({ x: h.x, y: h.y, ttl: 0.4, color: '#FF8A3D', size: h.r * 2 });
      for (const bug of sim.bugs) {
        if (bug.dead || Math.hypot(bug.pos.x - h.x, bug.pos.y - h.y) > h.r + bug.radius * 0.5) continue;
        const sorted = bug.parts
          .filter((p) => p.alive)
          .map((p) => ({ p, d: Math.hypot(partWorld(bug, p).x - h.x, partWorld(bug, p).y - h.y) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 3);
        for (const { p } of sorted) damagePart(sim, bug, p, 22);
      }
    }
  }
}

export function stompWarning(h: Hazard) {
  return h.kind === 'stomper' && h.t > h.period - STOMP_WARN;
}

function collideBugs(sim: Sim) {
  const [a, b] = sim.bugs;
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const d = Math.hypot(dx, dy) || 0.01;
  const minD = (a.radius + b.radius) * 0.75;
  if (d >= minD) return;
  const nx = dx / d;
  const ny = dy / d;
  const overlap = minD - d;
  const ma = Math.max(1, a.stats.mass);
  const mb = Math.max(1, b.stats.mass);
  a.pos.x -= nx * overlap * (mb / (ma + mb));
  a.pos.y -= ny * overlap * (mb / (ma + mb));
  b.pos.x += nx * overlap * (ma / (ma + mb));
  b.pos.y += ny * overlap * (ma / (ma + mb));
  const closing = (a.vel.x - b.vel.x) * nx + (a.vel.y - b.vel.y) * ny;
  if (closing <= 0) return;
  const impulse = (2 * closing) / (ma + mb);
  a.vel.x -= impulse * mb * nx * 0.8;
  a.vel.y -= impulse * mb * ny * 0.8;
  b.vel.x += impulse * ma * nx * 0.8;
  b.vel.y += impulse * ma * ny * 0.8;
  if (closing > 70) {
    const mid = { x: a.pos.x + nx * a.radius * 0.7, y: a.pos.y + ny * a.radius * 0.7 };
    damageNear(sim, a, mid, closing * 0.03 * (mb / ma));
    damageNear(sim, b, mid, closing * 0.03 * (ma / mb));
  }
}

export function step(sim: Sim, dt: number, inputs: [Input, Input]) {
  if (sim.over) return;
  sim.time += dt;
  stepBug(sim, 0, inputs[0], dt);
  stepBug(sim, 1, inputs[1], dt);
  collideBugs(sim);
  stepStompers(sim, dt);

  for (const pr of sim.projectiles) {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.ttl -= dt;
    const target = sim.bugs[pr.owner === 0 ? 1 : 0];
    const hit = nearestPart(target, pr);
    if (hit && hit.d < CELL * 0.6) {
      damagePart(sim, target, strikeTarget(target, pr) ?? hit.p, pr.damage);
      pr.ttl = 0;
    }
  }
  sim.projectiles = sim.projectiles.filter((p) => p.ttl > 0);
  for (const e of sim.effects) e.ttl -= dt;
  sim.effects = sim.effects.filter((e) => e.ttl > 0);
  for (const bug of sim.bugs) for (const p of bug.parts) p.flash = Math.max(0, p.flash - dt);

  const [p, o] = sim.bugs;
  if (p.dead || o.dead) {
    sim.over = true;
    sim.winner = p.dead && o.dead ? null : p.dead ? 1 : 0;
  } else if (sim.time >= MATCH_SECONDS) {
    sim.over = true;
    const fp = hpFraction(p);
    const fo = hpFraction(o);
    sim.winner = Math.abs(fp - fo) < 0.01 ? null : fp > fo ? 0 : 1;
    sim.log.push('Time! Judges decide on remaining integrity.');
  }
}

export function forfeit(sim: Sim, who: 0 | 1) {
  if (sim.over) return;
  sim.over = true;
  sim.winner = who === 0 ? 1 : 0;
  sim.log.push(`${sim.bugs[who].name} forfeits.`);
}

// ── AI ──────────────────────────────────────────────────────────────

function inHazard(sim: Sim, at: Vec, pad: number) {
  return sim.hazards.some(
    (h) => Math.hypot(at.x - h.x, at.y - h.y) < h.r + pad && (h.kind === 'acid' || stompWarning(h) || h.t > h.period - 2),
  );
}

function rotate(v: Vec, a: number): Vec {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Simple steering AI: close in with melee, kite with darts, dodge hazards. */
export function aiInput(sim: Sim, me: 0 | 1, aggression: number): Input {
  const bug = sim.bugs[me];
  const foe = sim.bugs[me === 0 ? 1 : 0];
  if (bug.dead || foe.dead) return { x: 0, y: 0 };
  const dx = foe.pos.x - bug.pos.x;
  const dy = foe.pos.y - bug.pos.y;
  const dist = Math.hypot(dx, dy) || 1;
  let dir: Vec = { x: dx / dist, y: dy / dist };
  let throttle = 1;

  const weapons = bug.parts.filter((p) => p.alive && p.part.weapon);
  const ranged = weapons.some((p) => p.part.weapon!.projectileSpeed);
  const melee = weapons.some((p) => !p.part.weapon!.projectileSpeed);
  const hurt = hpFraction(bug) < 0.35;

  if (ranged && (!melee || aggression < 0.5)) {
    if (dist < 120) {
      dir = rotate(dir, Math.PI * 0.75);
    } else if (dist < 200) {
      throttle = 0.12; // hold and aim
    }
  } else if (hurt && aggression < 0.6) {
    dir = rotate(dir, Math.PI / 2.5);
  } else if (dist > 80) {
    // Lead the target a little.
    const lead = { x: foe.pos.x + foe.vel.x * 0.3 - bug.pos.x, y: foe.pos.y + foe.vel.y * 0.3 - bug.pos.y };
    const n = Math.hypot(lead.x, lead.y) || 1;
    dir = { x: lead.x / n, y: lead.y / n };
  }

  // Dodge hazards and walls.
  const probe = { x: bug.pos.x + dir.x * 70, y: bug.pos.y + dir.y * 70 };
  if (inHazard(sim, probe, bug.radius * 0.5)) dir = rotate(dir, Math.PI / 2.2);
  const m = ARENA_SIZE / 2;
  const edge = Math.max(Math.abs(bug.pos.x - m), Math.abs(bug.pos.y - m));
  if (edge > m - 60) {
    const c = { x: m - bug.pos.x, y: m - bug.pos.y };
    const n = Math.hypot(c.x, c.y) || 1;
    dir = { x: dir.x * 0.5 + (c.x / n) * 0.5, y: dir.y * 0.5 + (c.y / n) * 0.5 };
  }
  return { x: dir.x * throttle, y: dir.y * throttle };
}

// ── Render snapshot ────────────────────────────────────────────────

export type PartView = { lx: number; ly: number; color: string; glyph: string; hp: number; flash: boolean };
export type BugView = { x: number; y: number; rot: number; name: string; hp: number; parts: PartView[]; dead: boolean };
export type SimView = {
  bugs: BugView[];
  hazards: { kind: Hazard['kind']; x: number; y: number; r: number; warn: boolean }[];
  projectiles: Vec[];
  effects: Effect[];
  time: number;
  log: string[];
  over: boolean;
  winner: 0 | 1 | null;
};

export function snapshot(sim: Sim): SimView {
  return {
    bugs: sim.bugs.map((b) => ({
      x: b.pos.x,
      y: b.pos.y,
      rot: b.heading + Math.PI / 2,
      name: b.name,
      hp: hpFraction(b),
      dead: b.dead,
      parts: b.parts
        .filter((p) => p.alive)
        .map((p) => ({
          lx: p.lx,
          ly: p.ly,
          color: CATEGORY_COLOR[p.part.category],
          glyph: CATEGORY_GLYPH[p.part.category],
          hp: Math.max(0, p.hp) / p.part.hp,
          flash: p.flash > 0,
        })),
    })),
    hazards: sim.hazards.map((h) => ({ kind: h.kind, x: h.x, y: h.y, r: h.r, warn: stompWarning(h) })),
    projectiles: sim.projectiles.map((p) => ({ x: p.x, y: p.y })),
    effects: sim.effects.map((e) => ({ ...e })),
    time: sim.time,
    log: sim.log.slice(-3),
    over: sim.over,
    winner: sim.winner,
  };
}
