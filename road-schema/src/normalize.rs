use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::schema::SCHEMA_VERSION;

pub type Tags = BTreeMap<String, String>;

#[derive(Debug, Clone, PartialEq)]
pub struct RoadAttributes {
    pub properties: BTreeMap<String, Value>,
}

const GAME_ROADS: &[&str] = &[
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "road",
    "track",
    "raceway",
    "busway",
];

const PAVED_SURFACES: &[&str] = &[
    "paved",
    "asphalt",
    "concrete",
    "concrete:lanes",
    "concrete:plates",
    "paving_stones",
    "sett",
    "unhewn_cobblestone",
    "cobblestone",
    "metal",
    "wood",
];

const UNPAVED_SURFACES: &[&str] = &[
    "unpaved",
    "compacted",
    "fine_gravel",
    "gravel",
    "pebblestone",
    "rock",
    "dirt",
    "earth",
    "ground",
    "mud",
    "sand",
    "grass",
    "grass_paver",
    "clay",
];

fn non_empty<'a>(tags: &'a Tags, key: &str) -> Option<&'a str> {
    tags.get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn truthy(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("yes" | "true" | "1")
    )
}

pub fn is_game_road(tags: &Tags) -> bool {
    let Some(highway) = non_empty(tags, "highway") else {
        return false;
    };
    GAME_ROADS.contains(&highway) && !truthy(non_empty(tags, "area"))
}

fn first_number(value: &str) -> Option<f64> {
    let mut start = None;
    let mut end = 0;
    let mut seen_digit = false;

    for (index, ch) in value.char_indices() {
        let allowed =
            ch.is_ascii_digit() || ch == '.' || ((ch == '+' || ch == '-') && start.is_none());
        if allowed {
            if start.is_none() {
                start = Some(index);
            }
            if ch.is_ascii_digit() {
                seen_digit = true;
            }
            end = index + ch.len_utf8();
        } else if start.is_some() {
            if seen_digit {
                break;
            }
            start = None;
        }
    }

    let start = start?;
    if !seen_digit {
        return None;
    }
    value[start..end].parse::<f64>().ok()
}

fn integer(tags: &Tags, key: &str) -> Option<i64> {
    first_number(non_empty(tags, key)?).map(|value| value.round() as i64)
}

pub fn speed_kmh(value: Option<&str>) -> Option<f64> {
    let raw = value?.trim().to_ascii_lowercase();
    let number = first_number(&raw)?;
    if raw.contains("mph") {
        Some(number * 1.609_344)
    } else if raw.contains("knot") {
        Some(number * 1.852)
    } else {
        Some(number)
    }
}

pub fn meters(value: Option<&str>) -> Option<f64> {
    let raw = value?.trim().to_ascii_lowercase();
    let number = first_number(&raw)?;
    if raw.contains("ft") || raw.contains("feet") || raw.contains("foot") || raw.contains('\'') {
        Some(number * 0.3048)
    } else {
        Some(number)
    }
}

fn road_class(highway: &str) -> &str {
    highway.strip_suffix("_link").unwrap_or(highway)
}

fn class_priority(class: &str) -> i64 {
    match class {
        "motorway" => 9,
        "trunk" => 8,
        "primary" => 7,
        "secondary" => 6,
        "tertiary" => 5,
        "unclassified" | "residential" => 4,
        "living_street" | "busway" => 3,
        "service" | "road" => 2,
        "track" => 1,
        "raceway" => 5,
        _ => 0,
    }
}

fn lane_width(class: &str) -> f64 {
    match class {
        "motorway" | "trunk" | "raceway" => 3.6,
        "primary" | "secondary" => 3.4,
        "track" => 3.0,
        _ => 3.2,
    }
}

fn estimated_width_meters(class: &str, lanes: Option<i64>) -> f64 {
    if let Some(lanes) = lanes.filter(|lanes| *lanes > 0) {
        return 2.8_f64.max(lanes as f64 * lane_width(class));
    }
    match class {
        "motorway" | "trunk" => 7.4,
        "primary" | "secondary" => 6.8,
        "tertiary" | "unclassified" | "residential" => 6.0,
        "living_street" | "service" => 4.5,
        "track" => 3.2,
        "raceway" => 8.0,
        "busway" => 3.5,
        _ => 5.5,
    }
}

