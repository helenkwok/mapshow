use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::path::Path;

use anyhow::{Context, Result, anyhow};
use osmpbf::{Element, ElementReader, RelMemberType};
use pmtiles::{PmTilesWriter, TileCoord, TileType};
use redb::{Database, ReadableTable, ReadableTableMetadata, TableDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::mvt::{TileRoadFeature, encode_road_tile};
use crate::normalize::{Tags, is_game_road, normalize_road_tags};
use crate::restriction::{
    RestrictionMember, RestrictionMemberType, TurnRestriction, encode_restrictions_for_from_way,
    parse_restriction,
};
use crate::schema::{LAYER_NAME, MAX_ZOOM, MIN_ZOOM};

const NODE_USAGE: TableDefinition<u64, u64> = TableDefinition::new("node_usage");
const NODE_COORDS: TableDefinition<u64, &[u8]> = TableDefinition::new("node_coords");
const TILE_RECORDS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("tile_records");

const MVT_EXTENT: u32 = 4096;
const BUFFER_FRACTION: f64 = 32.0 / 256.0;
const BUFFER_UNITS: f64 = MVT_EXTENT as f64 * BUFFER_FRACTION;
const USAGE_BATCH_LIMIT: usize = 250_000;
const COORD_BATCH_LIMIT: usize = 100_000;
const TILE_BATCH_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct TileKey {
    z: u8,
    x: u32,
    y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SpoolFeature {
    id: u64,
    properties: BTreeMap<String, Value>,
    lines: Vec<Vec<(i32, i32)>>,
}

impl From<SpoolFeature> for TileRoadFeature {
    fn from(feature: SpoolFeature) -> Self {
        Self {
            id: feature.id,
            properties: feature.properties,
            lines: feature.lines,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StreamingBuildSummary {
    pub road_ways: usize,
    pub road_segments: usize,
    pub restrictions: usize,
    pub referenced_nodes: usize,
    pub resolved_nodes: usize,
    pub output_tiles: usize,
    pub min_zoom: u8,
    pub max_zoom: u8,
}

struct PreparedScratch {
    _tempdir: TempDir,
    db: Database,
    summary: StreamingBuildSummary,
    bounds: Option<(f64, f64, f64, f64)>,
}

fn collect_tags<'a>(tags: impl Iterator<Item = (&'a str, &'a str)>) -> Tags {
    tags.map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

fn restriction_member_type(member_type: RelMemberType) -> RestrictionMemberType {
    match member_type {
        RelMemberType::Node => RestrictionMemberType::Node,
        RelMemberType::Way => RestrictionMemberType::Way,
        RelMemberType::Relation => RestrictionMemberType::Relation,
    }
}

fn deterministic_segment_id(way_id: i64, first_node: i64, last_node: i64, ordinal: usize) -> i64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for value in [way_id, first_node, last_node, ordinal as i64] {
        for byte in value.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    (hash & ((1_u64 << 53) - 1)) as i64
}

fn encode_coord(lng: f64, lat: f64) -> [u8; 16] {
    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&lng.to_le_bytes());
    bytes[8..].copy_from_slice(&lat.to_le_bytes());
    bytes
}

fn decode_coord(bytes: &[u8]) -> Result<(f64, f64)> {
    if bytes.len() != 16 {
        return Err(anyhow!("invalid coordinate payload length {}", bytes.len()));
    }
    let mut lng = [0_u8; 8];
    let mut lat = [0_u8; 8];
    lng.copy_from_slice(&bytes[..8]);
    lat.copy_from_slice(&bytes[8..]);
    Ok((f64::from_le_bytes(lng), f64::from_le_bytes(lat)))
}

fn flush_usage(db: &Database, batch: &mut HashMap<u64, u64>) -> Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    let write = db.begin_write()?;
    {
        let mut table = write.open_table(NODE_USAGE)?;
        for (node_id, increment) in batch.drain() {
            let current = table.get(&node_id)?.map(|value| value.value()).unwrap_or(0);
            table.insert(&node_id, &(current + increment))?;
        }
    }
    write.commit()?;
    Ok(())
}

fn flush_coords(db: &Database, batch: &mut Vec<(u64, [u8; 16])>) -> Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    let write = db.begin_write()?;
    {
        let mut table = write.open_table(NODE_COORDS)?;
        for (node_id, bytes) in batch.drain(..) {
            table.insert(&node_id, bytes.as_slice())?;
        }
    }
    write.commit()?;
    Ok(())
}

fn flush_tiles(db: &Database, batch: &mut Vec<(Vec<u8>, Vec<u8>)>) -> Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    let write = db.begin_write()?;
    {
        let mut table = write.open_table(TILE_RECORDS)?;
        for (key, value) in batch.drain(..) {
            table.insert(key.as_slice(), value.as_slice())?;
        }
    }
    write.commit()?;
    Ok(())
}

fn pass_one_usage_and_restrictions(
    input: &Path,
    db: &Database,
) -> Result<(usize, Vec<TurnRestriction>)> {
    let mut usage_batch = HashMap::<u64, u64>::new();
    let mut restrictions = Vec::<TurnRestriction>::new();
    let mut road_ways = 0_usize;
    let mut failure = None::<anyhow::Error>;

    ElementReader::from_path(input)?.for_each(|element| {
        if failure.is_some() {
            return;
        }
        match element {
            Element::Way(way) => {
                let tags = collect_tags(way.tags());
                if !is_game_road(&tags) {
                    return;
                }
                road_ways += 1;
                for node_id in way.refs() {
                    *usage_batch.entry(node_id as u64).or_default() += 1;
                }
                if usage_batch.len() >= USAGE_BATCH_LIMIT
                    && let Err(error) = flush_usage(db, &mut usage_batch)
                {
                    failure = Some(error);
                }
            }
            Element::Relation(relation) => {
                let tags = collect_tags(relation.tags());
                let members = relation
                    .members()
                    .filter_map(|member| {
                        Some(RestrictionMember {
                            member_type: restriction_member_type(member.member_type),
                            id: member.member_id,
                            role: member.role().ok()?.to_owned(),
                        })
                    })
                    .collect::<Vec<_>>();
                if let Some(restriction) = parse_restriction(relation.id(), &tags, &members) {
                    restrictions.push(restriction);
                }
            }
            _ => {}
        }
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    flush_usage(db, &mut usage_batch)?;
    Ok((road_ways, restrictions))
}

fn pass_two_coordinates(input: &Path, db: &Database) -> Result<usize> {
    let read = db.begin_read()?;
    let usage = read.open_table(NODE_USAGE)?;
    let mut coords_batch = Vec::<(u64, [u8; 16])>::new();
    let mut resolved = 0_usize;
    let mut failure = None::<anyhow::Error>;

    ElementReader::from_path(input)?.for_each(|element| {
        if failure.is_some() {
            return;
        }
        let coordinate = match element {
            Element::Node(node) => Some((node.id(), node.lon(), node.lat())),
            Element::DenseNode(node) => Some((node.id(), node.lon(), node.lat())),
            _ => None,
        };
        let Some((node_id, lng, lat)) = coordinate else {
            return;
        };
        match usage.get(&(node_id as u64)) {
            Ok(Some(_)) => {
                coords_batch.push((node_id as u64, encode_coord(lng, lat)));
                resolved += 1;
                if coords_batch.len() >= COORD_BATCH_LIMIT
                    && let Err(error) = flush_coords(db, &mut coords_batch)
                {
                    failure = Some(error);
                }
            }
            Ok(None) => {}
            Err(error) => failure = Some(error.into()),
        }
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    flush_coords(db, &mut coords_batch)?;
    Ok(resolved)
}

fn project_to_tile_space(lng: f64, lat: f64, zoom: u8) -> (f64, f64) {
    let n = 2_f64.powi(i32::from(zoom));
    let x = (lng + 180.0) / 360.0 * n;
    let latitude = lat.clamp(-85.051_128_78, 85.051_128_78).to_radians();
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

fn clip_polyline(points: &[(f64, f64)]) -> Vec<Vec<(i32, i32)>> {
    let min = -BUFFER_UNITS;
    let max = f64::from(MVT_EXTENT) + BUFFER_UNITS;
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
                .collect()
        })
        .collect()
}

fn tile_range(min: f64, max: f64, n: u32) -> (u32, u32) {
    let lower = (min - BUFFER_FRACTION).floor().max(0.0) as u32;
    let upper = (max + BUFFER_FRACTION)
        .floor()
        .min(f64::from(n.saturating_sub(1))) as u32;
    (lower.min(n - 1), upper.min(n - 1))
}

fn tile_record_key(tile: TileKey, sequence: u64) -> [u8; 17] {
    let mut key = [0_u8; 17];
    key[0] = tile.z;
    key[1..5].copy_from_slice(&tile.x.to_be_bytes());
    key[5..9].copy_from_slice(&tile.y.to_be_bytes());
    key[9..17].copy_from_slice(&sequence.to_be_bytes());
    key
}

fn decode_tile_key(key: &[u8]) -> Result<TileKey> {
    if key.len() != 17 {
        return Err(anyhow!("invalid tile spool key length {}", key.len()));
    }
    let mut x = [0_u8; 4];
    let mut y = [0_u8; 4];
    x.copy_from_slice(&key[1..5]);
    y.copy_from_slice(&key[5..9]);
    Ok(TileKey {
        z: key[0],
        x: u32::from_be_bytes(x),
        y: u32::from_be_bytes(y),
    })
}

fn spool_segment(
    segment_id: i64,
    coordinates: &[(f64, f64)],
    properties: &BTreeMap<String, Value>,
    sequence: &mut u64,
    batch: &mut Vec<(Vec<u8>, Vec<u8>)>,
) -> Result<()> {
    for zoom in MIN_ZOOM..=MAX_ZOOM {
        let n = 1_u32 << zoom;
        let projected = coordinates
            .iter()
            .map(|(lng, lat)| project_to_tile_space(*lng, *lat, zoom))
            .collect::<Vec<_>>();
        let min_x = projected.iter().map(|point| point.0).fold(f64::INFINITY, f64::min);
        let max_x = projected
            .iter()
            .map(|point| point.0)
            .fold(f64::NEG_INFINITY, f64::max);
        let min_y = projected.iter().map(|point| point.1).fold(f64::INFINITY, f64::min);
        let max_y = projected
            .iter()
            .map(|point| point.1)
            .fold(f64::NEG_INFINITY, f64::max);
        let (min_x_tile, max_x_tile) = tile_range(min_x, max_x, n);
        let (min_y_tile, max_y_tile) = tile_range(min_y, max_y, n);

        for x in min_x_tile..=max_x_tile {
            for y in min_y_tile..=max_y_tile {
                let local = projected
                    .iter()
                    .map(|(world_x, world_y)| {
                        (
                            (world_x - f64::from(x)) * f64::from(MVT_EXTENT),
                            (world_y - f64::from(y)) * f64::from(MVT_EXTENT),
                        )
                    })
                    .collect::<Vec<_>>();
                let lines = clip_polyline(&local);
                if lines.is_empty() {
                    continue;
                }
                let feature = SpoolFeature {
                    id: segment_id as u64,
                    properties: properties.clone(),
                    lines,
                };
                let key = tile_record_key(TileKey { z: zoom, x, y }, *sequence);
                *sequence += 1;
                batch.push((key.to_vec(), serde_json::to_vec(&feature)?));
            }
        }
    }
    Ok(())
}

fn usage_count(table: &impl ReadableTable<u64, u64>, node_id: i64) -> Result<u64> {
    Ok(table
        .get(&(node_id as u64))?
        .map(|value| value.value())
        .unwrap_or(0))
}

fn node_coordinate(table: &impl ReadableTable<u64, &[u8]>, node_id: i64) -> Result<(f64, f64)> {
    let value = table
        .get(&(node_id as u64))?
        .ok_or_else(|| anyhow!("missing coordinate for referenced OSM node {node_id}"))?;
    decode_coord(value.value())
}

fn pass_three_spool_tiles(
    input: &Path,
    db: &Database,
    restrictions: &[TurnRestriction],
) -> Result<(usize, Option<(f64, f64, f64, f64)>)> {
    let read = db.begin_read()?;
    let usage = read.open_table(NODE_USAGE)?;
    let coords = read.open_table(NODE_COORDS)?;
    let mut restrictions_by_from = HashMap::<i64, Vec<TurnRestriction>>::new();
    for restriction in restrictions {
        restrictions_by_from
            .entry(restriction.from_way)
            .or_default()
            .push(restriction.clone());
    }

    let mut tile_batch = Vec::<(Vec<u8>, Vec<u8>)>::new();
    let mut sequence = 0_u64;
    let mut segment_count = 0_usize;
    let mut bounds = None::<(f64, f64, f64, f64)>;
    let mut failure = None::<anyhow::Error>;

    ElementReader::from_path(input)?.for_each(|element| {
        if failure.is_some() {
            return;
        }
        let Element::Way(way) = element else {
            return;
        };
        let tags = collect_tags(way.tags());
        if !is_game_road(&tags) {
            return;
        }
        let node_ids = way.refs().collect::<Vec<_>>();
        if node_ids.len() < 2 {
            return;
        }

        let mut breaks = vec![0_usize];
        for (index, node_id) in node_ids.iter().enumerate().skip(1).take(node_ids.len() - 2) {
            match usage_count(&usage, *node_id) {
                Ok(count) if count > 1 => breaks.push(index),
                Ok(_) => {}
                Err(error) => {
                    failure = Some(error);
                    return;
                }
            }
        }
        breaks.push(node_ids.len() - 1);

        let way_restrictions = restrictions_by_from.get(&way.id()).map(Vec::as_slice).unwrap_or(&[]);
        for (ordinal, pair) in breaks.windows(2).enumerate() {
            let start = pair[0];
            let end = pair[1];
            if end <= start {
                continue;
            }
            let segment_nodes = &node_ids[start..=end];
            let first_node = segment_nodes[0];
            let last_node = *segment_nodes.last().unwrap();
            let mut segment_coords = Vec::with_capacity(segment_nodes.len());
            for node_id in segment_nodes {
                match node_coordinate(&coords, *node_id) {
                    Ok(coordinate) => segment_coords.push(coordinate),
                    Err(error) => {
                        failure = Some(error);
                        return;
                    }
                }
            }
            let Some(mut attributes) = normalize_road_tags(
                &tags,
                way.id(),
                Some(first_node),
                Some(last_node),
                segment_nodes.len(),
            ) else {
                continue;
            };
            let segment_id = deterministic_segment_id(way.id(), first_node, last_node, ordinal);
            attributes.properties.insert("segment_id".into(), json!(segment_id));
            let encoded_restrictions = encode_restrictions_for_from_way(way_restrictions, way.id());
            if encoded_restrictions != "[]" {
                attributes
                    .properties
                    .insert("turn_restrictions".into(), json!(encoded_restrictions));
            }

            for (lng, lat) in &segment_coords {
                bounds = Some(match bounds {
                    Some((min_lng, min_lat, max_lng, max_lat)) => (
                        min_lng.min(*lng),
                        min_lat.min(*lat),
                        max_lng.max(*lng),
                        max_lat.max(*lat),
                    ),
                    None => (*lng, *lat, *lng, *lat),
                });
            }

            if let Err(error) = spool_segment(
                segment_id,
                &segment_coords,
                &attributes.properties,
                &mut sequence,
                &mut tile_batch,
            ) {
                failure = Some(error);
                return;
            }
            segment_count += 1;
            if tile_batch.len() >= TILE_BATCH_LIMIT
                && let Err(error) = flush_tiles(db, &mut tile_batch)
            {
                failure = Some(error);
                return;
            }
        }
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    flush_tiles(db, &mut tile_batch)?;
    Ok((segment_count, bounds))
}

fn prepare_scratch(input: &Path) -> Result<PreparedScratch> {
    let tempdir = tempfile::tempdir().context("creating road generator scratch directory")?;
    let db = Database::create(tempdir.path().join("roadgen.redb"))?;
    let (road_ways, restrictions) = pass_one_usage_and_restrictions(input, &db)?;

    let read = db.begin_read()?;
    let usage_table = read.open_table(NODE_USAGE)?;
    let referenced_nodes = usage_table.len()? as usize;
    drop(usage_table);
    drop(read);

    let resolved_nodes = pass_two_coordinates(input, &db)?;
    let (road_segments, bounds) = pass_three_spool_tiles(input, &db, &restrictions)?;

    Ok(PreparedScratch {
        _tempdir: tempdir,
        db,
        summary: StreamingBuildSummary {
            road_ways,
            road_segments,
            restrictions: restrictions.len(),
            referenced_nodes,
            resolved_nodes,
            output_tiles: 0,
            min_zoom: MIN_ZOOM,
            max_zoom: MAX_ZOOM,
        },
        bounds,
    })
}

fn vector_layer_metadata() -> Value {
    json!({
        "id": LAYER_NAME,
        "description": "Mapshow simulation-oriented OpenStreetMap road segments",
        "minzoom": MIN_ZOOM,
        "maxzoom": MAX_ZOOM,
        "fields": {}
    })
}

fn consume_tile_records(
    db: &Database,
    mut sink: impl FnMut(TileKey, Vec<TileRoadFeature>) -> Result<()>,
) -> Result<usize> {
    let read = db.begin_read()?;
    let table = read.open_table(TILE_RECORDS)?;
    let mut current_key = None::<TileKey>;
    let mut current_features = Vec::<TileRoadFeature>::new();
    let mut tile_count = 0_usize;

    for record in table.iter()? {
        let (key, value) = record?;
        let tile_key = decode_tile_key(key.value())?;
        let feature: SpoolFeature = serde_json::from_slice(value.value())?;
        if current_key.is_some_and(|current| current != tile_key) {
            sink(current_key.unwrap(), std::mem::take(&mut current_features))?;
            tile_count += 1;
        }
        current_key = Some(tile_key);
        current_features.push(feature.into());
    }
    if let Some(tile_key) = current_key {
        sink(tile_key, current_features)?;
        tile_count += 1;
    }
    Ok(tile_count)
}

pub fn write_xyz_streaming(
    input: &Path,
    output_dir: &Path,
    tile_url_template: &str,
) -> Result<StreamingBuildSummary> {
    let mut prepared = prepare_scratch(input)?;
    fs::create_dir_all(output_dir)?;
    let output_tiles = consume_tile_records(&prepared.db, |key, features| {
        let bytes = encode_road_tile(&features, MVT_EXTENT);
        let directory = output_dir.join(key.z.to_string()).join(key.x.to_string());
        fs::create_dir_all(&directory)?;
        fs::write(directory.join(format!("{}.pbf", key.y)), bytes)?;
        Ok(())
    })?;

    let tilejson = json!({
        "tilejson": "3.0.0",
        "name": "Mapshow game roads",
        "description": "Schema-v3 simulation road tiles generated by the Rust mapshow-roadgen pipeline",
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
    prepared.summary.output_tiles = output_tiles;
    Ok(prepared.summary)
}

pub fn write_pmtiles_streaming(
    input: &Path,
    output: &Path,
) -> Result<StreamingBuildSummary> {
    let mut prepared = prepare_scratch(input)?;
    let (min_lng, min_lat, max_lng, max_lat) = prepared
        .bounds
        .unwrap_or((-180.0, -85.0, 180.0, 85.0));
    let metadata = json!({
        "name": "Mapshow game roads",
        "description": "Schema-v3 simulation road tiles generated by the Rust mapshow-roadgen pipeline",
        "attribution": "© OpenStreetMap contributors",
        "vector_layers": [vector_layer_metadata()]
    })
    .to_string();
    let file = File::create(output)?;
    let mut writer = PmTilesWriter::new(TileType::Mvt)
        .min_zoom(MIN_ZOOM)
        .max_zoom(MAX_ZOOM)
        .bounds(min_lng, min_lat, max_lng, max_lat)
        .center((min_lng + max_lng) / 2.0, (min_lat + max_lat) / 2.0)
        .center_zoom(MIN_ZOOM)
        .metadata(&metadata)
        .create(file)?;

    let output_tiles = consume_tile_records(&prepared.db, |key, features| {
        let bytes = encode_road_tile(&features, MVT_EXTENT);
        let coordinate = TileCoord::new(key.z, key.x, key.y)?;
        writer.add_tile(coordinate, &bytes)?;
        Ok(())
    })?;
    writer.finalize()?;
    prepared.summary.output_tiles = output_tiles;
    Ok(prepared.summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinate_round_trip_is_exact() {
        let bytes = encode_coord(138.6, -34.9);
        assert_eq!(decode_coord(&bytes).unwrap(), (138.6, -34.9));
    }

    #[test]
    fn tile_spool_keys_sort_by_tile_before_sequence() {
        let a = tile_record_key(TileKey { z: 12, x: 3, y: 4 }, 99);
        let b = tile_record_key(TileKey { z: 12, x: 3, y: 5 }, 0);
        assert!(a < b);
        assert_eq!(decode_tile_key(&a).unwrap(), TileKey { z: 12, x: 3, y: 4 });
    }

    #[test]
    fn deterministic_ids_stay_within_javascript_safe_integer_range() {
        let id = deterministic_segment_id(1234, 10, 20, 1);
        assert!(id <= (1_i64 << 53) - 1);
        assert_eq!(id, deterministic_segment_id(1234, 10, 20, 1));
    }
}
