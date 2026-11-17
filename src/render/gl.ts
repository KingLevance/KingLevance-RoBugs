import type { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

/** A three.js renderer drawing into an expo-gl context (native and web). */
export function createRenderer(gl: ExpoWebGLRenderingContext, clearColor: THREE.ColorRepresentation) {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const canvas = {
    width: w,
    height: h,
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    clientHeight: h,
    getContext: () => gl,
  } as unknown as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl as unknown as WebGLRenderingContext, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.setClearColor(clearColor);
  return renderer;
}
