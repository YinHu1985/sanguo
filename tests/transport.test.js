import test from "node:test";
import assert from "node:assert/strict";
import { executeTransfer } from "../src/js/game/rules.js";
import { findFriendlyRoute, reachableFriendlyCities } from "../src/js/game/routes.js";

const rules = { actions: { transfer: 40 } };
const city = (id, factionId, adjacent, extra = {}) => ({ id, name: id, factionId, adjacent,
  troops: 2000, training: 40, morale: 50, gold: 500, food: 1000, officerIds: [], ...extra });
function fixture() {
  return {
    year: 196, month: 3, playerFactionId: "own", commandsRemaining: 6, eventLog: [],
    relations: { "ally|own": { friendliness: 70, allianceUntil: 196 * 12 + 6 } },
    officers: [{ id: "officer", name: "运输将领", factionId: "own", status: "active", locationCityId: "a", merit: 10, acted: false }],
    cities: [
      city("a", "own", ["b", "neutral", "enemy"], { troops: 10000, training: 80, morale: 90, gold: 1000, food: 5000, officerIds: ["officer"] }),
      city("b", "own", ["a", "c", "d"]),
      city("c", "own", ["b"]),
      city("d", "ally", ["b", "far"]),
      city("far", "own", ["d"]),
      city("neutral", "neutral", ["a", "island"]),
      city("enemy", "enemy", ["a", "island"]),
      city("island", "own", ["neutral", "enemy"])
    ]
  };
}
const getCity = (state, id) => state.cities.find((entry) => entry.id === id);

test("friendly routes use BFS across any number of connected friendly cities", () => {
  const state = fixture();
  const before = structuredClone(state);
  assert.deepEqual(findFriendlyRoute(state, "a", "c"), ["a", "b", "c"]);
  assert.deepEqual(findFriendlyRoute(state, "a", "far"), ["a", "b", "d", "far"]);
  assert.deepEqual(findFriendlyRoute(state, "a", "a"), ["a"]);
  assert.deepEqual(reachableFriendlyCities(state, "a").map((entry) => entry.id), ["b", "c", "d", "far"]);
  assert.equal(findFriendlyRoute(state, "a", "unknown"), null);
  assert.deepEqual(reachableFriendlyCities(state, "unknown"), []);
  assert.deepEqual(state, before);
});

test("neutral and hostile cities block otherwise connected destinations", () => {
  const state = fixture();
  for (const target of ["neutral", "enemy", "island"]) assert.equal(findFriendlyRoute(state, "a", target), null);
  assert.equal(findFriendlyRoute(state, "neutral", "neutral"), null);
  // Even malformed diplomacy cannot turn unoccupied neutral land into an ally.
  state.relations["neutral|own"] = { allianceUntil: 9999 };
  assert.equal(findFriendlyRoute(state, "a", "neutral"), null);
  assert.equal(findFriendlyRoute(state, "a", "island"), null);
});

test("allied passage expires at the current month and never uses an ally's alliances", () => {
  const state = fixture();
  state.relations["ally|own"].allianceUntil = state.year * 12 + state.month;
  assert.equal(findFriendlyRoute(state, "a", "d"), null);
  assert.equal(findFriendlyRoute(state, "a", "far"), null);
  state.relations["ally|own"].allianceUntil += 1;
  assert.deepEqual(findFriendlyRoute(state, "a", "far"), ["a", "b", "d", "far"]);
  getCity(state, "far").factionId = "third";
  state.relations["ally|third"] = { allianceUntil: 9999 };
  assert.equal(findFriendlyRoute(state, "a", "far"), null);
  assert.deepEqual(findFriendlyRoute(state, "d", "far", "ally"), ["d", "far"]);
});

