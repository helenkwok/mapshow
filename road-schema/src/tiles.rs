use std::collections::BTreeMap;
use std::fs::{self, File};
use std::path::Path;

use anyhow::{Context, Result};
use pmtiles::{PmTilesWriter, TileCoord, TileType};
use serde::Serialize;
use serde_json::json;

use crate::mvt::{encode_road_tile, TileRoadFeature};
use crate::pbf::{LngLat, RoadDataset};
use crate::schema::{LAYER_NAME, MAX_ZOOM, MIN_ZOOM};

pub const MVT_EXTENT: u32 = 4096;
const BUFFER_PIXELS: f64 = 32.0;
const TILE_PIXELS: f64 = 256.0;
const BUFFER_FRACTION: f64 = BUFFER_PIXELS / TILE_PIXELS;
const BUFFER_UNITS: f64 = MVT_EXTENT as f64 * BUFFER_FRACTION;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct TileKey {
    z: u8,
    x: u32,
    y: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TileBuildSummary {
    pub input_segments: usize,
    pub output_tiles: usize,
    pub min_zoom: u8,
    pub max_zoom: u8,
}

type TileBuckets = BTreeMap<TileKey, Vec<TileRoadFeature>>;

fn project_to_tile_space(point: LngLat, zoom: u8) -> (f64, f64) {
    let n = 2_f64.powi(i32::from(zoom));
    let x = (point.lng + 180.0) / 360.0 * n;
    let latitude = point.lat.clamp(-85.051_128_78, 85.051_128_78).to_radians();
    let y = (1.0 - (latitude.tan() + 1.0 / latitude.cos()).ln() / std::f64::consts::PI)
        / 2.0
        * n;
    (x, y)
}

fn clip_parameter(p: f64, q: f64, lower: &mut f64, upper: &mut f64) -> bool {
    if p.abs() < f64::EPSILON {
        return q >= 0.0;
    }
    let ratio = q / p;
    if p < 0.0 {
        if ratio > *upper {
            return false;
        }
        *lower = lower.max(ratio);
    } else {
        if ratio < *lower {
            return false;
        }
        *upper = upper.min(ratio);
    }
    true
}

fn clip_segment(
    start: (f64, f64),
    end: (f64, f64),
    min: f64,
    max: f64,
) -> Option<((f64, f64), (f64, f64))> {
    let dx = end.0 - start.0;
    let dy = end.1 - start.1;
    let mut lower = 0.0;
    let mut upper = 1.0;

    if !clip_parameter(-dx, start.0 - min, &mut lower, &mut upper)
        || !clip_parameter(dx, max - start.0, &mut lower, &mut upper)
        || !clip_parameter(-dy, start.1 - min, &mut lower, &mut upper)
        || !clip_parameter(dy, max - start.1, &mut lower, &mut upper)
    {
        return None;
    }

    Some((
        (start.0 + lower * dx, start.1 + lower * dy),
        (start.0 + upper * dx, start.1 + upper * dy),
    ))
}

fn near(a: (f64, f64), b: (f64, f64)) -> bool {
    (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6
}

fn clip_polyline(points: &[(f64, f64)], min: f64, max: f64) -> Vec<Vec<(i32, i32)>> {
    let mut fragments = Vec::<Vec<(f64, f64)>>::new();
    let mut current = Vec::<(f64, f64)>::new();

    for pair in points.windows(2) {
        if let Some((start, end)) = clip_segment(pair[0], pair[1], min, max) {
            if current.last().is_some_and(|last| near(*last, start)) {
                if !current.last().is_some_and(|last| near(*last, end)) {
                    current.push(end);
                }
            } else {
                if current.len() >= 2 {
                    fragments.push(std::mem::take(&mut current));
                }
                current.push(start);
                if !near(start, end) {
                    current.push(end);
                }
            }
        } else if current.len() >= 2 {
            fragments.push(std::mem::take(&mut current));
        } else {
            current.clear();
        }
    }
    if current.len() >= 2 {
        fragments.push(current);
    }

    fragments
        .into_iter()
        .map(|fragment| {
            fragment
                .into_iter()
                .map(|(x, y)| (x.round() as i32, y.round() as i32))
                .collect::<Vec<_>>()
        })
        .filter(|line| line.len() >= 2)
        .collect()
}

fn tile_range(min: f64, max: f64, n: u32) -> (u32, u32) {
    let lower = (min - BUFFER_FRACTION).floor().max(0.0) as u32;
    let upper = (max + BUFFER_FRACTION)
        .floor()
        .min(f64::from(n.saturating_sub(1))) as u32;
    (lower.min(n - 1), upper.min(n - 1))
}

fn build_tile_buckets(dataset: &RoadDataset) -> TileBuckets {
    let mut buckets = TileBuckets::new();

    for segment in &dataset.segments {
        for zoom in MIN_ZOOM..=MAX_ZOOM {
            let n = 1_u32 << zoom;
            let projected = segment
                .coordinates
                .iter()
                .copied()
                .map(|point| project_to_tile_space(point, zoom))
                .collect::<Vec<_>>();
            if projected.len() < 2 {
                continue;
            }

            let min_x = projected
                .iter()
                .map(|point| point.0)
                .fold(f64::INFINITY, f64::min);
            let max_x = projected
                .iter()
                .map(|point| point.0)
                .fold(f64::NEG_INFINITY, f64::max);
            let min_y = projected
                .iter()
                .map(|point| point.1)
                .fold(f64::INFINITY, f64::min);
            let max_y = projected
                .iter()
                .map(|point| point.1)
                .fold(f64::NEG_INFINITY, f64::max);
            let (min_tile_x, max_tile_x) = tile_range(min_x, max_x, n);
            let (min_tile_y, max_tile_y) = tile_range(min_y, max_y, n);

            for tile_x in min_tile_x..=max_tile_x {
                for tile_y in min_tile_y..=max_tile_y {
                    let local = projected
                        .iter()
                        .map(|(x, y)| {
                            (
                                (x - f64::from(tile_x)) * f64::from(MVT_EXTENT),
                                (y - f64::from(tile_y)) * f64::from(MVT_EXTENT),
                            )
                        })
                        .collect::<Vec<_>>();
                    let lines = clip_polyline(
                        &local,
                        -BUFFER_UNITS,
                        f64::from(MVT_EXTENT) + BUFFER_UNITS,
                    );
                    if lines.is_empty() {
                        continue;
                    }
                    buckets
                        .entry(TileKey {
                            z: zoom,
                            x: tile_x,
                            y: tile_y,
                        })
                        .or_default()
                        .push(TileRoadFeature {
                            id: segment.segment_id as u64,
                            properties: segment.properties.clone(),
                            lines,
                        });
                }
            }
        }
    }

    buckets
}

fn dataset_bounds(dataset: &RoadDataset) -> Option<(f64, f64, f64, f64)> {
    let mut min_lng = f64::INFINITY;
    let mut min_lat = f64::INFINITY;
    let mut max_lng = f64::NEG_INFINITY;
    let mut max_lat = f64::NEG_INFINITY;
    let mut found = false;
    for point in dataset
        .segments
        .iter()
        .flat_map(|segment| segment.coordinates.iter())
    {
        found = true;
        min_lng = min_lng.min(point.lng);
        min_lat = min_lat.min(point.lat);
        max_lng = max_lng.max(point.lng);
        max_lat = max_lat.max(point.lat);
    }
    found.then_some((min_lng, min_lat, max_lng, max_lat))
}

fn vector_layer_metadata() -> serde_json::Value {
    json!({
        "id": LAYER_NAME,
        "description": "Mapshow simulation-oriented OpenStreetMap road segments",
        "minzoom": MIN_ZOOM,
        "maxzoom": MAX_ZOOM,
        "fields": {}
    })
}

pub fn write_xyz_tiles(
    dataset: &RoadDataset,
    output_dir: &Path,
    tile_url_template: &str,
) -> Result<TileBuildSummary> {
    let buckets = build_tile_buckets(dataset);
    fs::create_dir_all(output_dir)
        .with_context(|| format!("creating tile output directory {}", output_dir.display()))?;

    for (key, features) in &buckets {
        let bytes = encode_road_tile(features, MVT_EXTENT);
        if bytes.is_empty() {
            continue;
        }
        let tile_dir = output_dir.join(key.z.to_string()).join(key.x.to_string());
        fs::create_dir_all(&tile_dir)?;
        fs::write(tile_dir.join(format!("{}.pbf", key.y)), bytes)?;
    }

    let tilejson = json!({
        "tilejson": "3.0.0",
        "name": "Mapshow game roads",
        "description": "Schema-v3 simulation road tiles generated by mapshow-roadgen",
        "attribution": "© OpenStreetMap contributors",
        "minzoom": MIN_ZOOM,
        "maxzoom": MAX_ZOOM,
        "tiles": [tile_url_template],
        "vector_layers": [vector_layer_metadata()]
    });
    fs::write(
        output_dir.join("tilejson.json"),
        serde_json::to_vec_pretty(&tilejson)?,
    )?;

    Ok(TileBuildSummary {
        input_segments: dataset.segments.len(),
        output_tiles: buckets.len(),
        min_zoom: MIN_ZOOM,
        max_zoom: MAX_ZOOM,
    })
}

pub fn write_pmtiles(dataset: &RoadDataset, output: &Path) -> Result<TileBuildSummary> {
    let buckets = build_tile_buckets(dataset);
    let (min_lng, min_lat, max_lng, max_lat) = dataset_bounds(dataset).unwrap_or((-180.0, -85.0, 180.0, 85.0));
    let center_lng = (min_lng + max_lng) / 2.0;
    let center_lat = (min_lat + max_lat) / 2.0;
    let metadata = json!({
        "name": "Mapshow game roads",
        "description": "Schema-v3 simulation road tiles generated by mapshow-roadgen",
        "attribution": "© OpenStreetMap contributors",
        "vector_layers": [vector_layer_metadata()]
    })
    .to_string();

    let file = File::create(output).with_context(|| format!("creating {}", output.display()))?;
    let mut writer = PmTilesWriter::new(TileType::Mvt)
        .min_zoom(MIN_ZOOM)
        .max_zoom(MAX_ZOOM)
        .bounds(min_lng, min_lat, max_lng, max_lat)
        .center(center_lng, center_lat)
        .center_zoom(MIN_ZOOM)
        .metadata(&metadata)
        .create(file)
        .context("creating PMTiles writer")?;

    for (key, features) in &buckets {
        let bytes = encode_road_tile(features, MVT_EXTENT);
        if bytes.is_empty() {
            continue;
        }
        let coordinate = TileCoord::new(key.z, key.x, key.y).context("validating PMTiles coordinate")?;
        writer
            .add_tile(coordinate, &bytes)
            .context("writing PMTiles tile")?;
    }
    writer.finalize().context("finalizing PMTiles archive")?;

    Ok(TileBuildSummary {
        input_segments: dataset.segments.len(),
        output_tiles: buckets.len(),
        min_zoom: MIN_ZOOM,
        max_zoom: MAX_ZOOM,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_crossing_line_to_buffered_tile() {
        let lines = clip_polyline(&[(-1000.0, 2000.0), (5000.0, 2000.0)], -512.0, 4608.0);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0][0], (-512, 2000));
        assert_eq!(*lines[0].last().unwrap(), (4608, 2000));
    }

    #[test]
    fn web_mercator_projection_is_centered_at_zero_zero() {
        let (x, y) = project_to_tile_space(LngLat { lng: 0.0, lat: 0.0 }, 1);
        assert!((x - 1.0).abs() < 1e-9);
        assert!((y - 1.0).abs() < 1e-9);
    }
}
