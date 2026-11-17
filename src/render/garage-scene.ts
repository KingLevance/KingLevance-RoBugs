/**
 * 3D garage: shows the bug exactly as it looks in the arena, standing on its
 * build grid, and supports picking/dragging parts by screen position.
 */
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

import { GRID_H, GRID_W, key, type Placement } from '@/game/build';
import { getPart } from '@/game/parts';

import { createRenderer } from './gl';
import { buildPart, toonMaterial, toonMesh, type PartModel } from './models';

const BG = 0x14171c;
const MIDX = (GRID_W - 1) / 2;
const MIDY = (GRID_H - 1) / 2;
const VIEW_DIR = new THREE.Vector3(0, 1, 0.72).normalize();

const cellToWorld = (x: number, y: number) => new THREE.Vector3(x - MIDX, 0, y - MIDY);

export type Cell = { x: number; y: number };
export type DragState = { cell: Cell | null; inside: boolean };

export class GarageRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private bug = new THREE.Group();
  private models = new Map<string, PartModel>();
  private hover: THREE.Mesh;
  private selRing: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private clock = 0;
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

    this.scene.add(this.bug);
  }

  /** Pull the camera back until the whole bench fits the viewport. */
  private fitCamera() {
    const corners = [-1, 1].flatMap((sx) =>
      [-1, 1].flatMap((sz) => [0, 1.4].map((y) => new THREE.Vector3(sx * (MIDX + 0.9), y, sz * (MIDY + 1.1)))),
    );
    const target = new THREE.Vector3(0, 0.3, 0.2);
    for (let d = 4; d < 60; d += 0.25) {
      this.camera.position.copy(target).addScaledVector(VIEW_DIR, d);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld();
      const fits = corners.every((c) => {
        const p = c.clone().project(this.camera);
        return Math.abs(p.x) < 0.94 && Math.abs(p.y) < 0.94;
      });
      if (fits) break;
    }
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitCamera();
  }

  setPlacements(placements: Placement[]) {
    const wanted = new Map(placements.map((p) => [key(p.x, p.y), p]));
    // Drop models that changed or vanished.
    for (const [k, m] of this.models) {
      const p = wanted.get(k);
      if (!p || m.root.userData.partId !== p.partId) {
        this.bug.remove(m.root);
        m.root.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
        this.models.delete(k);
      }
    }
    for (const [k, p] of wanted) {
      if (this.models.has(k)) continue;
      const model = buildPart(getPart(p.partId).category, Math.sign(p.x - MIDX));
      model.root.userData.partId = p.partId;
      model.root.userData.cellKey = k;
      model.root.position.copy(cellToWorld(p.x, p.y));
      this.bug.add(model.root);
      this.models.set(k, model);
    }
  }

  setSelected(cell: Cell | null) {
    this.selected = cell ? key(cell.x, cell.y) : null;
  }

  /** Grid cell under a point given in view-relative 0..1 coordinates (null if off the grid). */
  pick(nx: number, ny: number): { cell: Cell | null; point: THREE.Vector3 | null } {
    this.raycaster.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), this.camera);
    // Parts stand up off the grid, so test the models first: a touch on a part's
    // visible body picks that part, not the floor tile behind it.
    for (const hit of this.raycaster.intersectObjects(this.bug.children, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.cellKey === undefined) o = o.parent;
      if (o) {
        const [x, y] = (o.userData.cellKey as string).split(',').map(Number);
        return { cell: { x, y }, point: hit.point };
      }
    }
    return this.floorAt(nx, ny);
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

  /** Is there a part on this cell? */
  has(cell: Cell) {
    return this.models.has(key(cell.x, cell.y));
  }

  startDrag(cell: Cell) {
    const k = key(cell.x, cell.y);
    if (!this.models.has(k)) return false;
    this.dragging = { key: k, point: cellToWorld(cell.x, cell.y) };
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
      const [x, y] = this.dragging.key.split(',').map(Number);
      m.root.position.copy(cellToWorld(x, y));
      m.root.scale.setScalar(1);
    }
    this.dragging = null;
    this.hover.visible = false;
  }

  render(dt: number) {
    this.clock += dt;
    const t = this.clock;
    for (const [k, m] of this.models) {
      m.animate?.(t);
      const isSel = k === this.selected;
      m.mat.emissive.setScalar(isSel ? 0.12 + Math.sin(t * 6) * 0.08 : 0);
    }

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
      this.hover.visible = true;
      (this.hover.material as THREE.MeshBasicMaterial).color.set(inside ? 0x3ddc97 : 0xff5d5d);
      if (inside) this.hover.position.copy(cellToWorld(x, y)).setY(0.04);
      else this.hover.position.set(p.x, 0.04, p.z);
    }

    if (this.selected && !this.dragging) {
      const [x, y] = this.selected.split(',').map(Number);
      this.selRing.visible = this.models.has(this.selected);
      this.selRing.position.copy(cellToWorld(x, y)).setY(0.05);
    } else {
      this.selRing.visible = false;
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
