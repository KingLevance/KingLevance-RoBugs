/**
 * Arena simulation. Pure TypeScript, no React, no rendering.
 *
 * Deterministic: fixed timestep, seeded RNG kept in sim state, all player
 * input arrives through `step()`. The world is a 2D floor plane
 * (x right, y "down"/toward the player's start); the 3D renderer lifts it.
 */
import { computeStats, connectedKeys, pkey, resolve, type Build, type BugStats, type Layer } from './build';
import { getMove, meetsRequirement, MOVES, PROC, ULT_SECONDS, type MoveId } from './moves';
import type { ArenaId } from './opponents';
import type { Category, PartDef, PartTag } from './parts';

export const CELL = 22;
/** Arena width/depth in world px (22 px = one grid cell). */
export const ARENA_SIZE = 830;
export const MATCH_SECONDS = 90;
export const STEP = 1 / 60;
/** Global damage multiplier — lower = longer fights. */
export const DAMAGE_SCALE = 0.8;

export type Vec = { x: number; y: number };

export type SimPart = {
  x: number;
  y: number;
  /** Layer: 1 = stacked on top of the part in the same cell, −1 = slung underneath it. */
  z: Layer;
  /** Facing in quarter turns clockwise from the front (weapons): 0 front, 1 right, 2 back, 3 left. */
  r: number;
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
  index: number;
  /** 0 = the player's side, 1 = the opposition. */
  team: 0 | 1;
  /** How hard its AI presses the attack (0..1). */
  aggr: number;
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
  /** Altitude above the floor (world px). Flying needs wing lift: see stats.maxAlt. */
  alt: number;
  vAlt: number;
  /** Wing stamina in seconds of flight left; drains in the air, refills on the ground. */
  stamina: number;
  /** Grounded until stamina refills to this fraction (after running out). */
  grounded: boolean;
  moves: MoveId[];
  moveCd: Partial<Record<MoveId, number>>;
  proc: number;
  /** Seconds of Carapace Lock left. */
  shield: number;
  /** Seconds of invulnerability left (Skitter Dash). */
  invuln: number;
  /** Seconds left tangled in silk: crawls, can't fly (Web Snare). */
  webbed: number;
  /** Seconds left stunned: can't move or attack (Static Burst). */
  stun: number;
  /** Seconds of invisibility left (Ghost Shell). */
  cloak: number;
  /** Seconds of Overclock left: faster movement and attacks. */
  haste: number;
  /** Seconds left underground (Burrow Strike): untouchable, tunnelling at its target. */
  burrow: number;
  /** Exponentially decaying recent damage taken, for move judgement. */
  recentDamage: number;
  /** Autonomous driver state (see aiInput). */
  ai: AiState;
};

export type Hazard =
  | { kind: 'acid'; x: number; y: number; r: number }
  | { kind: 'stomper'; x: number; y: number; r: number; period: number; t: number };

/** `z`/`vz`: altitude and climb rate, so darts can be shot up at flyers (or down from them). */
export type Projectile = { x: number; y: number; z: number; vx: number; vy: number; vz: number; damage: number; owner: number; ttl: number; big: boolean; kind?: 'web' | 'laser' };
/** `h`: altitude (world px). */
export type Effect = { x: number; y: number; h: number; ttl: number; color: string; size: number };

export type SimEvent =
  /** A part took damage. `part` indexes the victim's parts; `by` is the attacking bug (null for hazards/walls). */
  | { type: 'hit'; bug: number; by: number | null; part: number; x: number; y: number; h: number; dmg: number; broke: boolean; shielded: boolean; crit: boolean }
  | { type: 'break'; bug: number; x: number; y: number; h: number; category: Category; time: number }
  /** A bug hit the floor after losing lift; `impact` is its fall speed. */
  | { type: 'crash'; bug: number; x: number; y: number; impact: number }
  /** A bug slammed into the arena wall (`impact` = speed into it). */
  | { type: 'wall'; bug: number; x: number; y: number; impact: number; spiked: boolean }
  | { type: 'ult-start'; bug: number; move: MoveId }
  | { type: 'ult-release'; bug: number; move: MoveId }
  | { type: 'move'; bug: number; move: MoveId }
  /** A burrowed bug bursts out of the floor. */
  | { type: 'erupt'; bug: number; x: number; y: number };

export type Ult = { id: MoveId; caster: number; t: number; dur: number };

