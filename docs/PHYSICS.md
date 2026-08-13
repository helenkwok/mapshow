# Physics coordinate boundary

Mapshow keeps geographic rendering and physics coordinates separate.

## Why a floating origin

MapLibre renders the world in Web Mercator coordinates. Those coordinates are appropriate for a map renderer but are a poor long-term coordinate system for vehicle physics: a car, wheel collider, suspension ray and contact manifold should operate on small local metre values rather than planet-scale geographic coordinates.

Mapshow therefore uses a floating physics frame. Until a player vehicle exists, the camera centre is used as the player proxy.

The default frame moves after the camera has travelled 400 m from the current physics origin. Moving the frame does **not** rebuild OSM topology, lanes, road profiles or visual Three.js meshes. It only retransforms the already generated collision bodies into a new local frame.

## Physics axes

The engine-neutral physics convention is:

- `+X`: east
- `+Y`: up
- `+Z`: north
- units: metres

Road collision geometry is generated per road/intersection in the MapLibre rendering convention and converted at the adapter boundary. Terrain elevations are converted to height relative to the floating origin elevation.

## Modules

`src/map/floating-origin.ts`

- owns the current geographic anchor
- stores the anchor Mercator coordinate and metres-to-Mercator scale
- increments an origin revision when the anchor shifts
- intentionally has no dependency on a physics engine

`src/map/physics-adapter.ts`

- consumes `RoadCollisionWorld`
- converts each triangle mesh into the local X-east/Y-up/Z-north frame
- keeps stable collider IDs
- reports created, updated and removed colliders as a sync batch
- retransforms active colliders when the floating-origin revision changes
- intentionally does not instantiate Rapier/Bullet/Ammo bodies

`src/map/road-collision.ts`

- remains the renderer-independent geographic collision source
- contains road strips and intersection triangle meshes
- retains OSM-derived surface/bridge/tunnel/layer metadata for later material and contact policy

## Engine adapter contract

A future physics backend should consume `PhysicsSyncBatch` rather than reading MapLibre or Three.js objects directly.

For each batch:

1. remove IDs in `removed`;
2. replace bodies in `updated`;
3. create bodies in `created`;
4. treat a changed `originRevision` as a local-world rebase;
5. keep the player/chassis state in the same floating frame.

This keeps Rapier replaceable and prevents vehicle code from depending on Web Mercator.

## Next milestone

The next step is a Rapier implementation of this boundary:

- one static trimesh collider per streamed road/intersection body;
- collider add/update/remove from `PhysicsSyncBatch`;
- a debug overlay comparing render geometry and physics geometry;
- no vehicle controller until collider streaming and origin rebasing are validated.
