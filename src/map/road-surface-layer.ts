import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { MercatorCoordinate } from "maplibre-gl";
import * as THREE from "three";
import type { GameRoadRecord } from "./game-roads";
import {
  buildCollisionStrip,
  collisionWorldFromBodies,
  simplifyCollisionPoints,
  type RoadCollisionBody,
  type RoadCollisionWorld,
} from "./road-collision";
import { prepareIntersectionPolygon } from "./road-intersections";
import {
  buildLaneNetwork,
  type DrivingSide,
  type RoadLaneNetwork,
  type SegmentLaneLayout,
} from "./road-lanes";
import { buildRoadProfilePart } from "./road-profile";
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
  roadPositions: number[];
  roadIndices: number[];
  lanePositions: number[];
  laneIndices: number[];
  collisionPositions: number[];
  collisionIndices: number[];
}

interface ActiveSurface {
  group: THREE.Group;
  fingerprint: string;
  collision: RoadCollisionBody;
}

export interface RoadSurfaceStats {
  activeSegments: number;
  graphNodes: number;
  directedArcs: number;
  activeLanes: number;
  candidateLaneConnections: number;
  laneConnections: number;
  filteredByTurnLanes: number;
  filteredByRestrictions: number;
  unenforcedRestrictions: number;
  intersectionPolygons: number;
  collisionBodies: number;
  collisionTriangles: number;
  created: number;
  replaced: number;
  removed: number;
}

const LANE_GUIDE_HALF_WIDTH_METERS = 0.055;
export const ROAD_VISUAL_LIFT_METERS = 0.2;

