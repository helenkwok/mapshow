import type { LocalPhysicsPoint } from "./floating-origin";

export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

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
  maxForwardForceN: number;
  maxReverseForceN: number;
  maxBrakeForceN: number;
  maxYawTorqueNm: number;
}

export interface ChassisActuation {
  force: LocalPhysicsPoint;
  torque: LocalPhysicsPoint;
}

export const DEFAULT_CHASSIS_CONFIG: ChassisConfig = {
  widthMeters: 1.82,
  heightMeters: 0.7,
  lengthMeters: 4.25,
  massKg: 1200,
  friction: 0.82,
  restitution: 0.01,
  linearDamping: 0.22,
  angularDamping: 1.6,
  maxForwardForceN: 9000,
  maxReverseForceN: 4500,
  maxBrakeForceN: 14000,
  maxYawTorqueNm: 6500,
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

export function horizontalForwardFromQuaternion(rotation: QuaternionLike): LocalPhysicsPoint {
  // Rotate local +Z into world space, then flatten it to the X/Z driving plane.
  const x = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
  const z = 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y);
  const length = Math.hypot(x, z);
  if (length < 1e-8) return { x: 0, y: 0, z: 1 };
  return { x: x / length, y: 0, z: z / length };
}

export function computeChassisActuation(
  rotation: QuaternionLike,
  linearVelocity: LocalPhysicsPoint,
  rawControls: ChassisControls,
  config: ChassisConfig = DEFAULT_CHASSIS_CONFIG,
): ChassisActuation {
  const controls = normalizeChassisControls(rawControls);
  const forward = horizontalForwardFromQuaternion(rotation);
  const thrustLimit = controls.throttle >= 0
    ? config.maxForwardForceN
    : config.maxReverseForceN;
  const thrust = controls.throttle * thrustLimit;

  let brakeX = 0;
  let brakeZ = 0;
  const horizontalSpeed = Math.hypot(linearVelocity.x, linearVelocity.z);
  if (controls.brake > 0 && horizontalSpeed > 1e-5) {
    const brakeMagnitude = Math.min(
      config.maxBrakeForceN * controls.brake,
      horizontalSpeed * config.massKg * 8,
    );
    brakeX = -(linearVelocity.x / horizontalSpeed) * brakeMagnitude;
    brakeZ = -(linearVelocity.z / horizontalSpeed) * brakeMagnitude;
  }

  // This yaw torque is only a temporary chassis-validation control. Real steering will come from
  // suspension/tire contact forces rather than rotating the chassis directly.
  const steeringAuthority = Math.min(1, 0.25 + horizontalSpeed / 8);

  return {
    force: {
      x: forward.x * thrust + brakeX,
      y: 0,
      z: forward.z * thrust + brakeZ,
    },
    torque: {
      x: 0,
      y: controls.steer * config.maxYawTorqueNm * steeringAuthority,
      z: 0,
    },
  };
}
