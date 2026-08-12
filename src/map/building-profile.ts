export const LOW_RISE_MAX_HEIGHT = 24;
export const MID_RISE_MAX_HEIGHT = 70;
export const DEFAULT_BUILDING_HEIGHT = 8;
export const GROUND_FLOOR_HEIGHT = 3.6;
export const ROOF_CAP_HEIGHT = 0.7;

export type FacadeFamily = "brick" | "masonry" | "glass";

export interface BuildingProfile {
  height: number;
  minHeight: number;
  estimatedLevels: number;
  facade: FacadeFamily;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function facadeFamilyForHeight(height: number): FacadeFamily {
  if (height >= MID_RISE_MAX_HEIGHT) return "glass";
  if (height >= LOW_RISE_MAX_HEIGHT) return "masonry";
  return "brick";
}

export function buildingProfileFromProperties(
  properties: Record<string, unknown>,
): BuildingProfile {
  const height = Math.max(
    0,
    finiteNumber(properties.render_height) ?? DEFAULT_BUILDING_HEIGHT,
  );
  const minHeight = Math.min(
    height,
    Math.max(0, finiteNumber(properties.render_min_height) ?? 0),
  );
  const explicitLevels = finiteNumber(properties["building:levels"]);
  const estimatedLevels = Math.max(
    1,
    Math.round(explicitLevels ?? (height - minHeight) / 3.2),
  );

  return {
    height,
    minHeight,
    estimatedLevels,
    facade: facadeFamilyForHeight(height),
  };
}
