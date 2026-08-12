import type { Map as MapLibreMap } from "maplibre-gl";

const SIZE = 64;

type Rgba = readonly [number, number, number, number];

export const BUILDING_PATTERNS = {
  ground: "mapshow-building-ground",
  brick: "mapshow-building-brick",
  masonry: "mapshow-building-masonry",
  glass: "mapshow-building-glass",
} as const;

function image(): { width: number; height: number; data: Uint8Array } {
  return {
    width: SIZE,
    height: SIZE,
    data: new Uint8Array(SIZE * SIZE * 4),
  };
}

function fill(
  target: { data: Uint8Array },
  x0: number,
  y0: number,
  width: number,
  height: number,
  color: Rgba,
): void {
  const x1 = Math.min(SIZE, x0 + width);
  const y1 = Math.min(SIZE, y0 + height);

  for (let y = Math.max(0, y0); y < y1; y += 1) {
    for (let x = Math.max(0, x0); x < x1; x += 1) {
      const offset = (y * SIZE + x) * 4;
      target.data[offset] = color[0];
      target.data[offset + 1] = color[1];
      target.data[offset + 2] = color[2];
      target.data[offset + 3] = color[3];
    }
  }
}

function groundPattern(): ReturnType<typeof image> {
  const result = image();
  fill(result, 0, 0, SIZE, SIZE, [71, 74, 76, 255]);
  fill(result, 5, 7, 23, 50, [28, 43, 51, 255]);
  fill(result, 36, 7, 23, 50, [31, 47, 55, 255]);
  fill(result, 9, 11, 15, 38, [70, 103, 118, 255]);
  fill(result, 40, 11, 15, 38, [73, 108, 124, 255]);
  fill(result, 0, 57, SIZE, 7, [48, 49, 50, 255]);
  return result;
}

function brickPattern(): ReturnType<typeof image> {
  const result = image();
  fill(result, 0, 0, SIZE, SIZE, [151, 126, 105, 255]);

  for (let y = 0; y < SIZE; y += 16) {
    fill(result, 0, y + 14, SIZE, 2, [112, 99, 87, 255]);
    const offset = (y / 16) % 2 === 0 ? 4 : 20;
    for (let x = offset; x < SIZE; x += 32) {
      fill(result, x, y, 2, 16, [112, 99, 87, 255]);
    }
  }

  for (let y = 3; y < SIZE; y += 16) {
    for (let x = 6; x < SIZE; x += 32) {
      fill(result, x, y, 20, 9, [48, 65, 72, 255]);
      fill(result, x + 2, y + 2, 16, 5, [89, 120, 132, 255]);
    }
  }

  return result;
}

function masonryPattern(): ReturnType<typeof image> {
  const result = image();
  fill(result, 0, 0, SIZE, SIZE, [178, 177, 169, 255]);

  for (let y = 5; y < SIZE; y += 16) {
    for (let x = 5; x < SIZE; x += 20) {
      fill(result, x, y, 12, 9, [49, 63, 68, 255]);
      fill(result, x + 2, y + 2, 8, 5, [108, 133, 141, 255]);
    }
  }

  fill(result, 0, 0, SIZE, 2, [142, 141, 135, 255]);
  fill(result, 0, 32, SIZE, 2, [142, 141, 135, 255]);
  return result;
}

function glassPattern(): ReturnType<typeof image> {
  const result = image();
  fill(result, 0, 0, SIZE, SIZE, [39, 61, 72, 255]);

  for (let x = 0; x < SIZE; x += 16) {
    fill(result, x, 0, 2, SIZE, [93, 112, 118, 255]);
  }
  for (let y = 0; y < SIZE; y += 16) {
    fill(result, 0, y, SIZE, 2, [91, 111, 118, 255]);
  }
  for (let y = 3; y < SIZE; y += 16) {
    for (let x = 3; x < SIZE; x += 16) {
      fill(result, x, y, 11, 11, [77, 111, 128, 255]);
      fill(result, x + 1, y + 1, 4, 8, [116, 147, 160, 255]);
    }
  }

  return result;
}

export function registerBuildingPatterns(map: MapLibreMap): void {
  const images = [
    [BUILDING_PATTERNS.ground, groundPattern()],
    [BUILDING_PATTERNS.brick, brickPattern()],
    [BUILDING_PATTERNS.masonry, masonryPattern()],
    [BUILDING_PATTERNS.glass, glassPattern()],
  ] as const;

  for (const [id, data] of images) {
    if (!map.hasImage(id)) {
      map.addImage(id, data, { pixelRatio: 2 });
    }
  }
}