export type Sim = {
  /** Team 0 (the player's side, player first) then team 1. A 1v1 is [player, opponent]. */
  bugs: Bug[];
  hazards: Hazard[];
  arena: ArenaId;
  spikedWalls: boolean;
  projectiles: Projectile[];
  effects: Effect[];
  time: number;
  over: boolean;
  /** True if the match ended by forfeit (no rewards). */
  forfeited: boolean;
  /** Winning team: 0 = the player's side, 1 = the opposition, null = draw. */
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

export type Fighter = { build: Build; moves: MoveId[]; aggression?: number };

/** Desired movement direction in world space; magnitude (0..1) is throttle. */
export type Input = {
  x: number;
  y: number;
  /** Wanted altitude as a fraction (0..1) of the bug's flight ceiling. Ignored if it can't fly. */
  alt?: number;
  /**
   * Heading to turn to while moving (radians). Without it the bug turns toward
   * where it's going; with it, it crab-walks: sideways or backwards, more slowly.
   */
  face?: number;
};

const STOMP_WARN = 1.2;

/**
 * Critical hits (weapon hits only): a base chance, more when striking the
 * victim's side or rear, plus sensor bonuses (stats.crit). Crits multiply damage.
 */
export const CRIT = { base: 0.06, flank: 0.06, rear: 0.12, max: 0.35, mult: 1.6 } as const;

// ── Helpers ─────────────────────────────────────────────────────────

function rand(sim: Sim) {
  sim.rng = (sim.rng + 0x6d2b79f5) | 0;
  let t = sim.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** World angle a part points (its facing added to the bug's heading). */
export function facingAngle(bug: Bug, p: SimPart) {
  return bug.heading + p.r * (Math.PI / 2);
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

/** Living enemies of `bug`. */
export function foesOf(sim: Sim, bug: Bug) {
  return sim.bugs.filter((b) => b.team !== bug.team && !b.dead);
}

/** The enemy `bug` is dealing with: the nearest living one (or any enemy, if they're all down). */
export function foeOf(sim: Sim, bug: Bug): Bug {
  let best: Bug | null = null;
  let bestD = Infinity;
  for (const b of sim.bugs) {
    if (b.team === bug.team || b.dead) continue;
    const d = Math.hypot(b.pos.x - bug.pos.x, b.pos.y - bug.pos.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best ?? sim.bugs.find((b) => b.team !== bug.team)!;
}

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

function makeBug(index: number, team: 0 | 1, fighter: Fighter, pos: Vec, heading: number): Bug {
  const placed = resolve(fighter.build.placements);
  const ground = placed.filter((p) => !p.z);
  const cx = ground.reduce((a, p) => a + p.x, 0) / ground.length;
  const cy = ground.reduce((a, p) => a + p.y, 0) / ground.length;
  const parts: SimPart[] = placed.map((p) => ({
    x: p.x,
    y: p.y,
    z: p.z ?? 0,
    r: p.r ?? 0,
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
    team,
    aggr: fighter.aggression ?? 0.7,
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
    webbed: 0,
    stun: 0,
    cloak: 0,
    haste: 0,
    burrow: 0,
    recentDamage: 0,
    alt: 0,
    vAlt: 0,
    stamina: 0,
    grounded: false,
    ai: newAi(index),
  };
  refresh(bug);
  bug.stamina = maxStamina(bug);
  return bug;
}

/** Seconds a bug can stay airborne: more lift for its weight = longer flights. */
export function maxStamina(bug: Bug) {
  return bug.stats.maxAlt > 0 ? 2.2 + (bug.stats.maxAlt / 70) * 2.6 : 0;
}

function arenaHazards(arena: ArenaId): { hazards: Hazard[]; spikedWalls: boolean } {
  const m = ARENA_SIZE / 2;
  /** Hazard positions are laid out on a 600-wide plan and scaled to the arena; sizes stay fixed. */
  const at = (v: number) => (v / 600) * ARENA_SIZE;
  switch (arena) {
    case 'pit':
      return {
        spikedWalls: false,
        hazards: [
          { kind: 'acid', x: at(150), y: m, r: 52 },
          { kind: 'acid', x: at(450), y: m, r: 52 },
        ],
      };
    case 'foundry':
      return {
        spikedWalls: true,
        hazards: [
          { kind: 'stomper', x: m, y: m, r: 70, period: 6, t: 0 },
          { kind: 'acid', x: at(110), y: at(110), r: 46 },
          { kind: 'acid', x: at(490), y: at(490), r: 46 },
        ],
      };
    case 'hive':
      return {
        spikedWalls: true,
        hazards: [
          { kind: 'stomper', x: at(170), y: m, r: 60, period: 5, t: 0 },
          { kind: 'stomper', x: at(430), y: m, r: 60, period: 5, t: 2.5 },
          { kind: 'acid', x: m, y: m, r: 40 },
        ],
      };
  }
}

export function createSim(player: Fighter, opponent: Fighter, arena: ArenaId, seed: number): Sim {
  return createTeamSim([player], [opponent], arena, seed);
}

/** A fight between two sides of 1–3 bugs each. `allies[0]` is the player's own bug. */
export function createTeamSim(allies: Fighter[], enemies: Fighter[], arena: ArenaId, seed: number): Sim {
  const { hazards, spikedWalls } = arenaHazards(arena);
  // Line each side up across the arena.
  const xs = (n: number, k: number) => ARENA_SIZE / 2 + (n === 1 ? 0 : (k - (n - 1) / 2) * (n === 2 ? 0.32 : 0.26) * ARENA_SIZE);
  const bugs: Bug[] = [];
  allies.forEach((f, k) => bugs.push(makeBug(bugs.length, 0, f, { x: xs(allies.length, k), y: ARENA_SIZE * 0.78 }, -Math.PI / 2)));
  enemies.forEach((f, k) => bugs.push(makeBug(bugs.length, 1, f, { x: xs(enemies.length, k), y: ARENA_SIZE * 0.22 }, Math.PI / 2)));
  return {
    bugs,
    hazards,
    arena,
    spikedWalls,
    projectiles: [],
    effects: [],
    time: 0,
    over: false,
    forfeited: false,
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
  bug.stats = computeStats(alive.map((p) => ({ x: p.x, y: p.y, z: p.z, part: p.part })));
  bug.radius = alive.reduce((m, p) => Math.max(m, Math.hypot(p.lx, p.ly)), 0) + CELL * 0.5;
  const hasCore = alive.some((p) => p.part.category === 'core');
  const hasThorax = alive.some((p) => p.part.category === 'thorax');
  if (!hasCore || !hasThorax) bug.dead = true;
}

// ── Damage ──────────────────────────────────────────────────────────

function nearestPart(bug: Bug, at: Vec, exposedOnly = false): { p: SimPart; w: Vec; d: number } | null {
  let best: { p: SimPart; w: Vec; d: number } | null = null;
  for (const p of bug.parts) {
    if (!p.alive || (exposedOnly && shielded(bug, p))) continue;
    const w = partWorld(bug, p);
    const d = Math.hypot(w.x - at.x, w.y - at.y);
    if (!best || d < best.d) best = { p, w, d };
  }
  return best;
}

/** Is this part hidden from weapons? Parts slung underneath are, while the part above them survives. */
function shielded(bug: Bug, p: SimPart) {
  return p.z === -1 && bug.parts.some((q) => q.alive && q.z === 0 && q.x === p.x && q.y === p.y);
}

/**
 * A strike lands on the nearest exposed part, or a random neighbour of it.
 * `fromAbove`: attacks from higher up favour parts stacked on top.
 */
function strikeTarget(sim: Sim, bug: Bug, at: Vec, fromAbove = false): SimPart | null {
  const near = nearestPart(bug, at, true);
  if (!near) return null;
  let options = bug.parts.filter((p) => {
    if (!p.alive || shielded(bug, p)) return false;
    const w = partWorld(bug, p);
    return Math.hypot(w.x - at.x, w.y - at.y) <= near.d + CELL * 1.1;
  });
  if (fromAbove) {
    const tops = options.filter((p) => p.z === 1);
    if (tops.length && rand(sim) < 0.6) options = tops;
  }
  return options[Math.floor(rand(sim) * options.length)] ?? near.p;
}

function gainProc(bug: Bug, n: number) {
  if (!bug.dead) bug.proc = Math.min(PROC.max, bug.proc + n);
}

function canBeHurt(sim: Sim, bug: Bug) {
  if (bug.dead || bug.invuln > 0 || bug.burrow > 0) return false;
  return !(sim.ult && sim.ult.caster === bug.index);
}

/**
 * Apply damage to one part. `attacker` is the bug credited with proc points
 * (null for hazards and walls).
 */
/** Chance that `attacker` lands a critical hit on `victim` when striking from `from`. */
export function critChance(attacker: Bug, victim: Bug, from: Vec) {
  const side = Math.abs(angleDiff(victim.heading, Math.atan2(from.y - victim.pos.y, from.x - victim.pos.x)));
  const angle = side > 2.1 ? CRIT.rear : side > 1.1 ? CRIT.flank : 0;
  return Math.min(CRIT.max, CRIT.base + angle + attacker.stats.crit);
}

function damagePart(sim: Sim, bug: Bug, p: SimPart, dmg: number, attacker: Bug | null, crit = false) {
  if (!p.alive || !canBeHurt(sim, bug)) return;
  if (bug.cloak > 0) bug.cloak = Math.min(bug.cloak, 0.4); // a hit flushes it out of hiding
  dmg *= DAMAGE_SCALE * (0.8 + rand(sim) * 0.4) * (crit ? CRIT.mult : 1);
  if (bug.shield > 0) dmg *= 0.3;
  p.hp -= dmg;
  p.flash = 0.15;
  bug.recentDamage += dmg;
  gainProc(bug, (dmg / 5) * PROC.damageTakenPer5);
  if (p.part.category === 'armor') gainProc(bug, PROC.armorAbsorb);
  if (attacker) gainProc(attacker, PROC.hitLanded + (crit ? PROC.crit : 0));

  const w = partWorld(bug, p);
  sim.effects.push({ x: w.x, y: w.y, h: bug.alt, ttl: crit ? 0.35 : 0.25, color: crit ? '#FF9A2E' : '#FFE08A', size: 6 + Math.min(dmg, 20) * 0.6 + (crit ? 8 : 0) });
  sim.events.push({
    type: 'hit',
    bug: bug.index,
    by: attacker ? attacker.index : null,
    part: bug.parts.indexOf(p),
    x: w.x,
    y: w.y,
    h: bug.alt,
    dmg,
    broke: p.hp <= 0,
    shielded: bug.shield > 0,
    crit,
  });
  // Heavier hits rattle the camera a little; crits get a beat of hit-stop.
  sim.shake = Math.max(sim.shake, Math.min(0.12, dmg * 0.006));
  if (crit) {
    sim.hitstop = Math.max(sim.hitstop, 0.04);
    sim.shake = Math.max(sim.shake, 0.18);
  }
  if (p.hp > 0) return;

  p.alive = false;
  // A part breaking gets a beat of hit-stop and a proper shake.
  sim.hitstop = Math.max(sim.hitstop, 0.05);
  sim.shake = Math.max(sim.shake, 0.24);
  if (attacker) gainProc(attacker, PROC.partBroken);
  sim.events.push({ type: 'break', bug: bug.index, x: w.x, y: w.y, h: bug.alt, category: p.part.category, time: sim.time });
  sim.log.push(`${bug.name} lost ${p.part.name}!`);

  // Anything no longer connected to the body falls off.
  const alive = bug.parts.filter((q) => q.alive);
  const keep = connectedKeys(alive.map((q) => ({ x: q.x, y: q.y, z: q.z, part: q.part })));
  for (const q of alive) {
    if (!keep.has(pkey(q))) {
      q.alive = false;
      const qw = partWorld(bug, q);
      sim.events.push({ type: 'break', bug: bug.index, x: qw.x, y: qw.y, h: bug.alt, category: q.part.category, time: sim.time });
      sim.log.push(`${bug.name}'s ${q.part.name} broke off!`);
    }
  }
  refresh(bug);
  if (bug.dead) sim.log.push(`${bug.name} is disabled!`);
}

function damageNear(sim: Sim, bug: Bug, at: Vec, dmg: number, attacker: Bug | null) {
  const hit = nearestPart(bug, at, true);
  if (hit) damagePart(sim, bug, hit.p, dmg, attacker);
}

// ── Signature moves ─────────────────────────────────────────────────

function moveReady(sim: Sim, bug: Bug, id: MoveId): boolean {
  const m = getMove(id);
  if ((bug.moveCd[id] ?? 0) > 0 || bug.proc < m.cost) return false;
  if (m.ultimate && sim.ult) return false;
  return meetsRequirement(m, bug.parts.filter((p) => p.alive).map((p) => p.part));
}

/** Does this move make sense right now? */
function judge(sim: Sim, bug: Bug, id: MoveId): boolean {
  const foe = foeOf(sim, bug);
  const dx = foe.pos.x - bug.pos.x;
  const dy = foe.pos.y - bug.pos.y;
  const dist = Math.hypot(dx, dy);
  const facing = Math.abs(angleDiff(bug.heading, Math.atan2(dy, dx)));
  // Can't aim a big attack at something it can't see.
  if ((foe.cloak > 0 || foe.burrow > 0) && dist > 60 && AIMED.includes(id)) return false;
  const near = (range: number, flyersOnly = false) =>
    foesOf(sim, bug).some(
      (e) =>
        e.burrow <= 0 &&
        Math.hypot(e.pos.x - bug.pos.x, e.pos.y - bug.pos.y) < range + e.radius * 0.5 &&
        Math.abs(e.alt - bug.alt) < 45 &&
        (!flyersOnly || e.alt > 8),
    );
  switch (id) {
    case 'mandible-crusher': {
      return bug.parts.some((p) => {
        if (!p.alive || p.part.category !== 'mandibles') return false;
        const near = nearestPart(foe, partWorld(bug, p), true);
        return !!near && near.d < 70 && facing < 0.9 && Math.abs(foe.alt - bug.alt) < 30;
      });
    }
    case 'venom-barrage': {
      // The bug swings its stinger onto the target during the wind-up, so it only
      // needs to be roughly on that side (whichever way the stinger points).
      const sting = bug.parts.find((p) => p.alive && p.part.category === 'stinger');
      const aim = sting ? Math.abs(angleDiff(facingAngle(bug, sting), Math.atan2(dy, dx))) : facing;
      return Math.hypot(dist, foe.alt - bug.alt) < 280 && aim < 1.4;
    }
    case 'carapace-lock':
      return bug.shield <= 0 && (bug.recentDamage > 22 || (hpFraction(bug) < 0.4 && dist < 100));
    case 'skitter-dash': {
      const underStomper = sim.hazards.some(
        (h) => stompWarning(h) && Math.hypot(bug.pos.x - h.x, bug.pos.y - h.y) < h.r + bug.radius * 0.5,
      );
      return underStomper || (dist < 80 && bug.recentDamage > 14 && hpFraction(bug) < hpFraction(foe));
    }
    case 'web-snare':
      return foe.webbed <= 0 && dist > 40 && dist < 250;
    case 'burrow-strike':
      return bug.alt < 6 && bug.webbed <= 0 && foe.alt < 30 && dist > 70 && dist < 330;
    case 'ghost-shell':
      return bug.cloak <= 0 && dist > 90 && dist < 320 && foe.parts.some((p) => p.alive && p.part.weapon);
    case 'sunder-beam':
      return dist < 300 && Math.abs(foe.alt - bug.alt) < 40;
    case 'static-burst':
      return near(105);
    case 'overclock':
      return bug.haste <= 0 && dist < 170;
    case 'gale-flap':
      return near(120, true) || (near(120) && bug.recentDamage > 10);
  }
}

/** Moves that need to see their target. */
const AIMED: MoveId[] = ['mandible-crusher', 'venom-barrage', 'web-snare', 'burrow-strike', 'sunder-beam'];

/** Heading that points `bug`'s part tagged `tag` (whichever way it's mounted) at `foe`. */
export function aimHeading(bug: Bug, foe: Bug, tag: PartTag) {
  const part = bug.parts.find((p) => p.alive && p.part.tag === tag);
  return Math.atan2(foe.pos.y - bug.pos.y, foe.pos.x - bug.pos.x) - (part?.r ?? 0) * (Math.PI / 2);
}

/** Tangle a bug in silk. Spider-legged bugs shrug most of it off. */
function snare(sim: Sim, bug: Bug) {
  const spider = bug.parts.some((p) => p.alive && p.part.tag === 'spider');
  bug.webbed = spider ? 1.2 : 3.5;
  sim.log.push(spider ? `${bug.name} shrugs off the web.` : `${bug.name} is webbed!`);
}

/** A burrowed bug bursts out: hits what's above it from underneath and tosses it. */
function erupt(sim: Sim, bug: Bug) {
  sim.events.push({ type: 'erupt', bug: bug.index, x: bug.pos.x, y: bug.pos.y });
  sim.effects.push({ x: bug.pos.x, y: bug.pos.y, h: 0, ttl: 0.4, color: '#C98B4A', size: bug.radius * 2.4 });
  sim.shake = Math.max(sim.shake, 0.4);
  for (const e of foesOf(sim, bug)) {
    const d = Math.hypot(e.pos.x - bug.pos.x, e.pos.y - bug.pos.y);
    if (e.burrow > 0 || e.alt > 30 || d > bug.radius + e.radius * 0.6 + 20) continue;
    // From below: anything slung underneath first, then legs, then whatever's nearest.
    const targets = e.parts
      .filter((p) => p.alive)
      .map((p) => {
        const w = partWorld(e, p);
        return { p, d: Math.hypot(w.x - bug.pos.x, w.y - bug.pos.y), pri: p.z === -1 ? 0 : p.part.category === 'legs' ? 1 : 2 };
      })
      .sort((a, b) => a.pri - b.pri || a.d - b.d)
      .slice(0, 3);
    for (const { p } of targets) damagePart(sim, e, p, 24, bug);
    if (!e.dead) {
      // Tossed into the air; it lands hard.
      e.alt = Math.max(e.alt, 6);
      e.vAlt = 150;
      e.vel.x += ((e.pos.x - bug.pos.x) / (d || 1)) * 120;
      e.vel.y += ((e.pos.y - bug.pos.y) / (d || 1)) * 120;
    }
  }
}

/** Underground: untouchable, tunnelling straight at its target, then erupting beneath it. */
function stepBurrow(sim: Sim, bug: Bug, dt: number) {
  const foe = foeOf(sim, bug);
  const dx = foe.pos.x - bug.pos.x;
  const dy = foe.pos.y - bug.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  if (!foe.dead && d > 4) {
    const go = Math.min(d, Math.max(150, bug.stats.topSpeed * 1.5) * dt);
    bug.pos.x += (dx / d) * go;
    bug.pos.y += (dy / d) * go;
    const turn = angleDiff(bug.heading, Math.atan2(dy, dx));
    bug.heading += Math.sign(turn) * Math.min(Math.abs(turn), 7 * dt);
  }
  const r = bug.radius;
  bug.pos.x = Math.max(r, Math.min(ARENA_SIZE - r, bug.pos.x));
  bug.pos.y = Math.max(r, Math.min(ARENA_SIZE - r, bug.pos.y));
  bug.vel.x = 0;
  bug.vel.y = 0;
  bug.alt = 0;
  bug.vAlt = 0;
  bug.burrow -= dt;
  // Right underneath: come up after a moment's rumble.
  if (bug.burrow > 0.25 && d < (bug.radius + foe.radius) * 0.35) bug.burrow = 0.25;
  if (bug.burrow <= 0) {
    bug.burrow = 0;
    erupt(sim, bug);
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
  const foe = foeOf(sim, bug);
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
      // Swing round so the stinger points straight at the target (the cutscene shows the turn)…
      bug.heading = aimHeading(bug, foe, 'venom');
      const from = sting ? partWorld(bug, sting) : bug.pos;
      // …and fire a tight fan at where the target will be when the darts arrive.
      const tFly = Math.max(0.1, Math.hypot(foe.pos.x - from.x, foe.pos.y - from.y) / 380);
      const lead = { x: foe.pos.x + foe.vel.x * tFly * 0.6, y: foe.pos.y + foe.vel.y * tFly * 0.6 };
      const aim = Math.atan2(lead.y - from.y, lead.x - from.x);
      for (let k = -3; k <= 3; k++) {
        const a = aim + k * 0.055;
        const dz = foe.alt - bug.alt;
        sim.projectiles.push({ x: from.x, y: from.y, z: bug.alt, vx: Math.cos(a) * 380, vy: Math.sin(a) * 380, vz: dz / tFly, damage: 10, owner: bug.index, ttl: 1, big: true });
      }
      break;
    }
    case 'carapace-lock':
      bug.shield = 4;
      break;
    case 'skitter-dash': {
      // Sidestep away from danger: pick the side facing away from the foe.
      let side = angleDiff(bug.heading, Math.atan2(foe.pos.y - bug.pos.y, foe.pos.x - bug.pos.x)) > 0 ? -1 : 1;
      // …unless that side is a wall: dash the other way.
      const out = (k: number) => wallGap({ x: bug.pos.x - f.y * k * 120, y: bug.pos.y + f.x * k * 120 });
      if (out(side) < bug.radius + 10 && out(-side) > out(side)) side = -side;
      bug.vel.x += -f.y * side * 340;
      bug.vel.y += f.x * side * 340;
      bug.invuln = 0.5;
      gainProc(bug, PROC.dodge);
      break;
    }
    case 'web-snare': {
      const gland = bug.parts.find((p) => p.alive && p.part.tag === 'silk');
      const from = gland ? partWorld(bug, gland) : bug.pos;
      const tFly = Math.max(0.1, Math.hypot(foe.pos.x - from.x, foe.pos.y - from.y) / 300);
      const a = Math.atan2(foe.pos.y + foe.vel.y * tFly * 0.7 - from.y, foe.pos.x + foe.vel.x * tFly * 0.7 - from.x);
      sim.projectiles.push({ x: from.x, y: from.y, z: bug.alt + 6, vx: Math.cos(a) * 300, vy: Math.sin(a) * 300, vz: (foe.alt - bug.alt - 6) / tFly, damage: 4, owner: bug.index, ttl: 1.3, big: true, kind: 'web' });
      break;
    }
    case 'burrow-strike':
      bug.burrow = 1.5;
      bug.vel.x = 0;
      bug.vel.y = 0;
      break;
    case 'ghost-shell':
      bug.cloak = 4.5;
      break;
    case 'sunder-beam': {
      // Swing the lens onto the target, then cut straight through everything in line.
      bug.heading = aimHeading(bug, foe, 'laser');
      const lens = bug.parts.find((p) => p.alive && p.part.tag === 'laser');
      const from = lens ? partWorld(bug, lens) : bug.pos;
      const a = Math.atan2(foe.pos.y - from.y, foe.pos.x - from.x);
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      for (const e of foesOf(sim, bug)) {
        if (e.burrow > 0 || Math.abs(e.alt - bug.alt) > 45) continue;
        e.parts
          .filter((p) => p.alive && !shielded(e, p))
          .map((p) => {
            const w = partWorld(e, p);
            return { p, along: (w.x - from.x) * ux + (w.y - from.y) * uy, off: Math.abs((w.x - from.x) * uy - (w.y - from.y) * ux) };
          })
          .filter((t) => t.along > 0 && t.off < CELL * 0.75)
          .sort((x, y) => x.along - y.along)
          .slice(0, 5)
          .forEach(({ p }, k) => damagePart(sim, e, p, 22 * (1 - k * 0.08), bug));
      }
      break;
    }
    case 'static-burst':
      for (const e of foesOf(sim, bug)) {
        const d = Math.hypot(e.pos.x - bug.pos.x, e.pos.y - bug.pos.y);
        if (e.burrow > 0 || d > 120 + e.radius * 0.5 || Math.abs(e.alt - bug.alt) > 45) continue;
        e.stun = 1.3;
        e.proc = Math.max(0, e.proc - 15);
        e.parts
          .filter((p) => p.alive)
          .map((p) => ({ p, d: Math.hypot(partWorld(e, p).x - bug.pos.x, partWorld(e, p).y - bug.pos.y) }))
          .sort((x, y) => x.d - y.d)
          .slice(0, 2)
          .forEach(({ p }) => damagePart(sim, e, p, 8, bug));
      }
      sim.effects.push({ x: bug.pos.x, y: bug.pos.y, h: bug.alt, ttl: 0.4, color: '#FFE14D', size: 240 });
      break;
    case 'overclock':
      bug.haste = 5;
      break;
    case 'gale-flap':
      for (const e of foesOf(sim, bug)) {
        const d = Math.hypot(e.pos.x - bug.pos.x, e.pos.y - bug.pos.y) || 1;
        if (e.burrow > 0 || d > 150 + e.radius * 0.5) continue;
        // Lighter bugs fly further; anything in the air is knocked out of it.
        const push = 320 * Math.max(0.5, Math.min(1.6, 90 / Math.max(1, e.stats.mass)));
        e.vel.x += ((e.pos.x - bug.pos.x) / d) * push;
        e.vel.y += ((e.pos.y - bug.pos.y) / d) * push;
        if (e.alt > 6) e.stamina = 0;
      }
      gainProc(bug, PROC.dodge);
      break;
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

function stepBug(sim: Sim, i: number, input: Input, dt: number) {
  const bug = sim.bugs[i];
  bug.recentDamage *= Math.exp(-dt * 0.8);
  bug.shield = Math.max(0, bug.shield - dt);
  bug.invuln = Math.max(0, bug.invuln - dt);
  bug.webbed = Math.max(0, bug.webbed - dt);
  bug.stun = Math.max(0, bug.stun - dt);
  bug.cloak = Math.max(0, bug.cloak - dt);
  bug.haste = Math.max(0, bug.haste - dt);
  for (const id of bug.moves) bug.moveCd[id] = Math.max(0, (bug.moveCd[id] ?? 0) - dt);
  if (bug.dead) {
    bug.vel.x *= 0.9;
    bug.vel.y *= 0.9;
    stepFlight(sim, bug, { x: 0, y: 0 }, dt);
    return;
  }
  if (bug.burrow > 0) {
    stepBurrow(sim, bug, dt);
    return;
  }
  const s = bug.stats;
  const throttle = bug.stun > 0 ? 0 : Math.min(1, Math.hypot(input.x, input.y));
  // Silk slows (spider legs mostly ignore it); Overclock speeds up.
  const spider = bug.webbed > 0 && bug.parts.some((p) => p.alive && p.part.tag === 'spider');
  const pace = (bug.webbed > 0 ? (spider ? 0.8 : 0.35) : 1) * (bug.haste > 0 ? 1.35 : 1);
  const want = Math.atan2(input.y, input.x);
  const crab = input.face !== undefined && throttle > 0.05;
  let align = 0;
  if (throttle > 0.05) {
    const d = angleDiff(bug.heading, crab ? input.face! : want);
    const turn = Math.sign(d) * Math.min(Math.abs(d), s.turnRate * (bug.webbed > 0 && !spider ? 0.55 : 1) * dt);
    bug.heading += turn;
    align = Math.max(0, Math.cos(angleDiff(bug.heading, want)));
  }
  // Lopsided legs make the bug pull to one side.
  bug.heading -= s.thrustBias * 1.4 * throttle * dt;

  // Normally a bug walks where it points; crab-walking moves along the input, slower off-axis.
  const f = crab ? forward(want) : forward(bug.heading);
  const speed = pace * (crab ? s.topSpeed * throttle * (0.42 + 0.58 * align) : s.topSpeed * throttle * (0.3 + 0.7 * align));
  const k = Math.min(1, 5 * dt);
  bug.vel.x += (f.x * speed - bug.vel.x) * k;
  bug.vel.y += (f.y * speed - bug.vel.y) * k;

  stepFlight(sim, bug, input, dt);

  // Weapons fire automatically when an enemy part is inside their cone and reach.
  const foes = foesOf(sim, bug);
  if (foes.length && bug.stun <= 0) {
    for (const p of bug.parts) {
      const w = p.part.weapon;
      if (!p.alive || !w) continue;
      p.cooldown -= dt * (bug.haste > 0 ? 1.5 : 1);
      if (p.cooldown > 0) continue;
      const wp = partWorld(bug, p);
      // The nearest exposed part of any enemy.
      let target: ReturnType<typeof nearestPart> = null;
      let enemy = foes[0];
      for (const f of foes) {
        if (f.burrow > 0) continue; // underground
        const t = nearestPart(f, wp, true);
        if (t && f.cloak > 0 && t.d > CELL * 1.2) continue; // can't see it unless it's touching
        if (t && (!target || t.d < target.d)) {
          target = t;
          enemy = f;
        }
      }
      if (!target) continue;
      const reach = w.range * s.reach + CELL * 0.5;
      // Height difference counts: ground jaws can't reach a bug flying overhead.
      const dz = enemy.alt - bug.alt;
      if (Math.hypot(target.d, dz) > reach) continue;
      const toward = Math.atan2(target.w.y - wp.y, target.w.x - wp.x);
      if (target.d > CELL && Math.abs(angleDiff(facingAngle(bug, p), toward)) > w.arc) continue;
      p.cooldown = w.cooldown;
      // Striking gives away a cloaked bug, but the ambush always crits (melee).
      const ambush = bug.cloak > 0;
      if (ambush) bug.cloak = 0;
      if (w.projectileSpeed) {
        const dx = target.w.x - wp.x;
        const dy = target.w.y - wp.y;
        const n = Math.hypot(dx, dy) || 1;
        const flight = Math.max(0.05, Math.hypot(n, dz) / w.projectileSpeed);
        sim.projectiles.push({
          x: wp.x,
          y: wp.y,
          z: bug.alt,
          vx: (dx / n) * w.projectileSpeed,
          vy: (dy / n) * w.projectileSpeed,
          vz: dz / flight,
          damage: w.damage,
          owner: i,
          ttl: (reach * 1.3) / w.projectileSpeed,
          big: false,
          kind: w.beam ? 'laser' : undefined,
        });
      } else {
        let dmg = w.damage;
        if (w.ramBonus) {
          const closing = (bug.vel.x - enemy.vel.x) * Math.cos(toward) + (bug.vel.y - enemy.vel.y) * Math.sin(toward);
          dmg += Math.max(0, closing) * w.ramBonus;
        }
        const crit = rand(sim) < critChance(bug, enemy, wp) || ambush;
        damagePart(sim, enemy, strikeTarget(sim, enemy, wp, bug.alt > enemy.alt + 15) ?? target.p, dmg, bug, crit);
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
    if (impact > 40) {
      sim.events.push({ type: 'wall', bug: bug.index, x: wallPt.x, y: wallPt.y, impact, spiked: sim.spikedWalls });
      if (sim.spikedWalls) damageNear(sim, bug, wallPt, 4 + impact * 0.06, null);
    }
  });

  // Acid
  bug.hazardTimer -= dt;
  for (const h of sim.hazards) {
    const d = Math.hypot(bug.pos.x - h.x, bug.pos.y - h.y);
    if (h.kind === 'acid' && d < h.r && bug.alt < 6 && bug.hazardTimer <= 0) {
      bug.hazardTimer = 0.5;
      // Acid eats the underside first: anything slung under the bug.
      const belly = bug.parts.filter((p) => p.alive && p.z === -1);
      const alive = belly.length ? belly : bug.parts.filter((p) => p.alive);
      const victim = alive[Math.floor(rand(sim) * alive.length)];
      if (victim) damagePart(sim, bug, victim, 5, null);
    }
  }
}

/**
 * Altitude. Bugs with enough wing lift climb toward the altitude the AI asks
 * for; a bug that loses its wings (or is disabled) falls, and hitting the floor
 * hard damages its underside and legs.
 */
function stepFlight(sim: Sim, bug: Bug, input: Input, dt: number) {
  const ceiling = bug.dead ? 0 : bug.stats.maxAlt;
  // Wing stamina: drains in the air, refills on the ground. Run dry and you must land.
  const max = maxStamina(bug);
  if (bug.alt > 4) bug.stamina = Math.max(0, bug.stamina - dt);
  else bug.stamina = Math.min(max, bug.stamina + dt * 0.9);
  if (bug.stamina <= 0 && bug.alt > 4 && !bug.grounded) {
    bug.grounded = true;
    sim.log.push(`${bug.name}'s wings are spent!`);
  }
  if (bug.grounded && bug.stamina >= max * 0.6) bug.grounded = false;
  if (bug.alt > ceiling + 1) {
    // Falling.
    bug.vAlt -= 420 * dt;
  } else {
    const want = bug.grounded || bug.webbed > 0 || bug.stun > 0 ? 0 : Math.max(0, Math.min(1, input.alt ?? 0)) * ceiling;
    const climb = Math.max(-120, Math.min(90, (want - bug.alt) * 5));
    bug.vAlt += (climb - bug.vAlt) * Math.min(1, dt * 8);
  }
  bug.alt += bug.vAlt * dt;
  if (bug.alt <= 0) {
    const impact = -bug.vAlt;
    bug.alt = 0;
    bug.vAlt = 0;
    if (impact > 120) {
      sim.events.push({ type: 'crash', bug: bug.index, x: bug.pos.x, y: bug.pos.y, impact });
      sim.shake = Math.max(sim.shake, 0.3);
      const low = bug.parts
        .filter((p) => p.alive)
        .sort((a, b) => a.z - b.z || Number(b.part.category === 'legs') - Number(a.part.category === 'legs'))
        .slice(0, 3);
      for (const p of low) damagePart(sim, bug, p, (impact - 100) * 0.12, null);
    }
  }
  bug.alt = Math.min(bug.alt, Math.max(ceiling, bug.alt)); // never pushed up past the ceiling by itself
}

function stepStompers(sim: Sim, dt: number) {
  for (const h of sim.hazards) {
    if (h.kind !== 'stomper') continue;
    const before = h.t;
    h.t = (h.t + dt) % h.period;
    if (h.t >= before) continue;
    // Slam! Damage the three nearest parts of any bug under it.
    sim.effects.push({ x: h.x, y: h.y, h: 0, ttl: 0.4, color: '#FF8A3D', size: h.r * 2 });
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
  for (let i = 0; i < sim.bugs.length; i++) for (let j = i + 1; j < sim.bugs.length; j++) collidePair(sim, sim.bugs[i], sim.bugs[j]);
}

function collidePair(sim: Sim, a: Bug, b: Bug) {
  if (Math.abs(a.alt - b.alt) > 26) return; // one is flying over the other
  if (a.burrow > 0 || b.burrow > 0) return; // one is underground
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
  if (closing > 70 && a.team !== b.team) {
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

/** Advance the world by `dt` (use STEP). `inputs[i]` drives `sim.bugs[i]`. */
export function step(sim: Sim, dt: number, inputs: Input[]) {
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
  for (let i = 0; i < sim.bugs.length; i++) stepBug(sim, i, inputs[i] ?? { x: 0, y: 0 }, dt);
  collideBugs(sim);
  stepStompers(sim, dt);

  for (const pr of sim.projectiles) {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.z = Math.max(0, pr.z + pr.vz * dt);
    pr.ttl -= dt;
    const attacker = sim.bugs[pr.owner];
    for (const target of foesOf(sim, attacker)) {
      if (target.burrow > 0) continue;
      const hit = nearestPart(target, pr, true);
      if (!(hit && hit.d < CELL * (pr.kind === 'web' ? 1.1 : 0.6) && Math.abs(pr.z - target.alt) < (pr.kind === 'web' ? 30 : 20))) continue;
      if (pr.kind === 'web') {
        snare(sim, target);
        damagePart(sim, target, hit.p, pr.damage, attacker);
        pr.ttl = 0;
        break;
      }
      // Weapon darts can crit (judged by where they came from); move volleys can't.
      const from = { x: pr.x - pr.vx * 0.2, y: pr.y - pr.vy * 0.2 };
      const crit = !pr.big && rand(sim) < critChance(attacker, target, from);
      damagePart(sim, target, strikeTarget(sim, target, pr, pr.z > target.alt + 8) ?? hit.p, pr.damage, attacker, crit);
      pr.ttl = 0;
      break;
    }
  }
  sim.projectiles = sim.projectiles.filter((p) => p.ttl > 0);
  for (const bug of sim.bugs) for (const p of bug.parts) p.flash = Math.max(0, p.flash - dt);
  checkOver(sim);
}

function checkOver(sim: Sim) {
  const up = (team: 0 | 1) => sim.bugs.some((b) => b.team === team && !b.dead);
  if (!up(0) || !up(1)) {
    sim.over = true;
    sim.winner = !up(0) && !up(1) ? null : !up(0) ? 1 : 0;
  } else if (sim.time >= MATCH_SECONDS) {
    sim.over = true;
    const fp = teamHp(sim, 0);
    const fo = teamHp(sim, 1);
    sim.winner = Math.abs(fp - fo) < 0.01 ? null : fp > fo ? 0 : 1;
    sim.log.push('Time! Judges decide on remaining integrity.');
  }
}

/** Remaining integrity of a whole side (0..1). */
export function teamHp(sim: Sim, team: 0 | 1) {
  const mine = sim.bugs.filter((b) => b.team === team);
  const hp = mine.reduce((a, b) => a + b.parts.reduce((s, p) => s + (p.alive ? Math.max(0, p.hp) : 0), 0), 0);
  return hp / Math.max(1, mine.reduce((a, b) => a + b.maxHp, 0));
}

export function forfeit(sim: Sim, team: 0 | 1) {
  if (sim.over) return;
  sim.over = true;
  sim.forfeited = true;
  sim.winner = team === 0 ? 1 : 0;
  sim.log.push(`${sim.bugs.find((b) => b.team === team)!.name} forfeits.`);
}

// ── AI ──────────────────────────────────────────────────────────────
//
// A small state machine per bug, driven entirely by sim state (deterministic):
//   approach → circle round the enemy's weapons to the side of a juicy part
//   strike   → dive at that part with our weapons
//   retreat  → peel away after a flurry (or when losing the trade), then re-engage
//   windup / charge → rammers (horns) back off, then charge at full speed
//   orbit    → ranged builds circle at range and turn in to shoot
// The style comes from the build: weapons, speed and turning vs the enemy's.

export type AiMode = 'approach' | 'strike' | 'retreat' | 'windup' | 'charge' | 'orbit';
export type AiState = {
  mode: AiMode;
  t: number;
  side: 1 | -1;
  target: number;
  engaged: number;
  stuck: number;
  /** Smoothed body angle (radians) used to turn precious parts away from the enemy. */
  guard: number;
  /** Index of the enemy it's fighting (it sticks with one until another is much closer). */
  foe: number;
  /** Where it last saw that enemy (it hunts there while the enemy is cloaked). */
  seenX: number;
  seenY: number;
};

export function newAi(index: number): AiState {
  return { mode: 'approach', t: 0, side: index % 2 === 0 ? 1 : -1, target: -1, engaged: 0, stuck: 0, guard: 0, foe: -1, seenX: 0, seenY: 0 };
}

/** How much we want to break each part category. */
const TARGET_VALUE: Record<Category, number> = {
  core: 3,
  thorax: 2.2,
  mandibles: 2.4,
  pincers: 2.4,
  stinger: 2.6,
  horn: 2,
  legs: 2,
  wings: 1.6,
  head: 1.4,
  sensor: 1,
  abdomen: 1,
  armor: 0.5,
};

/** Distance from `p` to the nearest arena wall. */
function wallGap(p: Vec) {
  return Math.min(p.x, p.y, ARENA_SIZE - p.x, ARENA_SIZE - p.y);
}

/** Unit vector from `p` toward the nearest wall. */
function wallNormal(p: Vec): Vec {
  const g = [p.x, ARENA_SIZE - p.x, p.y, ARENA_SIZE - p.y];
  const i = g.indexOf(Math.min(...g));
  return [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }][i];
}

/** How open the space is `ahead` px along `d` (bigger = more room). */
function room(bug: Bug, d: Vec, ahead: number) {
  return wallGap({ x: bug.pos.x + d.x * ahead, y: bug.pos.y + d.y * ahead });
}

function rotate(v: Vec, a: number): Vec {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

const unit = (v: Vec): Vec => {
  const n = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / n, y: v.y / n };
};

/**
 * How much a bug wants to keep a part of its own out of harm's way: cores most
 * (it's out without them), then weapons (more so the last one), then legs and
 * wings, then the rest. Worn parts matter more. Armor is happy to take hits.
 */
function partWorth(p: SimPart, weapons: number, cores: number) {
  const c = p.part.category;
  if (c === 'armor') return -0.6;
  const base = c === 'core' ? (cores <= 1 ? 4 : 3) : p.part.weapon ? (weapons <= 1 ? 3.2 : 2.4) : c === 'thorax' ? 2 : c === 'legs' || c === 'wings' ? 1.6 : 1;
  const wear = 1 - Math.max(0, p.hp) / p.part.hp;
  return base * (0.6 + wear * 1.6);
}

/** How much of `bug`'s precious stuff faces `foe` if it points along heading `h` (lower = safer). */
function exposure(bug: Bug, foe: Bug, h: number) {
  const parts = bug.parts.filter((p) => p.alive);
  const weapons = parts.filter((p) => p.part.weapon).length;
  const cores = parts.filter((p) => p.part.category === 'core').length;
  // Foe direction in the bug's local frame (local −y is forward, +x is right).
  const phi = Math.atan2(foe.pos.y - bug.pos.y, foe.pos.x - bug.pos.x) - h;
  const fx = Math.sin(phi);
  const fy = -Math.cos(phi);
  let cost = 0;
  for (const p of parts) {
    const d = Math.hypot(p.lx, p.ly);
    if (p.z === -1 || d < CELL * 0.4) continue; // tucked away or dead centre
    const facing = Math.max(0, (p.lx * fx + p.ly * fy) / d) * (d / Math.max(CELL, bug.radius));
    cost += partWorth(p, weapons, cores) * facing;
  }
  return cost;
}

const GUARD_OFFSETS = [-0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6];

/**
 * A small body angle (≤ ~30°) that keeps `bug`'s most precious parts turned
 * away from `foe` while its main weapons (facing `mainR`) still bear on `aim`.
 * Returns the offset to add to the heading that points those weapons straight at it.
 */
function guardOffset(bug: Bug, foe: Bug, mainR: number, aim: number) {
  const parts = bug.parts.filter((p) => p.alive);
  const base = aim - mainR * (Math.PI / 2);
  const main = parts.filter((p) => p.part.weapon && !p.part.weapon.projectileSpeed && p.r === mainR);
  const dps = main.reduce((a, p) => a + p.part.weapon!.damage / p.part.weapon!.cooldown, 0) || 1;
  // Turn further only when something precious is badly hurt.
  const urgent = parts.some((p) => (p.part.category === 'core' || p.part.weapon) && p.hp < p.part.hp * 0.45);
  const limit = urgent ? 0.8 : 0.6;
  let best = 0;
  let bestCost = Infinity;
  for (const o of GUARD_OFFSETS.map((g) => g * (limit / 0.6))) {
    const h = base + o;
    let cost = Math.abs(o) * 0.3 + exposure(bug, foe, h); // prefer squaring up
    // Don't turn so far the main weapons can't land.
    for (const p of main) {
      const off = Math.abs(angleDiff(h + p.r * (Math.PI / 2), aim));
      if (off > p.part.weapon!.arc * 0.85) cost += 3 * ((p.part.weapon!.damage / p.part.weapon!.cooldown) / dps);
    }
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = o;
    }
  }
  return best;
}

/** Pick the enemy part most worth hitting: valuable, damaged, and on the outside. */
function pickTarget(foe: Bug): number {
  let best = -1;
  let bestScore = -Infinity;
  foe.parts.forEach((p, i) => {
    if (!p.alive) return;
    const outer = Math.hypot(p.lx, p.ly) / Math.max(CELL, foe.radius - CELL * 0.5);
    const wear = 1 - Math.max(0, p.hp) / p.part.hp;
    const score = TARGET_VALUE[p.part.category] * (0.6 + 0.6 * outer) * (1 + wear) - p.hp / 200;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** Point just outside the enemy, on the side where `part` sits. */
function attackPoint(foe: Bug, part: SimPart, me: Bug): Vec {
  const w = partWorld(foe, part);
  const out = unit({ x: w.x - foe.pos.x, y: w.y - foe.pos.y });
  const r = foe.radius + me.radius * 0.6;
  return { x: foe.pos.x + out.x * r, y: foe.pos.y + out.y * r };
}

function hazardNear(sim: Sim, at: Vec, within: number) {
  return sim.hazards.find((h) => Math.hypot(at.x - h.x, at.y - h.y) < h.r + within);
}

/** Autonomous driver for bug `me`. Mutates only `bug.ai`; deterministic. */
export function aiInput(sim: Sim, me: number, aggression: number = sim.bugs[me].aggr, dt: number = STEP): Input {
  const bug = sim.bugs[me];
  if (bug.dead) return { x: 0, y: 0 };
  // The world is frozen during cutscenes and hit-stop: don't let AI timers run on.
  if (sim.ult || sim.hitstop > 0) return { x: 0, y: 0 };
  const ai = bug.ai;
  // Pick a fight: stay on the current enemy unless it's down or another is much closer.
  const nearest = foeOf(sim, bug);
  const current = sim.bugs[ai.foe];
  const gap = (b: Bug) => Math.hypot(b.pos.x - bug.pos.x, b.pos.y - bug.pos.y);
  if (!current || current.dead || current.team === bug.team || gap(nearest) < gap(current) * 0.65) {
    if (ai.foe !== nearest.index) ai.target = -1;
    ai.foe = nearest.index;
  }
  const foe = sim.bugs[ai.foe];
  if (foe.dead) return { x: 0, y: 0 };
  ai.t += dt;

  const toFoe = { x: foe.pos.x - bug.pos.x, y: foe.pos.y - bug.pos.y };
  const dist = Math.hypot(toFoe.x, toFoe.y) || 1;
  const toFoeN = { x: toFoe.x / dist, y: toFoe.y / dist };
  const contact = bug.radius + foe.radius;

  // Lost sight of it (cloaked): head for where it was last seen and prowl around there.
  const hidden = foe.cloak > 0 && dist > 75;
  if (!hidden) {
    ai.seenX = foe.pos.x;
    ai.seenY = foe.pos.y;
  } else {
    const to = { x: ai.seenX - bug.pos.x, y: ai.seenY - bug.pos.y };
    const d = Math.hypot(to.x, to.y);
    const prowl = d > 50 ? unit(to) : rotate(d > 1 ? unit(to) : toFoeN, (Math.PI / 2) * ai.side);
    return steer(sim, bug, prowl, d > 50 ? 0.7 : 0.45, 0);
  }
  // Something is tunnelling at us: keep moving (flyers climb out of reach).
  if (foe.burrow > 0) {
    return steer(sim, bug, rotate({ x: -toFoeN.x, y: -toFoeN.y }, 0.5 * ai.side), 1, bug.stats.maxAlt > 12 && !bug.grounded ? 1 : 0);
  }

  // Build-driven style.
  const weapons = bug.parts.filter((p) => p.alive && p.part.weapon);
  const ranged = weapons.some((p) => p.part.weapon!.projectileSpeed);
  const melee = weapons.filter((p) => !p.part.weapon!.projectileSpeed);
  // Which way do most of our weapons point? (0 front, 1 right, 2 back, 3 left.)
  const mainFacing = (list: SimPart[]) => {
    const dps = [0, 0, 0, 0];
    for (const p of list) dps[p.r] += p.part.weapon!.damage / p.part.weapon!.cooldown;
    return dps.reduce((best, v, i) => (v > dps[best] + 1e-6 ? i : best), 0);
  };
  const meleeR = mainFacing(melee);
  const rangedR = mainFacing(weapons.filter((p) => p.part.weapon!.projectileSpeed));
  /** Heading that points facing `r` at the world angle `a`. */
  const faceFor = (r: number, a: number) => a - r * (Math.PI / 2);
  let face: number | undefined;
  // Only a front horn can build a charge.
  const rammer = melee.some((p) => p.part.weapon!.ramBonus && p.r === 0);
  const nimble = bug.stats.turnRate > foe.stats.turnRate * 1.1 || bug.stats.topSpeed > foe.stats.topSpeed * 1.15;
  const heavy = bug.stats.mass > foe.stats.mass * 1.3;
  const myHp = hpFraction(bug);
  const foeHp = hpFraction(foe);

  // Where are we relative to the enemy's weapons? (0 = dead ahead of it)
  const fromFoe = Math.atan2(bug.pos.y - foe.pos.y, bug.pos.x - foe.pos.x);
  // In front of any of its melee weapons (they can point sideways or backwards).
  const foeMelee = foe.parts.filter((p) => p.alive && p.part.weapon && !p.part.weapon.projectileSpeed);
  const inFoeFront = (foeMelee.length ? foeMelee.map((p) => facingAngle(foe, p)) : [foe.heading]).some(
    (a) => Math.abs(angleDiff(a, fromFoe)) < 1.1,
  );
  const foeArmed = foe.parts.some((p) => p.alive && p.part.weapon);

  // Retarget when the old target is gone.
  if (ai.target < 0 || !foe.parts[ai.target]?.alive) ai.target = pickTarget(foe);
  const target = foe.parts[ai.target];
  if (!target) return { x: 0, y: 0 };
  const targetW = partWorld(foe, target);

  // Altitude: flyers cruise high (over hazards and enemy jaws) and drop to the
  // enemy's height to strike. 1 = as high as the wings allow.
  const flyer = bug.stats.maxAlt > 12 && !bug.grounded;
  const matchFoe = flyer ? Math.min(1, foe.alt / bug.stats.maxAlt) : 0;
  let alt = flyer ? 1 : 0;

  const away = { x: -toFoeN.x, y: -toFoeN.y };
  /** Swing `ai.side` to whichever side of `base` (rotated by `angle`) has more open floor. */
  const pickSide = (base: Vec, angle: number, ahead = 140) => {
    const l = room(bug, rotate(base, angle), ahead);
    const r = room(bug, rotate(base, -angle), ahead);
    if (Math.abs(l - r) > 15) ai.side = l > r ? 1 : -1;
  };

  // Stuck (pinned on a wall, wedged in a corner): break out toward the middle.
  const speed = Math.hypot(bug.vel.x, bug.vel.y);
  const touchingFoe = dist < contact * 1.05;
  if (speed < bug.stats.topSpeed * 0.18 && !touchingFoe && wallGap(bug.pos) < bug.radius + 40) ai.stuck += dt;
  else ai.stuck = Math.max(0, ai.stuck - dt * 2);

  // Unarmed: survive. Circle away (toward open floor) and dodge.
  if (melee.length === 0 && !ranged) {
    if (ai.t > 0.5) {
      pickSide(away, 0.9, 160);
      ai.t = 0;
    }
    let flee = rotate(away, 0.9 * ai.side);
    // Running into a corner just gets you cornered: lean back toward the middle.
    const close = 1 - Math.min(1, (wallGap(bug.pos) - bug.radius) / 90);
    if (close > 0) {
      const m = ARENA_SIZE / 2;
      const c = unit({ x: m - bug.pos.x, y: m - bug.pos.y });
      flee = unit({ x: flee.x + c.x * close * 1.6, y: flee.y + c.y * close * 1.6 });
    }
    ai.mode = 'retreat';
    return steer(sim, bug, flee, 1, alt);
  }

  let dir: Vec = toFoeN;
  let throttle = 1;
  const setMode = (m: AiMode) => {
    ai.mode = m;
    ai.t = 0;
    if (m === 'retreat') {
      pickSide(away, 0.7);
      // Turn away on whichever side keeps hurt precious parts further from the enemy
      // (unless that side is boxed in by a wall).
      const mid = (sd: number) => Math.atan2(toFoeN.y, toFoeN.x) + sd * (Math.PI / 2);
      const pref: 1 | -1 = exposure(bug, foe, mid(1)) <= exposure(bug, foe, mid(-1)) ? 1 : -1;
      if (room(bug, rotate(away, 0.7 * pref), 140) > bug.radius + 30) ai.side = pref;
    }
    if (m === 'windup') pickSide(away, 0.5, 160);
  };
  let goalDist = Infinity;

  if (ai.stuck > 0.7) {
    ai.stuck = 0;
    setMode('retreat');
  }

  if (ranged && melee.length === 0) {
    // ── Sniper: orbit at range; turn in to shoot when a stinger is ready.
    if (ai.mode !== 'orbit') setMode('orbit');
    const want = 175;
    const ready = weapons.some((p) => p.cooldown < 0.25);
    let tangent = rotate(toFoeN, (Math.PI / 2) * ai.side);
    // Don't orbit into the wall: turn the circle round instead.
    if (room(bug, tangent, 90) < bug.radius + 20 && room(bug, { x: -tangent.x, y: -tangent.y }, 90) > room(bug, tangent, 90)) {
      ai.side = ai.side === 1 ? -1 : 1;
      tangent = { x: -tangent.x, y: -tangent.y };
      ai.t = 0;
    }
    const radial = (dist - want) / 60;
    dir = unit({ x: tangent.x + toFoeN.x * radial, y: tangent.y + toFoeN.y * radial });
    if (rangedR !== 0) {
      // Stinger points sideways or backwards: keep it on the target while circling (or backing off).
      face = faceFor(rangedR, Math.atan2(targetW.y - bug.pos.y, targetW.x - bug.pos.x));
    } else if (ready && dist < 240) {
      dir = unit({ x: targetW.x - bug.pos.x, y: targetW.y - bug.pos.y });
      throttle = 0.25;
      goalDist = Math.max(0, dist - contact);
    }
    alt = flyer ? 0.85 + Math.sin(sim.time * 1.3 + me) * 0.15 : 0;
    if (ai.t > 4) {
      ai.side = ai.side === 1 ? -1 : 1; // change orbit direction now and then
      ai.t = 0;
    }
  } else if (rammer && ai.mode !== 'retreat' && ai.mode !== 'strike') {
    // ── Rammer: back off to build a run-up, then charge the target part.
    if (ai.mode !== 'windup' && ai.mode !== 'charge') setMode('windup');
    if (ai.mode === 'windup') {
      dir = rotate(away, 0.5 * ai.side);
      // Out of run-up room? Charge from here rather than back into the wall.
      const blocked = room(bug, dir, bug.radius + 30) < bug.radius + 10 && ai.t > 0.4;
      if (dist > contact + 120 || ai.t > 1.6 || blocked) setMode('charge');
    } else {
      dir = unit({ x: targetW.x - bug.pos.x, y: targetW.y - bug.pos.y });
      goalDist = Math.max(0, dist - contact * 0.5);
      alt = matchFoe; // dive-bomb
      // Whiffed (it sidestepped and the wall is coming up)? Pull out of the charge.
      const ahead = forward(bug.heading);
      const missed = ahead.x * toFoeN.x + ahead.y * toFoeN.y < 0.2 && room(bug, ahead, 80) < bug.radius + 20;
      if (dist < contact * 0.85 || ai.t > 2 || missed) setMode('strike');
    }
  } else {
    // ── Brawler: approach (flanking the weapons) → strike → retreat → repeat.
    if (ai.mode === 'orbit' || ai.mode === 'windup' || ai.mode === 'charge') setMode('approach');

    if (ai.mode === 'approach') {
      let goal = attackPoint(foe, target, bug);
      // Heavy builds shove enemies into hazards: come from the far side of the hazard.
      const hz = heavy ? hazardNear(sim, foe.pos, 110) : undefined;
      if (hz) {
        const push = unit({ x: foe.pos.x - hz.x, y: foe.pos.y - hz.y });
        goal = { x: foe.pos.x + push.x * contact, y: foe.pos.y + push.y * contact };
      } else if (sim.spikedWalls && bug.stats.mass >= foe.stats.mass * 0.85 && wallGap(foe.pos) < foe.radius + 70) {
        // Enemy near the spikes: get between it and the middle and pin it there.
        const n = wallNormal(foe.pos);
        goal = { x: foe.pos.x - n.x * contact, y: foe.pos.y - n.y * contact };
      }
      const toGoal = { x: goal.x - bug.pos.x, y: goal.y - bug.pos.y };
      const goalDist0 = Math.hypot(toGoal.x, toGoal.y);
      // Don't walk into its weapons: circle round them first (nimble bugs try harder).
      const foeHasMelee = foe.parts.some((p) => p.alive && p.part.weapon && !p.part.weapon.projectileSpeed);
      const flankEager = foeArmed && foeHasMelee && !heavy && (nimble || aggression < 0.85);
      if (flankEager && inFoeFront && dist < contact + 140 && ai.t < (nimble ? 3.5 : 2)) {
        ai.side = angleDiff(foe.heading, fromFoe) > 0 ? 1 : -1;
        const tangent = rotate(toFoeN, (-Math.PI / 2) * ai.side);
        const keepOff = (contact + 60 - dist) / 50;
        dir = unit({ x: tangent.x - toFoeN.x * keepOff, y: tangent.y - toFoeN.y * keepOff });
      } else {
        dir = unit(toGoal);
        goalDist = goalDist0;
      }
      // Side or rear weapons: turn them toward the enemy for the last stretch and crab in.
      if (meleeR !== 0 && dist < contact + 100) face = faceFor(meleeR, Math.atan2(targetW.y - bug.pos.y, targetW.x - bug.pos.x));
      if (goalDist0 < 30 || dist < contact * 0.95) setMode('strike');
      if (ai.t > 5) setMode('strike'); // stop dancing eventually
      // Start the dive a little before arriving.
      if (flyer && dist < contact + 60) alt = Math.max(matchFoe, 0.35);
    } else if (ai.mode === 'strike') {
      // Dive at the target part, leading it by how long it takes us to get there (cuts off kiters).
      alt = matchFoe;
      const eta = Math.min(1.2, dist / Math.max(60, bug.stats.topSpeed));
      const lead = { x: targetW.x + foe.vel.x * eta - bug.pos.x, y: targetW.y + foe.vel.y * eta - bug.pos.y };
      dir = unit(lead);
      goalDist = Math.max(0, dist - contact * 0.5);
      // Square up the main weapons, angled a little to keep precious parts out of reach
      // (only once the enemy is close enough to hurt them, and only if it's armed).
      const aim = Math.atan2(lead.y, lead.x);
      const threat = foeArmed && dist < contact + 90;
      ai.guard += ((threat && melee.length ? guardOffset(bug, foe, meleeR, aim) : 0) - ai.guard) * Math.min(1, dt * 3);
      if (meleeR !== 0 || Math.abs(ai.guard) > 0.03) face = faceFor(meleeR, aim) + ai.guard;
      const touching = dist < contact * 0.95;
      if (touching) ai.engaged += dt;
      else if (ai.t > 2.2) setMode('approach'); // lost them: re-set up the attack
      const flurry = 0.5 + aggression * 1.1;
      // Backing off only helps against melee; against a shooter, stay on it.
      const foeMelee = foe.parts.some((p) => p.alive && p.part.weapon && !p.part.weapon.projectileSpeed);
      const losingTrade = foeMelee && bug.recentDamage > 18 && myHp < foeHp + 0.05;
      // A core or last weapon close to breaking: don't hang around as long.
      const fragile = bug.parts.some(
        (p) => p.alive && (p.part.category === 'core' || (p.part.weapon && weapons.length <= 1)) && p.hp < p.part.hp * 0.3,
      );
      if (ai.engaged > flurry * (fragile ? 0.65 : 1) || (losingTrade && ai.engaged > 0.4)) {
        ai.engaged = 0;
        setMode('retreat');
      }
    } else if (ai.mode === 'retreat') {
      // Peel away on an arc (toward open floor), then come back from the other side.
      dir = rotate(away, 0.7 * ai.side);
      // Backed against a wall: slide out along it toward the middle instead.
      if (room(bug, dir, 120) < bug.radius + 20) {
        const m = ARENA_SIZE / 2;
        dir = unit({ x: m - bug.pos.x + away.x * 80, y: m - bug.pos.y + away.y * 80 });
      }
      const length = 0.55 + (1 - aggression) * 0.6 + (myHp < 0.35 ? 0.4 : 0);
      if (ai.t > length) {
        ai.side = ai.side === 1 ? -1 : 1;
        ai.target = pickTarget(foe);
        setMode('approach');
      }
    }
  }

  return steer(sim, bug, dir, throttle, alt, goalDist, face);
}

/**
 * Danger (0..1) of heading along `d` for the next moment: walls (only getting
 * closer counts), acid near the floor, presses about to slam. Probes stop at
 * `goalDist` so chasing an enemy that's against the wall is still allowed.
 */
function danger(sim: Sim, bug: Bug, d: Vec, look: number, airborne: boolean) {
  const margin = bug.radius + 34;
  const gapNow = wallGap(bug.pos);
  let worst = 0;
  for (const s of [0.4, 0.75, 1]) {
    const p = { x: bug.pos.x + d.x * look * s, y: bug.pos.y + d.y * look * s };
    const gap = wallGap(p);
    if (gap < margin) {
      let w = (margin - gap) / margin;
      if (gap >= gapNow - 1) w *= 0.25; // sliding along / away from a wall is fine
      worst = Math.max(worst, Math.min(1, w) * (sim.spikedWalls ? 1 : 0.75));
    }
    for (const h of sim.hazards) {
      const live = h.kind === 'acid' ? !airborne : h.t > h.period - 2.2;
      if (!live) continue;
      const edge = Math.hypot(p.x - h.x, p.y - h.y) - h.r - bug.radius * 0.5;
      const now = Math.hypot(bug.pos.x - h.x, bug.pos.y - h.y) - h.r - bug.radius * 0.5;
      if (edge < 24 && edge <= now) worst = Math.max(worst, Math.min(1, (24 - edge) / 30) * 0.9);
    }
  }
  return worst;
}

const STEER_DIRS = Array.from({ length: 16 }, (_, k) => ({ x: Math.cos((k * Math.PI) / 8), y: Math.sin((k * Math.PI) / 8) }));

/**
 * Final steering (context steering): score 16 directions by how well they match
 * where we want to go minus how dangerous they are, and take the best. Slows
 * down to turn when the bug is pointed at something it shouldn't run into.
 */
function steer(sim: Sim, bug: Bug, dir: Vec, throttle: number, alt = 0, goalDist = Infinity, face?: number): Input {
  const airborne = bug.alt > 10 && alt * bug.stats.maxAlt > 10;
  const speed = Math.hypot(bug.vel.x, bug.vel.y);
  // Never look less far than we need to stop.
  const look = Math.max(speed * 0.3, Math.min(goalDist, 45 + speed * 0.55 + bug.radius * 0.5));
  let best = dir;
  let bestScore = -Infinity;
  for (const c of [dir, ...STEER_DIRS]) {
    const want = c.x * dir.x + c.y * dir.y;
    const score = want - danger(sim, bug, c, look, airborne) * 2.4;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = c;
    }
  }
  // Facing danger and needing to turn hard? Ease off so we turn on the spot
  // (bugs move along their heading, so full throttle would carry us into it).
  // (Crab-walking moves along `best` directly, so there's no turn to wait for.)
  const f = forward(bug.heading);
  const align = f.x * best.x + f.y * best.y;
  if (face === undefined && align < 0.3 && danger(sim, bug, f, look, airborne) > 0.35) throttle *= 0.15;
  return { x: best.x * throttle, y: best.y * throttle, alt, face };
}

// ── HUD summary (cheap, for React) ──────────────────────────────────

export type HudBug = { name: string; team: 0 | 1; dead: boolean; status: string; hp: number; proc: number; shield: boolean; flying: boolean; wings: number; moves: { id: MoveId; cd: number; ready: boolean }[] };
export type Hud = { bugs: HudBug[]; time: number; log: string[]; over: boolean; winner: 0 | 1 | null; ult: Ult | null; flash: number };

export function hud(sim: Sim): Hud {
  const b = (bug: Bug): HudBug => ({
    name: bug.name,
    team: bug.team,
    dead: bug.dead,
    hp: hpFraction(bug),
    proc: bug.proc,
    status: `${bug.webbed > 0 ? ' 🕸' : ''}${bug.stun > 0 ? ' ⚡' : ''}${bug.cloak > 0 ? ' 👻' : ''}${bug.burrow > 0 ? ' ⛏' : ''}${bug.haste > 0 ? ' 🔥' : ''}`,
    shield: bug.shield > 0,
    flying: bug.alt > 8,
    wings: maxStamina(bug) > 0 ? bug.stamina / maxStamina(bug) : -1,
    moves: bug.moves.map((id) => ({ id, cd: bug.moveCd[id] ?? 0, ready: moveReady(sim, bug, id) })),
  });
  return {
    bugs: sim.bugs.map(b),
    time: sim.time,
    log: sim.log.slice(-3),
    over: sim.over,
    winner: sim.winner,
    ult: sim.ult ? { ...sim.ult } : null,
    flash: sim.flash,
  };
}

export const ALL_MOVE_IDS = MOVES.map((m) => m.id);
