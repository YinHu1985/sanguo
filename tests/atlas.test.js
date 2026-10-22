import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyAtlasToScenario, projectCity } from "../src/js/game/atlas.js";
import { createInitialState, loadState, migrateState } from "../src/js/game/state.js";
import { advanceMonth, validateArmy } from "../src/js/game/rules.js";
import { calculateMonthlyIncome, monthlySalaryCost } from "../src/js/game/economy.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const projection = { width: 1800, height: 1500, west: 93, east: 132, north: 43, south: 17 };
const fixture = {
  version: 1,
  projection,
  cities: [
    { id: "xiaopei", name: "小沛", province: "徐州", region: "中原", longitude: 116.94, latitude: 34.73, aliases: [], labelSide: "left", labelDy: 0, adjacent: ["xuzhou", "luoyang"] },
    { id: "xuzhou", name: "下邳", province: "徐州", region: "中原", longitude: 117.95, latitude: 34.3, aliases: ["徐州"], labelSide: "right", labelDy: 0, adjacent: ["xiaopei"] },
    { id: "luoyang", name: "洛阳", province: "司隶", region: "中原", longitude: 112.45, latitude: 34.62, aliases: [], labelSide: "left", labelDy: 0, adjacent: ["xiaopei"] }
  ]
};

test("atlas adds empty cities while retaining scenario forces and economy", () => {
  const before = structuredClone(scenario);
  const enriched = applyAtlasToScenario(scenario, fixture);
  const base = scenario.cities.find((city) => city.id === "xuzhou");
  const existing = enriched.cities.find((city) => city.id === "xuzhou");
  const empty = enriched.cities.find((city) => city.id === "luoyang");
  assert.equal(existing.name, "下邳");
  assert.equal(existing.gold, base.gold);
  assert.equal(existing.troops, base.troops);
  assert.deepEqual(existing.officerIds, base.officerIds);
  assert.deepEqual(existing.aliases, ["徐州"]);
  assert.equal(empty.factionId, "neutral");
  assert.equal(empty.troops, 0);
  assert.deepEqual(empty.officerIds, []);
  assert.equal(empty.governorId, null);
  assert.ok(enriched.factions.some((faction) => faction.id === "neutral"));
  assert.deepEqual(scenario, before);
});

test("loading a version-one save refreshes geography without resetting campaign progress", (context) => {
  const saved = createInitialState(scenario, rules);
  const occupied = saved.cities.find((city) => city.id === "puyang");
  const home = saved.cities.find((city) => city.id === "xiaopei");
  occupied.factionId = saved.playerFactionId;
  occupied.troops = 7123;
  occupied.officerIds = ["guan-yu"];
  occupied.governorId = "guan-yu";
  home.officerIds = home.officerIds.filter((id) => id !== "guan-yu");
  home.gold = 12345;
  home.food = 67890;
  home.agriculture = 92;
  saved.officers.find((officer) => officer.id === "guan-yu").acted = true;
  saved.officers.find((officer) => officer.id === "guan-yu").merit = 9999;
  saved.year = 199;
  saved.month = 8;
  saved.commandsRemaining = 2;
  saved.selectedCityId = "puyang";
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => JSON.stringify(saved) } });
  context.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  });

  const enriched = applyAtlasToScenario(scenario, fixture);
  const loaded = loadState(enriched, rules);
  assert.equal(loaded.cities.find((city) => city.id === "xiaopei").gold, 12345);
  assert.equal(loaded.cities.find((city) => city.id === "xiaopei").food, 67890);
  assert.equal(loaded.cities.find((city) => city.id === "xiaopei").agriculture, 92);
  assert.deepEqual(loaded.cities.find((city) => city.id === "xiaopei").adjacent, ["xuzhou", "luoyang"]);
  assert.equal(loaded.cities.find((city) => city.id === "xiaopei").x, projectCity(fixture.cities[0], projection).x);
  assert.equal(loaded.cities.find((city) => city.id === "xuzhou").name, "下邳");
  assert.equal(loaded.cities.find((city) => city.id === "puyang").factionId, saved.playerFactionId);
  assert.equal(loaded.cities.find((city) => city.id === "puyang").troops, 7123);
  assert.equal(loaded.cities.find((city) => city.id === "puyang").governorId, "guan-yu");
  assert.deepEqual(loaded.cities.find((city) => city.id === "puyang").officerIds, ["guan-yu"]);
  assert.equal(loaded.officers.find((officer) => officer.id === "guan-yu").acted, true);
  assert.equal(loaded.officers.find((officer) => officer.id === "guan-yu").merit, 9999);
  assert.equal(loaded.year, 199);
  assert.equal(loaded.month, 8);
  assert.equal(loaded.commandsRemaining, 2);
  assert.equal(loaded.selectedCityId, "puyang");
  assert.equal(loaded.cities.find((city) => city.id === "luoyang").factionId, "neutral");
  assert.deepEqual(migrateState(loaded, enriched, rules), loaded);
});

