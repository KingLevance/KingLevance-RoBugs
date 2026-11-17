/**
 * Three.js view of a Sim. Reads sim state every frame; never writes to it.
 * Works with an expo-gl context on native and web.
 */
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

import { getMove } from '@/game/moves';
import { CATEGORY_COLOR } from '@/game/parts';
import { ARENA_SIZE, CELL, partWorld, stompWarning, type Bug, type Sim, type SimPart } from '@/game/sim';

import { createRenderer } from './gl';
import { FlexRig, GIVE } from './flex';
import { adjacentPairs, buildConnector, buildPart, seatHeight, stackOffset, toonMaterial, toonMesh, UNDER_LIFT, UNDER_SCALE, type Connector, type PartModel } from './models';

const HALF = ARENA_SIZE / CELL / 2;
const FOV = 50;
const BG = 0x14171c;

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
  shadow: THREE.Mesh;
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
  baseRadius: number;
  /** Small bobbing pointer above the player's bug only. */
  marker: THREE.Mesh | null;
  shield: THREE.Mesh;
  walk: number;
  lean: number;
  lastHeading: number;
  /** Knockback flinch (world units), springs back to zero. */
  kick: THREE.Vector3;
};
type Debris = { obj: THREE.Object3D; vel: THREE.Vector3; spin: THREE.Vector3; age: number };

