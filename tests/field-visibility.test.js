import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getFieldConfig, hexDistance, hexLine, canSeeTile, computeFieldVisibility, unitVisible } from "../src/js/game/field-visibility.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const plainMap = (width = 18, height = 14) => ({ width, height, terrain: Array(width * height).fill("plain") });
const putTerrain = (map, x, y, terrain) => { map.terrain[y * map.width + x] = terrain; };
const unit = (id, side, x, y, extra = {}) => ({ id, side, position: { x, y }, maxActionPoints: 3, troops: 1000, ...extra });
const see = (map, observer, target, extras = {}) => canSeeTile({ observer, target, map, rules, ...extras });

test("field configuration exposes reduced AP, matching vision, terrain concealment and extension keys without mutating rules", () => {
  const config = getFieldConfig(rules);
  assert.equal(config.movementScale, 0.5);
  assert.equal(config.attackCostScale, 0.5);
  assert.equal(config.minActionPoints, 2);
  assert.equal(config.maxActionPoints, 5);
  assert.equal(config.visionBonus, 1);
  assert.equal(config.cautiousMoveMultiplier, 3);
  assert.deepEqual(config.concealmentTerrains, ["forest", "hill"]);
  config.concealmentTerrains.push("river");
  assert.deepEqual(rules.battle.field.concealmentTerrains, ["forest", "hill"]);
  assert.equal(getFieldConfig({ battle: { field: { futureScoutBonus: 2 } } }).futureScoutBonus, 2);
});

test("odd-q front-facing staggered columns have the correct six neighbors for both parities", () => {
  for (const [origin, neighbors] of [
    [{ x: 4, y: 4 }, [[4, 3], [4, 5], [3, 3], [3, 4], [5, 3], [5, 4]]],
    [{ x: 5, y: 4 }, [[5, 3], [5, 5], [4, 4], [4, 5], [6, 4], [6, 5]]]
  ]) {
    for (const [x, y] of neighbors) {
      assert.equal(hexDistance(origin, { x, y }), 1);
      assert.equal(hexDistance({ x, y }, origin), 1);
    }
  }
  assert.equal(hexDistance({ x: 4, y: 4 }, { x: 5, y: 5 }), 2);
  assert.equal(hexDistance({ x: 5, y: 4 }, { x: 4, y: 3 }), 2);
});

test("hex lines are reversible adjacent steps with distance+1 points, not a route around obstacles", () => {
  for (const [from, to] of [[{ x: 0, y: 0 }, { x: 17, y: 13 }], [{ x: 4, y: 3 }, { x: 2, y: 9 }], [{ x: 2, y: 4 }, { x: 4, y: 4 }]]) {
    const line = hexLine(from, to);
    assert.equal(line.length, hexDistance(from, to) + 1);
    assert.deepEqual(line[0], from);
    assert.deepEqual(line.at(-1), to);
    assert.deepEqual(line, hexLine(to, from).reverse());
    for (let index = 1; index < line.length; index += 1) assert.equal(hexDistance(line[index - 1], line[index]), 1);
  }
});

test("ordinary three-AP formations see four hexes and their spent action points do not reduce vision", () => {
  const map = plainMap();
  const observer = unit("scout", "ally", 4, 4, { actionPoints: 0 });
  assert.equal(see(map, observer, { x: 4, y: 8 }), true);
  assert.equal(see(map, observer, { x: 4, y: 9 }), false);
  const battle = { units: [observer], map, rules };
  const sight = computeFieldVisibility(battle, "ally");
  assert.equal(sight.tiles.has("4,8"), true);
  assert.equal(sight.tiles.has("4,9"), false);
});

test("forest and hills are visible from adjacent tiles but conceal targets at two or more hexes", () => {
  for (const terrain of ["forest", "hill"]) {
    const map = plainMap();
    const observer = unit("scout", "ally", 4, 4);
    putTerrain(map, 4, 5, terrain);
    assert.equal(see(map, observer, { x: 4, y: 5 }), true);
    putTerrain(map, 4, 5, "plain");
    putTerrain(map, 4, 6, terrain);
    assert.equal(see(map, observer, { x: 4, y: 6 }), false);
  }
});

test("ordinary plains, rivers and forts remain visible at the normal four-hex radius", () => {
  for (const terrain of ["plain", "river", "fort"]) {
    const map = plainMap();
    putTerrain(map, 4, 7, terrain);
    putTerrain(map, 4, 8, terrain);
    assert.equal(see(map, unit("scout", "ally", 4, 4), { x: 4, y: 8 }), true);
  }
});

test("intermediate forest or hill blocks the plain tiles behind it even when a walking route exists around it", () => {
  for (const terrain of ["forest", "hill"]) {
    const map = plainMap();
    putTerrain(map, 4, 5, terrain);
    const observer = unit("scout", "ally", 4, 4);
    assert.equal(see(map, observer, { x: 4, y: 6 }), false);
    assert.equal(see(map, observer, { x: 4, y: 8 }), false);
    assert.equal(see(map, observer, { x: 2, y: 4 }), true, "unrelated directions remain visible");
  }
});

test("terrain occupied by the observer does not trap its sight inside its own forest or hill", () => {
  for (const terrain of ["forest", "hill"]) {
    const map = plainMap();
    putTerrain(map, 4, 4, terrain);
    const observer = unit("scout", "ally", 4, 4);
    assert.equal(see(map, observer, { x: 4, y: 4 }), true);
    assert.equal(see(map, observer, { x: 4, y: 5 }), true);
    assert.equal(see(map, observer, { x: 4, y: 8 }), true);
  }
});

