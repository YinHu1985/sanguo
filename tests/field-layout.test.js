import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fieldGridMetrics, fieldTilesMarkup } from "../src/js/ui/field-view.js";

const mapSizes = [[18, 14], [9, 7], [12, 7], [5, 4], [2, 1], [1, 1], [1, 5], [32, 20]];
const containers = [
  { width: 1280, height: 638, space: 20 },
  { width: 1920, height: 998, space: 20 },
  { width: 1024, height: 686, space: 20 },
  { width: 390, height: 780, space: 16 },
  { width: 320, height: 780, space: 16 },
  { width: 1600, height: 560, space: 20 },
];
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${message}: expected ${expected}, got ${actual}`);

function renderedTiles(width, height) {
  const battle = {
    map: { width, height }, playerSide: "ally", activeUnit: null,
    rules: { terrain: { plain: { name: "平原" } } },
    getVisibility: () => ({ visible: new Set(), explored: new Set(), unitIds: new Set() }),
    fieldUnits: () => [], terrainAt: () => "plain",
  };
  return [...fieldTilesMarkup(battle).matchAll(/<button\b[^>]*data-x="(\d+)" data-y="(\d+)"[^>]*style="([^"]+)"/g)]
    .map(([, x, y, style]) => ({ x: Number(x), y: Number(y),
      ...Object.fromEntries([...style.matchAll(/--tile-(left|top|width|height):([\d.eE+-]+)%/g)]
        .map(([, key, value]) => [key, Number(value) / 100])) }));
}

// Mirrors the content-box dimensions defined by the CSS container-unit fit.
// Tile positions themselves come from production markup, not from this helper.
function fitBoard(map, container) {
  const { aspectRatio } = fieldGridMetrics(map);
  const width = Math.min(container.width - container.space,
    (container.height - container.space) * aspectRatio);
  return { width, height: width / aspectRatio };
}

test("grid metrics reserve the half-row for staggered columns, but not for a single column", () => {
  assert.deepEqual(fieldGridMetrics({ width: 18, height: 14 }),
    { columns: 18, rows: 14.5, aspectRatio: 18 / 14.5 });
  assert.deepEqual(fieldGridMetrics({ width: 1, height: 5 }),
    { columns: 1, rows: 5, aspectRatio: 1 / 5 });
  for (const [width, height] of mapSizes) {
    const grid = fieldGridMetrics({ width, height });
    assert.equal(grid.columns, width);
    assert.equal(grid.rows, height + (width > 1 ? 0.5 : 0));
    assert.equal(grid.aspectRatio, width / grid.rows);
  }
});

test("rendered tile percentages produce square cells across map sizes and container aspect ratios", () => {
  for (const [width, height] of mapSizes) {
    const tiles = renderedTiles(width, height);
    assert.equal(tiles.length, width * height);
    for (const container of containers) {
      const board = fitBoard({ width, height }, container);
      const expectedCell = Math.min((container.width - container.space) / width,
        (container.height - container.space) / (height + (width > 1 ? 0.5 : 0)));
      for (const tile of tiles) {
        const context = `${width}×${height} map in ${container.width}×${container.height} at ${tile.x},${tile.y}`;
        close(tile.width * board.width, expectedCell, `${context} width`);
        close(tile.height * board.height, expectedCell, `${context} height`);
      }
      assert.ok(board.width + 4 <= container.width, "the two 2px borders must fit horizontally");
      assert.ok(board.height + 4 <= container.height, "the two 2px borders must fit vertically");
    }
  }
});

test("odd columns shift down exactly half a square while same-column rows remain one square apart", () => {
  for (const [width, height] of mapSizes) {
    const tiles = renderedTiles(width, height);
    for (const container of containers) {
      const board = fitBoard({ width, height }, container);
      const cell = board.width / width;
      for (const tile of tiles) {
        close(tile.left * board.width, tile.x * cell, "column origin");
        close(tile.top * board.height, (tile.y + (tile.x % 2) * 0.5) * cell, "staggered row origin");
        if (tile.y > 0) {
          const above = tiles.find((other) => other.x === tile.x && other.y === tile.y - 1);
          close((tile.top - above.top) * board.height, cell, "consecutive row spacing");
        }
        if (tile.x > 0) {
          const left = tiles.find((other) => other.x === tile.x - 1 && other.y === tile.y);
          close((tile.top - left.top) * board.height,
            (tile.x % 2 ? 0.5 : -0.5) * cell, "alternating half-row offset");
        }
      }
    }
  }
});

test("all rendered tiles remain within the board and the last shifted row reaches the bottom edge", () => {
  for (const [width, height] of mapSizes) {
    const tiles = renderedTiles(width, height);
    for (const tile of tiles) {
      assert.ok(tile.left >= 0 && tile.top >= 0);
      assert.ok(tile.left + tile.width <= 1 + 1e-12, "right edge cannot be clipped");
      assert.ok(tile.top + tile.height <= 1 + 1e-12, "bottom edge cannot be clipped");
    }
    close(Math.max(...tiles.map((tile) => tile.left + tile.width)), 1, "rightmost edge");
    close(Math.max(...tiles.map((tile) => tile.top + tile.height)), 1, "lowest edge");
    const bottomRight = tiles.at(-1);
    close(bottomRight.left + bottomRight.width, 1, "last tile right edge");
    const expectedBottomGap = width > 1 && width % 2 === 1 ? 0.5 / (height + 0.5) : 0;
    close(1 - bottomRight.top - bottomRight.height, expectedBottomGap, "last column stagger gap");
  }
});

test("field CSS preserves a content-box ratio and never stretches the board independently on both axes", async () => {
  const css = await readFile(new URL("../src/styles/warfare.css", import.meta.url), "utf8");
  const wrapper = css.match(/\.battlefield-wrap\s*\{([^}]+)\}/)?.[1];
  assert.match(wrapper, /container-type\s*:\s*size\s*;/);
  const boardRules = [...css.matchAll(/\.battlefield\s*\{([^}]+)\}/g)].map((match) => match[1]);
  const base = boardRules[0].replace(/\s+/g, "");
  assert.ok(base.includes("box-sizing:content-box;"));
  assert.ok(base.includes("inset:auto;"));
  assert.ok(base.includes("height:auto;aspect-ratio:var(--field-ratio);"));
  assert.ok(base.includes("width:min(calc(100cqw-var(--field-space)),calc((100cqh-var(--field-space))*var(--field-ratio)));"));
  assert.ok(base.includes("left:50%;top:50%;transform:translate(-50%,-50%);"));
  for (const override of boardRules.slice(1)) {
    assert.doesNotMatch(override, /(?:^|;)\s*(?:inset|width|height|aspect-ratio|box-sizing)\s*:/,
      "responsive overrides may change the gutter, not stretch or distort the board");
  }
});

test("battle rendering supplies the same dynamic aspect ratio used by tile geometry", async () => {
  const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  assert.match(app, /field\.style\.setProperty\("--field-ratio",\s*fieldGridMetrics\(battle\.map\)\.aspectRatio\)/);
});
