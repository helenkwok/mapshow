package org.mapshow.roads;

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.Profile;
import com.onthegomap.planetiler.config.Arguments;
import com.onthegomap.planetiler.reader.SourceFeature;
import com.onthegomap.planetiler.reader.osm.OsmElement;
import com.onthegomap.planetiler.reader.osm.OsmSourceFeature;
import java.nio.file.Path;

/** Generates a simulation-oriented road vector-tile layer from OpenStreetMap ways. */
public final class MapshowRoadProfile implements Profile {
  public static final String LAYER = "game_road";
  public static final int MIN_ZOOM = 12;
  public static final int MAX_ZOOM = 16;

  @Override
  public void processFeature(SourceFeature sourceFeature, FeatureCollector features) {
    if (!sourceFeature.canBeLine() || !RoadTagNormalizer.isGameRoad(sourceFeature.tags())) return;
    if (!(sourceFeature instanceof OsmSourceFeature osmFeature)) return;
    if (!(osmFeature.originalElement() instanceof OsmElement.Way way)) return;

    int nodeCount = way.nodes().size();
    Long firstNode = nodeCount > 0 ? way.nodes().get(0) : null;
    Long lastNode = nodeCount > 0 ? way.nodes().get(nodeCount - 1) : null;
    var attributes = RoadTagNormalizer.normalize(
      sourceFeature.tags(),
      sourceFeature.id(),
      firstNode,
      lastNode,
      nodeCount
    );

    var road = features.line(LAYER)
      .setZoomRange(MIN_ZOOM, MAX_ZOOM)
      // This is simulation input rather than cartographic decoration: retain small roads and source geometry vertices.
      .setMinPixelSize(0)
      .setPixelTolerance(0)
      // Keep context beyond tile edges so the browser can build continuous road surfaces before clipping locally.
      .setBufferPixels(32);

    for (var attribute : attributes.entrySet()) {
      road.setAttr(attribute.getKey(), attribute.getValue());
    }
  }

  @Override
  public String name() {
    return "Mapshow game roads";
  }

  @Override
  public String description() {
    return "OpenStreetMap road ways retaining simulation-oriented identity, dimensions, access and vertical-layer metadata";
  }

  @Override
  public boolean isOverlay() {
    return true;
  }

  @Override
  public String attribution() {
    return """
      <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>
      """.trim();
  }

  public static void main(String[] args) {
    run(Arguments.fromArgsOrConfigFile(args));
  }

  static void run(Arguments input) {
    var args = input.orElse(Arguments.of(
      "minzoom", MIN_ZOOM,
      "maxzoom", MAX_ZOOM
    ));
    String area = args.getString("area", "Geofabrik area to download", "monaco");
    String source = "planet".equalsIgnoreCase(area) ? "aws:latest" : "geofabrik:" + area;

    Planetiler.create(args)
      .setProfile(new MapshowRoadProfile())
      .addOsmSource("osm", Path.of("data", "sources", area + ".osm.pbf"), source)
      .overwriteOutput(Path.of("data", "game-roads.mbtiles"))
      .run();
  }
}
