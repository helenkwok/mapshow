package org.mapshow.roads;

import com.onthegomap.planetiler.reader.osm.OsmElement;
import com.onthegomap.planetiler.reader.osm.OsmReader;
import com.onthegomap.planetiler.reader.osm.OsmRelationInfo;
import java.util.List;

/** Compact restriction relation data retained in memory during Planetiler's OSM passes. */
record TurnRestrictionInfo(
  @Override long id,
  String restriction,
  String conditional,
  String except,
  long fromWay,
  long toWay,
  Long viaNode,
  Long viaWay
) implements OsmRelationInfo {

  static TurnRestrictionInfo fromRelation(OsmElement.Relation relation) {
    if (!relation.hasTag("type", "restriction")) return null;
    String restriction = stringTag(relation, "restriction");
    String conditional = stringTag(relation, "restriction:conditional");
    if (restriction == null && conditional == null) return null;

    Long fromWay = null;
    Long toWay = null;
    Long viaNode = null;
    Long viaWay = null;
    for (var member : relation.members()) {
      if ("from".equals(member.role()) && member.type() == OsmElement.Type.WAY) {
        fromWay = member.ref();
      } else if ("to".equals(member.role()) && member.type() == OsmElement.Type.WAY) {
        toWay = member.ref();
      } else if ("via".equals(member.role())) {
        if (member.type() == OsmElement.Type.NODE) viaNode = member.ref();
        else if (member.type() == OsmElement.Type.WAY) viaWay = member.ref();
      }
    }
    if (fromWay == null || toWay == null || (viaNode == null && viaWay == null)) return null;

    return new TurnRestrictionInfo(
      relation.id(),
      restriction,
      conditional,
      stringTag(relation, "except"),
      fromWay,
      toWay,
      viaNode,
      viaWay
    );
  }

  static String encodeForFromWay(List<OsmReader.RelationMember<TurnRestrictionInfo>> memberships) {
    StringBuilder json = new StringBuilder("[");
    boolean first = true;
    for (var membership : memberships) {
      if (!"from".equals(membership.role())) continue;
      var restriction = membership.relation();
      if (!first) json.append(',');
      first = false;
      json.append('{')
        .append("\"id\":").append(restriction.id())
        .append(",\"restriction\":").append(jsonString(restriction.restriction()))
        .append(",\"to\":").append(restriction.toWay());
      if (restriction.viaNode() != null) {
        json.append(",\"via_node\":").append(restriction.viaNode());
      }
      if (restriction.viaWay() != null) {
        json.append(",\"via_way\":").append(restriction.viaWay());
      }
      if (restriction.except() != null) {
        json.append(",\"except\":").append(jsonString(restriction.except()));
      }
      if (restriction.conditional() != null) {
        json.append(",\"conditional\":").append(jsonString(restriction.conditional()));
      }
      json.append('}');
    }
    return json.append(']').toString();
  }

  private static String stringTag(OsmElement relation, String key) {
    Object value = relation.tags().get(key);
    if (value == null) return null;
    String string = value.toString().trim();
    return string.isEmpty() ? null : string;
  }

  private static String jsonString(String value) {
    if (value == null) return "null";
    StringBuilder escaped = new StringBuilder("\"");
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '\\' -> escaped.append("\\\\");
        case '"' -> escaped.append("\\\"");
        case '\n' -> escaped.append("\\n");
        case '\r' -> escaped.append("\\r");
        case '\t' -> escaped.append("\\t");
        default -> escaped.append(c);
      }
    }
    return escaped.append('"').toString();
  }
}
