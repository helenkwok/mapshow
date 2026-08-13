pub mod normalize;
pub mod restriction;
pub mod schema;

pub use normalize::{is_game_road, normalize_road_tags, RoadAttributes, Tags};
pub use restriction::{
    encode_restrictions_for_from_way, parse_restriction, RestrictionMember,
    RestrictionMemberType, TurnRestriction,
};
pub use schema::SCHEMA_VERSION;
