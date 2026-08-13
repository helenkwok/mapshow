use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use osmpbf::{Element, ElementReader, RelMemberType};
use serde::Serialize;

use crate::normalize::{is_game_road, normalize_road_tags, RoadAttributes, Tags};
use crate::restriction::{
    encode_restrictions_for_from_way, parse_restriction, RestrictionMember,
    RestrictionMemberType, TurnRestriction,
};

#[derive(Debug, Clone)]
struct RawRoadWay {
    id: i64,
    tags: Tags,
    node_ids: Vec<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LngLat {
    pub lng: f64,
    pub lat: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RoadSegment {
    pub segment_id: i64,
    pub osm_id: i64,
    pub ordinal: usize,
    pub node_ids: Vec<i64>,
    pub coordinates: Vec<LngLat>,
    pub properties: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExtractionSummary {
    pub road_ways: usize,
    pub road_segments: usize,
    pub restrictions: usize,
    pub referenced_nodes: usize,
    pub resolved_nodes: usize,
}

#[derive(Debug, Clone)]
pub struct RoadDataset {
    pub segments: Vec<RoadSegment>,
    pub restrictions: Vec<TurnRestriction>,
    pub summary: ExtractionSummary,
}

fn collect_tags<'a>(tags: impl Iterator<Item = (&'a str, &'a str)>) -> Tags {
    tags.map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

fn member_type(member_type: RelMemberType) -> RestrictionMemberType {
    match member_type {
        RelMemberType::Node => RestrictionMemberType::Node,
        RelMemberType::Way => RestrictionMemberType::Way,
        RelMemberType::Relation => RestrictionMemberType::Relation,
    }
}

fn deterministic_segment_id(way_id: i64, first_node: i64, last_node: i64, ordinal: usize) -> i64 {
    // FNV-1a followed by a 53-bit mask keeps IDs exactly representable in JavaScript Number/MVT clients.
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for value in [way_id, first_node, last_node, ordinal as i64] {
        for byte in value.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    (hash & ((1_u64 << 53) - 1)) as i64
}

fn split_indices(node_ids: &[i64], usage: &HashMap<i64, u32>) -> Vec<usize> {
    if node_ids.len() < 2 {
        return Vec::new();
    }
    let mut breaks = vec![0];
    for (index, node_id) in node_ids.iter().enumerate().skip(1).take(node_ids.len() - 2) {
        if usage.get(node_id).copied().unwrap_or(0) > 1 {
            breaks.push(index);
        }
    }
    breaks.push(node_ids.len() - 1);
    breaks
}

fn split_way(
    way: &RawRoadWay,
    usage: &HashMap<i64, u32>,
    locations: &HashMap<i64, LngLat>,
    restrictions: &[TurnRestriction],
) -> Vec<RoadSegment> {
    let breaks = split_indices(&way.node_ids, usage);
    if breaks.len() < 2 {
        return Vec::new();
    }

    breaks
        .windows(2)
        .enumerate()
        .filter_map(|(ordinal, pair)| {
            let start = pair[0];
            let end = pair[1];
            if end <= start {
                return None;
            }
            let node_ids = way.node_ids[start..=end].to_vec();
            let coordinates = node_ids
                .iter()
                .map(|node_id| locations.get(node_id).copied())
                .collect::<Option<Vec<_>>>()?;
            if coordinates.len() < 2 {
                return None;
            }

            let first_node = *node_ids.first()?;
            let last_node = *node_ids.last()?;
            let RoadAttributes { mut properties } = normalize_road_tags(
                &way.tags,
                way.id,
                Some(first_node),
                Some(last_node),
                node_ids.len(),
            )?;
            let segment_id = deterministic_segment_id(way.id, first_node, last_node, ordinal);
            properties.insert("segment_id".into(), serde_json::json!(segment_id));

            let encoded_restrictions = encode_restrictions_for_from_way(restrictions, way.id);
            if encoded_restrictions != "[]" {
                properties.insert(
                    "turn_restrictions".into(),
                    serde_json::json!(encoded_restrictions),
                );
            }

            Some(RoadSegment {
                segment_id,
                osm_id: way.id,
                ordinal,
                node_ids,
                coordinates,
                properties,
            })
        })
        .collect()
}

pub fn read_road_dataset(path: &Path) -> Result<RoadDataset> {
    let mut ways = Vec::<RawRoadWay>::new();
    let mut restrictions = Vec::<TurnRestriction>::new();
    let mut node_usage = HashMap::<i64, u32>::new();
    let mut referenced_nodes = HashSet::<i64>::new();

    ElementReader::from_path(path)
        .with_context(|| format!("opening OSM PBF {}", path.display()))?
        .for_each(|element| match element {
            Element::Way(way) => {
                let tags = collect_tags(way.tags());
                if !is_game_road(&tags) {
                    return;
                }
                let node_ids = way.refs().collect::<Vec<_>>();
                for node_id in &node_ids {
                    *node_usage.entry(*node_id).or_default() += 1;
                    referenced_nodes.insert(*node_id);
                }
                ways.push(RawRoadWay {
                    id: way.id(),
                    tags,
                    node_ids,
                });
            }
            Element::Relation(relation) => {
                let tags = collect_tags(relation.tags());
                let members = relation
                    .members()
                    .filter_map(|member| {
                        let role = member.role().ok()?.to_owned();
                        Some(RestrictionMember {
                            member_type: member_type(member.member_type),
                            id: member.member_id,
                            role,
                        })
                    })
                    .collect::<Vec<_>>();
                if let Some(restriction) = parse_restriction(relation.id(), &tags, &members) {
                    restrictions.push(restriction);
                }
            }
            _ => {}
        })
        .with_context(|| format!("reading OSM ways/relations from {}", path.display()))?;

    let mut locations = HashMap::<i64, LngLat>::with_capacity(referenced_nodes.len());
    ElementReader::from_path(path)
        .with_context(|| format!("reopening OSM PBF {} for node coordinates", path.display()))?
        .for_each(|element| match element {
            Element::Node(node) if referenced_nodes.contains(&node.id()) => {
                locations.insert(
                    node.id(),
                    LngLat {
                        lng: node.lon(),
                        lat: node.lat(),
                    },
                );
            }
            Element::DenseNode(node) if referenced_nodes.contains(&node.id()) => {
                locations.insert(
                    node.id(),
                    LngLat {
                        lng: node.lon(),
                        lat: node.lat(),
                    },
                );
            }
            _ => {}
        })
        .with_context(|| format!("reading node coordinates from {}", path.display()))?;

    let mut segments = Vec::new();
    for way in &ways {
        segments.extend(split_way(way, &node_usage, &locations, &restrictions));
    }

    let summary = ExtractionSummary {
        road_ways: ways.len(),
        road_segments: segments.len(),
        restrictions: restrictions.len(),
        referenced_nodes: referenced_nodes.len(),
        resolved_nodes: locations.len(),
    };

    Ok(RoadDataset {
        segments,
        restrictions,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_segment_ids_fit_javascript_integer_range() {
        let id = deterministic_segment_id(1_234_567_890, 10, 20, 3);
        assert!(id >= 0);
        assert!(id <= (1_i64 << 53) - 1);
        assert_eq!(id, deterministic_segment_id(1_234_567_890, 10, 20, 3));
        assert_ne!(id, deterministic_segment_id(1_234_567_890, 20, 30, 4));
    }

    #[test]
    fn splits_at_nodes_shared_by_multiple_ways() {
        let usage = HashMap::from([(1, 1), (2, 2), (3, 1), (4, 1)]);
        assert_eq!(split_indices(&[1, 2, 3], &usage), vec![0, 1, 2]);
        assert_eq!(split_indices(&[2, 4], &usage), vec![0, 1]);
    }
}
