package org.mapshow.roads;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.carrotsearch.hppc.LongArrayList;
import com.onthegomap.planetiler.reader.osm.OsmElement;
import java.util.Map;
import org.junit.jupiter.api.Test;

class MapshowRoadProfileTest {
  private static OsmElement.Way way(long id, Map<String, Object> tags) {
    LongArrayList nodes = new LongArrayList();
    nodes.add(1L);
    nodes.add(2L);
    return new OsmElement.Way(id, tags, nodes);
  }

  @Test
  void onlyGameRoadsParticipateInIntersectionSplitting() {
    MapshowRoadProfile profile = new MapshowRoadProfile();
    assertTrue(profile.splitOsmWayAtIntersections(way(1L, Map.of("highway", "residential"))));
    assertTrue(profile.splitOsmWayAtIntersections(way(2L, Map.of("highway", "primary"))));
    assertFalse(profile.splitOsmWayAtIntersections(way(3L, Map.of("highway", "footway"))));
    assertFalse(profile.splitOsmWayAtIntersections(way(4L, Map.of("highway", "residential", "area", "yes"))));
  }
}
