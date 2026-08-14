import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import * as THREE from "three";
import type { FloatingOriginFrame } from "./floating-origin";
import type { RapierPhysicsWorld } from "./rapier-physics";

export class RapierDebugLayer implements CustomLayerInterface {
  readonly id = "mapshow-rapier-debug";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map?: MapLibreMap;
  private renderer?: THREE.WebGLRenderer;
  private readonly camera = new THREE.Camera();
  private readonly scene = new THREE.Scene();
  private line?: THREE.LineSegments;
  private frame?: FloatingOriginFrame;
  private enabled = false;

  constructor(private readonly physics: RapierPhysicsWorld) {}

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.enabled || !this.renderer || !this.line || !this.frame) return;
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(
      Array.from(options.defaultProjectionData.mainMatrix),
    );
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  onRemove(): void {
    this.disposeLine();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.map = undefined;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.disposeLine();
    else this.refresh();
    this.map?.triggerRepaint();
  }

  setFrame(frame: FloatingOriginFrame): void {
    this.frame = frame;
    if (this.enabled) this.refresh();
  }

  refresh(): void {
    if (!this.enabled || !this.frame) return;
    const debug = this.physics.debugRender();
    if (!debug || debug.vertices.length === 0) {
      this.disposeLine();
      return;
    }

    const positions = new Float32Array(debug.vertices.length);
    for (let index = 0; index < debug.vertices.length; index += 3) {
      // Physics uses X east, Y up, Z north. Map-local rendering uses X east, Y south, Z up.
      positions[index] = debug.vertices[index];
      positions[index + 1] = -debug.vertices[index + 2];
      positions[index + 2] = debug.vertices[index + 1];
    }

    const vertexCount = debug.vertices.length / 3;
    const colors = new Float32Array(vertexCount * 3);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const source = vertex * 4;
      const target = vertex * 3;
      colors[target] = debug.colors[source];
      colors[target + 1] = debug.colors[source + 1];
      colors[target + 2] = debug.colors[source + 2];
    }

    this.disposeLine();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    // Debug geometry must stay diagnostic even when it lies exactly on terrain or road colliders.
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    this.line = new THREE.LineSegments(geometry, material);
    this.line.frustumCulled = false;
    this.line.renderOrder = 10_000;
    this.line.position.set(
      this.frame.mercator.x,
      this.frame.mercator.y,
      this.frame.elevationMeters * this.frame.meterScale,
    );
    this.line.scale.set(this.frame.meterScale, this.frame.meterScale, this.frame.meterScale);
    this.scene.add(this.line);
    this.map?.triggerRepaint();
  }

  get visible(): boolean {
    return this.enabled;
  }

  private disposeLine(): void {
    if (!this.line) return;
    this.line.geometry.dispose();
    if (Array.isArray(this.line.material)) {
      for (const material of this.line.material) material.dispose();
    } else {
      this.line.material.dispose();
    }
    this.line.removeFromParent();
    this.line = undefined;
  }
}
