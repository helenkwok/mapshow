use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::normalize::Tags;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestrictionMemberType {
    Node,
    Way,
    Relation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestrictionMember {
    pub member_type: RestrictionMemberType,
    pub id: i64,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnRestriction {
    pub id: i64,
    pub restriction: Option<String>,
    pub conditional: Option<String>,
    pub except: Option<String>,
    pub from_way: i64,
    pub to_way: i64,
    pub via_node: Option<i64>,
    pub via_way: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct TileRestriction {
    id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    restriction: Option<String>,
    #[serde(rename = "to")]
    to_way: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    via_node: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    via_way: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    except: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conditional: Option<String>,
}

fn non_empty(tags: &Tags, key: &str) -> Option<String> {
    tags.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn parse_restriction(
    id: i64,
    tags: &Tags,
    members: &[RestrictionMember],
) -> Option<TurnRestriction> {
    if tags.get("type").map(String::as_str) != Some("restriction") {
        return None;
    }

    let restriction = non_empty(tags, "restriction");
    let conditional = non_empty(tags, "restriction:conditional");
    if restriction.is_none() && conditional.is_none() {
        return None;
    }

    let mut from_way = None;
    let mut to_way = None;
    let mut via_node = None;
    let mut via_way = None;

    for member in members {
        match (member.role.as_str(), member.member_type) {
            ("from", RestrictionMemberType::Way) => from_way = Some(member.id),
            ("to", RestrictionMemberType::Way) => to_way = Some(member.id),
            ("via", RestrictionMemberType::Node) => via_node = Some(member.id),
            ("via", RestrictionMemberType::Way) => via_way = Some(member.id),
            _ => {}
        }
    }

    Some(TurnRestriction {
        id,
        restriction,
        conditional,
        except: non_empty(tags, "except"),
        from_way: from_way?,
        to_way: to_way?,
        via_node: match (via_node, via_way) {
            (None, None) => return None,
            (node, _) => node,
        },
        via_way,
    })
}

pub fn encode_restrictions_for_from_way(
    restrictions: &[TurnRestriction],
    from_way: i64,
) -> String {
    let encoded = restrictions
        .iter()
        .filter(|restriction| restriction.from_way == from_way)
        .map(|restriction| TileRestriction {
            id: restriction.id,
            restriction: restriction.restriction.clone(),
            to_way: restriction.to_way,
            via_node: restriction.via_node,
            via_way: restriction.via_way,
            except: restriction.except.clone(),
            conditional: restriction.conditional.clone(),
        })
        .collect::<Vec<_>>();

    serde_json::to_string(&encoded).expect("serializing a restriction vector cannot fail")
}

/// Builds a relation-id keyed index useful during multi-pass PBF processing.
pub fn index_restrictions(
    restrictions: impl IntoIterator<Item = TurnRestriction>,
) -> BTreeMap<i64, TurnRestriction> {
    restrictions
        .into_iter()
        .map(|restriction| (restriction.id, restriction))
        .collect()
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
    fn parses_simple_via_node_restriction() {
        let restriction = parse_restriction(
            99,
            &tags(&[("type", "restriction"), ("restriction", "no_right_turn")]),
            &[
                RestrictionMember {
                    member_type: RestrictionMemberType::Way,
                    id: 10,
                    role: "from".into(),
                },
                RestrictionMember {
                    member_type: RestrictionMemberType::Node,
                    id: 20,
                    role: "via".into(),
                },
                RestrictionMember {
                    member_type: RestrictionMemberType::Way,
                    id: 30,
                    role: "to".into(),
                },
            ],
        )
        .expect("restriction should parse");

        assert_eq!(restriction.from_way, 10);
        assert_eq!(restriction.to_way, 30);
        assert_eq!(restriction.via_node, Some(20));
        assert_eq!(restriction.via_way, None);
        assert_eq!(restriction.restriction.as_deref(), Some("no_right_turn"));
    }

    #[test]
    fn preserves_via_way_conditional_and_exceptions() {
        let restriction = parse_restriction(
            100,
            &tags(&[
                ("type", "restriction"),
                ("restriction:conditional", "no_left_turn @ (Mo-Fr 07:00-09:00)"),
                ("except", "bus;bicycle"),
            ]),
            &[
                RestrictionMember {
                    member_type: RestrictionMemberType::Way,
                    id: 1,
                    role: "from".into(),
                },
                RestrictionMember {
                    member_type: RestrictionMemberType::Way,
                    id: 2,
                    role: "via".into(),
                },
                RestrictionMember {
                    member_type: RestrictionMemberType::Way,
                    id: 3,
                    role: "to".into(),
                },
            ],
        )
        .expect("conditional restriction should parse");

        assert_eq!(restriction.via_way, Some(2));
        assert_eq!(restriction.except.as_deref(), Some("bus;bicycle"));
        assert!(restriction.conditional.is_some());
    }

    #[test]
    fn emits_typescript_compatible_json_shape() {
        let restrictions = vec![TurnRestriction {
            id: 7,
            restriction: Some("only_straight_on".into()),
            conditional: None,
            except: Some("bicycle".into()),
            from_way: 10,
            to_way: 30,
            via_node: Some(20),
            via_way: None,
        }];

        assert_eq!(
            encode_restrictions_for_from_way(&restrictions, 10),
            r#"[{"id":7,"restriction":"only_straight_on","to":30,"via_node":20,"except":"bicycle"}]"#
        );
    }
}
