import type { LocalPhysicsPoint } from "./floating-origin";
import {
  DEFAULT_CHASSIS_CONFIG,
  normalizeChassisControls,
  type ChassisConfig,
  type ChassisControls,
} from "./vehicle-chassis";

export type WheelRole = "front-left" | "front-right" | "rear-left" | "rear-right";

export interface VehicleSuspensionConfig {
  wheelRadiusMeters: number;
  suspensionRestLengthMeters: number;
  maxSuspensionTravelMeters: number;
  suspensionStiffness: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  maxSuspensionForceN: number;
  frictionSlip: number;
  sideFrictionStiffness: number;
  wheelSideInsetMeters: number;
  axleEndInsetMeters: number;
  maxSteeringAngleRadians: number;
  steeringFadeSpeedMetersPerSecond: number;
  minimumSteeringFactor: number;
  maxForwardEngineForceN: number;
  maxReverseEngineForceN: number;
  maxBrakeImpulse: number;
}

export interface VehicleWheelDefinition {
  index: number;
  role: WheelRole;
  chassisConnection: LocalPhysicsPoint;
  suspensionDirection: LocalPhysicsPoint;
  axleDirection: LocalPhysicsPoint;
  steer: boolean;
  drive: boolean;
  brake: boolean;
}

export interface RaycastVehicleActuation {
  steeringAngleRadians: number;
  engineForcePerDrivenWheelN: number;
  brakeImpulsePerWheel: number;
}

export const DEFAULT_SUSPENSION_CONFIG: VehicleSuspensionConfig = {
  wheelRadiusMeters: 0.34,
  suspensionRestLengthMeters: 0.34,
  maxSuspensionTravelMeters: 0.18,
  suspensionStiffness: 24,
  suspensionCompression: 4.2,
  suspensionRelaxation: 4.8,
  maxSuspensionForceN: 8500,
  frictionSlip: 4.2,
  sideFrictionStiffness: 1,
  wheelSideInsetMeters: 0.14,
  axleEndInsetMeters: 0.58,
  maxSteeringAngleRadians: 0.5,
  steeringFadeSpeedMetersPerSecond: 28,
  minimumSteeringFactor: 0.34,
  maxForwardEngineForceN: 9000,
  maxReverseEngineForceN: 5200,
  maxBrakeImpulse: 18,
};

export function buildWheelDefinitions(
  chassis: ChassisConfig = DEFAULT_CHASSIS_CONFIG,
  suspension: VehicleSuspensionConfig = DEFAULT_SUSPENSION_CONFIG,
): VehicleWheelDefinition[] {
  const halfTrack = Math.max(0.45, chassis.widthMeters / 2 - suspension.wheelSideInsetMeters);
  const halfWheelbase = Math.max(0.9, chassis.lengthMeters / 2 - suspension.axleEndInsetMeters);
  const connectionY = -chassis.heightMeters / 2 + 0.06;
  const down = { x: 0, y: -1, z: 0 };
  // Rapier derives the wheel's forward direction from contact normal × axle. With +Y up and Mapshow's +Z
  // chassis-forward convention, the axle must point toward local -X so positive engine force moves +Z.
  const axle = { x: -1, y: 0, z: 0 };

  return [
    {
      index: 0,
      role: "front-left",
      chassisConnection: { x: -halfTrack, y: connectionY, z: halfWheelbase },
      suspensionDirection: down,
      axleDirection: axle,
      steer: true,
      drive: false,
      brake: true,
    },
    {
      index: 1,
      role: "front-right",
      chassisConnection: { x: halfTrack, y: connectionY, z: halfWheelbase },
      suspensionDirection: down,
      axleDirection: axle,
      steer: true,
      drive: false,
      brake: true,
    },
    {
      index: 2,
      role: "rear-left",
      chassisConnection: { x: -halfTrack, y: connectionY, z: -halfWheelbase },
      suspensionDirection: down,
      axleDirection: axle,
      steer: false,
      drive: true,
      brake: true,
    },
    {
      index: 3,
      role: "rear-right",
      chassisConnection: { x: halfTrack, y: connectionY, z: -halfWheelbase },
      suspensionDirection: down,
      axleDirection: axle,
      steer: false,
      drive: true,
      brake: true,
    },
  ];
}

export function computeRaycastVehicleActuation(
  rawControls: ChassisControls,
  speedMetersPerSecond: number,
  suspension: VehicleSuspensionConfig = DEFAULT_SUSPENSION_CONFIG,
  drivenWheelCount = 2,
): RaycastVehicleActuation {
  const controls = normalizeChassisControls(rawControls);
  const speed = Math.abs(Number.isFinite(speedMetersPerSecond) ? speedMetersPerSecond : 0);
  const steeringFactor = Math.max(
    suspension.minimumSteeringFactor,
    1 - speed / suspension.steeringFadeSpeedMetersPerSecond,
  );
  const totalEngineForce = controls.throttle >= 0
    ? controls.throttle * suspension.maxForwardEngineForceN
    : controls.throttle * suspension.maxReverseEngineForceN;

  return {
    steeringAngleRadians: controls.steer * suspension.maxSteeringAngleRadians * steeringFactor,
    engineForcePerDrivenWheelN: drivenWheelCount > 0 ? totalEngineForce / drivenWheelCount : 0,
    brakeImpulsePerWheel: controls.brake * suspension.maxBrakeImpulse,
  };
}
