import {
  MercatorCoordinate,
  type CustomRenderMethodInput,
  type LngLatLike,
  type Map as MapLibreMap,
} from "maplibre-gl";
import * as THREE from "three";

export interface MercatorRenderFrame {
  origin: MercatorCoordinate;
  meterScale: number;
}

export function mercatorRenderFrameAt(
  lngLat: LngLatLike,
  altitudeMeters = 0,
): MercatorRenderFrame {
  const origin = MercatorCoordinate.fromLngLat(lngLat, altitudeMeters);
  return {
    origin,
    meterScale: origin.meterInMercatorCoordinateUnits(),
  };
}

export function mercatorRenderFrameAtMapCenter(map: MapLibreMap): MercatorRenderFrame {
  return mercatorRenderFrameAt(map.getCenter(), 0);
}

/**
 * Express an object whose geometry is stored in local metres around objectOrigin inside a nearby
 * render frame. Keeping the Object3D translation near zero avoids losing metre-scale precision when
 * Three.js uploads model matrices as Float32 at close zoom levels.
 */
export function applyRelativeMercatorTransform(
  object: THREE.Object3D,
  objectOrigin: MercatorCoordinate,
  objectMeterScale: number,
  frame: MercatorRenderFrame,
  liftMeters = 0,
): void {
  const scaleRatio = objectMeterScale / frame.meterScale;
  object.position.set(
    (objectOrigin.x - frame.origin.x) / frame.meterScale,
    (objectOrigin.y - frame.origin.y) / frame.meterScale,
    (objectOrigin.z - frame.origin.z) / frame.meterScale + liftMeters * scaleRatio,
  );
  object.scale.set(scaleRatio, scaleRatio, scaleRatio);
}

/** Compose MapLibre's world projection with the local-metre frame used by the Three.js scene. */
export function projectionMatrixForMercatorFrame(
  options: CustomRenderMethodInput,
  frame: MercatorRenderFrame,
): THREE.Matrix4 {
  const projection = new THREE.Matrix4().fromArray(
    Array.from(options.defaultProjectionData.mainMatrix),
  );
  const localToMercator = new THREE.Matrix4()
    .makeTranslation(frame.origin.x, frame.origin.y, frame.origin.z)
    .scale(new THREE.Vector3(frame.meterScale, frame.meterScale, frame.meterScale));
  return projection.multiply(localToMercator);
}