function pushStrip(
  positions: number[],
  indices: number[],
  points: LocalPoint[],
  centerOffsetM: number,
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
    const centerX = point.x + normalX * centerOffsetM;
    const centerY = point.y + normalY * centerOffsetM;
    positions.push(
      centerX + normalX * halfWidth,
      centerY + normalY * halfWidth,
      point.z + ROAD_VISUAL_LIFT_METERS,
      centerX - normalX * halfWidth,
      centerY - normalY * halfWidth,
      point.z + ROAD_VISUAL_LIFT_METERS,
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

function appendCollisionStrip(
  positions: number[],
  indices: number[],
  points: LocalPoint[],
  halfWidth: number,
): void {
  const strip = buildCollisionStrip(simplifyCollisionPoints(points), halfWidth);
  const base = positions.length / 3;
  positions.push(...strip.positions);
  indices.push(...strip.indices.map((index) => index + base));
}

function localProfilePoints(
  segment: RoadWorldSegment,
  world: RoadWorld,
  map: MapLibreMap,
  terrainEnabled: boolean,
  part: [number, number][],
  origin: MercatorCoordinate,
  meterScale: number,
): { points: LocalPoint[]; elevations: number[] } {
  const profile = buildRoadProfilePart(map, world, segment, part, terrainEnabled);
  const elevations: number[] = [];
  const points = profile.samples.map((sample) => {
    const mercator = MercatorCoordinate.fromLngLat(sample.point, 0);
    elevations.push(sample.elevationM);
    return {
      x: (mercator.x - origin.x) / meterScale,
      y: (mercator.y - origin.y) / meterScale,
      z: sample.elevationM,
    };
  });
  return { points, elevations };
}

function prepareSegment(
  segment: RoadWorldSegment,
  world: RoadWorld,
  map: MapLibreMap,
  terrainEnabled: boolean,
  laneLayout: SegmentLaneLayout,
  drivingSide: DrivingSide,
): PreparedSegment | null {
  if (segment.parts.length === 0) return null;
  const origin = MercatorCoordinate.fromLngLat(segment.center, 0);
  const meterScale = origin.meterInMercatorCoordinateUnits();
  const roadPositions: number[] = [];
  const roadIndices: number[] = [];
  const lanePositions: number[] = [];
  const laneIndices: number[] = [];
  const collisionPositions: number[] = [];
  const collisionIndices: number[] = [];
  const elevationSignature: string[] = [];
  const uniqueOffsets = [...new Set(laneLayout.lanes.map((lane) => lane.lateralOffsetM.toFixed(3)))].map(Number);
  const halfWidth = Math.max(1.4, segment.record.widthM / 2);

  for (const part of segment.parts) {
    const local = localProfilePoints(
      segment,
      world,
      map,
      terrainEnabled,
      part,
      origin,
      meterScale,
    );
    if (local.points.length < 2) continue;
    elevationSignature.push(...local.elevations.map((value) => value.toFixed(1)));
    pushStrip(roadPositions, roadIndices, local.points, 0, halfWidth);
    appendCollisionStrip(collisionPositions, collisionIndices, local.points, halfWidth);
    for (const offset of uniqueOffsets) {
      pushStrip(
        lanePositions,
        laneIndices,
        local.points,
        offset,
        LANE_GUIDE_HALF_WIDTH_METERS,
      );
    }
  }

  if (roadPositions.length === 0 || collisionPositions.length === 0) return null;
  const fingerprint = [
    segment.record.segmentId,
    segment.record.widthM.toFixed(1),
    segment.record.bridge ? "b" : segment.record.tunnel ? "t" : "g",
    segment.record.layer,
    terrainEnabled ? "terrain" : "flat",
    drivingSide,
    laneLayout.forwardLaneCount,
    laneLayout.backwardLaneCount,
    uniqueOffsets.join(","),
    elevationSignature.join(","),
  ].join("|");
  return {
    fingerprint,
    origin,
    meterScale,
    roadPositions,
    roadIndices,
    lanePositions,
    laneIndices,
    collisionPositions,
    collisionIndices,
  };
}

function geometryFromBuffers(positions: number[], indices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
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
  private intersectionGroup = new THREE.Group();
  private intersectionCollisions: RoadCollisionBody[] = [];
  private laneNetwork?: RoadLaneNetwork;
  private intersectionCount = 0;
  private collisionWorld: RoadCollisionWorld = collisionWorldFromBodies([]);

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

  private readonly laneGuideMaterial = new THREE.MeshBasicMaterial({
    color: 0xe7e2d6,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  constructor() {
    this.scene.add(this.intersectionGroup);
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderer || (this.active.size === 0 && this.intersectionGroup.children.length === 0)) return;
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(
      Array.from(options.defaultProjectionData.mainMatrix),
    );
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  onRemove(): void {
    this.clear();
    this.renderer?.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    this.laneGuideMaterial.dispose();
    this.renderer = undefined;
    this.map = undefined;
  }

  setWorld(
    world: RoadWorld,
    map: MapLibreMap,
    terrainEnabled: boolean,
    drivingSide: DrivingSide,
  ): RoadSurfaceStats {
    this.laneNetwork = buildLaneNetwork(world, drivingSide);
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
      const laneLayout = this.laneNetwork.layouts.get(segment.record.segmentId);
      if (!laneLayout) continue;
      const prepared = prepareSegment(
        segment,
        world,
        map,
        terrainEnabled,
        laneLayout,
        drivingSide,
      );
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
      group.userData.drivingSide = drivingSide;
      group.userData.laneIds = laneLayout.lanes.map((lane) => lane.laneId);
      group.add(
        new THREE.Mesh(
          geometryFromBuffers(prepared.roadPositions, prepared.roadIndices),
          materialFor(segment.record, this.materials),
        ),
      );
      if (prepared.lanePositions.length > 0) {
        const laneMesh = new THREE.Mesh(
          geometryFromBuffers(prepared.lanePositions, prepared.laneIndices),
          this.laneGuideMaterial,
        );
        laneMesh.name = `${segment.key}:lane-guides`;
        group.add(laneMesh);
      }
      group.position.set(prepared.origin.x, prepared.origin.y, prepared.origin.z);
      group.scale.set(prepared.meterScale, prepared.meterScale, prepared.meterScale);

      const collision: RoadCollisionBody = {
        bodyId: `${segment.key}:collision`,
        kind: "road-segment",
        origin: prepared.origin,
        meterScale: prepared.meterScale,
        positions: prepared.collisionPositions,
        indices: prepared.collisionIndices,
        segmentId: segment.record.segmentId,
        surfaceClass: segment.record.surfaceClass,
        bridge: segment.record.bridge,
        tunnel: segment.record.tunnel,
        layer: segment.record.layer,
      };

      if (current) {
        disposeGroup(current.group);
        replaced += 1;
      } else {
        created += 1;
      }
      this.scene.add(group);
      this.active.set(segment.key, { group, fingerprint: prepared.fingerprint, collision });
    }

    this.rebuildIntersections(world, map, terrainEnabled);
    this.rebuildCollisionWorld();
    if (created > 0 || replaced > 0 || removed > 0) this.map?.triggerRepaint();
    return {
      activeSegments: this.active.size,
      graphNodes: world.nodes.size,
      directedArcs: world.arcs.length,
      activeLanes: this.laneNetwork.lanes.size,
      candidateLaneConnections: this.laneNetwork.candidateConnectionCount,
      laneConnections: this.laneNetwork.connections.length,
      filteredByTurnLanes: this.laneNetwork.filteredByTurnLanes,
      filteredByRestrictions: this.laneNetwork.filteredByRestrictions,
      unenforcedRestrictions: this.laneNetwork.unenforcedRestrictionCount,
      intersectionPolygons: this.intersectionCount,
      collisionBodies: this.collisionWorld.bodies.length,
      collisionTriangles: this.collisionWorld.triangleCount,
      created,
      replaced,
      removed,
    };
  }

  clear(): void {
    for (const active of this.active.values()) disposeGroup(active.group);
    this.active.clear();
    disposeGroup(this.intersectionGroup);
    this.intersectionGroup = new THREE.Group();
    this.scene.add(this.intersectionGroup);
    this.intersectionCollisions = [];
    this.laneNetwork = undefined;
    this.intersectionCount = 0;
    this.collisionWorld = collisionWorldFromBodies([]);
    this.map?.triggerRepaint();
  }

  get activeCount(): number {
    return this.active.size;
  }

  get activeLaneCount(): number {
    return this.laneNetwork?.lanes.size ?? 0;
  }

  get laneConnectionCount(): number {
    return this.laneNetwork?.connections.length ?? 0;
  }

  get activeIntersectionCount(): number {
    return this.intersectionCount;
  }

  getCollisionWorld(): RoadCollisionWorld {
    return this.collisionWorld;
  }

  private rebuildCollisionWorld(): void {
    this.collisionWorld = collisionWorldFromBodies([
      ...[...this.active.values()].map((active) => active.collision),
      ...this.intersectionCollisions,
    ]);
  }

  private rebuildIntersections(world: RoadWorld, map: MapLibreMap, terrainEnabled: boolean): void {
    disposeGroup(this.intersectionGroup);
    this.intersectionGroup = new THREE.Group();
    this.scene.add(this.intersectionGroup);
    this.intersectionCollisions = [];
    this.intersectionCount = 0;

    for (const node of world.nodes.values()) {
      const prepared = prepareIntersectionPolygon(node, world, map, terrainEnabled);
      if (!prepared) continue;
      const geometry = geometryFromBuffers(prepared.positions, prepared.indices);
      const mesh = new THREE.Mesh(
        geometry,
        materialFor(prepared.dominantSegment.record, this.materials),
      );
      const group = new THREE.Group();
      group.name = `road-intersection:${prepared.nodeId}`;
      group.userData.nodeId = prepared.nodeId;
      group.userData.incidentSegments = node.incidentSegmentIds;
      group.position.set(
        prepared.origin.x,
        prepared.origin.y,
        prepared.origin.z + ROAD_VISUAL_LIFT_METERS * prepared.meterScale,
      );
      group.scale.set(prepared.meterScale, prepared.meterScale, prepared.meterScale);
      group.add(mesh);
      this.intersectionGroup.add(group);
      this.intersectionCollisions.push({
        bodyId: `road-intersection:${prepared.nodeId}:collision`,
        kind: "intersection",
        origin: prepared.origin,
        meterScale: prepared.meterScale,
        positions: [...prepared.positions],
        indices: [...prepared.indices],
        nodeId: prepared.nodeId,
        surfaceClass: prepared.dominantSegment.record.surfaceClass,
        bridge: prepared.dominantSegment.record.bridge,
        tunnel: prepared.dominantSegment.record.tunnel,
        layer: prepared.dominantSegment.record.layer,
      });
      this.intersectionCount += 1;
    }
  }
}
