import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { MercatorCoordinate } from "maplibre-gl";
import * as THREE from "three";
import { distanceMeters, type LngLatTuple } from "./building-feature";
import type { GameRoadRecord } from "./game-roads";
import type { RoadWorld, RoadWorldSegment } from "./road-world";

interface LocalPoint {
  x: number;
  y: number;
  z: number;
}

interface PreparedSegment {
  fingerprint: string;
  origin: MercatorCoordinate;
  meterScale: number;
  positions: number[];
  indices: number[];
}

interface ActiveSurface {
  group: THREE.Group;
  fingerprint: string;
}

export interface RoadSurfaceStats {
  activeSegments: number;
  graphNodes: number;
  directedArcs: number;
  created: number;
  replaced: number;
  removed: number;
}

const MAX_SAMPLE_SPACING_METERS = 8;
const ROAD_SURFACE_LIFT_METERS = 0.08;
const BRIDGE_MIN_CLEARANCE_METERS = 4.5;
const TUNNEL_MIN_DEPTH_METERS = 3;
const JUNCTION_SIDES = 12;

function terrainElevation(map: MapLibreMap, point: LngLatTuple, enabled: boolean): number {
  if (!enabled) return 0;
  const elevation = map.queryTerrainElevation(point);
  return typeof elevation === "number" && Number.isFinite(elevation) ? elevation : 0;
}

function roadElevation(
  map: MapLibreMap,
  road: GameRoadRecord,
  point: LngLatTuple,
  terrainEnabled: boolean,
): number {
  const ground = terrainElevation(map, point, terrainEnabled);
  if (road.bridge) {
    return ground + Math.max(BRIDGE_MIN_CLEARANCE_METERS, Math.max(1, road.layer) * 3.5);
  }
  if (road.tunnel) {
    return ground - Math.max(TUNNEL_MIN_DEPTH_METERS, Math.max(1, Math.abs(road.layer)) * 3);
  }
  return ground + ROAD_SURFACE_LIFT_METERS;
}

function densify(line: LngLatTuple[]): LngLatTuple[] {
  if (line.length < 2) return line;
  const result: LngLatTuple[] = [line[0]];
  for (let index = 1; index < line.length; index += 1) {
    const start = line[index - 1];
    const end = line[index];
    const length = distanceMeters(start, end);
    const steps = Math.max(1, Math.ceil(length / MAX_SAMPLE_SPACING_METERS));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      result.push([
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ]);
    }
  }
  return result;
}

function pushStrip(
  positions: number[],
  indices: number[],
  points: LocalPoint[],
  halfWidth: number,
): void {
  if (points.length < 2) return;
  const base = positions.length / 3;

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    let dx = next.x - previous.x;
    let dy = next.y - previous.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      dx = 1;
      dy = 0;
    } else {
      dx /= length;
      dy /= length;
    }
    const normalX = -dy;
    const normalY = dx;
    const point = points[index];
    positions.push(
      point.x + normalX * halfWidth,
      point.y + normalY * halfWidth,
      point.z,
      point.x - normalX * halfWidth,
      point.y - normalY * halfWidth,
      point.z,
    );
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const left0 = base + index * 2;
    const right0 = left0 + 1;
    const left1 = left0 + 2;
    const right1 = left0 + 3;
    indices.push(left0, right0, left1, right0, right1, left1);
  }
}

function prepareSegment(
  segment: RoadWorldSegment,
  map: MapLibreMap,
  terrainEnabled: boolean,
): PreparedSegment | null {
  if (segment.parts.length === 0) return null;
  const origin = MercatorCoordinate.fromLngLat(segment.center, 0);
  const meterScale = origin.meterInMercatorCoordinateUnits();
  const positions: number[] = [];
  const indices: number[] = [];
  const elevationSignature: string[] = [];

  for (const part of segment.parts) {
    const dense = densify(part);
    const local: LocalPoint[] = dense.map((point) => {
      const mercator = MercatorCoordinate.fromLngLat(point, 0);
      const z = roadElevation(map, segment.record, point, terrainEnabled);
      elevationSignature.push(z.toFixed(1));
      return {
        x: (mercator.x - origin.x) / meterScale,
        y: (mercator.y - origin.y) / meterScale,
        z,
      };
    });
    pushStrip(positions, indices, local, Math.max(1.4, segment.record.widthM / 2));
  }

  if (positions.length === 0) return null;
  const fingerprint = [
    segment.record.segmentId,
    segment.record.widthM.toFixed(1),
    segment.record.bridge ? "b" : segment.record.tunnel ? "t" : "g",
    segment.record.layer,
    terrainEnabled ? "terrain" : "flat",
    elevationSignature.join(","),
  ].join("|");
  return { fingerprint, origin, meterScale, positions, indices };
}

function geometryFromPrepared(prepared: PreparedSegment): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(prepared.positions, 3));
  geometry.setIndex(prepared.indices);
  geometry.computeVertexNormals();
  return geometry;
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
  group.removeFromParent();
}

function materialFor(
  road: GameRoadRecord,
  materials: Record<GameRoadRecord["surfaceClass"], THREE.Material>,
): THREE.Material {
  return materials[road.surfaceClass];
}

