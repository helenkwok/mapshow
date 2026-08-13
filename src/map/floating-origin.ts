import { MercatorCoordinate } from "maplibre-gl";
import { distanceMeters, type LngLatTuple } from "./building-feature";

export interface FloatingOriginFrame {
  revision: number;
  anchor: LngLatTuple;
  elevationMeters: number;
  mercator: MercatorCoordinate;
  meterScale: number;
}

export interface FloatingOriginUpdate {
  frame: FloatingOriginFrame;
  shifted: boolean;
  shiftDistanceMeters: number;
}

export const DEFAULT_ORIGIN_SHIFT_THRESHOLD_METERS = 400;

function createFrame(
  anchor: LngLatTuple,
  elevationMeters: number,
  revision: number,
): FloatingOriginFrame {
  const mercator = MercatorCoordinate.fromLngLat(anchor, 0);
  return {
    revision,
    anchor: [...anchor] as LngLatTuple,
    elevationMeters,
    mercator,
    meterScale: mercator.meterInMercatorCoordinateUnits(),
  };
}

export class FloatingOriginController {
  private frame?: FloatingOriginFrame;

  constructor(
    readonly shiftThresholdMeters = DEFAULT_ORIGIN_SHIFT_THRESHOLD_METERS,
  ) {}

  update(anchor: LngLatTuple, elevationMeters: number): FloatingOriginUpdate {
    if (!this.frame) {
      this.frame = createFrame(anchor, elevationMeters, 1);
      return { frame: this.frame, shifted: true, shiftDistanceMeters: 0 };
    }

    const shiftDistanceMeters = distanceMeters(this.frame.anchor, anchor);
    if (shiftDistanceMeters < this.shiftThresholdMeters) {
      return { frame: this.frame, shifted: false, shiftDistanceMeters };
    }

    this.frame = createFrame(anchor, elevationMeters, this.frame.revision + 1);
    return { frame: this.frame, shifted: true, shiftDistanceMeters };
  }

  reset(anchor: LngLatTuple, elevationMeters: number): FloatingOriginFrame {
    const revision = (this.frame?.revision ?? 0) + 1;
    this.frame = createFrame(anchor, elevationMeters, revision);
    return this.frame;
  }

  get current(): FloatingOriginFrame | undefined {
    return this.frame;
  }
}
