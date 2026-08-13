# Rapier integration notes

This file records the current Mapshow-to-Rapier boundary so later vehicle work does not bypass the engine-neutral adapter.

## Runtime

Mapshow uses `@dimforge/rapier3d-compat` in the browser.

`RoadPhysicsAdapter` remains the source of local collider descriptors. `RapierPhysicsWorld` consumes only `PhysicsSyncBatch` and local physics coordinates; it does not read MapLibre features, Web Mercator coordinates or Three.js road meshes directly.

## Static world

Each active road or intersection collision body becomes one standalone Rapier trimesh collider. Stable Mapshow collider IDs are mapped to Rapier collider handles internally.

Surface classes currently select coarse friction defaults:

- paved: high friction;
- unpaved: lower friction;
- unknown: intermediate friction.

Restitution is zero for the static road environment.

## Dynamic validation probe

Before introducing a vehicle, Mapshow uses one deliberately simple dynamic cuboid as a physics probe.

The probe:

- spawns about 6 m above the nearest active road collider;
- has a fixed test mass and moderate friction;
- uses low restitution;
- has continuous collision detection enabled;
- reports local position, speed, sleep state, contact-pair count, age and floating-origin rebase count;
- is shown by the Rapier debug overlay.

It is not intended to approximate a chassis or tyre model. Its purpose is to reveal collider seams, missing surfaces, unstable contact, streaming gaps and origin-rebase errors before vehicle complexity is added.

## Fixed-step simulation

The browser advances Rapier with a fixed 1/60 s physics step and an accumulator. Frame catch-up is bounded so a long browser stall cannot trigger an unlimited number of physics steps in one animation frame.

## Floating-origin rebasing

Physics uses local metres with X east, Y up and Z north. When the floating origin changes, static collision geometry is regenerated through the engine-neutral adapter in the new frame.

The dynamic probe is not recreated. Its current local position is transformed from the old floating frame into the new frame, while its physical velocity and orientation are preserved. This lets the probe validate rebasing without introducing a discontinuity from respawning it.

## Streaming

The static sync order is:

1. remove stale collider IDs;
2. replace updated colliders;
3. create new colliders;
4. retain unchanged Rapier colliders.

A floating-origin revision causes the engine-neutral adapter to emit updated local positions, which are then replaced in Rapier.

## Debugging

The optional Rapier debug layer renders Rapier debug line geometry back into MapLibre using the current floating-origin transform. With a probe active, the debug layer is refreshed while the body is moving so both the static road world and dynamic collider can be inspected together.

## Next validation

Use the dynamic probe to test:

- gravity/contact with road surfaces;
- generated intersection seams;
- bridge/tunnel collision continuity;
- streamed collider entry/removal boundaries;
- terrain mode changes;
- floating-origin rebasing while the probe remains active.

Only after these remain stable should Mapshow add chassis, suspension, tyres, steering, throttle and braking.
