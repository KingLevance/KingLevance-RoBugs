/**
 * Hub showcase: the player's bug slowly turning on a lit pedestal.
 */
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

import type { Placement } from '@/game/build';

import { buildBugModel, type BugModel } from './bug-model';
import { createRenderer } from './gl';
import { IDLE, toonMaterial, toonMesh } from './models';

export class ShowcaseRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private turn = new THREE.Group();
  private bug: BugModel | null = null;
  private glow: THREE.Mesh;
  private ring: THREE.Mesh;
  private motes: THREE.Points;
  private t = 0;

  constructor(
    private gl: ExpoWebGLRenderingContext,
    background: THREE.ColorRepresentation,
  ) {
    this.renderer = createRenderer(gl, background);
    this.camera = new THREE.PerspectiveCamera(32, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.1, 100);
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x2a2f38, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(-5, 10, 6);
    this.scene.add(key);
    const back = new THREE.DirectionalLight(0xffc27a, 0.9);
    back.position.set(4, 3, -8);
    this.scene.add(back);

    // Pedestal: a low stepped disc with a glowing amber rim.
    const ped = new THREE.Group();
    const base = toonMesh(new THREE.CylinderGeometry(2.7, 2.95, 0.5, 40), toonMaterial(0x252b34), 0.012);
    base.position.y = -0.3;
    const top = toonMesh(new THREE.CylinderGeometry(2.45, 2.55, 0.14, 40), toonMaterial(0x313844), 0.01);
    top.position.y = -0.02;
    ped.add(base, top);
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.5, 0.05, 6, 64),
      new THREE.MeshBasicMaterial({ color: 0xf2a93b, transparent: true, opacity: 0.85 }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = 0.05;
    ped.add(this.ring);
    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(3.3, 40),
      new THREE.MeshBasicMaterial({ color: 0xf2a93b, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = -0.56;
    ped.add(this.glow);
    this.scene.add(ped);
    this.scene.add(this.turn);

    // Floating dust in the spotlight.
    const n = 60;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1 + Math.random() * 4;
      pos.set([Math.cos(a) * r, Math.random() * 4, Math.sin(a) * r], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.motes = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: 0xffd9a0, size: 0.06, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.scene.add(this.motes);
  }

  setPlacements(placements: Placement[]) {
    if (this.bug) this.turn.remove(this.bug.root);
    this.bug = buildBugModel(placements);
    this.turn.add(this.bug.root);
    this.frame();
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frame();
  }

  /** Scale the bug to sit on the pedestal and back the camera off until the pedestal fits. */
  private frame() {
    const r = Math.max(1.6, this.bug?.radius ?? 2.4);
    this.turn.scale.setScalar(Math.min(1.25, 2.5 / r));
    const half = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hTan = Math.tan(half) * this.camera.aspect;
    // Fit the pedestal (r ≈ 3) across, and the bug's height (≈ 2.4) up.
    const dist = Math.max(4.1 / hTan, 3.2 / Math.tan(half)) + 2;
    this.camera.position.set(0, dist * 0.45, dist);
    this.camera.lookAt(0, -0.5, 0);
  }

  render(dt: number) {
    this.t += dt;
    const t = this.t;
    this.turn.rotation.y = -0.5 + t * 0.35;
    this.bug?.animate({ t, ...IDLE });
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(t * 2) * 0.2;
    this.motes.rotation.y = t * 0.05;
    this.motes.position.y = Math.sin(t * 0.4) * 0.15;
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
