/**
 * Three.js view of a Sim. Reads sim state every frame; never writes to it.
 * Works with an expo-gl context on native and web.
 */
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

import { getMove, type MoveId } from '@/game/moves';
import { CATEGORY_COLOR, type Category } from '@/game/parts';
import { ARENA_SIZE, CELL, partWorld, type Bug, type Sim, type SimPart } from '@/game/sim';

import { createRenderer } from './gl';
import { ArenaDressing } from './arena';
import { FlexRig, GIVE } from './flex';
import { adjacentPairs, buildConnector, buildPart, seatHeight, stackOffset, UNDER_LIFT, UNDER_SCALE, type Connector, type PartModel } from './models';

const HALF = ARENA_SIZE / CELL / 2;
const FOV = 50;
const BG = 0x12151a;

/** Sim floor (x, y) → three world (x, 0, z). One grid cell = 1 unit. */
const toWorld = (x: number, y: number, h = 0) => new THREE.Vector3(x / CELL - HALF, h, y / CELL - HALF);

/** Rotation about +y that points a model's −z at sim heading `h`. */
const yaw = (h: number) => Math.atan2(-Math.cos(h), -Math.sin(h));

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

type PartView = {
  part: SimPart;
  model: PartModel;
  attached: boolean;
  /** 1 when just hit, decays: the part pops. */
  punch: number;
  /** Index in the bug's FlexRig. */
  flex: number;
};
type BugView = {
  group: THREE.Group;
  pose: THREE.Group;
  parts: PartView[];
  /** Frame struts between neighbouring parts; hidden once either end breaks off. */
  links: { a: PartView; b: PartView; c: Connector }[];
  /** Spring joints: parts sway and lag instead of moving as one rigid block. */
  rig: FlexRig;
  /** On the floor (stays down when the bug flies): part shadows + thin team ring. */
  ground: THREE.Group;
  /** Shadows only (shrink as the bug climbs). */
  shadows: THREE.Group;
  /** One soft contact shadow shaped like the bug's footprint; rebuilt when parts break off. */
  shadow: THREE.Mesh;
  /** Attached grid parts the shadow was last drawn for. */
  shadowCount: number;
  baseRadius: number;
  /** Small bobbing pointer above the player's bug only. */
  marker: THREE.Mesh | null;
  shield: THREE.Group;
  walk: number;
  lean: number;
  lastHeading: number;
  /** Knockback flinch (world units), springs back to zero. */
  kick: THREE.Vector3;
};
/**
 * A signature move being staged: `charge` while the sim is frozen for the
 * cutscene (p = progress through it), then `strike` for a moment after it
 * resolves (the payoff: impacts, recoil, slow motion).
 */
type Cine = { id: MoveId; caster: 0 | 1; phase: 'charge' | 'strike'; p: number };
/** Seconds of follow-through after an ultimate resolves. */
const FINISH = 0.8;
/** Which weapon each move channels through (for the charge glow). */
const MOVE_PART: Partial<Record<MoveId, Category>> = { 'mandible-crusher': 'mandibles', 'venom-barrage': 'stinger', 'carapace-lock': 'armor' };

type Debris = { obj: THREE.Object3D; vel: THREE.Vector3; spin: THREE.Vector3; age: number };

/**
 * Draw a soft contact shadow under a bug: the union of a feathered disc under
 * each attached grid part (max, not sum, so overlaps don't darken), as an
 * alpha texture on one floor plane.
 */
function softShadow(mesh: THREE.Mesh, parts: { part: SimPart; attached: boolean }[]) {
  const pts = parts.filter((p) => p.attached && !p.part.z).map((p) => ({ x: p.part.lx / CELL, y: p.part.ly / CELL }));
  const mat = mesh.material as THREE.MeshBasicMaterial;
  mat.alphaMap?.dispose();
  mesh.visible = pts.length > 0;
  if (!pts.length) return;
  const M = 1.1;
  const x0 = Math.min(...pts.map((p) => p.x)) - M;
  const x1 = Math.max(...pts.map((p) => p.x)) + M;
  const y0 = Math.min(...pts.map((p) => p.y)) - M;
  const y1 = Math.max(...pts.map((p) => p.y)) + M;
  const PX = 14;
  const W = Math.ceil((x1 - x0) * PX);
  const H = Math.ceil((y1 - y0) * PX);
  const data = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) / PX;
      // Texture rows run along +v, which the rotated plane maps to −z.
      const y = y1 - (j + 0.5) / PX;
      let d = Infinity;
      for (const p of pts) d = Math.min(d, Math.hypot(x - p.x, y - p.y));
      const t = Math.min(1, Math.max(0, (1.0 - d) / 0.75));
      const a = t * t * (3 - 2 * t);
      const o = (j * W + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.round(a * 255);
      data[o + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  mat.alphaMap = tex;
  mat.needsUpdate = true;
  mesh.scale.set(x1 - x0, y1 - y0, 1);
  mesh.position.set((x0 + x1) / 2, 0.025, (y0 + y1) / 2);
}

/** Faceted energy shell (Carapace Lock): a faint additive fill plus bright facet edges. */
function hexShell(radius: number) {
  const g = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  geo.scale(1, 0.72, 1);
  geo.translate(0, radius * 0.45, 0);
  g.add(
    new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x4fa8ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    ),
  );
  g.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    ),
  );
  return g;
}

/** Point an object's local +z along a world direction. */
const faceAlong = (o: THREE.Object3D, d: THREE.Vector3) => o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.clone().normalize());