test("a multi-hop transport moves troops, gold and food together and charges only one command/fee", () => {
  const state = fixture();
  const source = getCity(state, "a");
  const target = getCity(state, "c");
  const middle = structuredClone(getCity(state, "b"));
  const result = executeTransfer(state, "a", "c", "officer", 1000, rules, { gold: 200, food: 750 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.path, ["a", "b", "c"]);
  assert.deepEqual(result.cargo, { troops: 1000, gold: 200, food: 750 });
  assert.equal(result.expense, 40);
  assert.deepEqual([source.troops, source.gold, source.food], [9000, 760, 4250]);
  assert.deepEqual([target.troops, target.gold, target.food], [3000, 700, 1750]);
  assert.deepEqual([target.training, target.morale], [53, 63]);
  assert.deepEqual(getCity(state, "b"), middle);
  assert.equal(state.commandsRemaining, 5);
  assert.equal(state.officers[0].acted, true);
  assert.equal(state.officers[0].merit, 40);
  assert.equal(state.officers[0].locationCityId, "a");
});

test("cargo may arrive at an allied city or cross an allied city to reach own territory", () => {
  for (const targetId of ["d", "far"]) {
    const state = fixture();
    const result = executeTransfer(state, "a", targetId, "officer", 500, rules, { gold: 100, food: 200 });
    assert.equal(result.ok, true);
    assert.equal(getCity(state, targetId).troops, 2500);
    assert.equal(getCity(state, targetId).gold, 600);
    assert.equal(getCity(state, targetId).food, 1200);
  }
});

test("gold and grain-only transports leave troop quality and garrisons unchanged", () => {
  for (const cargo of [{ gold: 100, food: 200 }, { gold: 100 }, { food: 200 }]) {
    const state = fixture();
    const source = getCity(state, "a");
    const target = getCity(state, "c");
    target.troops = 0;
    const result = executeTransfer(state, "a", "c", "officer", 0, rules, cargo);
    assert.equal(result.ok, true);
    assert.deepEqual([source.troops, source.training, source.morale], [10000, 80, 90]);
    assert.deepEqual([target.troops, target.training, target.morale], [0, 40, 50]);
    assert.equal(source.gold, 1000 - (cargo.gold ?? 0) - 40);
    assert.equal(target.gold, 500 + (cargo.gold ?? 0));
    assert.equal(source.food, 5000 - (cargo.food ?? 0));
    assert.equal(target.food, 1000 + (cargo.food ?? 0));
  }
});

test("legacy troop-only calls and numeric form input remain supported", () => {
  const state = fixture();
  assert.equal(executeTransfer(state, "a", "c", "officer", "500", rules).ok, true);
  assert.equal(getCity(state, "a").gold, 960);
  assert.equal(getCity(state, "c").food, 1000);
});

test("invalid or unavailable cargo never changes resources, officers or commands", () => {
  const badOrders = [
    [0, {}], [100, {}], [550, {}], [-100, {}], [500.5, {}], [NaN, {}], [Infinity, {}],
    [Number.MAX_SAFE_INTEGER + 1, {}], [null, { gold: 1 }], [false, { gold: 1 }],
    [10500, {}], [0, { gold: 961 }], [0, { food: 5001 }],
    [0, { gold: -1 }], [0, { food: -1 }], [0, { gold: 0.5 }], [0, { food: Infinity }],
    [0, { gold: NaN }], [0, { food: Number.MAX_SAFE_INTEGER + 1 }],
    [0, { gold: null, food: 1 }], [0, { gold: true }], [0, { food: {} }], [0, null], [0, []]
  ];
  for (const [troops, supplies] of badOrders) {
    const state = fixture();
    const before = structuredClone(state);
    assert.equal(executeTransfer(state, "a", "c", "officer", troops, rules, supplies).ok, false, `cargo: ${troops}, ${JSON.stringify(supplies)}`);
    assert.deepEqual(state, before);
  }
});

test("transport validates officers, source ownership, destination and command availability atomically", () => {
  const mutations = [
    (state) => { getCity(state, "a").officerIds = []; },
    (state) => { state.officers[0].acted = true; },
    (state) => { state.officers[0].status = "captured"; },
    (state) => { state.officers[0].status = "free"; },
    (state) => { state.officers[0].factionId = "ally"; },
    (state) => { state.officers[0].locationCityId = "b"; },
    (state) => { state.officers = []; },
    (state) => { getCity(state, "a").factionId = "ally"; },
    (state) => { state.commandsRemaining = 0; }
  ];
  for (const mutate of mutations) {
    const state = fixture();
    mutate(state);
    const before = structuredClone(state);
    assert.equal(executeTransfer(state, "a", "c", "officer", 500, rules).ok, false);
    assert.deepEqual(state, before);
  }
  for (const targetId of ["a", "neutral", "enemy", "island", "unknown"]) {
    const state = fixture();
    const before = structuredClone(state);
    assert.equal(executeTransfer(state, "a", targetId, "officer", 0, rules, { food: 1 }).ok, false);
    assert.deepEqual(state, before);
  }
});

test("source must afford cargo plus fee, with exact exhaustion allowed", () => {
  const state = fixture();
  const source = getCity(state, "a");
  const result = executeTransfer(state, "a", "c", "officer", 10000, rules, { gold: 960, food: 5000 });
  assert.equal(result.ok, true);
  assert.deepEqual([source.troops, source.gold, source.food], [0, 0, 0]);
  assert.deepEqual([getCity(state, "c").training, getCity(state, "c").morale], [73, 83]);
  const after = structuredClone(state);
  assert.equal(executeTransfer(state, "a", "c", "officer", 0, rules, { food: 1 }).ok, false);
  assert.deepEqual(state, after);
});

test("resource addition cannot overflow safe integer balances", () => {
  for (const [field, troops, supplies] of [["troops", 500, {}], ["gold", 0, { gold: 1 }], ["food", 0, { food: 1 }]]) {
    const state = fixture();
    getCity(state, "c")[field] = Number.MAX_SAFE_INTEGER;
    const before = structuredClone(state);
    assert.equal(executeTransfer(state, "a", "c", "officer", troops, rules, supplies).ok, false);
    assert.deepEqual(state, before);
  }
});
