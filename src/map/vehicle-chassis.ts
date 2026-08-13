export interface ChassisControls {
  throttle: number;
  steer: number;
  brake: number;
}

export interface ChassisConfig {
  widthMeters: number;
  heightMeters: number;
  lengthMeters: number;
  massKg: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
}

export const DEFAULT_CHASSIS_CONFIG: ChassisConfig = {
  widthMeters: 1.82,
  heightMeters: 0.7,
  lengthMeters: 4.25,
  massKg: 1200,
  // The ray-cast wheels provide the driving contact forces. Chassis friction only matters if the body itself
  // bottoms out against the road, so keep it lower than the previous direct-force validation body.
  friction: 0.38,
  restitution: 0.01,
  linearDamping: 0.16,
  angularDamping: 0.85,
};

export const ZERO_CHASSIS_CONTROLS: ChassisControls = {
  throttle: 0,
  steer: 0,
  brake: 0,
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeChassisControls(controls: ChassisControls): ChassisControls {
  return {
    throttle: clamp(controls.throttle, -1, 1),
    steer: clamp(controls.steer, -1, 1),
    brake: clamp(controls.brake, 0, 1),
  };
}
