# Rapier integration notes

This file records the Mapshow-to-Rapier boundary so later vehicle work does not bypass the engine-neutral road/collision architecture.

## Runtime package

Mapshow uses `@dimforge/rapier3d-compat` in the browser.

`RoadPhysicsAdapter` remains the source of static local collider descriptors. `RapierPhysicsWorld` consumes `PhysicsSyncBatch` plus local dynamic-body inputs; it does not read MapLibre features, Web Mercator road geometry or Three.js road meshes directly.

## Static world

Each active road/intersection collision body becomes one standalone Rapier trimesh collider.

Stable Mapshow collider IDs are mapped to Rapier handles internally. Stream updates use the adapter's create/update/remove delta rather than rebuilding the whole Rapier world.

Current road material defaults:

- paved: high friction;
- unpaved: lower friction;
- unknown: intermediate friction;
- road restitution: zero.

## Fixed-step simulation

Rapier advances at a fixed 1/60 s step using a browser-time accumulator. Catch-up is capped so a long browser stall cannot trigger unlimited physics work in one animation frame.

Static road streaming is event-driven by map/world refreshes; dynamic-body stepping continues independently through the animation loop.

## Dynamic probe

The diagnostic probe is a small cuboid spawned about 6 m above the nearest active road collider.

It uses:

- fixed test mass;
- moderate friction;
- low restitution;
- CCD;
- contact-pair/sleep/speed/position reporting.

Its purpose is to expose missing collision, seams, unstable contact, streaming gaps and origin-rebase errors without vehicle-control complexity.

## Minimal chassis

Mapshow also has a separate single-body chassis validation object.

The chassis uses a car-like footprint and 1,200 kg test mass with CCD, damping and coarse friction. It is controlled through direct rigid-body forces/torques:

```text
W / S     forward / reverse force
A / D     yaw torque
Space     braking force opposite horizontal velocity
```

The actuation math lives in `src/map/vehicle-chassis.ts`, not inside Rapier-specific code. `RapierPhysicsWorld` converts that result into `resetForces`, `resetTorques`, `addForce` and `addTorque` calls before each fixed substep.

The temporary thrust values deliberately exceed the static-friction threshold of the validation chassis on a paved road so the control path is observable in tests. They are not intended to represent a production powertrain or tyre force budget.

This is intentionally a **validation chassis, not a car model**. The next real vehicle stage needs wheel/suspension/tyre contacts rather than more tuning of the direct rigid-body controls.

## Floating-origin rebasing

Physics coordinates are local metres:

- X east;
- Y up;
- Z north.

When the floating origin changes:

- static road/intersection geometry is retransformed by `RoadPhysicsAdapter` and replaced as needed;
- dynamic probe position is transformed into the new local frame;
- dynamic chassis position is transformed into the new local frame;
- velocity/orientation are kept rather than recreating the body.

Terrain mode changes force a frame reset for the same reason: the local Y datum is tied to DEM elevation.

## Streaming order

For static collision:

1. remove stale collider IDs;
2. replace updated colliders;
3. create new colliders;
4. retain unchanged colliders.

Dynamic bodies are separate from this static lifecycle and survive normal collider refreshes.

## Debugging

The optional Rapier debug layer renders Rapier debug lines back through MapLibre using the current floating-origin transform.

With probe/chassis bodies active, debug geometry refreshes while they are moving so static and dynamic collider alignment can be inspected together.

## Tests

Vitest covers both the engine-independent contracts and a real Rapier/WASM integration path:

- floating-origin coordinate transformations;
- road collision geometry;
- `PhysicsSyncBatch` lifecycle behavior;
- chassis force/torque calculations;
- a real Rapier world containing a static road trimesh and a dynamic chassis that must fall into contact and then move under throttle.

CI runs that suite before strict TypeScript/Vite compilation. The integration test exists specifically to catch runtime/WASM behavior that a successful typecheck cannot prove.

Future Rapier integration tests should extend this same layer for suspension contacts, chassis pose and origin rebasing once the suspension system exists.

## Next physics milestone

Do **not** spend the next milestone making the direct-force chassis feel like a polished car.

The next useful step is a first wheel/suspension contact model that can validate:

- suspension ray/contact distance;
- spring/damper forces;
- per-wheel ground contact on generated road/intersection trimeshes;
- chassis pose over grades and seams;
- origin rebasing while suspension is active.

Tyre slip/friction, steering geometry and full vehicle controls should build on that contact model rather than on the temporary yaw/thrust forces.
