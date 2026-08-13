# Rapier integration notes

This file records the current Mapshow-to-Rapier boundary so later vehicle work does not bypass the engine-neutral adapter.

## Runtime

Mapshow uses `@dimforge/rapier3d-compat` in the browser.

`RoadPhysicsAdapter` remains the source of local collider descriptors. `RapierPhysicsWorld` consumes only `PhysicsSyncBatch` and does not read MapLibre features, Web Mercator coordinates or Three.js meshes directly.

## Static world

Each active road or intersection collision body becomes one standalone Rapier trimesh collider. Stable Mapshow collider IDs are mapped to Rapier collider handles internally.

Surface classes currently select coarse friction defaults:

- paved: high friction;
- unpaved: lower friction;
- unknown: intermediate friction.

Restitution is zero for the road environment.

## Streaming

The sync order is:

1. remove stale collider IDs;
2. replace updated colliders;
3. create new colliders;
4. retain unchanged Rapier colliders.

A floating-origin revision causes the engine-neutral adapter to emit updated local positions, which are then replaced in Rapier.

## Debugging

The optional Rapier debug layer renders Rapier debug line geometry back into MapLibre using the current floating-origin transform. It is intended to detect coordinate-axis, elevation, origin-rebase and collider-streaming errors before a vehicle is introduced.

## Next validation

Before a real car controller, add a minimal dynamic test body to verify:

- gravity/contact with road surfaces;
- stable transitions through generated intersections;
- bridge/tunnel collision continuity;
- behaviour while streamed colliders enter/leave range;
- behaviour during floating-origin rebasing.