export class ArenaRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private bugs: BugView[] = [];
  private debris: Debris[] = [];
  private projectiles: THREE.Mesh[] = [];
  private sparks: THREE.Mesh[] = [];
  private arena: ArenaDressing;
  private aura: THREE.Group;
  private auraSparks: THREE.Mesh[] = [];
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private clock = 0;
  private ultWeight = 0;
  /** Pulled further back on tall (portrait) screens so the arena fits. */
  /** ≥1: how much to pull cameras back for narrow (portrait) screens. */
  private aspectK = 1;
  private ultSide = 0;
  /** Direction the camera looks from (radians around +y; 0 = from the south side). */
  private camYaw = 0;
  /** Pre-fight intro, 1 → 0: the camera swoops in from high above as it counts down. */
  intro = 0;
  private eventCursor = 0;
  private tmpQ = new THREE.Quaternion();
  private bits: { m: THREE.Mesh; vel: THREE.Vector3; life: number; max: number }[] = [];
  private nextBit = 0;
  private waves: { m: THREE.Mesh; life: number }[] = [];
  private nextWave = 0;
  /** Follow-through after an ultimate resolves. */
  private finisher: { id: MoveId; caster: 0 | 1; t: number } | null = null;
  /** Glowing orb that gathers at the weapon during a charge. */
  private orb: THREE.Mesh;
  /** Speed streaks behind a lunging / dashing bug. */
  private streaks: THREE.Mesh[] = [];
  private streakLife = 0;
  private streakBug = 0;
  private streakColor = new THREE.Color();
  /** Trails behind big venom darts (pooled alongside projectiles). */
  private trails: THREE.Mesh[] = [];
  /** Flash spheres (muzzle flash, bite flash). */
  private flashes: { m: THREE.Mesh; life: number; max: number; size: number }[] = [];

  /**
   * Wall-clock pacing hint for the screen's sim loop: a brief slow motion
   * right as an ultimate lands (cosmetic; the sim itself stays deterministic).
   */
  get timeScale() {
    const f = this.finisher;
    if (!f) return 1;
    return f.t < 0.12 ? 0.25 : f.t < 0.55 ? 0.25 + ((f.t - 0.12) / 0.43) * 0.75 : 1;
  }

  constructor(
    private gl: ExpoWebGLRenderingContext,
    sim: Sim,
  ) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.renderer = createRenderer(gl, BG);

    this.camera = new THREE.PerspectiveCamera(FOV, w / h, 0.1, 200);
    this.fitOffset(w / h);

    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x30343c, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-8, 20, 10);
    this.scene.add(sun);

    this.arena = new ArenaDressing(this.scene, sim);
    sim.bugs.forEach((b) => this.bugs.push(this.buildBug(b)));

    // Ultimate charge aura (hidden until needed).
    this.aura = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.12, 6, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }),
    );
    ring.rotation.x = Math.PI / 2;
    this.aura.add(ring);
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      this.aura.add(s);
      this.auraSparks.push(s);
    }
    this.aura.visible = false;
    this.scene.add(this.aura);

    // Impact particles and break shockwaves (pooled).
    const bitGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(bitGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      m.visible = false;
      this.scene.add(m);
      this.bits.push({ m, vel: new THREE.Vector3(), life: 0, max: 1 });
    }
    const waveGeo = new THREE.RingGeometry(0.82, 1, 28);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(waveGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.scene.add(m);
      this.waves.push({ m, life: 0 });
    }

    this.orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.orb.visible = false;
    this.scene.add(this.orb);
    const streakGeo = new THREE.BoxGeometry(0.06, 0.06, 1);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(
        streakGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      m.visible = false;
      this.scene.add(m);
      this.streaks.push(m);
    }
    const flashGeo = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        flashGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      m.visible = false;
      this.scene.add(m);
      this.flashes.push({ m, life: 0, max: 1, size: 1 });
    }

    // Start the fight camera already in position (a long step snaps it there).
    this.updateCamera(sim, 10, 0);
  }

  private buildBug(bug: Bug): BugView {
    const group = new THREE.Group();
    const pose = new THREE.Group();
    group.add(pose);
    const ground = new THREE.Group();
    const shadows = new THREE.Group();
    ground.add(shadows);
    const seats = new Map<string, number>();
    // A part with something slung underneath rides higher.
    const lifted = new Set(bug.parts.filter((p) => p.z === -1).map((p) => `${p.x},${p.y}`));
    const lift = (p: SimPart) => (lifted.has(`${p.x},${p.y}`) ? UNDER_LIFT : 0);
    const parts = bug.parts.map((p) => {
      const model = buildPart(p.part.id, p.z ? 0 : Math.sign(Math.round(p.lx)), p.y);
      model.root.position.set(p.lx / CELL, 0, p.ly / CELL);
      pose.add(model.root);
      if (!p.z) {
        model.root.position.y = lift(p);
        seats.set(`${p.x},${p.y}`, seatHeight(model) + lift(p));
      }
      if (p.z === -1) {
        model.root.scale.setScalar(UNDER_SCALE);
        model.root.position.y = 0.02;
      }
      return { part: p, model, attached: true, punch: 0, flex: -1 };
    });
    // Stacked parts rest on top of the part in their cell.
    for (const pv of parts) {
      if (pv.part.z === 1) pv.model.root.position.y = stackOffset(pv.model, seats.get(`${pv.part.x},${pv.part.y}`) ?? 0.9);
    }

    const onGrid = parts.filter((pv) => !pv.part.z);
    const links = adjacentPairs(onGrid.map((pv) => pv.part)).map(([i, j]) => {
      const a = onGrid[i];
      const b = onGrid[j];
      const c = buildConnector(a.part.part.category, b.part.part.category);
      c.update(a.model.root.position, b.model.root.position);
      pose.add(c.obj);
      return { a, b, c };
    });

    // Spring joints: each part hangs off the neighbour one step closer to the
    // thorax (stacked/slung parts off the part in their cell).
    const rig = new FlexRig(pose);
    const at = new Map(onGrid.map((pv) => [`${pv.part.x},${pv.part.y}`, pv]));
    const root = onGrid.find((pv) => pv.part.part.category === 'thorax') ?? onGrid[0];
    const queue: { pv: PartView; parent: number; depth: number }[] = root ? [{ pv: root, parent: -1, depth: 0 }] : [];
    const seen = new Set<PartView>(root ? [root] : []);
    while (queue.length) {
      const { pv, parent, depth } = queue.shift()!;
      pv.flex = rig.add(pv.model.root, pv.model.root.position, parent, GIVE[pv.part.part.category], depth);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const n = at.get(`${pv.part.x + dx},${pv.part.y + dy}`);
        if (n && !seen.has(n)) {
          seen.add(n);
          queue.push({ pv: n, parent: pv.flex, depth: depth + 1 });
        }
      }
    }
    for (const pv of parts) {
      if (pv.flex >= 0) continue;
      const base = at.get(`${pv.part.x},${pv.part.y}`);
      pv.flex = rig.add(pv.model.root, pv.model.root.position, base && !pv.part.z ? -1 : (base?.flex ?? -1), GIVE[pv.part.part.category], 2);
    }
    rig.finalize();

    const r = bug.radius / CELL;
    const team = bug.index === 0 ? 0x3ddc97 : 0xff5d5d;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r + 0.22, r + 0.29, 40),
      new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.14, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ground.add(ring);
    this.scene.add(ground);

    // A small camera-facing pointer over the player's bug.
    let marker: THREE.Mesh | null = null;
    if (bug.index === 0) {
      const tri = new THREE.Shape();
      tri.moveTo(-0.26, 0.3);
      tri.lineTo(0.26, 0.3);
      tri.lineTo(0, -0.12);
      tri.closePath();
      marker = new THREE.Mesh(new THREE.ShapeGeometry(tri), new THREE.MeshBasicMaterial({ color: team, depthTest: false, transparent: true, opacity: 0.9 }));
      marker.renderOrder = 10;
      this.scene.add(marker);
    }

    const shield = hexShell(r + 0.6);
    shield.visible = false;
    group.add(shield);
    this.scene.add(group);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 1;
    shadows.add(shadow);
    softShadow(shadow, parts);
    return { group, pose, parts, links, rig, ground, shadows, shadow, shadowCount: parts.length, baseRadius: r, marker, shield, walk: 0, lean: 0, lastHeading: bug.heading, kick: new THREE.Vector3() };
  }

  private fitOffset(aspect: number) {
    this.aspectK = Math.max(1, 0.85 / aspect);
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitOffset(w / h);
  }

  render(sim: Sim, dt: number) {
    this.clock += dt;
    const t = this.clock;
    const ult = sim.ult;

    this.react(sim);
    this.updateReactions(dt);
    if (this.finisher) {
      this.finisher.t += dt;
      if (this.finisher.t > FINISH) this.finisher = null;
    }
    const cine = this.cine(sim);

    // Bugs
    const frozen = !!ult || sim.hitstop > 0 || sim.over;
    sim.bugs.forEach((bug, bi) => {
      const v = this.bugs[bi];
      v.kick.multiplyScalar(Math.exp(-dt * 13));
      const altU = bug.alt / CELL;
      v.group.position.copy(toWorld(bug.pos.x, bug.pos.y, altU)).add(v.kick);
      v.group.rotation.y = yaw(bug.heading);
      // Floor marks stay on the floor; shadows shrink as the bug climbs.
      v.ground.position.copy(toWorld(bug.pos.x, bug.pos.y));
      v.ground.rotation.y = v.group.rotation.y;
      v.shadows.scale.setScalar(Math.max(0.45, 1 - altU * 0.18));
      // Carapace shell: forms during the Carapace Lock charge, then holds while the shield lasts.
      const forming = cine?.id === 'carapace-lock' && cine.caster === bi && cine.phase === 'charge' ? smooth((cine.p - 0.35) / 0.55) : 0;
      v.shield.visible = bug.shield > 0 || forming > 0;
      if (v.shield.visible) {
        const snap = cine?.id === 'carapace-lock' && cine.caster === bi && cine.phase === 'strike' ? 1 - cine.p : 0;
        const sc = bug.shield > 0 ? 1 + snap * snap * 0.2 + Math.sin(t * 5) * 0.015 : 1.35 - forming * 0.35;
        v.shield.scale.setScalar(sc);
        v.shield.rotation.y = t * 0.6;
        const fill = v.shield.children[0] as THREE.Mesh;
        const edges = v.shield.children[1] as THREE.LineSegments;
        const a = bug.shield > 0 ? Math.min(1, bug.shield * 2) * (0.75 + Math.sin(t * 7) * 0.25) : forming;
        (fill.material as THREE.MeshBasicMaterial).opacity = 0.06 * a + snap * 0.12;
        (edges.material as THREE.LineBasicMaterial).opacity = 0.6 * a;
      }
      v.ground.visible = !bug.dead;
      v.ground.scale.setScalar(Math.max(0.4, bug.radius / CELL / v.baseRadius));
      if (v.marker) {
        v.marker.visible = !bug.dead && !ult;
        v.marker.position.copy(v.group.position).setY(v.group.position.y + 3.6 + Math.sin(t * 3) * 0.1);
        v.marker.quaternion.copy(this.camera.quaternion);
      }

      // Locomotion: the walk cycle advances with distance covered; the body bobs and leans into turns.
      const speedAbs = Math.hypot(bug.vel.x, bug.vel.y);
      const speed = bug.dead ? 0 : Math.min(1, speedAbs / 90);
      let turn = bug.heading - v.lastHeading;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      v.lastHeading = bug.heading;
      if (!frozen && !bug.dead) {
        v.walk += (speedAbs / CELL) * dt * 2.4;
        const want = THREE.MathUtils.clamp((-turn / Math.max(dt, 1e-3)) * 0.05, -0.16, 0.16);
        v.lean += (want - v.lean) * Math.min(1, dt * 8);
      }

      // Signature-move choreography (see poseCine), or the normal locomotion pose.
      let ov: { weapon?: Category; attack?: number; air?: number; glow?: number } = {};
      if (cine && cine.caster === bi && cine.phase === 'charge') {
        ov = this.poseCine(v, cine, t);
      } else {
        if (cine && cine.caster === bi && cine.id === 'mandible-crusher') ov = { weapon: 'mandibles', attack: 1 - smooth(cine.p / 0.5) };
        v.pose.scale.lerp(new THREE.Vector3(1, 1, 1), 0.3);
        v.pose.position.x *= 0.7;
        v.pose.position.z *= 0.75;
        // (Wrap first: Carapace Lock ends a full turn round, which must not unwind.)
        const ry = v.pose.rotation.y;
        v.pose.rotation.y = (((ry + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        v.pose.rotation.y *= 0.7;
        // Nose down when diving, up when climbing.
        const tilt = bug.alt > 2 ? THREE.MathUtils.clamp(bug.vAlt / 260, -0.35, 0.3) : 0;
        v.pose.rotation.x += (tilt - v.pose.rotation.x) * 0.2;
        const bob = bug.dead ? 0 : Math.abs(Math.sin(v.walk)) * 0.05 * speed + Math.sin(t * 2.2 + bi) * 0.012;
        v.pose.position.y += (bob - v.pose.position.y) * 0.3;
      }
      // Spring joints, then re-seat the struts between the swaying parts.
      v.rig.update(dt);
      for (const l of v.links) {
        l.c.obj.visible = l.a.attached && l.b.attached;
        if (l.c.obj.visible) l.c.update(l.a.model.root.position, l.b.model.root.position);
      }
      if (bug.dead) v.pose.rotation.z = Math.min(0.5, v.pose.rotation.z + dt);
      else v.pose.rotation.z = v.lean + Math.sin(v.walk) * 0.025 * speed;

      const attachedNow = v.parts.reduce((n, pv) => n + (pv.attached ? 1 : 0), 0);
      if (attachedNow !== v.shadowCount) {
        v.shadowCount = attachedNow;
        softShadow(v.shadow, v.parts);
      }
      for (const pv of v.parts) {
        if (pv.attached && !pv.part.alive) this.detach(bug, pv);
        if (!pv.attached) continue;
        const p = pv.part;
        pv.model.tint(Math.max(0, p.hp) / p.part.hp, p.flash > 0, ov.glow ?? 0);
        pv.punch = Math.max(0, pv.punch - dt * 7);
        pv.model.root.scale.setScalar(1 + pv.punch * pv.punch * 0.3);
        if (bug.dead) continue;
        // 1 at the moment the weapon fires, fading over ~0.28 s.
        const w = p.part.weapon;
        let attack = w && sim.time > 1 ? THREE.MathUtils.clamp(1 - (w.cooldown - p.cooldown) / 0.28, 0, 1) : 0;
        if (ov.attack !== undefined && ov.weapon === p.part.category) attack = ov.attack;
        pv.model.animate({ t, walk: v.walk, speed, attack, air: Math.max(ov.air ?? 0, Math.min(1, bug.alt / 14)) });
      }
    });

    this.updateDebris(dt);
    this.arena.update(sim, t, dt);
    this.updateProjectiles(sim);
    this.updateSparks(sim);
    this.updateCineFx(sim, cine, t, dt);
    this.updateCamera(sim, dt, t);

    this.renderer.render(this.scene, this.camera);
    this.gl.endFrameEXP();
  }

  /** Screen position (0..1 from the top-left) of a point on the arena floor plane, `h` units up. */
  project(x: number, y: number, h = 1): { x: number; y: number } {
    const p = toWorld(x, y, h).project(this.camera);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  }

  private burst(at: THREE.Vector3, count: number, color: THREE.ColorRepresentation, power: number) {
    for (let i = 0; i < count; i++) {
      const b = this.bits[this.nextBit];
      this.nextBit = (this.nextBit + 1) % this.bits.length;
      const a = Math.random() * Math.PI * 2;
      const up = 2 + Math.random() * 4;
      const out = (1.5 + Math.random() * 3) * power;
      b.vel.set(Math.cos(a) * out, up * power, Math.sin(a) * out);
      b.m.position.copy(at);
      (b.m.material as THREE.MeshBasicMaterial).color.set(color);
      b.life = b.max = 0.35 + Math.random() * 0.3;
      b.m.visible = true;
    }
  }

  /** Turn new sim events into reactions: part pop, knockback flinch, sparks, shockwaves. */
  private react(sim: Sim) {
    for (; this.eventCursor < sim.events.length; this.eventCursor++) {
      const e = sim.events[this.eventCursor];
      if (e.type === 'hit') {
        const v = this.bugs[e.bug];
        const pv = v.parts[e.part];
        if (pv) pv.punch = 1;
        // Knock the struck part's joint away from the attacker (in the bug's pose space).
        if (pv && e.by !== null) {
          const from = sim.bugs[e.by].pos;
          const dir = toWorld(e.x, e.y).sub(toWorld(from.x, from.y)).setY(0.4);
          if (dir.lengthSq() > 1e-6) {
            v.pose.getWorldQuaternion(this.tmpQ).invert();
            dir.normalize().applyQuaternion(this.tmpQ);
            v.rig.impulse(pv.flex, dir, THREE.MathUtils.clamp(e.dmg / 4, 1.5, 6));
          }
        }
        const at = toWorld(e.x, e.y, e.h / CELL + 0.7);
        const strength = THREE.MathUtils.clamp(e.dmg / 10, 0.5, 2.2);
        if (e.by !== null) {
          const from = sim.bugs[e.by].pos;
          const dir = toWorld(e.x, e.y).sub(toWorld(from.x, from.y)).setY(0);
          if (dir.lengthSq() > 1e-6) {
            dir.normalize();
            v.kick.addScaledVector(dir, 0.16 * strength); // victim flinches away…
            this.bugs[e.by].kick.addScaledVector(dir, 0.07 * strength); // …attacker follows through
          }
        }
        this.burst(at, Math.round(3 + strength * 3), e.shielded ? 0x7fb3ff : e.dmg >= 14 ? 0xffb347 : 0xffe08a, 0.8 + strength * 0.25);
        if (e.crit) {
          // Critical: a hot flash, a ring, an extra shower of sparks and a harder flinch.
          this.flash(at, 0xff9a2e, 0.9, 0.22);
          this.flash(at, 0xffffff, 0.45, 0.12);
          this.wave(at, 0xff9a2e);
          this.burst(at, 10, 0xffffff, 1.5);
          if (pv) pv.punch = 1.4;
          if (e.by !== null) {
            const from = sim.bugs[e.by].pos;
            const dir = toWorld(e.x, e.y).sub(toWorld(from.x, from.y)).setY(0);
            if (dir.lengthSq() > 1e-6) v.kick.addScaledVector(dir.normalize(), 0.25);
          }
        }
      } else if (e.type === 'ult-release') {
        this.arena.hype(0.9);
        this.finisher = { id: e.move, caster: e.bug, t: 0 };
        this.releaseFx(sim, e.move, e.bug);
      } else if (e.type === 'move' && e.move === 'skitter-dash') {
        const b = sim.bugs[e.bug];
        this.burst(toWorld(b.pos.x, b.pos.y, 0.2), 12, 0xc9c2b0, 0.9); // dust kicked up
        this.startStreaks(e.bug, getMove(e.move).color, 0.35);
      } else if (e.type === 'crash') {
        this.arena.hype(0.4);
        const at = toWorld(e.x, e.y, 0.2);
        this.burst(at, 16, 0x8c98a6, 1.3);
        const w = this.waves[this.nextWave];
        this.nextWave = (this.nextWave + 1) % this.waves.length;
        w.m.position.copy(at).setY(0.06);
        (w.m.material as THREE.MeshBasicMaterial).color.set(0xd9d4c7);
        w.life = 0.45;
        w.m.visible = true;
      } else if (e.type === 'break') {
        this.arena.hype(0.35);
        const at = toWorld(e.x, e.y, e.h / CELL + 0.6);
        this.burst(at, 12, CATEGORY_COLOR[e.category], 1.4);
        this.burst(at, 6, 0xffffff, 1.1);
        const w = this.waves[this.nextWave];
        this.nextWave = (this.nextWave + 1) % this.waves.length;
        w.m.position.copy(at).setY(0.06);
        (w.m.material as THREE.MeshBasicMaterial).color.set(CATEGORY_COLOR[e.category]);
        w.life = 0.45;
        w.m.visible = true;
      }
    }
  }

  private updateReactions(dt: number) {
    for (const b of this.bits) {
      if (b.life <= 0) continue;
      b.life -= dt;
      b.vel.y -= 16 * dt;
      b.m.position.addScaledVector(b.vel, dt);
      if (b.m.position.y < 0.05) {
        b.m.position.y = 0.05;
        b.vel.y *= -0.4;
      }
      b.m.rotation.x += dt * 12;
      b.m.rotation.y += dt * 9;
      b.m.scale.setScalar(Math.max(0.01, b.life / b.max));
      if (b.life <= 0) b.m.visible = false;
    }
    for (const w of this.waves) {
      if (w.life <= 0) continue;
      w.life -= dt;
      const k = 1 - w.life / 0.45;
      w.m.scale.setScalar(0.4 + k * 2.6);
      (w.m.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
      if (w.life <= 0) w.m.visible = false;
    }
  }

  private detach(bug: Bug, pv: PartView) {
    pv.attached = false;
    this.bugs[bug.index].rig.deactivate(pv.flex);
    const root = pv.model.root;
    const w = partWorld(bug, pv.part);
    const v = this.bugs[bug.index];
    const height = root.position.y + v.group.position.y;
    v.pose.remove(root);
    root.position.copy(toWorld(w.x, w.y, height));
    root.rotation.y = yaw(bug.heading);
    this.scene.add(root);
    const out = toWorld(w.x - bug.pos.x, w.y - bug.pos.y).add(new THREE.Vector3(HALF, 0, HALF)).normalize();
    this.debris.push({
      obj: root,
      vel: new THREE.Vector3(out.x * 4 + (Math.random() - 0.5) * 2, 6 + Math.random() * 3, out.z * 4 + (Math.random() - 0.5) * 2),
      spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
      age: 0,
    });
  }

  private updateDebris(dt: number) {
    for (const d of this.debris) {
      d.age += dt;
      d.vel.y -= 20 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      if (d.obj.position.y < 0) {
        d.obj.position.y = 0;
        d.vel.y *= -0.35;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.6);
      }
      d.obj.rotation.x += d.spin.x * dt;
      d.obj.rotation.z += d.spin.z * dt;
      if (d.age > 2.5) d.obj.scale.setScalar(Math.max(0.001, 1 - (d.age - 2.5) * 2));
    }
    const dead = this.debris.filter((d) => d.age > 3);
    dead.forEach((d) => this.scene.remove(d.obj));
    this.debris = this.debris.filter((d) => d.age <= 3);
  }

  private updateProjectiles(sim: Sim) {
    while (this.projectiles.length < sim.projectiles.length) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: 0xe07bff }));
      this.scene.add(m);
      this.projectiles.push(m);
      // Glowing tail (shown on the big venom darts).
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 1, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.5),
        new THREE.MeshBasicMaterial({ color: 0xc77dff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      tail.visible = false;
      this.scene.add(tail);
      this.trails.push(tail);
    }
    this.projectiles.forEach((m, i) => {
      const p = sim.projectiles[i];
      const tail = this.trails[i];
      m.visible = !!p;
      tail.visible = !!p?.big;
      if (!p) return;
      m.position.copy(toWorld(p.x, p.y, p.z / CELL + 0.7));
      m.scale.setScalar(p.big ? 1.8 : 1);
      if (p.big) {
        // Stretch the tail back along the flight path.
        const vel = new THREE.Vector3(p.vx, p.vz, p.vy);
        tail.position.copy(m.position);
        faceAlong(tail, vel);
        tail.scale.set(1.4, 1.4, 1.6 + Math.sin(this.clock * 40 + i) * 0.2);
      }
    });
  }

  private updateSparks(sim: Sim) {
    while (this.sparks.length < sim.effects.length) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
      this.scene.add(m);
      this.sparks.push(m);
    }
    this.sparks.forEach((m, i) => {
      const e = sim.effects[i];
      m.visible = !!e;
      if (!e) return;
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.set(e.color);
      mat.opacity = Math.min(0.9, e.ttl * 3);
      m.position.copy(toWorld(e.x, e.y, e.h / CELL + 0.8));
      m.scale.setScalar((e.size / CELL) * (1.3 - e.ttl));
      m.rotation.y += 0.2;
    });
  }

  /** The move being staged right now, if any. */
  private cine(sim: Sim): Cine | null {
    if (sim.ult) return { id: sim.ult.id, caster: sim.ult.caster, phase: 'charge', p: sim.ult.t / sim.ult.dur };
    if (this.finisher) return { id: this.finisher.id, caster: this.finisher.caster, phase: 'strike', p: this.finisher.t / FINISH };
    return null;
  }

  /**
   * Charge-up body language per move (pose space: −z is the bug's front).
   * Returns animation overrides for the caster's parts.
   */
  private poseCine(v: BugView, c: Cine, t: number) {
    const k = c.p;
    const crouch = smooth(k / 0.3);
    switch (c.id) {
      case 'mandible-crusher': {
        // Drop low, spread the jaws, draw back shuddering… then lunge.
        const draw = smooth((k - 0.2) / 0.55) * (1 - smooth((k - 0.84) / 0.1));
        const lunge = smooth((k - 0.86) / 0.14);
        v.pose.scale.set(1 + crouch * 0.07, 1 - crouch * 0.2 + lunge * 0.12, 1 + crouch * 0.05 + lunge * 0.1);
        v.pose.position.set(Math.sin(t * 70) * 0.04 * draw, -0.16 * crouch * (1 - lunge), 0.7 * draw - 1.5 * lunge);
        v.pose.rotation.x = -0.14 * crouch * (1 - lunge) + 0.05 * lunge;
        v.pose.rotation.y = 0;
        return { weapon: 'mandibles' as Category, attack: k < 0.88 ? -1.4 * smooth(k / 0.35) : 1, glow: 0.12 * draw };
      }
      case 'venom-barrage': {
        // Plant wide, draw venom into the stinger (body creeps back with each pulse), then brace.
        const charge = smooth((k - 0.15) / 0.7);
        const pulse = Math.max(0, Math.sin(t * 22)) * charge;
        v.pose.scale.set(1 + crouch * 0.1, 1 - crouch * 0.14, 1 + crouch * 0.04);
        v.pose.position.set(0, -0.12 * crouch, 0.35 * charge + pulse * 0.05);
        v.pose.rotation.x = -0.06 * crouch;
        v.pose.rotation.y = Math.sin(t * 3) * 0.04 * (1 - charge);
        return { weapon: 'stinger' as Category, attack: 0.25 + 0.75 * charge, glow: 0.1 * pulse };
      }
      case 'carapace-lock': {
        // Hunker down, tuck the legs, spin once while the plates gather and seal.
        const spin = smooth((k - 0.25) / 0.6);
        v.pose.scale.set(1 + crouch * 0.1, 1 - crouch * 0.3, 1 + crouch * 0.1);
        v.pose.position.set(0, -0.22 * crouch, 0);
        v.pose.rotation.x = 0;
        v.pose.rotation.y = spin * Math.PI * 2;
        return { air: 0.85 * crouch, glow: 0.06 + Math.sin(t * 12) * 0.04 * spin };
      }
      default:
        return {};
    }
  }

  /** World position just in front of the caster's channelling weapon (or its centre). */
  private weaponTip(bi: 0 | 1, sim: Sim, cat: Category | undefined) {
    const v = this.bugs[bi];
    const bug = sim.bugs[bi];
    const f = new THREE.Vector3(Math.cos(bug.heading), 0, Math.sin(bug.heading));
    const pv = cat ? v.parts.find((p) => p.attached && p.part.part.category === cat) : undefined;
    const at = new THREE.Vector3();
    if (pv) pv.model.root.getWorldPosition(at).add(new THREE.Vector3(0, 0.55, 0));
    else v.group.getWorldPosition(at).add(new THREE.Vector3(0, 0.8, 0));
    return { at: at.addScaledVector(f, cat === 'armor' ? 0 : 0.9), f };
  }

  private flash(at: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life = 0.35) {
    const fl = this.flashes.find((x) => x.life <= 0) ?? this.flashes[0];
    fl.m.position.copy(at);
    (fl.m.material as THREE.MeshBasicMaterial).color.set(color);
    fl.life = fl.max = life;
    fl.size = size;
    fl.m.visible = true;
  }

  private wave(at: THREE.Vector3, color: THREE.ColorRepresentation) {
    const w = this.waves[this.nextWave];
    this.nextWave = (this.nextWave + 1) % this.waves.length;
    w.m.position.copy(at).setY(0.08);
    (w.m.material as THREE.MeshBasicMaterial).color.set(color);
    w.life = 0.45;
    w.m.visible = true;
  }

  private startStreaks(bi: number, color: THREE.ColorRepresentation, life: number) {
    this.streakBug = bi;
    this.streakLife = life;
    this.streakColor.set(color);
  }

  /** The payoff the moment an ultimate resolves. */
  private releaseFx(sim: Sim, id: MoveId, bi: 0 | 1) {
    const color = getMove(id).color;
    const { at, f } = this.weaponTip(bi, sim, MOVE_PART[id]);
    const v = this.bugs[bi];
    if (id === 'mandible-crusher') {
      const foe = sim.bugs[bi === 0 ? 1 : 0];
      const bite = at.clone().lerp(toWorld(foe.pos.x, foe.pos.y, 0.8), 0.4);
      this.flash(bite, color, 1.5, 0.4);
      this.flash(bite, 0xffffff, 0.7, 0.18);
      this.wave(bite, color);
      this.wave(bite, 0xffffff);
      this.burst(bite, 18, color, 1.6);
      this.burst(bite, 10, 0xffffff, 1.3);
      this.startStreaks(bi, color, 0.3);
    } else if (id === 'venom-barrage') {
      this.flash(at, color, 1.3, 0.3);
      this.flash(at, 0xffffff, 0.6, 0.15);
      this.burst(at, 14, color, 1.2);
      v.kick.addScaledVector(f, -0.9); // recoil
    } else if (id === 'carapace-lock') {
      const c = v.group.position.clone().setY(0.8);
      this.flash(c, color, 1.8, 0.35);
      this.wave(c, color);
      this.wave(c, 0xffffff);
      this.burst(c, 16, color, 1.2);
    }
  }

  /** Charge glow, converging sparks, speed streaks and flashes. */
  private updateCineFx(sim: Sim, c: Cine | null, t: number, dt: number) {
    const charging = c?.phase === 'charge' ? c : null;
    this.aura.visible = !!charging;
    this.orb.visible = false;
    if (charging) {
      const color = new THREE.Color(getMove(charging.id).color);
      const caster = sim.bugs[charging.caster];
      const k = charging.p;
      const { at } = this.weaponTip(charging.caster, sim, MOVE_PART[charging.id]);
      this.aura.position.copy(toWorld(caster.pos.x, caster.pos.y, 0.1));
      const ring = this.aura.children[0] as THREE.Mesh;
      (ring.material as THREE.MeshBasicMaterial).color.copy(color);
      ring.scale.setScalar((1.3 - k * 0.5 + Math.sin(t * 20) * 0.04) * Math.max(0.8, caster.radius / CELL / 2.2));
      // Sparks stream in toward the weapon (or onto the shell for Carapace Lock).
      const local = at.clone().sub(this.aura.position);
      this.auraSparks.forEach((s, i) => {
        const a = (i / this.auraSparks.length) * Math.PI * 2 + t * 2.5;
        const u = (t * 1.4 + i * 0.23) % 1;
        const from = new THREE.Vector3(Math.cos(a) * 3.2, 0.3 + (i % 3) * 0.9, Math.sin(a) * 3.2);
        const to = charging.id === 'carapace-lock' ? new THREE.Vector3(Math.cos(a) * 1.6, 0.6 + (i % 4) * 0.35, Math.sin(a) * 1.6) : local;
        s.position.copy(from).lerp(to, u * u);
        s.scale.setScalar(0.6 + (1 - u) * 0.8);
        s.rotation.set(t * 5 + i, t * 3, 0);
        (s.material as THREE.MeshBasicMaterial).color.copy(color);
      });
      // Energy gathering at the weapon.
      if (charging.id !== 'carapace-lock') {
        const grow = smooth((k - 0.1) / 0.75) * (charging.id === 'mandible-crusher' ? 1 - smooth((k - 0.88) / 0.08) : 1);
        this.orb.visible = grow > 0.01;
        this.orb.position.copy(at);
        this.orb.scale.setScalar(0.15 + grow * (charging.id === 'venom-barrage' ? 1.1 : 0.7) + Math.sin(t * 30) * 0.05 * grow);
        const om = this.orb.material as THREE.MeshBasicMaterial;
        om.color.copy(color).lerp(new THREE.Color(0xffffff), 0.35);
        om.opacity = 0.55 + 0.35 * grow;
      }
      if (charging.id === 'mandible-crusher' && k > 0.86 && this.streakLife <= 0) this.startStreaks(charging.caster, color, 0.45);
    }

    // Speed streaks trailing a lunging / dashing bug.
    this.streakLife = Math.max(0, this.streakLife - dt);
    const sb = sim.bugs[this.streakBug];
    const back = new THREE.Vector3(-Math.cos(sb.heading), 0, -Math.sin(sb.heading));
    const side = new THREE.Vector3(-back.z, 0, back.x);
    const base = this.bugs[this.streakBug].group.position.clone().add(this.bugs[this.streakBug].pose.position.clone().applyQuaternion(this.bugs[this.streakBug].group.quaternion));
    this.streaks.forEach((m, i) => {
      m.visible = this.streakLife > 0;
      if (!m.visible) return;
      const off = ((i * 0.37) % 1) - 0.5;
      const len = 1.5 + ((i * 0.61) % 1) * 2.5;
      m.position.copy(base).addScaledVector(side, off * 2).addScaledVector(back, 1 + len / 2 + ((t * 9 + i * 0.3) % 1) * 1.2);
      m.position.y = 0.3 + ((i * 0.53) % 1) * 1.3;
      m.scale.set(1, 1, len);
      faceAlong(m, back);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.copy(this.streakColor);
      mat.opacity = Math.min(1, this.streakLife * 4) * 0.8;
    });

    for (const fl of this.flashes) {
      if (fl.life <= 0) continue;
      fl.life -= dt;
      const k = 1 - fl.life / fl.max;
      fl.m.scale.setScalar(fl.size * (0.4 + k * 0.9));
      (fl.m.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
      if (fl.life <= 0) fl.m.visible = false;
    }
  }

  private updateCamera(sim: Sim, dt: number, t: number) {
    // Fight camera: a three-quarter view from behind the player's bug looking at
    // the opponent (so on a tall phone screen the fight runs up the screen, with
    // real depth), swinging round smoothly as they circle and pulling back/up as
    // they separate or take to the air.
    const [a, b] = sim.bugs;
    const pa = toWorld(a.pos.x, a.pos.y, a.alt / CELL);
    const pb = toWorld(b.pos.x, b.pos.y, b.alt / CELL);
    const target = pa.clone().multiplyScalar(0.5).add(pb.clone().multiplyScalar(0.5));
    target.y = target.y * 0.7 + 0.6;
    const axis = pb.clone().sub(pa).setY(0);
    const sep = axis.length();
    if (sep > 2.5) {
      // Camera direction (target → camera) = behind the player, 35° off the axis.
      const behind = Math.atan2(-axis.x, -axis.z);
      const options = [behind + 0.6, behind - 0.6].map((y) => {
        let d = y - this.camYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        return d;
      });
      const turn = Math.abs(options[0]) < Math.abs(options[1]) ? options[0] : options[1];
      this.camYaw += THREE.MathUtils.clamp(turn, -0.8 * dt, 0.8 * dt);
    }
    const high = Math.max(a.alt, b.alt) / CELL;
    const pitch = 0.72 + Math.min(0.18, high * 0.05);
    const dist = THREE.MathUtils.clamp(sep * 0.7 + 22, 22, 34) * Math.sqrt(this.aspectK);
    const dir = new THREE.Vector3(Math.sin(this.camYaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(this.camYaw) * Math.cos(pitch));
    const followPos = target.clone().addScaledVector(dir, dist);
    const k = 1 - Math.exp(-dt * 3.5);
    this.camLook.lerp(target, k);
    this.camPos.lerp(followPos, k);

    // Pre-fight countdown: swoop down from a high, wide orbit into the fight view.
    if (this.intro > 0) {
      const k = smooth(this.intro);
      const a = this.camYaw + k * 1.5;
      const high = new THREE.Vector3(Math.sin(a) * 30, 24, Math.cos(a) * 30).multiplyScalar(Math.sqrt(this.aspectK));
      this.camPos.copy(followPos).lerp(high, k);
      this.camLook.copy(target).lerp(new THREE.Vector3(0, 0, 0), k * 0.6);
    }

    const c = this.cine(sim);
    this.ultWeight = c ? Math.min(1, this.ultWeight + dt * 6) : Math.max(0, this.ultWeight - dt * 2.5);
    let pos = this.camPos.clone();
    let look = this.camLook.clone();
    let fov = FOV;

    if (!c) this.ultSide = 0;
    if (c) {
      const caster = sim.bugs[c.caster];
      const foe = sim.bugs[c.caster === 0 ? 1 : 0];
      const center = toWorld(caster.pos.x, caster.pos.y, caster.alt / CELL);
      const foeAt = toWorld(foe.pos.x, foe.pos.y, foe.alt / CELL);
      const r = caster.radius / CELL;
      const K = this.aspectK;
      // Shoot from whichever side is further from the opponent, so the camera never ends up inside it.
      if (this.ultSide === 0) {
        const probe = (sd: number) =>
          Math.hypot(caster.pos.x + Math.cos(caster.heading + 0.95 * sd) * 120 - foe.pos.x, caster.pos.y + Math.sin(caster.heading + 0.95 * sd) * 120 - foe.pos.y);
        this.ultSide = probe(1) >= probe(-1) ? 1 : -1;
      }
      const side = this.ultSide;
      const dirAt = (a: number) => new THREE.Vector3(Math.cos(caster.heading + a), 0, Math.sin(caster.heading + a));
      const p = c.p;
      let shot: THREE.Vector3;
      let aim: THREE.Vector3;
      if (c.id === 'venom-barrage') {
        // Over the shoulder, looking down the barrel at the target.
        const behind = dirAt(Math.PI + 0.45 * side);
        const push = c.phase === 'charge' ? smooth((p - 0.6) / 0.4) : 1 - smooth(p);
        shot = center.clone().addScaledVector(behind, r + (4.2 - push * 1.2) * K).add(new THREE.Vector3(0, 1.5 + 0.8 * K, 0));
        aim = center.clone().lerp(foeAt, c.phase === 'charge' ? 0.35 : 0.35 + smooth(p) * 0.4).add(new THREE.Vector3(0, 0.6, 0));
        fov = FOV - 6 * push;
      } else if (c.id === 'carapace-lock') {
        // Circle the bug as the shell forms.
        const a = 0.95 * side + (c.phase === 'charge' ? smooth(p) * 1.8 : 1.8 + p * 0.3) * side;
        shot = center.clone().addScaledVector(dirAt(a), r + 5 * K).add(new THREE.Vector3(0, 1.7 + 0.8 * K, 0));
        aim = center.clone().add(new THREE.Vector3(0, 0.6, 0));
        fov = FOV - 4;
      } else if (c.phase === 'charge') {
        // Mandible Crusher: low front three-quarter, then push in hard for the lunge.
        const fwd = dirAt(0.95 * side);
        const push = smooth((p - 0.8) / 0.2);
        shot = center.clone().addScaledVector(fwd, r + (5.2 - push * 1.4) * K).add(new THREE.Vector3(0, 1.0 + 0.7 * K - push * 0.3, 0));
        aim = center.clone().add(new THREE.Vector3(0, 0.6, 0));
        fov = FOV - 9 * push;
      } else {
        // …and the bite from the side, framing both bugs.
        const mid = center.clone().lerp(foeAt, 0.5);
        const axis = foeAt.clone().sub(center).setY(0).normalize();
        const perp = new THREE.Vector3(-axis.z, 0, axis.x).multiplyScalar(side);
        shot = mid.clone().addScaledVector(perp, (5.5 + p * 1.5) * K).add(new THREE.Vector3(0, 1.4 + 0.6 * K, 0));
        aim = mid.clone().add(new THREE.Vector3(0, 0.5, 0));
        fov = FOV - 6 * (1 - p);
      }
      // Handheld drift.
      shot.add(new THREE.Vector3(Math.sin(t * 2.3) * 0.12, Math.sin(t * 3.1) * 0.08, Math.cos(t * 1.7) * 0.1));
      const swing = c.phase === 'charge' ? smooth(p / 0.3) : 1;
      pos = pos.lerp(shot, swing * this.ultWeight);
      look = look.lerp(aim, swing * this.ultWeight);
      fov = THREE.MathUtils.lerp(FOV, fov, this.ultWeight);
    }

    // Background falls into fog around the caster (cheap depth-of-field stand-in).
    const fog = this.scene.fog as THREE.Fog;
    let focus = 8;
    if (c) {
      const b = sim.bugs[c.caster];
      focus = pos.distanceTo(toWorld(b.pos.x, b.pos.y, b.alt / CELL)) + b.radius / CELL + (c.id === 'carapace-lock' ? 0 : 6);
    }
    fog.near = THREE.MathUtils.lerp(55, focus + 0.5, this.ultWeight);
    fog.far = THREE.MathUtils.lerp(120, focus + 10, this.ultWeight);

    if (sim.shake > 0) {
      const s = sim.shake * 0.9;
      pos.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose() {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.renderer.dispose();
  }
}
