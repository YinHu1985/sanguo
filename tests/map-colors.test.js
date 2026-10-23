import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMapColorView, buildMapLegendView, createNumericMapColorResolver, MapColorLayer, MAP_COLOR_RESOLVERS,
  normalizeMapMode, readMapMode, registerMapColorResolver, visibleTerritoryEdges, writeMapMode } from "../src/js/ui/map-colors.js";

const config = JSON.parse(await readFile(new URL("../src/data/map-modes.json", import.meta.url), "utf8"));
const atlas = JSON.parse(await readFile(new URL("../src/data/strategic-atlas.json", import.meta.url), "utf8"));
const fixture = () => ({
  playerFactionId: "a", year: 196, month: 1, elapsedMonths: 0, selectedCityId: "a1",
  commandsRemaining: 7, relations: {}, battles: [], pendingInvasions: [],
  factions: [
    { id: "a", name: "曹操军", color: "#b45b43" },
    { id: "b", name: "袁绍军", color: "#547a91" },
    { id: "c", name: "刘表军", color: "#6c875c" },
    { id: "neutral", name: "空城", color: "#96958a" }
  ],
  cities: [
    { id: "a1", name: "许昌", factionId: "a", province: "豫州" },
    { id: "a2", name: "濮阳", factionId: "a", province: "兖州" },
    { id: "b1", name: "邺", factionId: "b", province: "冀州" },
    { id: "c1", name: "襄阳", factionId: "c", province: "荆州" },
    { id: "n1", name: "空城", factionId: "neutral", province: "益州" }
  ]
});
const monthNumber = (state) => state.year * 12 + state.month;
const cellFor = (state, mode, id) => buildMapColorView(state, mode, config).cells.find((cell) => cell.cityId === id);
const freezeDeep = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeDeep);
  return Object.freeze(value);
};

