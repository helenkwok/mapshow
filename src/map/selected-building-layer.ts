import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { MercatorCoordinate } from "maplibre-gl";
import * as THREE from "three";
import type { BuildingProfile } from "./building-profile";

export type LngLatTuple = [number, number];

export interface BuildingSelection {
  ring: LngLatTuple[];
  profile: BuildingProfile;
}

interface Point2 {
  x: number;
  y: number;
}

interface Point3 extends Point2 {
  z: number;
}

interface EdgeBasis {
  start: Point2;
  unit: Point2;
  outward: Point2;
  length: number;
}

const WINDOW_OFFSET = 0.08;
const FRAME_OFFSET = 0.1;
const DOOR_OFFSET = 0.11;
const GROUND_DETAIL_HEIGHT = 3.6;
const MAX_FACADE_FLOORS = 12;
const MAX_BAYS_PER_EDGE = 12;
const ROOF_BASE_OFFSET = 0.76;

function samePoint(a: LngLatTuple, b: LngLatTuple): boolean {
  return Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
}

function openRing(ring: LngLatTuple[]): LngLatTuple[] {
  return ring.length > 2 && samePoint(ring[0], ring[ring.length - 1])
    ? ring.slice(0, -1)
    : [...ring];
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
  const sum = points.reduce(
    (result, point) => ({ x: result.x + point.x, y: result.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
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
    const currentSign = Math.sign(cross);
    if (sign === 0) sign = currentSign;
    else if (sign !== currentSign) return false;
  }
  return true;
}

function edgeBasis(points: Point2[], edgeIndex: number, area: number): EdgeBasis | null {
  const start = points[edgeIndex];
  const end = points[(edgeIndex + 1) % points.length];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  const unit = { x: dx / length, y: dy / length };
  const outward =
    area >= 0
      ? { x: unit.y, y: -unit.x }
      : { x: -unit.y, y: unit.x };
  return { start, unit, outward, length };
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
  edge: EdgeBasis,
  alongStart: number,
  alongEnd: number,
  zStart: number,
  zEnd: number,
  offset: number,
): void {
  const start = {
    x: edge.start.x + edge.unit.x * alongStart + edge.outward.x * offset,
    y: edge.start.y + edge.unit.y * alongStart + edge.outward.y * offset,
  };
  const end = {
    x: edge.start.x + edge.unit.x * alongEnd + edge.outward.x * offset,
    y: edge.start.y + edge.unit.y * alongEnd + edge.outward.y * offset,
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
  edge: EdgeBasis,
  left: number,
  right: number,
  bottom: number,
  top: number,
): void {
  const frameWidth = Math.min(0.12, (right - left) * 0.12);
  const frameHeight = Math.min(0.12, (top - bottom) * 0.12);
  addRectOnEdge(positions, indices, edge, left - frameWidth, left, bottom - frameHeight, top + frameHeight, FRAME_OFFSET);
  addRectOnEdge(positions, indices, edge, right, right + frameWidth, bottom - frameHeight, top + frameHeight, FRAME_OFFSET);
  addRectOnEdge(positions, indices, edge, left, right, bottom - frameHeight, bottom, FRAME_OFFSET);
  addRectOnEdge(positions, indices, edge, left, right, top, top + frameHeight, FRAME_OFFSET);
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
  group.clear();
}

export class SelectedBuildingLayer implements CustomLayerInterface {
  readonly id = "mapshow-selected-building-lod3";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map?: MapLibreMap;
  private renderer?: THREE.WebGLRenderer;
  private readonly camera = new THREE.Camera();
  private readonly scene = new THREE.Scene();
  private readonly detailGroup = new THREE.Group();
  private origin?: MercatorCoordinate;
  private meterScale = 1;

  private readonly paneMaterial = new THREE.MeshBasicMaterial({
    color: 0x29485e,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  private readonly frameMaterial = new THREE.MeshBasicMaterial({
    color: 0xd5d0c7,
    side: THREE.DoubleSide,
  });
  private readonly doorMaterial = new THREE.MeshBasicMaterial({
    color: 0x25323a,
    side: THREE.DoubleSide,
  });
  private readonly roofMaterial = new THREE.MeshBasicMaterial({
    color: 0x5f625f,
    side: THREE.DoubleSide,
  });

  constructor() {
    this.scene.add(this.detailGroup);
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderer || !this.origin || this.detailGroup.children.length === 0) return;

    const worldToClip = new THREE.Matrix4().fromArray(
      Array.from(options.modelViewProjectionMatrix),
    );
    const localMetersToWorld = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.meterScale, this.meterScale, this.meterScale));

    this.camera.projectionMatrix = worldToClip.multiply(localMetersToWorld);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  onRemove(): void {
    disposeGroup(this.detailGroup);
    this.renderer?.dispose();
    this.paneMaterial.dispose();
    this.frameMaterial.dispose();
    this.doorMaterial.dispose();
    this.roofMaterial.dispose();
    this.renderer = undefined;
    this.map = undefined;
  }

  clearSelection(): void {
    disposeGroup(this.detailGroup);
    this.origin = undefined;
    this.map?.triggerRepaint();
  }

  setSelection(selection: BuildingSelection): void {
    const ring = openRing(selection.ring);
    if (ring.length < 3) {
      this.clearSelection();
      return;
    }

    const lng = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
    const lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
    const origin = MercatorCoordinate.fromLngLat([lng, lat], 0);
    const meterScale = origin.meterInMercatorCoordinateUnits();
    const localRing = ring.map(([pointLng, pointLat]) => {
      const mercator = MercatorCoordinate.fromLngLat([pointLng, pointLat], 0);
      return {
        x: (mercator.x - origin.x) / meterScale,
        y: (mercator.y - origin.y) / meterScale,
      };
    });

    disposeGroup(this.detailGroup);
    this.origin = origin;
    this.meterScale = meterScale;
    this.buildFacadeDetails(localRing, selection.profile);
    this.buildRoof(localRing, selection.profile);
    this.map?.triggerRepaint();
  }

  private buildFacadeDetails(points: Point2[], profile: BuildingProfile): void {
    const panePositions: number[] = [];
    const paneIndices: number[] = [];
    const framePositions: number[] = [];
    const frameIndices: number[] = [];
    const doorPositions: number[] = [];
    const doorIndices: number[] = [];
    const area = signedArea(points);

    let entranceEdge: EdgeBasis | null = null;

    for (let edgeIndex = 0; edgeIndex < points.length; edgeIndex += 1) {
      const edge = edgeBasis(points, edgeIndex, area);
      if (!edge || edge.length < 1.8) continue;
      if (!entranceEdge || edge.length > entranceEdge.length) entranceEdge = edge;

      const bayCount = Math.max(1, Math.min(MAX_BAYS_PER_EDGE, Math.floor(edge.length / 3)));
      const bayWidth = edge.length / bayCount;
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
          const centerAlong = (bay + 0.5) * bayWidth;
          const left = centerAlong - windowWidth / 2;
          const right = centerAlong + windowWidth / 2;
          addRectOnEdge(panePositions, paneIndices, edge, left, right, bottom, top, WINDOW_OFFSET);
          addWindowFrame(framePositions, frameIndices, edge, left, right, bottom, top);
        }
      }
    }

    if (entranceEdge) {
      const width = Math.min(2.2, Math.max(1.2, entranceEdge.length * 0.18));
      const centerAlong = entranceEdge.length / 2;
      const bottom = profile.minHeight;
      const top = Math.min(profile.height - 0.3, bottom + 2.8);
      addRectOnEdge(
        doorPositions,
        doorIndices,
        entranceEdge,
        centerAlong - width / 2,
        centerAlong + width / 2,
        bottom,
        top,
        DOOR_OFFSET,
      );
    }

    if (panePositions.length > 0) {
      this.detailGroup.add(new THREE.Mesh(geometryFromBuffers(panePositions, paneIndices), this.paneMaterial));
    }
    if (framePositions.length > 0) {
      this.detailGroup.add(new THREE.Mesh(geometryFromBuffers(framePositions, frameIndices), this.frameMaterial));
    }
    if (doorPositions.length > 0) {
      this.detailGroup.add(new THREE.Mesh(geometryFromBuffers(doorPositions, doorIndices), this.doorMaterial));
    }
  }

  private buildRoof(points: Point2[], profile: BuildingProfile): void {
    const roofBase = profile.height + ROOF_BASE_OFFSET;
    const canUseHipRoof =
      profile.height < 24 && points.length >= 3 && points.length <= 10 && isConvex(points);

    if (canUseHipRoof) {
      const center = centroid(points);
      const maxRadius = Math.max(
        ...points.map((point) => Math.hypot(point.x - center.x, point.y - center.y)),
      );
      const rise = Math.min(4, Math.max(1.2, maxRadius * 0.22));
      const positions: number[] = [];
      const indices: number[] = [];
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        pushTriangle(
          positions,
          indices,
          { ...a, z: roofBase },
          { ...b, z: roofBase },
          { ...center, z: roofBase + rise },
        );
      }
      this.detailGroup.add(new THREE.Mesh(geometryFromBuffers(positions, indices), this.roofMaterial));
      return;
    }

    const shape = new THREE.Shape();
    shape.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i].x, points[i].y);
    shape.closePath();
    const roofGeometry = new THREE.ShapeGeometry(shape);
    roofGeometry.translate(0, 0, roofBase + 0.12);
    this.detailGroup.add(new THREE.Mesh(roofGeometry, this.roofMaterial));

    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      pushQuad(
        positions,
        indices,
        { ...a, z: roofBase },
        { ...b, z: roofBase },
        { ...b, z: roofBase + 0.45 },
        { ...a, z: roofBase + 0.45 },
      );
    }
    this.detailGroup.add(new THREE.Mesh(geometryFromBuffers(positions, indices), this.roofMaterial));
  }
}
