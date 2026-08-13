package org.mapshow.roads;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.onthegomap.planetiler.reader.osm.OsmElement;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TurnRestrictionInfoTest {
  @Test
  void parsesSimpleViaNodeRestriction() {
    var relation = new OsmElement.Relation(
      99L,
      Map.of("type", "restriction", "restriction", "no_left_turn", "except", "bus"),
      List.of(
        new OsmElement.Relation.Member(OsmElement.Type.WAY, 10L, "from"),
        new OsmElement.Relation.Member(OsmElement.Type.NODE, 20L, "via"),
        new OsmElement.Relation.Member(OsmElement.Type.WAY, 30L, "to")
      )
    );

    var info = TurnRestrictionInfo.fromRelation(relation);
    assertEquals(99L, info.id());
    assertEquals("no_left_turn", info.restriction());
    assertEquals(10L, info.fromWay());
    assertEquals(30L, info.toWay());
    assertEquals(20L, info.viaNode());
    assertEquals("bus", info.except());
    assertNull(info.viaWay());
  }

  @Test
  void preservesConditionalViaWayRestriction() {
    var relation = new OsmElement.Relation(
      100L,
      Map.of("type", "restriction", "restriction:conditional", "no_straight_on @ (07:00-09:00)"),
      List.of(
        new OsmElement.Relation.Member(OsmElement.Type.WAY, 11L, "from"),
        new OsmElement.Relation.Member(OsmElement.Type.WAY, 21L, "via"),
        new OsmElement.Relation.Member(OsmElement.Type.WAY, 31L, "to")
      )
    );

    var info = TurnRestrictionInfo.fromRelation(relation);
    assertEquals(21L, info.viaWay());
    assertEquals("no_straight_on @ (07:00-09:00)", info.conditional());
    assertNull(info.viaNode());
  }

  @Test
  void ignoresNonRestrictionRelations() {
    var relation = new OsmElement.Relation(101L, Map.of("type", "route", "route", "bus"), List.of());
    assertNull(TurnRestrictionInfo.fromRelation(relation));
  }
}