export class RoadSurfaceLayer implements CustomLayerInterface {
  readonly id = "mapshow-driveable-road-surfaces";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map?: MapLibreMap;
  private renderer?: THREE.WebGLRenderer;
  private readonly camera = new THREE.Camera();
  private readonly scene = new THREE.Scene();
  private readonly active = new Map<string, ActiveSurface>();
  private junctionGroup = new THREE.Group();

  private readonly materials: Record<GameRoadRecord["surfaceClass"], THREE.MeshBasicMaterial> = {
    paved: new THREE.MeshBasicMaterial({
      color: 0x3c4146,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    unpaved: new THREE.MeshBasicMaterial({
      color: 0x766a58,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    unknown: new THREE.MeshBasicMaterial({
      color: 0x54575a,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  };

  constructor() {
    this.scene.add(this.junctionGroup);
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderer || (this.active.size === 0 && this.junctionGroup.children.length === 0)) return;
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(
      Array.from(options.modelViewProjectionMatrix),
    );
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  onRemove(): void {
    this.clear();
    this.renderer?.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    this.renderer = undefined;
    this.map = undefined;
  }

  setWorld(world: RoadWorld, map: MapLibreMap, terrainEnabled: boolean): RoadSurfaceStats {
    const desired = new Set(world.segments.map((segment) => segment.key));
    let created = 0;
    let replaced = 0;
    let removed = 0;

    for (const [key, active] of this.active) {
      if (desired.has(key)) continue;
      disposeGroup(active.group);
      this.active.delete(key);
      removed += 1;
    }

    for (const segment of world.segments) {
      const prepared = prepareSegment(segment, map, terrainEnabled);
      if (!prepared) continue;
      const current = this.active.get(segment.key);
      if (current?.fingerprint === prepared.fingerprint) continue;

      const group = new THREE.Group();
      group.name = segment.key;
      group.userData.segmentId = segment.record.segmentId;
      group.userData.osmId = segment.record.osmId;
      group.userData.firstNode = segment.record.firstNode;
      group.userData.lastNode = segment.record.lastNode;
      group.userData.widthM = segment.record.widthM;
      group.userData.oneway = segment.record.oneway;
      group.add(
        new THREE.Mesh(
          geometryFromPrepared(prepared),
          materialFor(segment.record, this.materials),
        ),
      );
      group.position.set(prepared.origin.x, prepared.origin.y, prepared.origin.z);
      group.scale.set(prepared.meterScale, prepared.meterScale, prepared.meterScale);

      if (current) {
        disposeGroup(current.group);
        replaced += 1;
      } else {
        created += 1;
      }
      this.scene.add(group);
      this.active.set(segment.key, { group, fingerprint: prepared.fingerprint });
    }

    this.rebuildJunctionPads(world, map, terrainEnabled);
    if (created > 0 || replaced > 0 || removed > 0) this.map?.triggerRepaint();
    return {
      activeSegments: this.active.size,
      graphNodes: world.nodes.size,
      directedArcs: world.arcs.length,
      created,
      replaced,
      removed,
    };
  }

  clear(): void {
    for (const active of this.active.values()) disposeGroup(active.group);
    this.active.clear();
    disposeGroup(this.junctionGroup);
    this.junctionGroup = new THREE.Group();
    this.scene.add(this.junctionGroup);
    this.map?.triggerRepaint();
  }

  get activeCount(): number {
    return this.active.size;
  }

  private rebuildJunctionPads(world: RoadWorld, map: MapLibreMap, terrainEnabled: boolean): void {
    disposeGroup(this.junctionGroup);
    this.junctionGroup = new THREE.Group();
    this.scene.add(this.junctionGroup);
    const byId = new Map(world.segments.map((segment) => [segment.record.segmentId, segment]));

    for (const node of world.nodes.values()) {
      if (!node.position || node.incidentSegmentIds.length < 2) continue;
      const incident = node.incidentSegmentIds
        .map((id) => byId.get(id))
        .filter((segment): segment is RoadWorldSegment => segment !== undefined);
      if (incident.length < 2) continue;
      const dominant = [...incident].sort((a, b) => b.record.priority - a.record.priority)[0];
      const radius = Math.max(...incident.map((segment) => segment.record.widthM / 2)) + 0.35;
      const elevation = roadElevation(map, dominant.record, node.position, terrainEnabled);
      const origin = MercatorCoordinate.fromLngLat(node.position, 0);
      const scale = origin.meterInMercatorCoordinateUnits();
      const positions = [0, 0, elevation];
      const indices: number[] = [];

      for (let index = 0; index <= JUNCTION_SIDES; index += 1) {
        const angle = (index / JUNCTION_SIDES) * Math.PI * 2;
        positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, elevation);
        if (index > 0) indices.push(0, index, index + 1);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, materialFor(dominant.record, this.materials));
      const group = new THREE.Group();
      group.name = `road-junction:${node.nodeId}`;
      group.position.set(origin.x, origin.y, origin.z);
      group.scale.set(scale, scale, scale);
      group.add(mesh);
      this.junctionGroup.add(group);
    }
  }
}
