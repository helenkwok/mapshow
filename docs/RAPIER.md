# Rapier integration notes

This file records the Mapshow-to-Rapier boundary so vehicle work does not bypass the engine-neutral road/collision architecture.

## Runtime package

Mapshow uses `@dimforge/rapier3d-compat` in the browser.

`RoadPhysicsAdapter` remains the source of static local collider descriptors. `RapierPhysicsWorld` consumes `PhysicsSyncBatch` plus local dynamic-body inputs; it does not read MapLibre features, Web Mercator road geometry or Three.js road meshes directly.

## Static world

Each active road/intersection collision body becomes one standalone Rapier trimesh collider. Stable Mapshow collider IDs are mapped to Rapier handles internally. Stream updates use create/update/remove deltas instead of rebuilding the whole physics world.

Current road material defaults use higher friction for paved roads, lower friction for unpaved roads and zero road restitution.

## Fixed-step simulation

Rapier advances at a fixed 1/60 s step using a browser-time accumulator. Catch-up is capped so a long browser stall cannot trigger unlimited physics work in one animation frame.

Static road streaming is event-driven by map/world refreshes; dynamic-body stepping continues independently through the animation loop.

## Dynamic probe

The diagnostic probe remains a small cuboid used to isolate raw collider/contact/rebase failures without vehicle complexity.

## Raycast vehicle

The chassis now uses Rapier's `DynamicRayCastVehicleController` instead of applying direct force and yaw torque to the rigid body.

Configuration:

- chassis mass: 1,200 kg validation body;
- local up axis: `+Y`;
- local forward axis: `+Z`;
- four raycast wheels;
- wheel suspension rays: local `-Y`;
- wheel axle: local `-X`, which aligns positive engine force with Mapshow `+Z` forward;
- front wheels steer;
- rear wheels receive engine force;
- all wheels receive brake impulse.

Per-wheel tuning currently includes:

- wheel radius;
- suspension rest length and maximum travel;
- suspension stiffness;
- compression and relaxation damping;
- maximum suspension force;
- friction slip;
- side-friction stiffness.

Steering authority reduces with speed but retains a configurable minimum. Forward and reverse engine-force limits are configured separately and split across the driven wheels.

Before every Rapier world step, Mapshow:

1. normalizes user controls;
2. maps them to wheel steering, engine force and braking;
3. calls `DynamicRayCastVehicleController.updateVehicle()`;
4. excludes dynamic colliders from wheel ray queries, so the rays target the streamed static road/intersection world;
5. advances Rapier by one fixed substep.

## Wheel diagnostics

`DynamicChassisState` exposes a grounded-wheel count and per-wheel diagnostics for active chassis states:

- `wheelIsInContact`;
- suspension length;
- suspension force;
- steering angle;
- engine force;
- brake impulse;
- forward impulse;
- side impulse;
- contact point.

These values are intended to make road seam, suspension-load and traction problems observable before a custom tyre model is introduced.

## Floating-origin rebasing

Physics coordinates are local metres:

- X east;
- Y up;
- Z north.

When the floating origin changes:

- static road/intersection geometry is retransformed by `RoadPhysicsAdapter` and replaced as needed;
- dynamic probe position is transformed into the new local frame;
- chassis position is transformed into the new local frame;
- chassis velocity/orientation and the vehicle controller remain active rather than respawning.

After a rebase, Rapier propagates the modified rigid-body transforms to attached colliders before further vehicle queries.

Terrain mode changes force a frame reset because the local Y datum is tied to DEM elevation.

## Streaming order

For static collision:

1. remove stale collider IDs;
2. replace updated colliders;
3. create new colliders;
4. retain unchanged colliders.

Dynamic bodies and the raycast vehicle controller are separate from this static lifecycle and survive normal collider refreshes.

## Debugging

The optional Rapier debug layer renders Rapier debug lines back through MapLibre using the current floating-origin transform.

The drop probe is still useful when debugging a road collider independently of the suspension system.

## Tests

Vitest covers both engine-independent contracts and real Rapier/WASM execution:

- floating-origin coordinate transformations;
- road collision geometry;
- `PhysicsSyncBatch` lifecycle behavior;
- chassis configuration/control normalization;
- wheel placement and control-to-wheel mapping;
- a real four-wheel raycast suspension settling onto a static road trimesh;
- forward wheel-driven motion while the wheels remain grounded.

CI runs the suite before strict TypeScript/Vite compilation.

## Current boundary

The raycast controller is the **first real suspension/contact layer**, but it is not automatically the final vehicle dynamics model.

Still open:

- custom tyre load/slip curves;
- physical wheel bodies and wheel visual poses;
- differential/gearing/powertrain behavior;
- Ackermann/steering refinement;
- surface-dependent tyre policy beyond coarse Rapier friction values;
- route/lane-following integration;
- dynamic traffic collision filtering.

The next useful step is to evaluate the wheel contact/load/impulse data on real generated roads and decide what parts of the tyre model need to move beyond Rapier's built-in raycast vehicle behavior.
