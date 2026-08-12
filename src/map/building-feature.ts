import type { MapGeoJSONFeature } from "maplibre-gl";
import { buildingProfileFromProperties, type BuildingProfile } from "./building-profile";

export type LngLatTuple = [number, number];

export interface BuildingCandidate {
  key: string;
  ring: LngLatTuple[];
  profile: BuildingProfile;
  center: LngLatTuple;
  distanceMeters: number;
}

function isLngLatTuple(value: unknown): value is LngLatTuple {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function asRing(value: unknown): LngLatTuple[] | null {
  if (!Array.isArray(value)) return null;
  const ring = value.filter(isLngLatTuple);
  return ring.length >= 4 ? ring : null;
}

function ringArea(ring: LngLatTuple[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area / 2);
}

export function outerRingFromGeometry(geometry: {
  type: string;
  coordinates?: unknown;
}): LngLatTuple[] | null {
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    return asRing(geometry.coordinates[0]);
  }

  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    const rings = geometry.coordinates
      .map((polygon) => (Array.isArray(polygon) ? asRing(polygon[0]) : null))
      .filter((ring): ring is LngLatTuple[] => ring !== null);
    return rings.sort((a, b) => ringArea(b) - ringArea(a))[0] ?? null;
  }

  return null;
}

export function ringCenter(ring: LngLatTuple[]): LngLatTuple {
  const open =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  const total = open.reduce(
    (sum, [lng, lat]) => ({ lng: sum.lng + lng, lat: sum.lat + lat }),
    { lng: 0, lat: 0 },
  );
  return [total.lng / open.length, total.lat / open.length];
}

export function distanceMeters(a: LngLatTuple, b: LngLatTuple): number {
  const radians = Math.PI / 180;
  const lat1 = a[1] * radians;
  const lat2 = b[1] * radians;
  const dLat = (b[1] - a[1]) * radians;
  const dLng = (b[0] - a[0]) * radians;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function ringFingerprint(ring: LngLatTuple[]): string {
  return ring
    .slice(0, -1)
    .map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`)
    .join(";");
}

export function buildingFeatureKey(feature: MapGeoJSONFeature, ring: LngLatTuple[]): string {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const sourceId = feature.source ?? "source";
  const sourceLayer = feature.sourceLayer ?? "building";
  const externalId = properties.osm_id ?? properties.id ?? feature.id;
  if (externalId !== undefined && externalId !== null) {
    return `${sourceId}:${sourceLayer}:${String(externalId)}`;
  }
  return `${sourceId}:${sourceLayer}:geom-${hashString(ringFingerprint(ring))}`;
}

export function candidateFromFeature(
  feature: MapGeoJSONFeature,
  cameraCenter: LngLatTuple,
): BuildingCandidate | null {
  if (feature.sourceLayer !== "building") return null;
  const ring = outerRingFromGeometry(
    feature.geometry as { type: string; coordinates?: unknown },
  );
  if (!ring) return null;

  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const center = ringCenter(ring);
  return {
    key: buildingFeatureKey(feature, ring),
    ring,
    profile: buildingProfileFromProperties(properties),
    center,
    distanceMeters: distanceMeters(cameraCenter, center),
  };
}