test("map modes provide terrain-only, faction, diplomacy and all thirteen atlas provinces", () => {
  assert.equal(config.defaultMode, "none");
  assert.deepEqual(config.modes.map((mode) => mode.id), ["none", "faction", "diplomacy", "province"]);
  assert.equal(config.provinces.length, 13);
  assert.deepEqual(new Set(config.provinces.map((province) => province.id)), new Set(atlas.cities.map((city) => city.province)));
  assert.deepEqual(config.diplomacy.map((entry) => entry.id), ["self", "ally", "war", "unaffiliated", "neutral"]);
  for (const entry of [...config.provinces, ...config.diplomacy]) assert.match(entry.color, /^#[\da-f]{6}$/i);
  assert.match(config.boundaryNote, /示意.*非史实/);
});

test("all four map views are pure projections and do not alter or advance a campaign", () => {
  const state = fixture(), before = structuredClone(state), frozenConfig = freezeDeep(structuredClone(config));
  freezeDeep(state);
  for (const mode of config.modes) {
    const view = buildMapColorView(state, mode.id, frozenConfig);
    assert.equal(view.mode, mode.id);
    assert.equal(view.visible, mode.id !== "none");
    assert.equal(view.cells.length, mode.id === "none" ? 0 : state.cities.length);
    assert.equal(view.opacity, mode.opacity);
    assert.equal(view.legend.reduce((sum, group) => sum + group.count, 0), view.cells.length);
  }
  assert.deepEqual(state, before);
  assert.deepEqual(buildMapColorView(state, "none", config).legend, []);
  assert.equal(normalizeMapMode("unrecognized-old-preference", config), "none");
  assert.equal(buildMapColorView(state, "unrecognized-old-preference", config).visible, false);
});

test("faction colors update immediately after conquest while previous view snapshots remain unchanged", () => {
  const state = fixture();
  const before = buildMapColorView(state, "faction", config);
  assert.equal(before.legend.find((group) => group.key === "faction:a").count, 2);
  assert.equal(before.cells.find((cell) => cell.cityId === "b1").color, "#547a91");
  state.cities.find((city) => city.id === "b1").factionId = "a";
  const after = buildMapColorView(state, "faction", config);
  assert.equal(after.cells.find((cell) => cell.cityId === "b1").key, "faction:a");
  assert.equal(after.cells.find((cell) => cell.cityId === "b1").color, "#b45b43");
  assert.equal(after.legend.find((group) => group.key === "faction:a").count, 3);
  assert.ok(!after.legend.some((group) => group.key === "faction:b"));
  assert.equal(before.legend.find((group) => group.key === "faction:a").count, 2);
  assert.equal(before.cells.find((cell) => cell.cityId === "b1").key, "faction:b");
});

test("province colors follow atlas metadata, independently of current ownership", () => {
  const state = fixture();
  const before = buildMapColorView(state, "province", config);
  state.cities.forEach((city) => { city.factionId = "a"; });
  assert.deepEqual(buildMapColorView(state, "province", config), before);
  for (const cell of before.cells) {
    const city = state.cities.find((entry) => entry.id === cell.cityId);
    assert.equal(cell.key, `province:${city.province}`);
    assert.equal(cell.color, config.provinces.find((entry) => entry.id === city.province).color);
  }
});

test("diplomacy alliances are bilateral, non-transitive and expire on the existing campaign deadline", () => {
  const state = fixture(), currentMonth = monthNumber(state);
  state.relations = {
    "a|b": { friendliness: 70, allianceUntil: currentMonth + 1 },
    "b|c": { friendliness: 90, allianceUntil: currentMonth + 5 }
  };
  assert.equal(cellFor(state, "diplomacy", "a1").key, "self");
  assert.equal(cellFor(state, "diplomacy", "b1").key, "ally");
  assert.equal(cellFor(state, "diplomacy", "c1").key, "unaffiliated", "an ally's ally is not automatically our ally");
  state.playerFactionId = "b";
  assert.equal(cellFor(state, "diplomacy", "a1").key, "ally", "the same relation works in either direction");
  assert.equal(cellFor(state, "diplomacy", "c1").key, "ally");
  state.playerFactionId = "a";
  state.month += 1;
  assert.equal(cellFor(state, "diplomacy", "b1").key, "unaffiliated", "deadline month is no longer allied");
});

test("unaffiliated, unfriendly and even friendly non-allies are not shown as actual wars", () => {
  const state = fixture();
  state.relations = {
    "a|b": { friendliness: 0, allianceUntil: 0 },
    "a|c": { friendliness: 100, allianceUntil: 0 }
  };
  assert.equal(cellFor(state, "diplomacy", "b1").key, "unaffiliated");
  assert.equal(cellFor(state, "diplomacy", "c1").key, "unaffiliated");
  assert.equal(cellFor(state, "diplomacy", "n1").key, "neutral");
});

test("both active and paused wars override alliance colors, ended wars and third-party wars do not", () => {
  const state = fixture();
  state.relations["a|b"] = { friendliness: 80, allianceUntil: monthNumber(state) + 5 };
  for (const status of ["active", "paused"]) {
    for (const [attackerFactionId, defenderFactionId] of [["a", "b"], ["b", "a"]]) {
      state.battles = [{ status, attackerFactionId, defenderFactionId }];
      assert.equal(cellFor(state, "diplomacy", "b1").key, "war");
    }
  }
  state.battles[0].status = "ended";
  assert.equal(cellFor(state, "diplomacy", "b1").key, "ally");
  state.battles = [{ status: "active", attackerFactionId: "b", defenderFactionId: "c" }];
  assert.equal(cellFor(state, "diplomacy", "b1").key, "ally");
  assert.equal(cellFor(state, "diplomacy", "c1").key, "unaffiliated");
});

test("pending invasions indicate war before the tactical campaign exists and stop doing so once resolved", () => {
  const state = fixture();
  state.pendingInvasions = [{ attackerFactionId: "b", defenderFactionId: "a", resolved: false }];
  assert.equal(cellFor(state, "diplomacy", "b1").key, "war");
  state.pendingInvasions[0].resolved = true;
  assert.equal(cellFor(state, "diplomacy", "b1").key, "unaffiliated");
});

test("territory boundaries hide internal same-group edges but retain exterior and differing-group edges", () => {
  const state = fixture();
  const edges = [
    { cityIds: ["a1"], path: "outer" },
    { cityIds: ["a1", "a2"], path: "internal" },
    { cityIds: ["a2", "b1"], path: "border" },
    { cityIds: ["b1", "c1"], path: "other" },
    { cityIds: ["missing", "absent"], path: "unknown" }
  ];
  const original = structuredClone(edges);
  assert.deepEqual(visibleTerritoryEdges(edges, buildMapColorView(state, "faction", config).cells).map((edge) => edge.path), ["outer", "border", "other"]);
  state.cities.find((city) => city.id === "b1").factionId = "a";
  assert.deepEqual(visibleTerritoryEdges(edges, buildMapColorView(state, "faction", config).cells).map((edge) => edge.path), ["outer", "other"]);
  assert.deepEqual(visibleTerritoryEdges(edges, buildMapColorView(state, "province", config).cells).map((edge) => edge.path), ["outer", "internal", "border", "other"]);
  assert.deepEqual(visibleTerritoryEdges(edges, []), []);
  assert.deepEqual(edges, original);
});

test("unknown factions and malformed colors produce safe display fallbacks", () => {
  const state = fixture();
  state.factions[0].color = 'url("javascript:bad()")';
  state.cities[2].factionId = "unknown-faction";
  state.cities[3].province = null;
  delete state.cities[4].factionId;
  assert.equal(cellFor(state, "faction", "a1").color, config.colors.unknown);
  assert.equal(cellFor(state, "faction", "b1").label, "归属不明");
  assert.equal(cellFor(state, "province", "c1").label, "州郡未定");
  assert.equal(cellFor(state, "faction", "n1").key, "neutral");
  assert.equal(cellFor(state, "diplomacy", "n1").key, "neutral");
});

test("map mode preferences use their own key, normalize invalid saves and survive absent or throwing stores", () => {
  const values = new Map();
  const store = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readMapMode(config, store), "none");
  assert.equal(writeMapMode("diplomacy", config, store), "diplomacy");
  assert.equal(readMapMode(config, store), "diplomacy");
  assert.deepEqual([...values.keys()], ["hanmo-zhoujun-map-color-v1"]);
  assert.equal(writeMapMode("old-mode", config, store), "none");
  assert.equal(readMapMode(config, store), "none");
  const unavailable = { getItem: () => { throw new Error("storage denied"); }, setItem: () => { throw new Error("quota exceeded"); } };
  assert.equal(readMapMode(config, unavailable), "none");
  assert.equal(writeMapMode("faction", config, unavailable), "faction");
  assert.equal(readMapMode(config, null), "none");
  assert.equal(writeMapMode("province", config, null), "province");
});

