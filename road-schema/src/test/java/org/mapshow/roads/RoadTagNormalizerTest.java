package org.mapshow.roads;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

class RoadTagNormalizerTest {
  @Test
  void filtersPedestrianOnlyHighwaysAndAreas() {
    assertTrue(RoadTagNormalizer.isGameRoad(Map.of("highway", "residential")));
    assertTrue(RoadTagNormalizer.isGameRoad(Map.of("highway", "motorway_link")));
    assertFalse(RoadTagNormalizer.isGameRoad(Map.of("highway", "footway")));
    assertFalse(RoadTagNormalizer.isGameRoad(Map.of("highway", "residential", "area", "yes")));
  }

  @Test
  void normalizesDrivingTopologyAndLanePolicyMetadata() {
    var attrs = RoadTagNormalizer.normalize(
      Map.ofEntries(
        Map.entry("highway", "primary"),
        Map.entry("name", "Main Road"),
        Map.entry("lanes", "2"),
        Map.entry("turn:lanes", "left|through;right"),
        Map.entry("change:lanes", "not_right|yes"),
        Map.entry("maxspeed", "50 mph"),
        Map.entry("surface", "asphalt"),
        Map.entry("bridge", "yes"),
        Map.entry("layer", "1"),
        Map.entry("oneway", "yes")
      ),
      1234L,
      10L,
      20L,
      7
    );

    assertEquals(3, attrs.get("schema_version"));
    assertEquals(1234L, attrs.get("osm_id"));
    assertEquals("primary", attrs.get("road_class"));
    assertEquals(2, attrs.get("lanes"));
    assertEquals("left|through;right", attrs.get("turn_lanes_raw"));
    assertEquals("not_right|yes", attrs.get("change_lanes_raw"));
    assertEquals(80.5, ((Number) attrs.get("speed_kmh")).doubleValue(), 0.05);
    assertEquals(6.8, ((Number) attrs.get("width_m")).doubleValue(), 0.05);
    assertEquals("lanes", attrs.get("width_source"));
    assertEquals("paved", attrs.get("surface_class"));
    assertEquals(true, attrs.get("bridge"));
    assertEquals(1, attrs.get("layer"));
    assertEquals(1, attrs.get("oneway"));
    assertEquals(10L, attrs.get("first_node"));
    assertEquals(20L, attrs.get("last_node"));
    assertEquals(7, attrs.get("node_count"));
  }

  @Test
  void explicitWidthWinsAndRoundaboutImpliesOneway() {
    var attrs = RoadTagNormalizer.normalize(
      Map.of(
        "highway", "residential",
        "width", "5.5 m",
        "junction", "roundabout"
      ),
      1L,
      null,
      null,
      0
    );

    assertEquals(5.5, ((Number) attrs.get("width_m")).doubleValue(), 0.01);
    assertEquals("tag", attrs.get("width_source"));
    assertEquals(1, attrs.get("oneway"));
  }

  @Test
  void preservesUnknownSpeedAsRawOnly() {
    var attrs = RoadTagNormalizer.normalize(
      Map.of("highway", "secondary", "maxspeed", "signals"),
      2L,
      null,
      null,
      0
    );

    assertEquals("signals", attrs.get("maxspeed_raw"));
    assertNull(attrs.get("speed_kmh"));
  }

  @Test
  void understandsImperialWidth() {
    assertEquals(3.6576, RoadTagNormalizer.meters(Map.of("width", "12 ft"), "width"), 0.0001);
  }
}
