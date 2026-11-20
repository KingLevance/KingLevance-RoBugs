/**
 * 3D garage: shows the bug exactly as it looks in the arena, standing on its
 * build grid, and supports picking/dragging parts by screen position.
 */
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

import { GRID_H, GRID_W, pkey, type Layer, type Placement } from '@/game/build';
import { getPart } from '@/game/parts';

import { createRenderer } from './gl';
import { adjacentPairs, buildConnector, buildPart, IDLE, seatHeight, setGhost, setHighlight, stackOffset, toonMaterial, toonMesh, UNDER_LIFT, UNDER_SCALE, type PartModel } from './models';

const BG = 0x12151a;
const MIDX = (GRID_W - 1) / 2;
const MIDY = (GRID_H - 1) / 2;
const TARGET = new THREE.Vector3(0, 0.3, 0.2);
const MIN_PITCH = (12 * Math.PI) / 180;
const MAX_PITCH = (88 * Math.PI) / 180;

/** Named camera angles. yaw 0 = looking from behind the bug (front at the top). */
export const VIEWS = {
  angle: { yaw: 0, pitch: 0.95 },
  top: { yaw: 0, pitch: MAX_PITCH },
  side: { yaw: Math.PI / 2, pitch: 0.3 },
  front: { yaw: Math.PI, pitch: 0.35 },
} as const;
export type ViewName = keyof typeof VIEWS;

const dirFor = (yaw: number, pitch: number) =>
  new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));

const cellToWorld = (x: number, y: number) => new THREE.Vector3(x - MIDX, 0, y - MIDY);

/** A grid cell (floor). */
export type Cell = { x: number; y: number };
/** A part's position: cell + layer (1 = stacked on top, −1 = slung underneath). */
export type Slot = Cell & { z: Layer };

const slotKey = (s: { x: number; y: number; z?: number }) => pkey(s);
const parseKey = (k: string): Slot => {
  const [x, y] = k.split(',').map(Number);
  return { x, y, z: k.endsWith(',top') ? 1 : k.endsWith(',under') ? -1 : 0 };
};
export type DragState = { cell: Cell | null; inside: boolean };
/** A glowing "you can put it here" spot: tier 0 is the best spot, 1 good, 2 possible. */
export type HintSlot = Slot & { tier: 0 | 1 | 2 };

const HINT_COLORS = [0x3ddc97, 0x3ddc97, 0x9fe8c8] as const;
const HINT_ALPHA = [0.55, 0.36, 0.16] as const;