test("empty cities remain unchanged across a month and can be valid expedition targets", () => {
  const state = createInitialState(applyAtlasToScenario(scenario, fixture), rules);
  const empty = state.cities.find((city) => city.id === "luoyang");
  const before = structuredClone(empty);
  const expedition = validateArmy(state, "xiaopei", "luoyang", [{ officerId: "liu-bei", troops: 1000 }], rules);
  assert.equal(expedition.ok, true);
  const enemyCity = state.cities.find((city) => city.id === "puyang");
  const expectedEnemyGold = enemyCity.gold + calculateMonthlyIncome(enemyCity, rules) - monthlySalaryCost(state, enemyCity, rules);
  advanceMonth(state, rules);
  assert.deepEqual(empty, before);
  assert.equal(enemyCity.gold, expectedEnemyGold, "monthly economy settles all owned cities, while AI actions belong to runWorldTurn");
});

test("geographic projection places north above south and east to the right", () => {
  assert.deepEqual(projectCity({ longitude: 93, latitude: 43 }, projection), { x: 0, y: 0 });
  assert.deepEqual(projectCity({ longitude: 132, latitude: 17 }, projection), { x: 1800, y: 1500 });
  const changan = projectCity({ longitude: 108.94, latitude: 34.34 }, projection);
  const jianye = projectCity({ longitude: 118.8, latitude: 32.06 }, projection);
  const chengdu = projectCity({ longitude: 104.06, latitude: 30.67 }, projection);
  assert.ok(changan.x < jianye.x);
  assert.ok(changan.y < chengdu.y);
  assert.ok(chengdu.x < changan.x);
});

test("the complete atlas has valid, reciprocal routes and one connected city network", async () => {
  const atlas = JSON.parse(await readFile(new URL("../src/data/strategic-atlas.json", import.meta.url), "utf8"));
  const cities = new Map(atlas.cities.map((city) => [city.id, city]));
  assert.equal(cities.size, atlas.cities.length, "city ids must be unique");
  for (const original of scenario.cities) assert.ok(cities.has(original.id), `existing city ${original.id} must retain its id`);
  for (const city of atlas.cities) {
    const point = projectCity(city, atlas.projection);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${city.name} requires geographic coordinates`);
    assert.ok(point.x >= 0 && point.x <= atlas.projection.width && point.y >= 0 && point.y <= atlas.projection.height, `${city.name} must fit the map`);
    assert.equal(new Set(city.adjacent).size, city.adjacent.length, `${city.name} has repeated routes`);
    assert.ok(!city.adjacent.includes(city.id), `${city.name} cannot be adjacent to itself`);
    for (const neighborId of city.adjacent) {
      const neighbor = cities.get(neighborId);
      assert.ok(neighbor, `${city.name} refers to an unknown city ${neighborId}`);
      assert.ok(neighbor.adjacent.includes(city.id), `${city.name} ↔ ${neighbor.name} must work in both directions`);
    }
  }
  const visited = new Set();
  const queue = [atlas.cities[0].id];
  while (queue.length) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    queue.push(...cities.get(id).adjacent.filter((neighborId) => !visited.has(neighborId)));
  }
  assert.equal(visited.size, cities.size, "every city should be reachable through the strategic routes");
  assert.equal(cities.get("xuzhou").name, "下邳");
  assert.ok(cities.get("xuzhou").aliases.includes("徐州"));
});