test("straight edge rays cannot peek around a forest on either touched hex", () => {
  for (const blockingY of [3, 4]) {
    const map = plainMap();
    putTerrain(map, 3, blockingY, "forest");
    assert.equal(see(map, unit("scout", "ally", 2, 4), { x: 4, y: 4 }), false);
  }
});

test("unit/terrain hooks can extend scouting and see through specific obstacles without hardcoded officer IDs", () => {
  const map = plainMap();
  const observer = unit("scout", "ally", 4, 4, { scouting: true });
  assert.equal(see(map, observer, { x: 4, y: 10 }, { hooks: { visionRange: (unit, base) => base + (unit.scouting ? 2 : 0) } }), true);
  putTerrain(map, 4, 6, "forest");
  assert.equal(see(map, observer, { x: 4, y: 6 }, { hooks: { terrainSightLimit: (_unit, terrain, base) => terrain === "forest" ? 3 : base } }), true);
  assert.equal(see(map, observer, { x: 4, y: 8 }, { hooks: { terrainSightLimit: () => Infinity } }), false,
    "seeing farther into a target terrain does not also remove intermediate occlusion");
  const hooks = { canSeeThroughTerrain: (unit, terrain) => unit.scouting && terrain === "forest" };
  assert.equal(see(map, observer, { x: 4, y: 8 }, { hooks }), true);
  putTerrain(map, 4, 8, "forest");
  assert.equal(see(map, observer, { x: 4, y: 8 }, { hooks }), true);
  putTerrain(map, 4, 6, "hill");
  assert.equal(see(map, observer, { x: 4, y: 8 }, { hooks }), false);
});

test("own tile, map corners and top-edge rays are visible while off-board and invalid positions are rejected", () => {
  const map = plainMap();
  const observer = unit("scout", "ally", 0, 0);
  assert.equal(see(map, observer, { x: 0, y: 0 }, { range: 0 }), true);
  assert.equal(see(map, observer, { x: 4, y: 0 }), true);
  assert.equal(see(map, observer, { x: 0, y: 4 }), true);
  for (const target of [{ x: -1, y: 0 }, { x: 18, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 14 }, { x: 1.5, y: 0 }, { x: NaN, y: 0 }]) {
    assert.equal(see(map, observer, target), false);
  }
  assert.equal(hexDistance({ x: 0, y: 0 }, { x: NaN, y: 0 }), Infinity);
  assert.deepEqual(hexLine(null, { x: 0, y: 0 }), []);
  const sight = computeFieldVisibility({ map, rules, units: [observer] }, "ally");
  assert.ok([...sight.tiles].every((key) => { const [x, y] = key.split(",").map(Number); return x >= 0 && y >= 0 && x < map.width && y < map.height; }));
});

test("friendly live field formations share sight but dead troops and in-city units reveal no field terrain", () => {
  const map = plainMap();
  const first = unit("first", "ally", 1, 1);
  const second = unit("second", "ally", 10, 10);
  const distant = unit("distant", "enemy", 10, 11);
  const battle = { map, rules, units: [first, second, distant] };
  let sight = computeFieldVisibility(battle, "ally");
  assert.equal(sight.tiles.has("10,11"), true);
  assert.equal(sight.unitIds.has("distant"), true);
  assert.equal(unitVisible(battle, distant, "ally", sight.tiles), true);
  second.inCity = true;
  sight = computeFieldVisibility(battle, "ally");
  assert.equal(sight.tiles.has("10,11"), false);
  assert.equal(sight.unitIds.has("second"), false);
  second.inCity = false;
  second.troops = 0;
  assert.equal(computeFieldVisibility(battle, "ally").tiles.has("10,11"), false);
});

test("an ambusher becomes visible with its adjacent terrain without losing its ambush state", () => {
  const map = plainMap();
  putTerrain(map, 4, 6, "forest");
  const observer = unit("scout", "ally", 4, 4);
  const ambusher = unit("hidden", "enemy", 4, 6, { ambushing: true });
  const battle = { map, rules, units: [observer, ambusher] };
  assert.equal(unitVisible(battle, ambusher, "ally"), false);
  observer.position.y = 5;
  assert.equal(unitVisible(battle, ambusher, "ally"), true);
  assert.equal(ambusher.ambushing, true);
  assert.equal(unitVisible(battle, ambusher, "enemy"), true);
  battle.visibilityHooks = { detectAmbush: () => false };
  assert.equal(unitVisible(battle, ambusher, "ally"), false, "future camouflage may explicitly override normal discovery");
  assert.equal(unitVisible(battle, ambusher, "enemy"), true);
});

test("unit discovery is current sight only and never reads or alters explored terrain memory", () => {
  const map = plainMap();
  const observer = unit("scout", "ally", 4, 4);
  const enemy = unit("enemy", "enemy", 4, 5);
  const battle = { map, rules, units: [observer, enemy], explored: { ally: new Set(["4,5"]) } };
  assert.equal(unitVisible(battle, enemy, "ally"), true);
  observer.position = { x: 15, y: 12 };
  const before = structuredClone(battle);
  assert.equal(unitVisible(battle, enemy, "ally"), false);
  assert.equal(computeFieldVisibility(battle, "ally").tiles.has("4,5"), false);
  assert.deepEqual(battle, before);
});

test("vision hooks apply consistently to shared map visibility as well as individual tile checks", () => {
  const map = plainMap();
  const observer = unit("scout", "ally", 4, 4);
  const target = unit("enemy", "enemy", 4, 10);
  const battle = { map, rules, units: [observer, target], visibilityHooks: { visionRange: (_observer, base) => base + 2 } };
  const sight = computeFieldVisibility(battle, "ally");
  assert.equal(sight.tiles.has("4,10"), true);
  assert.equal(sight.unitIds.has("enemy"), true);
  assert.equal(unitVisible(battle, target, "ally", sight.tiles), true);
});
