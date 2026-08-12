package org.mapshow.roads;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class RoadTagNormalizer {
  private static final Set<String> GAME_ROADS = Set.of(
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service", "road", "track", "raceway", "busway"
  );

  private static final Set<String> PAVED_SURFACES = Set.of(
    "paved", "asphalt", "concrete", "concrete:lanes", "concrete:plates", "paving_stones",
    "sett", "unhewn_cobblestone", "cobblestone", "metal", "wood"
  );

  private static final Set<String> UNPAVED_SURFACES = Set.of(
    "unpaved", "compacted", "fine_gravel", "gravel", "pebblestone", "rock", "dirt",
    "earth", "ground", "mud", "sand", "grass", "grass_paver", "clay"
  );

  private static final Pattern NUMBER = Pattern.compile("[-+]?[0-9]*\\.?[0-9]+");

  private RoadTagNormalizer() {}

  static boolean isGameRoad(Map<String, Object> tags) {
    String highway = string(tags, "highway");
    return highway != null && GAME_ROADS.contains(highway) && !isTruthy(string(tags, "area"));
  }

  static Map<String, Object> normalize(
    Map<String, Object> tags,
    long osmId,
    Long firstNode,
    Long lastNode,
    int nodeCount
  ) {
    LinkedHashMap<String, Object> out = new LinkedHashMap<>();
    String highway = string(tags, "highway");
    if (highway == null) return out;

    String roadClass = roadClass(highway);
    Integer lanes = integer(tags, "lanes");
    Double explicitWidth = meters(tags, "width");
    Double taggedSpeed = speedKmh(tags.get("maxspeed"));
    int oneway = oneway(tags, highway);
    boolean bridge = flag(tags, "bridge");
    boolean tunnel = flag(tags, "tunnel");
    int layer = integer(tags, "layer") == null ? 0 : integer(tags, "layer");

    out.put("schema_version", 1);
    out.put("osm_id", osmId);
    out.put("highway", highway);
    out.put("road_class", roadClass);
    out.put("is_link", highway.endsWith("_link"));
    out.put("oneway", oneway);
    out.put("bridge", bridge);
    out.put("tunnel", tunnel);
    out.put("layer", layer);
    out.put("z_order", layer * 10 + (bridge ? 5 : 0) - (tunnel ? 5 : 0) + classPriority(roadClass));
    out.put("node_count", nodeCount);
    if (firstNode != null) out.put("first_node", firstNode);
    if (lastNode != null) out.put("last_node", lastNode);

    copyString(tags, out, "name");
    copyString(tags, out, "ref");
    copyString(tags, out, "service");
    copyString(tags, out, "access");
    copyString(tags, out, "vehicle");
    copyString(tags, out, "motor_vehicle");
    copyString(tags, out, "surface");
    copyString(tags, out, "smoothness");
    copyString(tags, out, "tracktype");
    copyString(tags, out, "junction");
    copyString(tags, out, "sidewalk");
    copyString(tags, out, "cycleway");
    copyString(tags, out, "lit");
    copyString(tags, out, "incline");

    copyRaw(tags, out, "lanes", "lanes_raw");
    copyRaw(tags, out, "lanes:forward", "lanes_forward_raw");
    copyRaw(tags, out, "lanes:backward", "lanes_backward_raw");
    copyRaw(tags, out, "maxspeed", "maxspeed_raw");
    copyRaw(tags, out, "maxspeed:forward", "maxspeed_forward_raw");
    copyRaw(tags, out, "maxspeed:backward", "maxspeed_backward_raw");
    copyRaw(tags, out, "width", "width_raw");
    copyRaw(tags, out, "oneway", "oneway_raw");

    if (lanes != null) out.put("lanes", lanes);
    Integer lanesForward = integer(tags, "lanes:forward");
    Integer lanesBackward = integer(tags, "lanes:backward");
    if (lanesForward != null) out.put("lanes_forward", lanesForward);
    if (lanesBackward != null) out.put("lanes_backward", lanesBackward);

    if (taggedSpeed != null) out.put("speed_kmh", round1(taggedSpeed));
    Double speedForward = speedKmh(tags.get("maxspeed:forward"));
    Double speedBackward = speedKmh(tags.get("maxspeed:backward"));
    if (speedForward != null) out.put("speed_forward_kmh", round1(speedForward));
    if (speedBackward != null) out.put("speed_backward_kmh", round1(speedBackward));

    double width = explicitWidth != null ? explicitWidth : estimatedWidthMeters(roadClass, lanes);
    out.put("width_m", round1(width));
    out.put("width_source", explicitWidth != null ? "tag" : lanes != null ? "lanes" : "class_default");
    out.put("surface_class", surfaceClass(string(tags, "surface")));
    out.put("priority", classPriority(roadClass));

    return out;
  }

  static Double speedKmh(Object value) {
    if (value == null) return null;
    String raw = value.toString().trim().toLowerCase(Locale.ROOT);
    Matcher matcher = NUMBER.matcher(raw);
    if (!matcher.find()) return null;
    double number = Double.parseDouble(matcher.group());
    if (raw.contains("mph")) return number * 1.609344;
    if (raw.contains("knot")) return number * 1.852;
    return number;
  }

  static Double meters(Map<String, Object> tags, String key) {
    Object value = tags.get(key);
    if (value == null) return null;
    String raw = value.toString().trim().toLowerCase(Locale.ROOT);
    Matcher matcher = NUMBER.matcher(raw);
    if (!matcher.find()) return null;
    double number = Double.parseDouble(matcher.group());
    if (raw.contains("ft") || raw.contains("feet") || raw.contains("foot") || raw.contains("'")) {
      return number * 0.3048;
    }
    return number;
  }

  private static int oneway(Map<String, Object> tags, String highway) {
    String raw = string(tags, "oneway");
    if (raw != null) {
      return switch (raw) {
        case "-1", "reverse" -> -1;
        case "yes", "true", "1" -> 1;
        case "no", "false", "0" -> 0;
        default -> 0;
      };
    }
    String junction = string(tags, "junction");
    if ("roundabout".equals(junction) || "motorway".equals(roadClass(highway))) return 1;
    return 0;
  }

  private static String roadClass(String highway) {
    return highway.endsWith("_link") ? highway.substring(0, highway.length() - 5) : highway;
  }

  private static int classPriority(String roadClass) {
    return switch (roadClass) {
      case "motorway" -> 9;
      case "trunk" -> 8;
      case "primary" -> 7;
      case "secondary" -> 6;
      case "tertiary" -> 5;
      case "raceway" -> 5;
      case "unclassified", "residential", "busway" -> 4;
      case "living_street" -> 3;
      case "service", "road" -> 2;
      case "track" -> 1;
      default -> 0;
    };
  }

  private static double estimatedWidthMeters(String roadClass, Integer lanes) {
    if (lanes != null && lanes > 0) return Math.max(3.2, lanes * 3.2);
    return switch (roadClass) {
      case "motorway" -> 7.2;
      case "trunk", "primary" -> 6.8;
      case "secondary" -> 6.5;
      case "tertiary" -> 6.2;
      case "unclassified", "residential", "busway" -> 5.5;
      case "living_street" -> 4.8;
      case "service", "road" -> 4.0;
      case "track" -> 3.2;
      case "raceway" -> 8.0;
      default -> 5.0;
    };
  }

  private static String surfaceClass(String surface) {
    if (surface == null) return "unknown";
    if (PAVED_SURFACES.contains(surface)) return "paved";
    if (UNPAVED_SURFACES.contains(surface)) return "unpaved";
    return "unknown";
  }

  private static boolean flag(Map<String, Object> tags, String key) {
    String value = string(tags, key);
    return value != null && !Set.of("no", "false", "0").contains(value);
  }

  private static boolean isTruthy(String value) {
    return value != null && Set.of("yes", "true", "1").contains(value);
  }

  private static Integer integer(Map<String, Object> tags, String key) {
    Object value = tags.get(key);
    if (value == null) return null;
    String raw = value.toString().trim();
    if (!raw.matches("[-+]?[0-9]+")) return null;
    try {
      return Integer.parseInt(raw);
    } catch (NumberFormatException ignored) {
      return null;
    }
  }

  private static String string(Map<String, Object> tags, String key) {
    Object value = tags.get(key);
    if (value == null) return null;
    String result = value.toString().trim().toLowerCase(Locale.ROOT);
    return result.isEmpty() ? null : result;
  }

  private static void copyString(Map<String, Object> tags, Map<String, Object> out, String key) {
    Object value = tags.get(key);
    if (value != null && !value.toString().isBlank()) out.put(key, value.toString());
  }

  private static void copyRaw(Map<String, Object> tags, Map<String, Object> out, String input, String output) {
    Object value = tags.get(input);
    if (value != null && !value.toString().isBlank()) out.put(output, value.toString());
  }

  private static double round1(double value) {
    return Math.round(value * 10.0) / 10.0;
  }
}
