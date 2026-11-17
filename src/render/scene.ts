/**
 * Three.js view of a Sim. Reads sim state every frame; never writes to it.
 * Works with an expo-gl context on native and web.
 */
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

import { getMove } from '@/game/moves';
import { ARENA_SIZE, CELL, partWorld, stompWarning, type Bug, type Sim, type SimPart } from '@/game/sim';

import { createRenderer } from './gl';
import { buildPart, toonMaterial, toonMesh, type PartModel } from './models';

const HALF = ARENA_SIZE / CELL / 2;
const FOV = 50;
const BASE_OFFSET = new THREE.Vector3(0, 15, 10.5);
const BG = 0x14171c;

/** Sim floor (x, y) → three world (x, 0, z). One grid cell = 1 unit. */
const toWorld = (x: number, y: number, h = 0) => new THREE.Vector3(x / CELL - HALF, h, y / CELL - HALF);

/** Rotation about +y that points a model's −z at sim heading `h`. */
const yaw = (h: number) => Math.atan2(-Math.cos(h), -Math.sin(h));

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

type PartView = { part: SimPart; model: PartModel; attached: boolean };
type BugView = { group: THREE.Group; pose: THREE.Group; parts: PartView[]; ring: THREE.Mesh; shield: THREE.Mesh };
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
  private followOffset = BASE_OFFSET.clone();
  /** ≥1: how much to pull cameras back for narrow (portrait) screens. */
  private aspectK = 1;
  private ultSide = 0;

  constructor(
    private gl: ExpoWebGLRenderingContext,
    sim: Sim,
  ) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.renderer = createRenderer(gl, BG);

    this.camera = new THREE.PerspectiveCamera(FOV, w / h, 0.1, 200);
    this.fitOffset(w / h);
    this.scene.fog = new THREE.Fog(BG, 60, 140);

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

    const start = this.followTarget(sim);
    this.camLook.copy(start);
    this.camPos.copy(start).add(this.followOffset);
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

  private buildBug(bug: Bug): BugView {
    const group = new THREE.Group();
    const pose = new THREE.Group();
    group.add(pose);
    const parts = bug.parts.map((p) => {
      const model = buildPart(p.part.category, Math.sign(Math.round(p.lx)));
      model.root.position.set(p.lx / CELL, 0, p.ly / CELL);
      pose.add(model.root);
      return { part: p, model, attached: true };
    });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(bug.radius / CELL + 0.2, bug.radius / CELL + 0.45, 32),
      new THREE.MeshBasicMaterial({ color: bug.index === 0 ? 0x3ddc97 : 0xff5d5d, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    group.add(ring);
    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(bug.radius / CELL + 0.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x4fa8ff, transparent: true, opacity: 0.25, wireframe: true }),
    );
    shield.visible = false;
    group.add(shield);
    this.scene.add(group);
    return { group, pose, parts, ring, shield };
  }

  private followTarget(sim: Sim) {
    const [a, b] = sim.bugs;
    return toWorld(a.pos.x * 0.65 + b.pos.x * 0.35, a.pos.y * 0.65 + b.pos.y * 0.35);
  }

  private fitOffset(aspect: number) {
    this.aspectK = Math.max(1, 0.85 / aspect);
    this.followOffset = BASE_OFFSET.clone().multiplyScalar(this.aspectK);
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

    // Bugs
    sim.bugs.forEach((bug, bi) => {
      const v = this.bugs[bi];
      v.group.position.copy(toWorld(bug.pos.x, bug.pos.y));
      v.group.rotation.y = yaw(bug.heading);
      v.shield.visible = bug.shield > 0;
      v.shield.rotation.y = t;
      v.ring.visible = !bug.dead;
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
        v.pose.rotation.x *= 0.7;
        v.pose.position.y *= 0.7;
      }
      if (bug.dead) v.pose.rotation.z = Math.min(0.5, v.pose.rotation.z + dt);

      for (const pv of v.parts) {
        if (pv.attached && !pv.part.alive) this.detach(bug, pv);
        if (!pv.attached) continue;
        const wear = Math.max(0, pv.part.hp) / pv.part.part.hp;
        pv.model.mat.color.copy(pv.model.base).multiplyScalar(0.45 + 0.55 * wear);
        pv.model.mat.emissive.setScalar(pv.part.flash > 0 ? 0.9 : 0);
        if (!ult && !bug.dead) pv.model.animate?.(t);
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

  private detach(bug: Bug, pv: PartView) {
    pv.attached = false;
    const root = pv.model.root;
    const w = partWorld(bug, pv.part);
    const v = this.bugs[bug.index];
    v.pose.remove(root);
    root.position.copy(toWorld(w.x, w.y));
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
      m.position.copy(toWorld(p.x, p.y, 0.7));
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
      m.position.copy(toWorld(e.x, e.y, 0.8));
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
    const target = this.followTarget(sim);
    const followPos = target.clone().add(this.followOffset);
    const k = 1 - Math.exp(-dt * 4);
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
      const center = toWorld(c.pos.x, c.pos.y);
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
      focus = pos.distanceTo(toWorld(c.pos.x, c.pos.y)) + c.radius / CELL;
    }
    fog.near = THREE.MathUtils.lerp(60, focus + 0.5, this.ultWeight);
    fog.far = THREE.MathUtils.lerp(140, focus + 10, this.ultWeight);

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
