use std::collections::{BTreeMap, HashMap};

use prost::Message;
use serde_json::Value as JsonValue;

use crate::schema::LAYER_NAME;

#[derive(Clone, PartialEq, Message)]
struct Tile {
    #[prost(message, repeated, tag = "3")]
    layers: Vec<Layer>,
}

#[derive(Clone, PartialEq, Message)]
struct Layer {
    #[prost(uint32, required, tag = "15")]
    version: u32,
    #[prost(string, required, tag = "1")]
    name: String,
    #[prost(message, repeated, tag = "2")]
    features: Vec<Feature>,
    #[prost(string, repeated, tag = "3")]
    keys: Vec<String>,
    #[prost(message, repeated, tag = "4")]
    values: Vec<MvtValue>,
    #[prost(uint32, optional, tag = "5")]
    extent: Option<u32>,
}

#[derive(Clone, PartialEq, Message)]
struct Feature {
    #[prost(uint64, optional, tag = "1")]
    id: Option<u64>,
    #[prost(uint32, repeated, packed = "true", tag = "2")]
    tags: Vec<u32>,
    #[prost(enumeration = "GeomType", optional, tag = "3")]
    r#type: Option<i32>,
    #[prost(uint32, repeated, packed = "true", tag = "4")]
    geometry: Vec<u32>,
}

#[derive(Clone, PartialEq, Message)]
struct MvtValue {
    #[prost(string, optional, tag = "1")]
    string_value: Option<String>,
    #[prost(float, optional, tag = "2")]
    float_value: Option<f32>,
    #[prost(double, optional, tag = "3")]
    double_value: Option<f64>,
    #[prost(int64, optional, tag = "4")]
    int_value: Option<i64>,
    #[prost(uint64, optional, tag = "5")]
    uint_value: Option<u64>,
    #[prost(sint64, optional, tag = "6")]
    sint_value: Option<i64>,
    #[prost(bool, optional, tag = "7")]
    bool_value: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
enum GeomType {
    Unknown = 0,
    Point = 1,
    Linestring = 2,
    Polygon = 3,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TileRoadFeature {
    pub id: u64,
    pub properties: BTreeMap<String, JsonValue>,
    pub lines: Vec<Vec<(i32, i32)>>,
}

fn mvt_value(value: &JsonValue) -> Option<MvtValue> {
    let mut result = MvtValue {
        string_value: None,
        float_value: None,
        double_value: None,
        int_value: None,
        uint_value: None,
        sint_value: None,
        bool_value: None,
    };

    match value {
        JsonValue::String(value) => result.string_value = Some(value.clone()),
        JsonValue::Bool(value) => result.bool_value = Some(*value),
        JsonValue::Number(value) => {
            if let Some(value) = value.as_i64() {
                result.int_value = Some(value);
            } else if let Some(value) = value.as_u64() {
                result.uint_value = Some(value);
            } else if let Some(value) = value.as_f64() {
                result.double_value = Some(value);
            } else {
                return None;
            }
        }
        JsonValue::Null | JsonValue::Array(_) | JsonValue::Object(_) => return None,
    }
    Some(result)
}

fn command(id: u32, count: usize) -> u32 {
    ((count as u32) << 3) | id
}

fn zigzag(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)) as u32
}

fn deduplicate_line(line: &[(i32, i32)]) -> Vec<(i32, i32)> {
    let mut result = Vec::with_capacity(line.len());
    for point in line {
        if result.last() != Some(point) {
            result.push(*point);
        }
    }
    result
}

fn encode_geometry(lines: &[Vec<(i32, i32)>]) -> Vec<u32> {
    let mut geometry = Vec::new();
    let mut cursor = (0_i32, 0_i32);

    for line in lines {
        let line = deduplicate_line(line);
        if line.len() < 2 {
            continue;
        }

        let first = line[0];
        geometry.push(command(1, 1));
        geometry.push(zigzag(first.0 - cursor.0));
        geometry.push(zigzag(first.1 - cursor.1));
        cursor = first;

        geometry.push(command(2, line.len() - 1));
        for point in &line[1..] {
            geometry.push(zigzag(point.0 - cursor.0));
            geometry.push(zigzag(point.1 - cursor.1));
            cursor = *point;
        }
    }

    geometry
}

pub fn encode_road_tile(features: &[TileRoadFeature], extent: u32) -> Vec<u8> {
    let mut keys = Vec::<String>::new();
    let mut key_indices = HashMap::<String, u32>::new();
    let mut values = Vec::<MvtValue>::new();
    let mut encoded_features = Vec::<Feature>::new();

    for feature in features {
        let geometry = encode_geometry(&feature.lines);
        if geometry.is_empty() {
            continue;
        }

        let mut tags = Vec::<u32>::new();
        for (key, value) in &feature.properties {
            let Some(value) = mvt_value(value) else {
                continue;
            };
            let key_index = if let Some(index) = key_indices.get(key) {
                *index
            } else {
                let index = keys.len() as u32;
                keys.push(key.clone());
                key_indices.insert(key.clone(), index);
                index
            };
            let value_index = values.len() as u32;
            values.push(value);
            tags.push(key_index);
            tags.push(value_index);
        }

        encoded_features.push(Feature {
            id: Some(feature.id),
            tags,
            r#type: Some(GeomType::Linestring as i32),
            geometry,
        });
    }

    if encoded_features.is_empty() {
        return Vec::new();
    }

    Tile {
        layers: vec![Layer {
            version: 2,
            name: LAYER_NAME.to_owned(),
            features: encoded_features,
            keys,
            values,
            extent: Some(extent),
        }],
    }
    .encode_to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encodes_non_empty_linestring_tile() {
        let bytes = encode_road_tile(
            &[TileRoadFeature {
                id: 7,
                properties: BTreeMap::from([
                    ("schema_version".into(), json!(3)),
                    ("highway".into(), json!("residential")),
                    ("bridge".into(), json!(false)),
                ]),
                lines: vec![vec![(0, 0), (100, 50), (200, 50)]],
            }],
            4096,
        );
        assert!(!bytes.is_empty());
        let decoded = Tile::decode(bytes.as_slice()).expect("encoded MVT must decode");
        assert_eq!(decoded.layers.len(), 1);
        assert_eq!(decoded.layers[0].name, LAYER_NAME);
        assert_eq!(decoded.layers[0].features.len(), 1);
        assert_eq!(decoded.layers[0].features[0].r#type, Some(2));
    }
}