fn surface_class(surface: Option<&str>) -> &'static str {
    let Some(surface) = surface else {
        return "unknown";
    };
    let normalized = surface.to_ascii_lowercase();
    if PAVED_SURFACES.contains(&normalized.as_str()) {
        "paved"
    } else if UNPAVED_SURFACES.contains(&normalized.as_str()) {
        "unpaved"
    } else {
        "unknown"
    }
}

fn flag(tags: &Tags, key: &str) -> bool {
    let Some(value) = non_empty(tags, key) else {
        return false;
    };
    !matches!(value.to_ascii_lowercase().as_str(), "no" | "0" | "false")
}

fn oneway(tags: &Tags, highway: &str) -> i64 {
    if let Some(raw) = non_empty(tags, "oneway") {
        match raw.to_ascii_lowercase().as_str() {
            "-1" | "reverse" => return -1,
            "yes" | "true" | "1" => return 1,
            "no" | "0" | "false" => return 0,
            _ => {}
        }
    }
    if non_empty(tags, "junction") == Some("roundabout") {
        return 1;
    }
    if matches!(highway, "motorway" | "motorway_link") {
        return 1;
    }
    0
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn insert_string(properties: &mut BTreeMap<String, Value>, tags: &Tags, key: &str) {
    if let Some(value) = non_empty(tags, key) {
        properties.insert(key.to_owned(), json!(value));
    }
}

fn insert_raw(
    properties: &mut BTreeMap<String, Value>,
    tags: &Tags,
    source_key: &str,
    output_key: &str,
) {
    if let Some(value) = non_empty(tags, source_key) {
        properties.insert(output_key.to_owned(), json!(value));
    }
}

pub fn normalize_road_tags(
    tags: &Tags,
    osm_id: i64,
    first_node: Option<i64>,
    last_node: Option<i64>,
    node_count: usize,
) -> Option<RoadAttributes> {
    let highway = non_empty(tags, "highway")?;
    let class = road_class(highway);
    let lanes = integer(tags, "lanes");
    let explicit_width = meters(non_empty(tags, "width"));
    let tagged_speed = speed_kmh(non_empty(tags, "maxspeed"));
    let bridge = flag(tags, "bridge");
    let tunnel = flag(tags, "tunnel");
    let layer = integer(tags, "layer").unwrap_or(0);
    let priority = class_priority(class);

    let mut properties = BTreeMap::new();
    properties.insert("schema_version".into(), json!(SCHEMA_VERSION));
    properties.insert("osm_id".into(), json!(osm_id));
    properties.insert("highway".into(), json!(highway));
    properties.insert("road_class".into(), json!(class));
    properties.insert("is_link".into(), json!(highway.ends_with("_link")));
    properties.insert("oneway".into(), json!(oneway(tags, highway)));
    properties.insert("bridge".into(), json!(bridge));
    properties.insert("tunnel".into(), json!(tunnel));
    properties.insert("layer".into(), json!(layer));
    properties.insert(
        "z_order".into(),
        json!(layer * 10 + if bridge { 5 } else { 0 } - if tunnel { 5 } else { 0 } + priority),
    );
    properties.insert("node_count".into(), json!(node_count));
    if let Some(first_node) = first_node {
        properties.insert("first_node".into(), json!(first_node));
    }
    if let Some(last_node) = last_node {
        properties.insert("last_node".into(), json!(last_node));
    }

    for key in [
        "name",
        "ref",
        "service",
        "access",
        "vehicle",
        "motor_vehicle",
        "surface",
        "smoothness",
        "tracktype",
        "junction",
        "sidewalk",
        "cycleway",
        "lit",
        "incline",
    ] {
        insert_string(&mut properties, tags, key);
    }

    for (source, output) in [
        ("lanes", "lanes_raw"),
        ("lanes:forward", "lanes_forward_raw"),
        ("lanes:backward", "lanes_backward_raw"),
        ("maxspeed", "maxspeed_raw"),
        ("maxspeed:forward", "maxspeed_forward_raw"),
        ("maxspeed:backward", "maxspeed_backward_raw"),
        ("width", "width_raw"),
        ("oneway", "oneway_raw"),
        ("turn:lanes", "turn_lanes_raw"),
        ("turn:lanes:forward", "turn_lanes_forward_raw"),
        ("turn:lanes:backward", "turn_lanes_backward_raw"),
        ("change:lanes", "change_lanes_raw"),
        ("change:lanes:forward", "change_lanes_forward_raw"),
        ("change:lanes:backward", "change_lanes_backward_raw"),
    ] {
        insert_raw(&mut properties, tags, source, output);
    }

    if let Some(lanes) = lanes {
        properties.insert("lanes".into(), json!(lanes));
    }
    if let Some(value) = integer(tags, "lanes:forward") {
        properties.insert("lanes_forward".into(), json!(value));
    }
    if let Some(value) = integer(tags, "lanes:backward") {
        properties.insert("lanes_backward".into(), json!(value));
    }

    if let Some(speed) = tagged_speed {
        properties.insert("speed_kmh".into(), json!(round1(speed)));
    }
    if let Some(speed) = speed_kmh(non_empty(tags, "maxspeed:forward")) {
        properties.insert("speed_forward_kmh".into(), json!(round1(speed)));
    }
    if let Some(speed) = speed_kmh(non_empty(tags, "maxspeed:backward")) {
        properties.insert("speed_backward_kmh".into(), json!(round1(speed)));
    }

    let width = explicit_width.unwrap_or_else(|| estimated_width_meters(class, lanes));
    properties.insert("width_m".into(), json!(round1(width)));
    properties.insert(
        "width_source".into(),
        json!(if explicit_width.is_some() {
            "tag"
        } else if lanes.is_some() {
            "lanes"
        } else {
            "class_default"
        }),
    );
    properties.insert(
        "surface_class".into(),
        json!(surface_class(non_empty(tags, "surface"))),
    );
    properties.insert("priority".into(), json!(priority));

    Some(RoadAttributes { properties })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(entries: &[(&str, &str)]) -> Tags {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn filters_non_game_roads_and_areas() {
        assert!(is_game_road(&tags(&[("highway", "residential")])));
        assert!(is_game_road(&tags(&[("highway", "motorway_link")])));
        assert!(!is_game_road(&tags(&[("highway", "footway")])));
        assert!(!is_game_road(&tags(&[
            ("highway", "residential"),
            ("area", "yes"),
        ])));
    }

    #[test]
    fn matches_java_driving_metadata_contract() {
        let attributes = normalize_road_tags(
            &tags(&[
                ("highway", "primary"),
                ("name", "Main Road"),
                ("lanes", "2"),
                ("maxspeed", "50 mph"),
                ("surface", "asphalt"),
                ("bridge", "yes"),
                ("layer", "1"),
                ("oneway", "yes"),
                ("turn:lanes", "left|through;right"),
            ]),
            1234,
            Some(10),
            Some(20),
            7,
        )
        .expect("road should normalize");

        let p = attributes.properties;
        assert_eq!(p["schema_version"], json!(3));
        assert_eq!(p["osm_id"], json!(1234));
        assert_eq!(p["road_class"], json!("primary"));
        assert_eq!(p["lanes"], json!(2));
        assert_eq!(p["speed_kmh"], json!(80.5));
        assert_eq!(p["width_m"], json!(6.8));
        assert_eq!(p["width_source"], json!("lanes"));
        assert_eq!(p["surface_class"], json!("paved"));
        assert_eq!(p["bridge"], json!(true));
        assert_eq!(p["layer"], json!(1));
        assert_eq!(p["oneway"], json!(1));
        assert_eq!(p["first_node"], json!(10));
        assert_eq!(p["last_node"], json!(20));
        assert_eq!(p["node_count"], json!(7));
        assert_eq!(p["turn_lanes_raw"], json!("left|through;right"));
    }

    #[test]
    fn explicit_width_and_roundabout_parity() {
        let attributes = normalize_road_tags(
            &tags(&[
                ("highway", "residential"),
                ("width", "5.5 m"),
                ("junction", "roundabout"),
            ]),
            1,
            None,
            None,
            0,
        )
        .unwrap();
        assert_eq!(attributes.properties["width_m"], json!(5.5));
        assert_eq!(attributes.properties["width_source"], json!("tag"));
        assert_eq!(attributes.properties["oneway"], json!(1));
    }

    #[test]
    fn unknown_speed_is_preserved_raw_without_guessing() {
        let attributes = normalize_road_tags(
            &tags(&[("highway", "secondary"), ("maxspeed", "signals")]),
            2,
            None,
            None,
            0,
        )
        .unwrap();
        assert_eq!(attributes.properties["maxspeed_raw"], json!("signals"));
        assert!(!attributes.properties.contains_key("speed_kmh"));
    }

    #[test]
    fn converts_imperial_width() {
        let converted = meters(Some("12 ft")).unwrap();
        assert!((converted - 3.6576).abs() < 0.0001);
    }
}
