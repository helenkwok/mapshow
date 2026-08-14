import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { MercatorCoordinate } from "maplibre-gl";
import * as THREE from "three";
import type { BuildingCandidate, LngLatTuple } from "./building-feature";
import type { BuildingProfile } from "./building-profile";

interface Point2 {
  x: number;
  y: number;
}

interface Point3 extends Point2 {
  z: number;
}

export interface BuildingDetailStats {
  activeBuildings: number;
  created: number;
  removed: number;
}

const WINDOW_OFFSET = 0.08;
const FRAME_OFFSET = 0.1;
const DOOR_OFFSET = 0.11;
const GROUND_DETAIL_HEIGHT = 3.6;
const MAX_FACADE_FLOORS = 10;
const MAX_BAYS_PER_EDGE = 8;
const MAX_WINDOWS_PER_BUILDING = 96;
const FLAT_ROOF_OFFSET = 0.76;

function samePoint(a: LngLatTuple, b: LngLatTuple): boolean {
  return Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
}

function openRing(ring: LngLatTuple[]): LngLatTuple[] {
  if (ring.length > 2 && samePoint(ring[0], ring[ring.length - 1])) {
    return ring.slice(0, -1);
  }
  return [...ring];
}

function signedArea(points: Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function centroid(points: Point2[]): Point2 {
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

function isConvex(points: Point2[]): boolean {
  if (points.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) continue;
    const current = Math.sign(cross);
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

function pushQuad(
  positions: number[],
  indices: number[],
  a: Point3,
  b: Point3,
  c: Point3,
  d: Point3,
): void {
  const base = positions.length / 3;
  for (const point of [a, b, c, d]) positions.push(point.x, point.y, point.z);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function pushTriangle(
  positions: number[],
  indices: number[],
  a: Point3,
  b: Point3,
  c: Point3,
): void {
  const base = positions.length / 3;
  for (const point of [a, b, c]) positions.push(point.x, point.y, point.z);
  indices.push(base, base + 1, base + 2);
}

function geometryFromBuffers(positions: number[], indices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addRectOnEdge(
  positions: number[],
  indices: number[],
  edgeStart: Point2,
  unit: Point2,
  outward: Point2,
  alongStart: number,
  alongEnd: number,
  zStart: number,
  zEnd: number,
  offset: number,
): void {
  const start = {
    x: edgeStart.x + unit.x * alongStart + outward.x * offset,
    y: edgeStart.y + unit.y * alongStart + outward.y * offset,
  };
  const end = {
    x: edgeStart.x + unit.x * alongEnd + outward.x * offset,
    y: edgeStart.y + unit.y * alongEnd + outward.y * offset,
  };
  pushQuad(
    positions,
    indices,
    { ...start, z: zStart },
    { ...end, z: zStart },
    { ...end, z: zEnd },
    { ...start, z: zEnd },
  );
}

function addWindowFrame(
  positions: number[],
  indices: number[],
  edgeStart: Point2,
  unit: Point2,
  outward: Point2,
  left: number,
  right: number,
  bottom: number,
  top: number,
): void {
  const frameWidth = Math.min(0.12, (right - left) * 0.12);
  const frameHeight = Math.min(0.12, (top - bottom) * 0.12);
  addRectOnEdge(positions, indices, edgeStart, unit, outward, left - frameWidth, left, bottom - frameHeight, top + frameHeight, FRAME_OFFSET);
  addRectOnEdge(positions, indices, edgeStart, unit, outward, right, right + frameWidth, bottom - frameHeight, top + frameHeight, FRAME_OFFSET);
  addRectOnEdge(positions, indices, edgeStart, unit, outward, left, right, bottom - frameHeight, bottom, FRAME_OFFSET);
  addRectOnEdge(positions, indices, edgeStart, unit, outward, left, right, top, top + frameHeight, FRAME_OFFSET);
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
  root.removeFromParent();
}

interface DetailMaterials {
  pane: THREE.Material;
  frame: THREE.Material;
  door: THREE.Material;
  roof: THREE.Material;
}

function localRingForCandidate(candidate: BuildingCandidate): {
  points: Point2[];
  origin: MercatorCoordinate;
  meterScale: number;
} | null {
  const ring = openRing(candidate.ring);
  if (ring.length < 3) return null;
  const [lng, lat] = candidate.center;
  const origin = MercatorCoordinate.fromLngLat(
    [lng, lat],
    candidate.groundElevationMeters,
  );
  const meterScale = origin.meterInMercatorCoordinateUnits();
  const points = ring.map(([pointLng, pointLat]) => {
    const mercator = MercatorCoordinate.fromLngLat([pointLng, pointLat], 0);
    return {
      x: (mercator.x - origin.x) / meterScale,
      y: (mercator.y - origin.y) / meterScale,
    };
  });
  return { points, origin, meterScale };
}

function addFacadeGeometry(
  group: THREE.Group,
  points: Point2[],
  profile: BuildingProfile,
  materials: DetailMaterials,
): void {
  const panePositions: number[] = [];
  const paneIndices: number[] = [];
  const framePositions: number[] = [];
  const frameIndices: number[] = [];
  const doorPositions: number[] = [];
  const doorIndices: number[] = [];
  const area = signedArea(points);
  let longestEdge = -1;
  let longestLength = 0;
  let generatedWindows = 0;

  for (let edgeIndex = 0; edgeIndex < points.length; edgeIndex += 1) {
    if (generatedWindows >= MAX_WINDOWS_PER_BUILDING) break;
    const start = points[edgeIndex];
    const end = points[(edgeIndex + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1.8) continue;
    if (length > longestLength) {
      longestLength = length;
      longestEdge = edgeIndex;
    }

    const unit = { x: dx / length, y: dy / length };
    const outward = area >= 0 ? { x: unit.y, y: -unit.x } : { x: -unit.y, y: unit.x };
    const bayCount = Math.max(1, Math.min(MAX_BAYS_PER_EDGE, Math.floor(length / 3)));
    const bayWidth = length / bayCount;
    const windowWidth = Math.min(1.9, bayWidth * 0.62);
    const floorCount = Math.max(1, Math.min(MAX_FACADE_FLOORS, profile.estimatedLevels - 1));
    const facadeBottom = Math.min(profile.height - 0.8, profile.minHeight + GROUND_DETAIL_HEIGHT);
    const facadeHeight = Math.max(0, profile.height - facadeBottom - 0.7);
    if (facadeHeight <= 0.8) continue;
    const floorSpacing = facadeHeight / floorCount;
    const windowHeight = Math.min(1.7, floorSpacing * 0.58);

    for (let floor = 0; floor < floorCount; floor += 1) {
      const centerZ = facadeBottom + (floor + 0.5) * floorSpacing;
      const bottom = centerZ - windowHeight / 2;
      const top = centerZ + windowHeight / 2;
      for (let bay = 0; bay < bayCount; bay += 1) {
        if (generatedWindows >= MAX_WINDOWS_PER_BUILDING) break;
        const centerAlong = (bay + 0.5) * bayWidth;
        const left = centerAlong - windowWidth / 2;
        const right = centerAlong + windowWidth / 2;
        addRectOnEdge(panePositions, paneIndices, start, unit, outward, left, right, bottom, top, WINDOW_OFFSET);
        addWindowFrame(framePositions, frameIndices, start, unit, outward, left, right, bottom, top);
        generatedWindows += 1;
      }
    }
  }

  if (longestEdge >= 0) {
    const start = points[longestEdge];
    const end = points[(longestEdge + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const unit = { x: dx / length, y: dy / length };
    const outward = area >= 0 ? { x: unit.y, y: -unit.x } : { x: -unit.y, y: unit.x };
    const width = Math.min(2.2, Math.max(1.2, length * 0.18));
    const centerAlong = length / 2;
    const bottom = profile.minHeight;
    const top = Math.min(profile.height - 0.3, bottom + 2.8);
    if (top > bottom) {
      addRectOnEdge(doorPositions, doorIndices, start, unit, outward, centerAlong - width / 2, centerAlong + width / 2, bottom, top, DOOR_OFFSET);
    }
  }

  if (panePositions.length > 0) group.add(new THREE.Mesh(geometryFromBuffers(panePositions, paneIndices), materials.pane));
  if (framePositions.length > 0) group.add(new THREE.Mesh(geometryFromBuffers(framePositions, frameIndices), materials.frame));
  if (doorPositions.length > 0) group.add(new THREE.Mesh(geometryFromBuffers(doorPositions, doorIndices), materials.door));
}

function addRoofGeometry(
  group: THREE.Group,
  points: Point2[],
  profile: BuildingProfile,
  roofMaterial: THREE.Material,
): void {
  const roofBase = profile.height + FLAT_ROOF_OFFSET;
  const canUseHipRoof = profile.height < 24 && points.length >= 3 && points.length <= 10 && isConvex(points);
  const positions: number[] = [];
  const indices: number[] = [];

  if (canUseHipRoof) {
    const center = centroid(points);
    const maxRadius = Math.max(...points.map((point) => Math.hypot(point.x - center.x, point.y - center.y)));
    const rise = Math.min(4.5, Math.max(1.2, maxRadius * 0.35));
    const peak = { ...center, z: roofBase + rise };
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      pushTriangle(positions, indices, { ...a, z: roofBase }, { ...b, z: roofBase }, peak);
    }
  } else {
    const center = centroid(points);
    const top = roofBase + 0.35;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      pushTriangle(positions, indices, { ...a, z: top }, { ...b, z: top }, { ...center, z: top });
      pushQuad(positions, indices, { ...a, z: roofBase }, { ...b, z: roofBase }, { ...b, z: top }, { ...a, z: top });
    }
  }

  if (positions.length > 0) group.add(new THREE.Mesh(geometryFromBuffers(positions, indices), roofMaterial));
}

function buildCandidateGroup(candidate: BuildingCandidate, materials: DetailMaterials): THREE.Group | null {
  const local = localRingForCandidate(candidate);
  if (!local) return null;

  const group = new THREE.Group();
  group.name = candidate.key;
  group.userData.mapshowBuildingKey = candidate.key;
  addFacadeGeometry(group, local.points, candidate.profile, materials);
  addRoofGeometry(group, local.points, candidate.profile, materials.roof);

  group.position.set(local.origin.x, local.origin.y, local.origin.z);
  group.scale.set(local.meterScale, local.meterScale, local.meterScale);
  return group;
}

function updateCandidateElevation(
  group: THREE.Group,
  candidate: BuildingCandidate,
): boolean {
  const terrainOrigin = MercatorCoordinate.fromLngLat(
    candidate.center,
    candidate.groundElevationMeters,
  );
  if (Math.abs(group.position.z - terrainOrigin.z) < 1e-12) return false;
  group.position.z = terrainOrigin.z;
  return true;
}

export class BuildingDetailLayer implements CustomLayerInterface {
  readonly id = "mapshow-building-lod3-stream";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map?: MapLibreMap;
  private renderer?: THREE.WebGLRenderer;
  private readonly camera = new THREE.Camera();
  private readonly scene = new THREE.Scene();
  private readonly active = new Map<string, THREE.Group>();

  private readonly materials: DetailMaterials = {
    pane: new THREE.MeshBasicMaterial({ color: 0x29485e, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    frame: new THREE.MeshBasicMaterial({ color: 0xd5d0c7, side: THREE.DoubleSide }),
    door: new THREE.MeshBasicMaterial({ color: 0x25323a, side: THREE.DoubleSide }),
    roof: new THREE.MeshBasicMaterial({ color: 0x5f625f, side: THREE.DoubleSide }),
  };

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderer || this.active.size === 0) return;
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
    this.renderer = undefined;
    this.map = undefined;
  }

  setBuildings(candidates: BuildingCandidate[]): BuildingDetailStats {
    const desired = new Set(candidates.map((candidate) => candidate.key));
    let removed = 0;
    let created = 0;
    let elevationChanged = false;

    for (const [key, group] of this.active) {
      if (!desired.has(key)) {
        disposeObject(group);
        this.active.delete(key);
        removed += 1;
      }
    }

    for (const candidate of candidates) {
      const existing = this.active.get(candidate.key);
      if (existing) {
        elevationChanged = updateCandidateElevation(existing, candidate) || elevationChanged;
        continue;
      }
      const group = buildCandidateGroup(candidate, this.materials);
      if (!group) continue;
      this.scene.add(group);
      this.active.set(candidate.key, group);
      created += 1;
    }

    if (created > 0 || removed > 0 || elevationChanged) this.map?.triggerRepaint();
    return { activeBuildings: this.active.size, created, removed };
  }

  clear(): void {
    for (const group of this.active.values()) disposeObject(group);
    this.active.clear();
    this.map?.triggerRepaint();
  }

  get activeCount(): number {
    return this.active.size;
  }
}