test("blocked localStorage property access cannot prevent map construction or preference changes", (context) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError: storage access blocked"); } });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
  assert.equal(readMapMode(config), "none");
  assert.equal(writeMapMode("faction", config), "faction");
});

test("legend configuration preserves the four existing modes without renderer mode-name branches", () => {
  const state = fixture();
  const readLegend = (mode) => buildMapLegendView(state, buildMapColorView(state, mode, config), config);
  assert.deepEqual(readLegend("none"), { items: [], reference: "", showFullLegend: false });
  for (const mode of ["faction", "province"]) {
    const legend = readLegend(mode);
    assert.equal(legend.items.length, 1);
    assert.equal(legend.items[0].cityId, state.selectedCityId);
    assert.equal(legend.reference, "");
    assert.equal(legend.showFullLegend, true);
  }
  const diplomacy = readLegend("diplomacy");
  assert.deepEqual(diplomacy.items.map((entry) => entry.key), config.diplomacy.map((entry) => entry.id), "include absent groups so the five-color key remains stable");
  assert.equal(diplomacy.reference, "以曹操军为准");
  assert.equal(diplomacy.showFullLegend, false);
  state.playerFactionId = "b";
  assert.equal(readLegend("diplomacy").reference, "以袁绍军为准");
  state.selectedCityId = "missing";
  assert.equal(readLegend("faction").items[0].key, "faction:a");
});

test("resolver registration validates extensions, prevents accidental replacement and permits clean teardown", (context) => {
  assert.throws(() => registerMapColorResolver("none", () => ({})), /non-reserved/);
  assert.throws(() => registerMapColorResolver("invalid id", () => ({})), /valid/);
  assert.throws(() => registerMapColorResolver("test-map", null), /function/);
  const original = MAP_COLOR_RESOLVERS.faction;
  assert.throws(() => registerMapColorResolver("faction", () => ({})), /already registered/);
  const replacement = () => ({ key: "test", label: "测试", color: "#123456" });
  const restore = registerMapColorResolver("faction", replacement, { replace: true });
  context.after(restore);
  assert.equal(MAP_COLOR_RESOLVERS.faction, replacement);
  restore();
  assert.equal(MAP_COLOR_RESOLVERS.faction, original);
  const remove = registerMapColorResolver("test-map", replacement);
  context.after(remove);
  assert.equal(MAP_COLOR_RESOLVERS["test-map"], replacement);
  remove();
  assert.equal(Object.hasOwn(MAP_COLOR_RESOLVERS, "test-map"), false);
});

