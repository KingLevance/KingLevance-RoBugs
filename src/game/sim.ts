/**
 * Arena simulation. Pure TypeScript, no React, no rendering.
 *
 * Deterministic: fixed timestep, seeded RNG kept in sim state, all player
 * input arrives through `step()`. The world is a 2D floor plane
 * (x right, y "down"/toward the player's start); the 3D renderer lifts it.
 */
import { computeStats, connectedKeys, key, resolve, type Build, type BugStats } from './build';
import { getMove, MOVES, PROC, ULT_SECONDS, type MoveId } from './moves';
import type { ArenaId } from './opponents';
import type { Category, PartDef } from './parts';

export const CELL = 22;
export const ARENA_SIZE = 600;
export const MATCH_SECONDS = 90;
export const STEP = 1 / 60;
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
  index: 0 | 1;
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
  moves: MoveId[];
  moveCd: Partial<Record<MoveId, number>>;
  proc: number;
  /** Seconds of Carapace Lock left. */
  shield: number;
  /** Seconds of invulnerability left (Skitter Dash). */
  invuln: number;
  /** Exponentially decaying recent damage taken, for move judgement. */
  recentDamage: number;
};

export type Hazard =
  | { kind: 'acid'; x: number; y: number; r: number }
  | { kind: 'stomper'; x: number; y: number; r: number; period: number; t: number };

export type Projectile = { x: number; y: number; vx: number; vy: number; damage: number; owner: 0 | 1; ttl: number; big: boolean };
export type Effect = { x: number; y: number; ttl: number; color: string; size: number };

export type SimEvent =
  | { type: 'break'; bug: 0 | 1; x: number; y: number; category: Category; time: number }
  | { type: 'ult-start'; bug: 0 | 1; move: MoveId }
  | { type: 'ult-release'; bug: 0 | 1; move: MoveId }
  | { type: 'move'; bug: 0 | 1; move: MoveId };

export type Ult = { id: MoveId; caster: 0 | 1; t: number; dur: number };

export type Sim = {
  bugs: [Bug, Bug];
  hazards: Hazard[];
  arena: ArenaId;
  spikedWalls: boolean;
  projectiles: Projectile[];
  effects: Effect[];
  time: number;
  over: boolean;
  /** 0 = player, 1 = opponent, null = draw. */
  winner: 0 | 1 | null;
  log: string[];
  /** Append-only; renderers keep their own read cursor. */
  events: SimEvent[];
  ult: Ult | null;
  hitstop: number;
  shake: number;
  flash: number;
  /** mulberry32 state. */
  rng: number;
};

export type Fighter = { build: Build; moves: MoveId[] };

/** Desired movement direction in world space; magnitude (0..1) is throttle. */
export type Input = { x: number; y: number };

const STOMP_WARN = 1.2;

// ── Helpers ─────────────────────────────────────────────────────────