export class ArenaRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private bugs: BugView[] = [];
  private debris: Debris[] = [];
  private projectiles: THREE.Mesh[] = [];
  private sparks: THREE.Mesh[] = [];
  private hazards: { obj: THREE.Object3D; ring?: THREE.Mesh; idx: number }[] = [];
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
  private eventCursor = 0;
  private tmpQ = new THREE.Quaternion();
  private bits: { m: THREE.Mesh; vel: THREE.Vector3; life: number; max: number }[] = [];
  private nextBit = 0;
  private waves: { m: THREE.Mesh; life: number }[] = [];
  private nextWave = 0;

  constructor(
    private gl: ExpoWebGLRenderingContext,
    sim: Sim,
  ) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.renderer = createRenderer(gl, BG);

    this.camera = new THREE.PerspectiveCamera(FOV, w / h, 0.1, 200);
    this.fitOffset(w / h);
    this.scene.fog = new THREE.Fog(BG, 55, 120);

    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x30343c, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-8, 20, 10);
    this.scene.add(sun);

    this.buildArena(sim);
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

    // Start the fight camera already in position (a long step snaps it there).
    this.updateCamera(sim, 10, 0);
  }

  private buildArena(sim: Sim) {
    const size = HALF * 2;
    const floor = toonMesh(new THREE.BoxGeometry(size, 0.4, size), toonMaterial(0x2b313a), 0);
    floor.position.y = -0.2;
    this.scene.add(floor);
    // Floor tiles
    const tileMat = toonMaterial(0x323943);
    for (let x = 0; x < 6; x++)
      for (let z = 0; z < 6; z++) {
        if ((x + z) % 2) continue;
        const t = new THREE.Mesh(new THREE.BoxGeometry(size / 6, 0.02, size / 6), tileMat);
        t.position.set(-HALF + (x + 0.5) * (size / 6), 0.01, -HALF + (z + 0.5) * (size / 6));
        this.scene.add(t);
      }
    const wallMat = toonMaterial(sim.spikedWalls ? 0x8a3b2e : 0x4b5563);
    const spikeMat = toonMaterial(0xd9d4c7);
    for (let i = 0; i < 4; i++) {
      const horiz = i < 2;
      const wall = toonMesh(new THREE.BoxGeometry(horiz ? size + 1.6 : 0.8, 1.4, horiz ? 0.8 : size), wallMat);
      const off = HALF + 0.4;
      wall.position.set(horiz ? 0 : i === 2 ? -off : off, 0.7, horiz ? (i === 0 ? -off : off) : 0);
      this.scene.add(wall);
      if (!sim.spikedWalls) continue;
      for (let k = 0; k < 9; k++) {
        const spike = toonMesh(new THREE.ConeGeometry(0.25, 0.8, 4), spikeMat, 0.05);
        const along = -HALF + (k + 0.5) * (size / 9);
        const inward = horiz ? (i === 0 ? 1 : -1) : i === 2 ? 1 : -1;
        if (horiz) {
          spike.position.set(along, 0.7, (i === 0 ? -HALF : HALF) + 0.05 * inward);
          spike.rotation.x = (Math.PI / 2) * inward;
        } else {
          spike.position.set((i === 2 ? -HALF : HALF) + 0.05 * inward, 0.7, along);
          spike.rotation.z = (-Math.PI / 2) * inward;
        }
        this.scene.add(spike);
      }
    }

    this.buildStadium();

    sim.hazards.forEach((h, idx) => {
      const r = h.r / CELL;
      if (h.kind === 'acid') {
        const pool = new THREE.Mesh(
          new THREE.CylinderGeometry(r, r, 0.08, 28),
          toonMaterial(0x7ce654, { emissive: 0x2f7a1c, transparent: true, opacity: 0.8 }),
        );
        pool.position.copy(toWorld(h.x, h.y, 0.05));
        this.scene.add(pool);
        this.hazards.push({ obj: pool, idx });
      } else {
        const column = toonMesh(new THREE.CylinderGeometry(r * 0.9, r * 0.9, 1.6, 8), toonMaterial(0x6b7280));
        const plate = toonMesh(new THREE.CylinderGeometry(r, r, 0.3, 8), toonMaterial(0xff8a3d), 0.03);
        plate.position.y = -0.9;
        column.add(plate);
        column.position.copy(toWorld(h.x, h.y, 5.6));
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(r * 0.85, r, 28),
          new THREE.MeshBasicMaterial({ color: 0xff5a28, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(toWorld(h.x, h.y, 0.03));
        this.scene.add(column, ring);
        this.hazards.push({ obj: column, ring, idx });
      }
    });
  }

  /** Raised arena platform, outer floor, tiered stands with a crowd, and floodlights. */
  private buildStadium() {
    const size = HALF * 2;
    const plinth = toonMesh(new THREE.BoxGeometry(size + 5, 1.6, size + 5), toonMaterial(0x1f242b), 0.02);
    plinth.position.y = -1.0;
    this.scene.add(plinth);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(size + 5.2, 0.12, size + 5.2), new THREE.MeshBasicMaterial({ color: 0xf2a93b }));
    trim.position.y = -0.25;
    this.scene.add(trim);
    const outer = new THREE.Mesh(new THREE.CircleGeometry(90, 48), toonMaterial(0x161a20));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -1.8;
    this.scene.add(outer);

    // Tiered stands in a bowl.
    const tiers = 5;
    const crowdColors = [0xf2a93b, 0x3ddc97, 0xff5d5d, 0x4fa8ff, 0xc77dff, 0xf1ede4, 0x8ed1e6];
    const perTier = 110;
    const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 1.0, 0.7), new THREE.MeshToonMaterial({ color: 0xffffff }), tiers * perTier);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    let n = 0;
    for (let i = 0; i < tiers; i++) {
      const r = 34 + i * 3.4;
      const top = -1.8 + 1.6 + i * 1.7;
      // Each tier: an inward-facing riser wall plus a flat ring to stand on.
      const mat = toonMaterial(i % 2 ? 0x2a3038 : 0x252a31);
      const riser = new THREE.Mesh(new THREE.CylinderGeometry(r, r, top + 1.8, 56, 1, true), mat);
      (riser.material as THREE.Material).side = THREE.DoubleSide;
      riser.position.y = (top - 1.8) / 2;
      const tread = new THREE.Mesh(new THREE.RingGeometry(r, r + 3.4, 56), mat);
      tread.rotation.x = -Math.PI / 2;
      tread.position.y = top;
      this.scene.add(riser, tread);
      for (let k = 0; k < perTier; k++) {
        const a = (k / perTier) * Math.PI * 2 + i * 0.13;
        const rr = r + 1.4 + Math.sin(k * 7.3 + i) * 0.5;
        m.makeRotationY(-a);
        m.setPosition(Math.cos(a) * rr, top + 0.5 + Math.abs(Math.sin(k * 3.1 + i * 2)) * 0.15, Math.sin(a) * rr);
        crowd.setMatrixAt(n, m);
        crowd.setColorAt(n, c.set(crowdColors[(k * 5 + i * 3) % crowdColors.length]).multiplyScalar(0.75));
        n++;
      }
    }
    crowd.instanceMatrix.needsUpdate = true;
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    this.scene.add(crowd);

    // Floodlight towers.
    const pole = toonMaterial(0x3a424d);
    const lamp = new THREE.MeshBasicMaterial({ color: 0xfff1c8 });
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const r = 54;
      const tower = toonMesh(new THREE.CylinderGeometry(0.5, 0.8, 26, 8), pole, 0.03);
      tower.position.set(Math.cos(a) * r, 11, Math.sin(a) * r);
      this.scene.add(tower);
      const head = new THREE.Mesh(new THREE.BoxGeometry(5, 2.4, 0.6), lamp);
      head.position.set(Math.cos(a) * r, 24.5, Math.sin(a) * r);
      head.lookAt(0, 0, 0);
      this.scene.add(head);
    }
  }

  private buildBug(bug: Bug): BugView {
    const group = new THREE.Group();
    const pose = new THREE.Group();
    group.add(pose);
    // Opaque, slightly-darker-than-floor blobs under each part: a shadow that follows the bug's
    // shape and loses pieces as parts break off (opaque so overlaps don't stack up).
    const shadowGeo = new THREE.CircleGeometry(0.62, 16);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x1d2128 });
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
      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(p.lx / CELL, 0.022, p.ly / CELL);
      shadow.visible = !p.z;
      if (!p.z) shadows.add(shadow);
      return { part: p, model, attached: true, shadow, punch: 0, flex: -1 };
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

    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(r + 0.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x4fa8ff, transparent: true, opacity: 0.25, wireframe: true }),
    );
    shield.visible = false;
    group.add(shield);
    this.scene.add(group);
    return { group, pose, parts, links, rig, ground, shadows, baseRadius: r, marker, shield, walk: 0, lean: 0, lastHeading: bug.heading, kick: new THREE.Vector3() };
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
      v.shield.visible = bug.shield > 0;
      v.shield.rotation.y = t;
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

      // Pose: crouch → rise → rear back while charging an ultimate.
      if (ult && ult.caster === bi) {
        const k = ult.t / ult.dur;
        const crouch = k < 0.35 ? smooth(k / 0.35) : 1 - smooth((k - 0.35) / 0.3);
        const rear = smooth((k - 0.6) / 0.3);
        v.pose.scale.set(1 + crouch * 0.08, 1 - crouch * 0.25 + rear * 0.1, 1 + crouch * 0.08);
        v.pose.rotation.x = rear * 0.35;
        v.pose.position.y = rear * 0.4;
      } else {
        v.pose.scale.lerp(new THREE.Vector3(1, 1, 1), 0.3);
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

      for (const pv of v.parts) {
        if (pv.attached && !pv.part.alive) this.detach(bug, pv);
        pv.shadow.visible = pv.attached && !pv.part.z;
        if (!pv.attached) continue;
        const p = pv.part;
        pv.model.tint(Math.max(0, p.hp) / p.part.hp, p.flash > 0);
        pv.punch = Math.max(0, pv.punch - dt * 7);
        pv.model.root.scale.setScalar(1 + pv.punch * pv.punch * 0.3);
        if (bug.dead) continue;
        // 1 at the moment the weapon fires, fading over ~0.28 s.
        const w = p.part.weapon;
        const attack = w && sim.time > 1 ? THREE.MathUtils.clamp(1 - (w.cooldown - p.cooldown) / 0.28, 0, 1) : 0;
        pv.model.animate({ t, walk: v.walk, speed, attack, air: Math.min(1, bug.alt / 14) });
      }
    });

    this.updateDebris(dt);
    this.updateHazards(sim);
    this.updateProjectiles(sim);
    this.updateSparks(sim);
    this.updateAura(sim, t);
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
      } else if (e.type === 'crash') {
        const at = toWorld(e.x, e.y, 0.2);
        this.burst(at, 16, 0x8c98a6, 1.3);
        const w = this.waves[this.nextWave];
        this.nextWave = (this.nextWave + 1) % this.waves.length;
        w.m.position.copy(at).setY(0.06);
        (w.m.material as THREE.MeshBasicMaterial).color.set(0xd9d4c7);
        w.life = 0.45;
        w.m.visible = true;
      } else if (e.type === 'break') {
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

  private updateHazards(sim: Sim) {
    for (const hv of this.hazards) {
      const h = sim.hazards[hv.idx];
      if (h.kind !== 'stomper') {
        hv.obj.scale.y = 1 + Math.sin(this.clock * 3 + hv.idx) * 0.3;
        continue;
      }
      const warnStart = h.period - 1.2;
      let y = 5.6;
      if (h.t < 0.5) y = 0.95 + (h.t / 0.5) * 4.65;
      else if (h.t > warnStart) y = 5.6 + ((h.t - warnStart) / 1.2) * 1.4;
      hv.obj.position.y = y;
      if (hv.ring) {
        const mat = hv.ring.material as THREE.MeshBasicMaterial;
        mat.opacity = stompWarning(h) ? 0.5 + Math.sin(this.clock * 25) * 0.3 : 0.25;
      }
    }
  }

  private updateProjectiles(sim: Sim) {
    while (this.projectiles.length < sim.projectiles.length) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: 0xe07bff }));
      this.scene.add(m);
      this.projectiles.push(m);
    }
    this.projectiles.forEach((m, i) => {
      const p = sim.projectiles[i];
      m.visible = !!p;
      if (!p) return;
      m.position.copy(toWorld(p.x, p.y, p.z / CELL + 0.7));
      m.scale.setScalar(p.big ? 1.8 : 1);
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

  private updateAura(sim: Sim, t: number) {
    const ult = sim.ult;
    this.aura.visible = !!ult;
    if (!ult) return;
    const caster = sim.bugs[ult.caster];
    const color = new THREE.Color(getMove(ult.id).color);
    const k = ult.t / ult.dur;
    this.aura.position.copy(toWorld(caster.pos.x, caster.pos.y, 0.1));
    const ring = this.aura.children[0] as THREE.Mesh;
    (ring.material as THREE.MeshBasicMaterial).color.copy(color);
    ring.scale.setScalar(1.6 - k * 0.8 + Math.sin(t * 20) * 0.05);
    this.auraSparks.forEach((s, i) => {
      const a = (i / this.auraSparks.length) * Math.PI * 2 + t * 4;
      const rise = ((t * 1.5 + i * 0.37) % 1) * 3;
      const r = 1.8 * (1 - k * 0.6);
      s.position.set(Math.cos(a) * r, rise, Math.sin(a) * r);
      (s.material as THREE.MeshBasicMaterial).color.copy(color);
    });
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

    const ult = sim.ult;
    this.ultWeight = ult ? Math.min(1, this.ultWeight + dt * 6) : Math.max(0, this.ultWeight - dt * 3);
    let pos = this.camPos.clone();
    let look = this.camLook.clone();
    let fov = FOV;

    if (!ult) this.ultSide = 0;
    if (ult) {
      // The camera swings round to face the caster, low and close…
      const c = sim.bugs[ult.caster];
      const center = toWorld(c.pos.x, c.pos.y, c.alt / CELL);
      // Three-quarter front view, from whichever side is further from the opponent,
      // so the shot never ends up inside the bug standing in front of the caster.
      if (this.ultSide === 0) {
        const foe = sim.bugs[ult.caster === 0 ? 1 : 0];
        const probe = (sd: number) =>
          Math.hypot(c.pos.x + Math.cos(c.heading + 0.95 * sd) * 120 - foe.pos.x, c.pos.y + Math.sin(c.heading + 0.95 * sd) * 120 - foe.pos.y);
        this.ultSide = probe(1) >= probe(-1) ? 1 : -1;
      }
      const side = this.ultSide;
      const fwd = new THREE.Vector3(Math.cos(c.heading + 0.95 * side), 0, Math.sin(c.heading + 0.95 * side));
      const p = ult.t / ult.dur;
      const swing = smooth(p / 0.35);
      const r = c.radius / CELL;
      const shot = center.clone().addScaledVector(fwd, r + 5.5 * this.aspectK).add(new THREE.Vector3(0, 1.6 + this.aspectK, 0));
      // …then pushes in hard over the last 18% while the FOV narrows.
      const push = smooth((p - 0.82) / 0.18);
      const close = center.clone().addScaledVector(fwd, r + 4.2 * this.aspectK).add(new THREE.Vector3(0, 1.2 + 0.7 * this.aspectK, 0));
      shot.lerp(close, push);
      // Handheld drift.
      shot.add(new THREE.Vector3(Math.sin(t * 2.3) * 0.12, Math.sin(t * 3.1) * 0.08, Math.cos(t * 1.7) * 0.1));
      pos = pos.lerp(shot, swing);
      look = look.lerp(center.clone().add(new THREE.Vector3(0, 0.7, 0)), swing);
      fov = FOV - 9 * push;
    }

    // Background falls into fog around the caster (cheap depth-of-field stand-in).
    const fog = this.scene.fog as THREE.Fog;
    let focus = 8;
    if (ult) {
      const c = sim.bugs[ult.caster];
      focus = pos.distanceTo(toWorld(c.pos.x, c.pos.y, c.alt / CELL)) + c.radius / CELL;
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