export class GarageRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private bug = new THREE.Group();
  private models = new Map<string, PartModel>();
  /** Height of the top surface of each grid part, by cell key (for stacking). */
  private baseTop = new Map<string, number>();
  /** Lets the garage say which layer the dragged part would drop into on a given cell (0 = the grid). */
  private stackTest: (cell: Cell) => Layer = () => 0;
  /** Cells whose grid part rides up because something is slung underneath. */
  private lifted = new Set<string>();
  private links: { a: string; b: string; obj: THREE.Group }[] = [];
  /** Green "good spot" tiles for the selected part. */
  private hints: { mesh: THREE.Mesh; tier: 0 | 1 | 2 }[] = [];
  private hintMats = HINT_COLORS.map((c, i) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: HINT_ALPHA[i], depthWrite: false }));
  /** See-through preview of a part being placed. */
  private ghost: { partId: string; model: PartModel; slot: Slot | null; ok: boolean } | null = null;
  /** Rings that burst out where a part was just placed. */
  private bursts: { mesh: THREE.Mesh; t: number }[] = [];
  /** Models added after the first build (they pop in). */
  private loaded = false;
  private hover: THREE.Mesh;
  private selRing: THREE.Mesh;
  /** Bobbing arrow over the selected part. */
  private selArrow: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private clock = 0;
  private yaw: number = VIEWS.angle.yaw;
  private pitch: number = VIEWS.angle.pitch;
  private goalYaw: number = VIEWS.angle.yaw;
  private goalPitch: number = VIEWS.angle.pitch;
  /** Whole-bench bounds (editing views) and bug bounds (eye-level views): minX, maxX, minZ, maxZ. */
  private benchBox = [-(MIDX + 0.9), MIDX + 0.9, -(MIDY + 1.1), MIDY + 1.1];
  private bugBox = this.benchBox.slice();
  private fitDirty = true;
  private selected: string | null = null;
  private dragging: { key: string; point: THREE.Vector3 } | null = null;

  constructor(private gl: ExpoWebGLRenderingContext) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.renderer = createRenderer(gl, BG);
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    this.fitCamera();

    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x30343c, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-6, 14, 8);
    this.scene.add(sun);

    // Workbench + grid tiles.
    const bench = toonMesh(new THREE.BoxGeometry(GRID_W + 0.8, 0.3, GRID_H + 0.8), toonMaterial(0x23282f), 0.01);
    bench.position.y = -0.17;
    this.scene.add(bench);
    const tileMat = toonMaterial(0x2f353e);
    for (let y = 0; y < GRID_H; y++)
      for (let x = 0; x < GRID_W; x++) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.9), tileMat);
        t.position.copy(cellToWorld(x, y)).setY(0);
        this.scene.add(t);
      }
    // Front marker (an arrow at the head end).
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.5, 3), new THREE.MeshBasicMaterial({ color: 0xf2a93b }));
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, 0.05, -MIDY - 0.85);
    this.scene.add(arrow);

    this.hover = new THREE.Mesh(
      new THREE.BoxGeometry(0.96, 0.06, 0.96),
      new THREE.MeshBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.55 }),
    );
    this.hover.visible = false;
    this.scene.add(this.hover);

    this.selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.62, 24),
      new THREE.MeshBasicMaterial({ color: 0xf2a93b, side: THREE.DoubleSide }),
    );
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.visible = false;
    this.scene.add(this.selRing);

    this.selArrow = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 4), new THREE.MeshBasicMaterial({ color: 0xffb23f }));
    this.selArrow.geometry.rotateX(Math.PI); // point down
    this.selArrow.visible = false;
    this.scene.add(this.selArrow);

    this.scene.add(this.bug);
  }

  /** Place the camera at the current yaw/pitch, pulled back until the whole bench fits. */
  private fitCamera() {
    this.fitDirty = false;
    const dir = dirFor(this.yaw, this.pitch);
    // Low, eye-level angles zoom to the bug itself; higher angles show the whole bench for editing.
    const t = THREE.MathUtils.smoothstep(0.75 - this.pitch, 0, 0.4);
    const [x0, x1, z0, z1] = this.benchBox.map((v, i) => THREE.MathUtils.lerp(v, this.bugBox[i], t));
    const target = new THREE.Vector3((x0 + x1) / 2, 0.4, (z0 + z1) / 2).lerp(TARGET, 1 - t);
    const corners = [x0, x1].flatMap((x) => [z0, z1].flatMap((z) => [0, 1.4].map((y) => new THREE.Vector3(x, y, z))));
    for (let d = 3; d < 60; d += 0.25) {
      this.camera.position.copy(target).addScaledVector(dir, d);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld();
      const fits = corners.every((c) => {
        const p = c.clone().project(this.camera);
        return Math.abs(p.x) < 0.94 && Math.abs(p.y) < 0.94;
      });
      if (fits) break;
    }
  }

  /** Spin the view by a finger drag (pixels). */
  orbit(dx: number, dy: number) {
    this.goalYaw -= dx * 0.01;
    this.goalPitch = THREE.MathUtils.clamp(this.goalPitch + dy * 0.008, MIN_PITCH, MAX_PITCH);
  }

  /** Ease to a named view. */
  setView(name: ViewName) {
    const v = VIEWS[name];
    // Take the short way round.
    const turns = Math.round((this.goalYaw - v.yaw) / (Math.PI * 2));
    this.goalYaw = v.yaw + turns * Math.PI * 2;
    this.goalPitch = v.pitch;
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitCamera();
  }

  setPlacements(placements: Placement[]) {
    const wanted = new Map(placements.map((p) => [slotKey(p), p]));
    // Drop models that changed or vanished; stacked models are always re-seated below.
    for (const [k, m] of this.models) {
      const p = wanted.get(k);
      if (!p || m.root.userData.partId !== p.partId || p.z) {
        this.bug.remove(m.root);
        this.models.delete(k);
      }
    }
    // Rebuild the frame struts between neighbouring grid parts.
    const ground = placements.filter((p) => !p.z);
    this.lifted = new Set(placements.filter((p) => p.z === -1).map((p) => slotKey({ x: p.x, y: p.y })));
    const lift = (p: Placement) => (this.lifted.has(slotKey({ x: p.x, y: p.y })) ? UNDER_LIFT : 0);
    for (const l of this.links) this.bug.remove(l.obj);
    this.links = adjacentPairs(ground).map(([i, j]) => {
      const a = ground[i];
      const b = ground[j];
      const c = buildConnector(getPart(a.partId).category, getPart(b.partId).category);
      c.update(cellToWorld(a.x, a.y).setY(lift(a)), cellToWorld(b.x, b.y).setY(lift(b)));
      this.bug.add(c.obj);
      return { a: slotKey(a), b: slotKey(b), obj: c.obj };
    });
    if (placements.length) {
      const xs = placements.map((p) => p.x - MIDX);
      const zs = placements.map((p) => p.y - MIDY);
      this.bugBox = [Math.min(...xs) - 0.9, Math.max(...xs) + 0.9, Math.min(...zs) - 0.9, Math.max(...zs) + 0.9];
    } else {
      this.bugBox = this.benchBox.slice();
    }
    this.fitDirty = true;
    this.seen = new Set(placements.map((p) => `${slotKey(p)}:${p.partId}`));
    // Grid parts first (so we know how tall each one is), then stacked parts on top.
    this.baseTop.clear();
    for (const p of [...ground, ...placements.filter((q) => q.z)]) {
      const k = slotKey(p);
      let model = this.models.get(k);
      if (!model) {
        model = buildPart(p.partId, p.z ? 0 : Math.sign(p.x - MIDX), p.y);
        model.root.userData.partId = p.partId;
        model.root.userData.cellKey = k;
        // Fresh parts pop in (stacked parts are rebuilt every time, so only when new to this slot).
        if (this.loaded && !this.seen.has(`${k}:${p.partId}`)) model.root.userData.born = this.clock;
        this.bug.add(model.root);
        this.models.set(k, model);
      }
      this.seat(p.x, p.y, (p.z ?? 0) as Layer, model);
      model.root.rotation.y = -(p.r ?? 0) * (Math.PI / 2); // weapon facing
    }
    this.loaded = true;
    if (this.ghost) this.placeGhostModel();
  }

  /** Part+slot keys currently on the bug (to tell which models are new). */
  private seen = new Set<string>();

  /** Put a model in its cell and layer: on the grid (raised if something's slung under it), on top, or underneath. */
  private seat(x: number, y: number, z: Layer, model: PartModel) {
    const ck = slotKey({ x, y });
    const lift = this.lifted.has(ck) ? UNDER_LIFT : 0;
    model.root.position.copy(cellToWorld(x, y));
    model.root.scale.setScalar(z === -1 ? UNDER_SCALE : 1);
    if (z === 0) {
      model.root.position.y = lift;
      this.baseTop.set(ck, seatHeight(model) + lift);
    } else if (z === 1) {
      model.root.position.y = stackOffset(model, this.baseTop.get(ck) ?? 0.9);
    } else {
      model.root.position.y = 0.02;
    }
  }

  /** Height of a slot's hint/hover tile. */
  private slotY(x: number, y: number, z: Layer) {
    return z === 1 ? (this.baseTop.get(slotKey({ x, y })) ?? 0.9) + 0.05 : 0.04;
  }

  setStackTest(fn: (cell: Cell) => Layer) {
    this.stackTest = fn;
  }

  /** Light up the spots a part can go (best spot brightest). Pass [] to clear. Stacked slots glow on top of their base. */
  setHints(slots: HintSlot[]) {
    while (this.hints.length < slots.length) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.9), this.hintMats[2]);
      this.scene.add(mesh);
      this.hints.push({ mesh, tier: 2 });
    }
    this.hints.forEach((h, i) => {
      h.mesh.visible = i < slots.length;
      if (i >= slots.length) return;
      const s = slots[i];
      h.tier = s.tier;
      h.mesh.material = this.hintMats[s.tier];
      h.mesh.position.copy(cellToWorld(s.x, s.y)).setY(this.slotY(s.x, s.y, s.z) + (s.tier === 0 ? 0.01 : 0));
      h.mesh.scale.setScalar((s.z === 1 ? 0.7 : s.z === -1 ? 0.5 : 1) * (s.tier === 2 ? 0.8 : 1));
    });
  }

  /**
   * Show a see-through preview of `partId` in `slot` (null slot hides it but keeps
   * the model ready). `ok` false tints it red. Pass a null part to remove it.
   */
  setGhost(partId: string | null, slot: Slot | null = null, ok = true, r = 0) {
    if (!partId) {
      if (this.ghost) this.bug.remove(this.ghost.model.root);
      this.ghost = null;
      if (!this.dragging) this.hover.visible = false;
      return;
    }
    if (!this.ghost || this.ghost.partId !== partId) {
      if (this.ghost) this.bug.remove(this.ghost.model.root);
      const model = buildPart(partId, slot ? Math.sign(slot.x - MIDX) : 0, slot?.y ?? 0);
      setGhost(model.root, 0.55);
      this.bug.add(model.root);
      this.ghost = { partId, model, slot, ok };
    }
    this.ghost.slot = slot;
    this.ghost.ok = ok;
    this.ghost.model.root.rotation.y = -r * (Math.PI / 2);
    this.placeGhostModel();
  }

  private placeGhostModel() {
    const g = this.ghost;
    if (!g) return;
    g.model.root.visible = !!g.slot && g.ok;
    if (!this.dragging) {
      this.hover.visible = !!g.slot && !g.ok;
      if (g.slot && !g.ok) {
        (this.hover.material as THREE.MeshBasicMaterial).color.set(0xff5d5d);
        this.hover.scale.setScalar(1);
        this.hover.position.copy(cellToWorld(g.slot.x, g.slot.y)).setY(0.05);
      }
    }
    if (!g.slot) return;
    const { x, y, z } = g.slot;
    g.model.root.position.copy(cellToWorld(x, y));
    g.model.root.scale.setScalar(z === -1 ? UNDER_SCALE : 1);
    g.model.root.position.y =
      z === 1 ? stackOffset(g.model, this.baseTop.get(slotKey({ x, y })) ?? 0.9) : z === -1 ? 0.02 : this.lifted.has(slotKey({ x, y })) ? UNDER_LIFT : 0;
    g.model.root.userData.baseY = g.model.root.position.y;
  }

  /** A ring bursts out of a slot (just placed something there). */
  burst(slot: Slot, color = 0x3ddc97) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.56, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(cellToWorld(slot.x, slot.y)).setY(this.slotY(slot.x, slot.y, slot.z) + 0.03);
    this.scene.add(mesh);
    this.bursts.push({ mesh, t: 0 });
  }

  /** Fade out the part in this slot (it's been lifted to move it). */
  setLifted(slot: Slot | null) {
    this.lifted_ = slot ? slotKey(slot) : null;
  }
  private lifted_: string | null = null;

  setSelected(slot: Slot | null) {
    this.selected = slot ? slotKey(slot) : null;
  }

  /** Grid cell under a point given in view-relative 0..1 coordinates (null if off the grid). */
  pick(nx: number, ny: number): { cell: Slot | null; point: THREE.Vector3 | null } {
    this.raycaster.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), this.camera);
    // Parts stand up off the grid, so test the models first: a touch on a part's
    // visible body picks that part, not the floor tile behind it.
    for (const hit of this.raycaster.intersectObjects(this.bug.children, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.cellKey === undefined) o = o.parent;
      if (o) return { cell: parseKey(o.userData.cellKey as string), point: hit.point };
    }
    const f = this.floorAt(nx, ny);
    return { cell: f.cell ? { ...f.cell, z: 0 } : null, point: f.point };
  }

  /** Grid cell on the floor under a screen point (ignores parts). */
  private floorAt(nx: number, ny: number): { cell: Cell | null; point: THREE.Vector3 | null } {
    this.raycaster.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), this.camera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.floor, point)) return { cell: null, point: null };
    const x = Math.round(point.x + MIDX);
    const y = Math.round(point.z + MIDY);
    const inside = x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
    return { cell: inside ? { x, y } : null, point };
  }

  startDrag(slot: Slot) {
    const k = slotKey(slot);
    if (!this.models.has(k)) return false;
    this.dragging = { key: k, point: cellToWorld(slot.x, slot.y) };
    return true;
  }

  dragTo(nx: number, ny: number): DragState {
    if (!this.dragging) return { cell: null, inside: false };
    const { cell, point } = this.floorAt(nx, ny);
    if (point) this.dragging.point.copy(point);
    return { cell, inside: !!cell };
  }

  endDrag() {
    if (!this.dragging) return;
    const m = this.models.get(this.dragging.key);
    if (m) {
      const { x, y, z } = parseKey(this.dragging.key);
      this.seat(x, y, z, m);
    }
    this.dragging = null;
    this.hover.visible = false;
  }

  render(dt: number) {
    this.clock += dt;
    if (Math.abs(this.goalYaw - this.yaw) > 1e-4 || Math.abs(this.goalPitch - this.pitch) > 1e-4) {
      const k = 1 - Math.exp(-dt * 12);
      this.yaw += (this.goalYaw - this.yaw) * k;
      this.pitch += (this.goalPitch - this.pitch) * k;
      this.fitDirty = true;
    }
    if (this.fitDirty && !this.dragging) this.fitCamera();
    const t = this.clock;
    for (const [k, m] of this.models) {
      m.animate({ t, ...IDLE });
      // The selected part glows and bobs; everything else dims a little so it stands out.
      const sel = k === this.selected;
      // Amber outline on the selected part (re-applied if its model was rebuilt).
      if (m.root.userData.hl !== sel) {
        setHighlight(m.root, sel);
        m.root.userData.hl = sel;
      }
      m.tint(this.selected && !sel ? 0.65 : 1, false, sel ? 0.2 + Math.sin(t * 6) * 0.1 : 0);
      m.root.visible = k !== this.lifted_;
      // Pop in: overshoot, then settle.
      const born = m.root.userData.born as number | undefined;
      if (born !== undefined && this.dragging?.key !== k) {
        const a = (t - born) / 0.35;
        const base = k.endsWith(',under') ? UNDER_SCALE : 1;
        if (a >= 1) {
          m.root.scale.setScalar(base);
          delete m.root.userData.born;
        } else {
          m.root.scale.setScalar(base * (a < 0.6 ? 0.4 + (a / 0.6) * 0.8 : 1.2 - ((a - 0.6) / 0.4) * 0.2));
        }
      }
    }

    this.hintMats[0].opacity = 0.45 + Math.sin(t * 5) * 0.2;
    this.hintMats[1].opacity = 0.3 + Math.sin(t * 4) * 0.08;
    for (const h of this.hints) if (h.tier === 0 && h.mesh.visible) h.mesh.scale.x = h.mesh.scale.z = (h.mesh.scale.y = 1) * (1 + Math.sin(t * 5) * 0.04);
    if (this.ghost?.slot) {
      const r = this.ghost.model.root;
      r.position.y = (r.userData.baseY as number) + 0.14 + Math.sin(t * 6) * 0.06;
      this.ghost.model.animate({ t, ...IDLE });
      this.ghost.model.tint(1, false, 0.35);
    }
    for (const b of this.bursts) {
      b.t += dt;
      const k = b.t / 0.45;
      b.mesh.scale.setScalar(1 + k * 1.4);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
      }
    }
    this.bursts = this.bursts.filter((b) => b.t < 0.45);
    const held = this.dragging?.key;
    for (const l of this.links) l.obj.visible = l.a !== held && l.b !== held;
    if (this.dragging) {
      const m = this.models.get(this.dragging.key);
      const p = this.dragging.point;
      if (m) {
        m.root.position.set(p.x, 0.55 + Math.sin(t * 8) * 0.05, p.z);
        m.root.scale.setScalar(1.12);
      }
      const x = Math.round(p.x + MIDX);
      const y = Math.round(p.z + MIDY);
      const inside = x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
      const layer: Layer = inside ? this.stackTest({ x, y }) : 0;
      this.hover.visible = true;
      this.hover.scale.setScalar(layer === 1 ? 0.7 : layer === -1 ? 0.5 : 1);
      (this.hover.material as THREE.MeshBasicMaterial).color.set(
        !inside ? 0xff5d5d : layer === 1 ? 0x7fd8ff : layer === -1 ? 0xffb347 : 0x3ddc97,
      );
      if (inside) this.hover.position.copy(cellToWorld(x, y)).setY(this.slotY(x, y, layer));
      else this.hover.position.set(p.x, 0.04, p.z);
    }

    if (this.selected && !this.dragging) {
      const { x, y, z } = parseKey(this.selected);
      const m = this.models.get(this.selected);
      if (m) {
        m.root.updateMatrixWorld(true);
        const top = new THREE.Box3().setFromObject(m.root).max.y;
        this.selArrow.position.copy(cellToWorld(x, y)).setY(top + 0.55 + Math.sin(t * 5) * 0.12);
        this.selArrow.rotation.y = t * 2;
      }
      this.selArrow.visible = !!m;
      this.selRing.visible = this.models.has(this.selected);
      this.selRing.position.copy(cellToWorld(x, y)).setY(this.slotY(x, y, z) + 0.01);
      this.selRing.scale.setScalar(z === -1 ? 0.6 : 1);
    } else {
      this.selRing.visible = false;
      this.selArrow.visible = false;
    }

    this.renderer.render(this.scene, this.camera);
    this.gl.endFrameEXP();
  }

  dispose() {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.renderer.dispose();
  }
}