function rand(sim: Sim) {
  sim.rng = (sim.rng + 0x6d2b79f5) | 0;
  let t = sim.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

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

const other = (i: 0 | 1): 0 | 1 => (i === 0 ? 1 : 0);

export function hpFraction(bug: Bug) {
  return bug.parts.reduce((a, p) => a + (p.alive ? Math.max(0, p.hp) : 0), 0) / bug.maxHp;
}

export function stompWarning(h: Hazard) {
  return h.kind === 'stomper' && h.t > h.period - STOMP_WARN;
}

function aliveCount(bug: Bug, c: Category) {
  return bug.parts.filter((p) => p.alive && p.part.category === c).length;
}

// ── Setup ───────────────────────────────────────────────────────────

function makeBug(index: 0 | 1, fighter: Fighter, pos: Vec, heading: number): Bug {
  const placed = resolve(fighter.build.placements);
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
    index,
    name: fighter.build.name,
    parts,
    pos,
    vel: { x: 0, y: 0 },
    heading,
    stats: computeStats(placed),
    radius: 0,
    maxHp: parts.reduce((a, p) => a + p.hp, 0),
    dead: false,
    hazardTimer: 0,
    moves: fighter.moves,
    moveCd: {},
    proc: 0,
    shield: 0,
    invuln: 0,
    recentDamage: 0,
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

export function createSim(player: Fighter, opponent: Fighter, arena: ArenaId, seed: number): Sim {
  const { hazards, spikedWalls } = arenaHazards(arena);
  return {
    bugs: [
      makeBug(0, player, { x: ARENA_SIZE / 2, y: ARENA_SIZE - 90 }, -Math.PI / 2),
      makeBug(1, opponent, { x: ARENA_SIZE / 2, y: 90 }, Math.PI / 2),
    ],
    hazards,
    arena,
    spikedWalls,
    projectiles: [],
    effects: [],
    time: 0,
    over: false,
    winner: null,
    log: [],
    events: [],
    ult: null,
    hitstop: 0,
    shake: 0,
    flash: 0,
    rng: seed | 0,
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

// ── Damage ──────────────────────────────────────────────────────────

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
function strikeTarget(sim: Sim, bug: Bug, at: Vec): SimPart | null {
  const near = nearestPart(bug, at);
  if (!near) return null;
  const options = bug.parts.filter((p) => {
    if (!p.alive) return false;
    const w = partWorld(bug, p);
    return Math.hypot(w.x - at.x, w.y - at.y) <= near.d + CELL * 1.1;
  });
  return options[Math.floor(rand(sim) * options.length)] ?? near.p;
}

function gainProc(bug: Bug, n: number) {
  if (!bug.dead) bug.proc = Math.min(PROC.max, bug.proc + n);
}

function canBeHurt(sim: Sim, bug: Bug) {
  if (bug.dead || bug.invuln > 0) return false;
  return !(sim.ult && sim.ult.caster === bug.index);
}

/**
 * Apply damage to one part. `attacker` is the bug credited with proc points
 * (null for hazards and walls).
 */
function damagePart(sim: Sim, bug: Bug, p: SimPart, dmg: number, attacker: Bug | null) {
  if (!p.alive || !canBeHurt(sim, bug)) return;
  dmg *= DAMAGE_SCALE * (0.8 + rand(sim) * 0.4);
  if (bug.shield > 0) dmg *= 0.3;
  p.hp -= dmg;
  p.flash = 0.15;
  bug.recentDamage += dmg;
  gainProc(bug, (dmg / 5) * PROC.damageTakenPer5);
  if (p.part.category === 'armor') gainProc(bug, PROC.armorAbsorb);
  if (attacker) gainProc(attacker, PROC.hitLanded);

  const w = partWorld(bug, p);
  sim.effects.push({ x: w.x, y: w.y, ttl: 0.25, color: '#FFE08A', size: 6 + Math.min(dmg, 20) * 0.6 });
  if (p.hp > 0) return;

  p.alive = false;
  if (attacker) gainProc(attacker, PROC.partBroken);
  sim.events.push({ type: 'break', bug: bug.index, x: w.x, y: w.y, category: p.part.category, time: sim.time });
  sim.log.push(`${bug.name} lost ${p.part.name}!`);

  // Anything no longer connected to the body falls off.
  const alive = bug.parts.filter((q) => q.alive);
  const keep = connectedKeys(alive.map((q) => ({ x: q.x, y: q.y, part: q.part })));
  for (const q of alive) {
    if (!keep.has(key(q.x, q.y))) {
      q.alive = false;
      const qw = partWorld(bug, q);
      sim.events.push({ type: 'break', bug: bug.index, x: qw.x, y: qw.y, category: q.part.category, time: sim.time });
      sim.log.push(`${bug.name}'s ${q.part.name} broke off!`);
    }
  }
  refresh(bug);
  if (bug.dead) sim.log.push(`${bug.name} is disabled!`);
}

function damageNear(sim: Sim, bug: Bug, at: Vec, dmg: number, attacker: Bug | null) {
  const hit = nearestPart(bug, at);
  if (hit) damagePart(sim, bug, hit.p, dmg, attacker);
}

// ── Signature moves ─────────────────────────────────────────────────

function moveReady(sim: Sim, bug: Bug, id: MoveId): boolean {
  const m = getMove(id);
  if ((bug.moveCd[id] ?? 0) > 0 || bug.proc < m.cost) return false;
  if (m.ultimate && sim.ult) return false;
  return aliveCount(bug, m.requires.category) >= m.requires.count;
}

/** Does this move make sense right now? */
function judge(sim: Sim, bug: Bug, id: MoveId): boolean {
  const foe = sim.bugs[other(bug.index)];
  const dx = foe.pos.x - bug.pos.x;
  const dy = foe.pos.y - bug.pos.y;
  const dist = Math.hypot(dx, dy);
  const facing = Math.abs(angleDiff(bug.heading, Math.atan2(dy, dx)));
  switch (id) {
    case 'mandible-crusher': {
      return bug.parts.some((p) => {
        if (!p.alive || p.part.category !== 'mandibles') return false;
        const near = nearestPart(foe, partWorld(bug, p));
        return !!near && near.d < 70 && facing < 0.9;
      });
    }
    case 'venom-barrage':
      return dist < 280 && facing < 0.45;
    case 'carapace-lock':
      return bug.shield <= 0 && (bug.recentDamage > 22 || (hpFraction(bug) < 0.4 && dist < 100));
    case 'skitter-dash': {
      const underStomper = sim.hazards.some(
        (h) => stompWarning(h) && Math.hypot(bug.pos.x - h.x, bug.pos.y - h.y) < h.r + bug.radius * 0.5,
      );
      return underStomper || (dist < 80 && bug.recentDamage > 14 && hpFraction(bug) < hpFraction(foe));
    }
  }
}

function castMove(sim: Sim, bug: Bug, id: MoveId) {
  const m = getMove(id);
  bug.proc -= m.cost;
  bug.moveCd[id] = m.cooldown;
  if (m.ultimate) {
    sim.ult = { id, caster: bug.index, t: 0, dur: ULT_SECONDS };
    sim.events.push({ type: 'ult-start', bug: bug.index, move: id });
    sim.log.push(`${bug.name}: ${m.name}!`);
  } else {
    sim.events.push({ type: 'move', bug: bug.index, move: id });
    sim.log.push(`${bug.name} uses ${m.name}.`);
    resolveMove(sim, bug, id);
  }
}

function resolveMove(sim: Sim, bug: Bug, id: MoveId) {
  const foe = sim.bugs[other(bug.index)];
  const f = forward(bug.heading);
  switch (id) {
    case 'mandible-crusher': {
      // Lunge, then bite the parts nearest our front.
      const dx = foe.pos.x - bug.pos.x;
      const dy = foe.pos.y - bug.pos.y;
      const dist = Math.hypot(dx, dy) || 1;
      const lunge = Math.max(0, Math.min(40, dist - (bug.radius + foe.radius) * 0.7));
      bug.pos.x += (dx / dist) * lunge;
      bug.pos.y += (dy / dist) * lunge;
      const front = { x: bug.pos.x + f.x * bug.radius, y: bug.pos.y + f.y * bug.radius };
      const jaws = aliveCount(bug, 'mandibles');
      const targets = foe.parts
        .filter((p) => p.alive)
        .map((p) => ({ p, d: Math.hypot(partWorld(foe, p).x - front.x, partWorld(foe, p).y - front.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      for (const { p } of targets) damagePart(sim, foe, p, 26 * Math.sqrt(jaws), bug);
      foe.vel.x += f.x * 160;
      foe.vel.y += f.y * 160;
      break;
    }
    case 'venom-barrage': {
      const sting = bug.parts.find((p) => p.alive && p.part.category === 'stinger');
      const from = sting ? partWorld(bug, sting) : bug.pos;
      for (let k = -3; k <= 3; k++) {
        const a = bug.heading + k * 0.09;
        sim.projectiles.push({ x: from.x, y: from.y, vx: Math.cos(a) * 380, vy: Math.sin(a) * 380, damage: 14, owner: bug.index, ttl: 1, big: true });
      }
      break;
    }
    case 'carapace-lock':
      bug.shield = 4;
      break;
    case 'skitter-dash': {
      // Sidestep away from danger: pick the side facing away from the foe.
      const side = angleDiff(bug.heading, Math.atan2(foe.pos.y - bug.pos.y, foe.pos.x - bug.pos.x)) > 0 ? -1 : 1;
      bug.vel.x += -f.y * side * 340;
      bug.vel.y += f.x * side * 340;
      bug.invuln = 0.5;
      gainProc(bug, PROC.dodge);
      break;
    }
  }
}

function tryMoves(sim: Sim, bug: Bug) {
  for (const id of bug.moves) {
    if (moveReady(sim, bug, id) && judge(sim, bug, id)) {
      castMove(sim, bug, id);
      return;
    }
  }
}

// ── Step ────────────────────────────────────────────────────────────

function stepBug(sim: Sim, i: 0 | 1, input: Input, dt: number) {
  const bug = sim.bugs[i];
  const enemy = sim.bugs[other(i)];
  bug.recentDamage *= Math.exp(-dt * 0.8);
  bug.shield = Math.max(0, bug.shield - dt);
  bug.invuln = Math.max(0, bug.invuln - dt);
  for (const id of bug.moves) bug.moveCd[id] = Math.max(0, (bug.moveCd[id] ?? 0) - dt);
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
          big: false,
        });
      } else {
        let dmg = w.damage;
        if (w.ramBonus) {
          const closing = (bug.vel.x - enemy.vel.x) * Math.cos(toward) + (bug.vel.y - enemy.vel.y) * Math.sin(toward);
          dmg += Math.max(0, closing) * w.ramBonus;
        }
        damagePart(sim, enemy, strikeTarget(sim, enemy, wp) ?? target.p, dmg, bug);
      }
    }
    tryMoves(sim, bug);
  }

  bug.pos.x += bug.vel.x * dt;
  bug.pos.y += bug.vel.y * dt;

  // Walls
  const r = bug.radius * 0.95;
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
    if (sim.spikedWalls && impact > 40) damageNear(sim, bug, wallPt, 4 + impact * 0.06, null);
  });

  // Acid
  bug.hazardTimer -= dt;
  for (const h of sim.hazards) {
    const d = Math.hypot(bug.pos.x - h.x, bug.pos.y - h.y);
    if (h.kind === 'acid' && d < h.r && bug.hazardTimer <= 0) {
      bug.hazardTimer = 0.5;
      const alive = bug.parts.filter((p) => p.alive);
      const victim = alive[Math.floor(rand(sim) * alive.length)];
      if (victim) damagePart(sim, bug, victim, 5, null);
    }
  }
}

function stepStompers(sim: Sim, dt: number) {
  for (const h of sim.hazards) {
    if (h.kind !== 'stomper') continue;
    const before = h.t;
    h.t = (h.t + dt) % h.period;
    if (h.t >= before) continue;
    // Slam! Damage the three nearest parts of any bug under it.
    sim.effects.push({ x: h.x, y: h.y, ttl: 0.4, color: '#FF8A3D', size: h.r * 2 });
    sim.shake = Math.max(sim.shake, 0.25);
    for (const bug of sim.bugs) {
      if (bug.dead) continue;
      const d = Math.hypot(bug.pos.x - h.x, bug.pos.y - h.y);
      if (d > h.r + bug.radius * 0.5) {
        if (d < h.r + bug.radius + 50) gainProc(bug, PROC.dodge); // near miss
        continue;
      }
      const sorted = bug.parts
        .filter((p) => p.alive)
        .map((p) => ({ p, d: Math.hypot(partWorld(bug, p).x - h.x, partWorld(bug, p).y - h.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      for (const { p } of sorted) damagePart(sim, bug, p, 22, null);
    }
  }
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
    damageNear(sim, a, mid, closing * 0.03 * (mb / ma), b);
    damageNear(sim, b, mid, closing * 0.03 * (ma / mb), a);
  }
}

function stepEffects(sim: Sim, dt: number) {
  for (const e of sim.effects) e.ttl -= dt;
  sim.effects = sim.effects.filter((e) => e.ttl > 0);
  sim.shake = Math.max(0, sim.shake - dt);
  sim.flash = Math.max(0, sim.flash - dt * 2.5);
}

/** Advance the world by `dt` (use STEP). Inputs: [player, opponent]. */
export function step(sim: Sim, dt: number, inputs: [Input, Input]) {
  if (sim.over) return;
  stepEffects(sim, dt);

  // An ultimate freezes the world while the cutscene plays.
  if (sim.ult) {
    sim.ult.t += dt;
    if (sim.ult.t >= sim.ult.dur) {
      const { id, caster } = sim.ult;
      sim.ult = null;
      resolveMove(sim, sim.bugs[caster], id);
      sim.events.push({ type: 'ult-release', bug: caster, move: id });
      sim.hitstop = 0.12;
      sim.shake = 0.6;
      sim.flash = 1;
    }
    checkOver(sim);
    return;
  }
  if (sim.hitstop > 0) {
    sim.hitstop -= dt;
    return;
  }

  sim.time += dt;
  stepBug(sim, 0, inputs[0], dt);
  stepBug(sim, 1, inputs[1], dt);
  collideBugs(sim);
  stepStompers(sim, dt);

  for (const pr of sim.projectiles) {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.ttl -= dt;
    const attacker = sim.bugs[pr.owner];
    const target = sim.bugs[other(pr.owner)];
    const hit = nearestPart(target, pr);
    if (hit && hit.d < CELL * 0.6) {
      damagePart(sim, target, strikeTarget(sim, target, pr) ?? hit.p, pr.damage, attacker);
      pr.ttl = 0;
    }
  }
  sim.projectiles = sim.projectiles.filter((p) => p.ttl > 0);
  for (const bug of sim.bugs) for (const p of bug.parts) p.flash = Math.max(0, p.flash - dt);
  checkOver(sim);
}

function checkOver(sim: Sim) {
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
  sim.winner = other(who);
  sim.log.push(`${sim.bugs[who].name} forfeits.`);
}

// ── AI ──────────────────────────────────────────────────────────────

function inHazard(sim: Sim, at: Vec, pad: number) {
  return sim.hazards.some(
    (h) => Math.hypot(at.x - h.x, at.y - h.y) < h.r + pad && (h.kind === 'acid' || h.t > h.period - 2),
  );
}

function rotate(v: Vec, a: number): Vec {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Simple steering AI: close in with melee, kite with darts, dodge hazards. Pure function of sim state. */
export function aiInput(sim: Sim, me: 0 | 1, aggression: number): Input {
  const bug = sim.bugs[me];
  const foe = sim.bugs[other(me)];
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

// ── HUD summary (cheap, for React) ──────────────────────────────────

export type HudBug = { name: string; hp: number; proc: number; shield: boolean; moves: { id: MoveId; cd: number; ready: boolean }[] };
export type Hud = { bugs: [HudBug, HudBug]; time: number; log: string[]; over: boolean; winner: 0 | 1 | null; ult: Ult | null; flash: number };

export function hud(sim: Sim): Hud {
  const b = (bug: Bug): HudBug => ({
    name: bug.name,
    hp: hpFraction(bug),
    proc: bug.proc,
    shield: bug.shield > 0,
    moves: bug.moves.map((id) => ({ id, cd: bug.moveCd[id] ?? 0, ready: moveReady(sim, bug, id) })),
  });
  return {
    bugs: [b(sim.bugs[0]), b(sim.bugs[1])],
    time: sim.time,
    log: sim.log.slice(-3),
    over: sim.over,
    winner: sim.winner,
    ult: sim.ult ? { ...sim.ult } : null,
    flash: sim.flash,
  };
}

export const ALL_MOVE_IDS = MOVES.map((m) => m.id);