test("numeric color rules support exact thresholds, invalid values and caller-owned external bands", () => {
  const bands = freezeDeep([
    { id: "high", min: 10000, label: "兵多", color: "#b14f3f" },
    { id: "low", min: 0, label: "兵少", color: "#387c70" },
    { id: "medium", min: 3000, label: "兵足", color: "#a69776" }
  ]);
  const before = structuredClone(bands);
  const resolver = createNumericMapColorResolver({ value: (city) => city.troops, bands, keyPrefix: "troops" });
  for (const [troops, key] of [[0, "low"], [2999, "low"], [3000, "medium"], [9999, "medium"], [10000, "high"], [1000000, "high"]]) {
    const style = resolver({ troops });
    assert.equal(style.key, `troops:${key}`);
    assert.equal(style.value, troops);
  }
  for (const troops of [undefined, null, NaN, Infinity, "1000", -1]) assert.equal(resolver({ troops }).key, "troops:unknown");
  assert.deepEqual(bands, before, "sorting thresholds must not reorder external config");
  assert.throws(() => createNumericMapColorResolver({ value: () => 0, bands: [] }), /bands/);
  assert.throws(() => createNumericMapColorResolver({ value: () => 0, bands: [{ id: "x", min: 0 }, { id: "y", min: 0 }] }), /distinct/);
  assert.throws(() => createNumericMapColorResolver({ value: () => 0, bands: [{ id: "x", min: 0 }, { id: "x", min: 1 }] }), /unique/);
});

test("an added heat-map mode reuses existing city geometry, border filtering, renderer and configurable legend", (context) => {
  const extended = structuredClone(config);
  extended.troopBands = [
    { id: "low", min: 0, label: "兵少", color: "#387c70" },
    { id: "high", min: 5000, label: "兵多", color: "#b14f3f" }
  ];
  extended.modes.push({ id: "troop-density-test", resolver: "numeric-test", label: "兵力测试", description: "扩展测试，非正式显示按钮", opacity: 0.45,
    metric: "troops", legend: { display: "all", palette: "troopBands", reference: "player", full: false } });
  const unregister = registerMapColorResolver("numeric-test", createNumericMapColorResolver({
    value: (city, state, config, definition) => city[definition.metric], bands: extended.troopBands, keyPrefix: "troops"
  }));
  context.after(unregister);
  const state = fixture();
  state.cities.forEach((city, index) => { city.troops = index < 2 ? 2000 : 8000; });
  const before = structuredClone(state);
  freezeDeep(state);
  const territories = freezeDeep({ projection: { width: 200, height: 100 }, landPath: "M0 0H200V100H0Z", waterPath: "",
    cells: [
      { cityId: "a1", path: "M0 0H50V100H0Z" },
      { cityId: "a2", path: "M50 0H100V100H50Z" },
      { cityId: "b1", path: "M100 0H200V100H100Z" }
    ],
    edges: [{ cityIds: ["a1", "a2"], path: "M50 0V100" }, { cityIds: ["a2", "b1"], path: "M100 0V100" }]
  });
  const makeNode = () => ({ attributes: {}, children: [], dataset: {}, style: { setProperty() {} }, classList: { toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; }, append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }, addEventListener() {} });
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElementNS: makeNode } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: null });
  context.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  });
  const map = new MapColorLayer({ layer: makeNode(), legend: makeNode(), note: makeNode(), selector: makeNode(), territories, config: extended });
  const firstNode = map.nodes.get("a1"), firstPath = firstNode.attributes.d, geometryGroup = map.fills;
  map.mode = "faction";
  map.render(state);
  map.mode = "troop-density-test";
  map.render(state);
  assert.equal(map.layer.dataset.mode, "troop-density-test");
  assert.equal(map.nodes.get("a1"), firstNode, "mode changes reuse existing SVG shapes");
  assert.equal(map.fills, geometryGroup);
  assert.equal(firstNode.attributes.d, firstPath);
  assert.equal(firstNode.attributes.fill, "#387c70");
  assert.equal(map.nodes.get("b1").attributes.fill, "#b14f3f");
  assert.equal(map.boundaries.attributes.d, "M100 0V100", "generic grouping hides the equal-band border");
  assert.match(map.legend.innerHTML, /兵少/);
  assert.match(map.legend.innerHTML, /兵多/);
  assert.match(map.legend.innerHTML, /以曹操军为准/);
  assert.doesNotMatch(map.legend.innerHTML, /data-map-full-legend/);
  assert.deepEqual(state, before);
  assert.equal(config.modes.length, 4, "the extension test does not add a production UI mode");
});
