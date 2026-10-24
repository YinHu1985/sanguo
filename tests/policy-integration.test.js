import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState, migrateState, loadState, storageKey } from "../src/js/game/state.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";
import { rollbackTechnology } from "../src/js/game/technology.js";
import { heavenCycleStatus } from "../src/js/game/heaven-cycle.js";
import { unitTypeAvailability } from "../src/js/game/troops.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const city = (id, factionId, officers, adjacent) => ({ id, name: id, factionId, officerIds: officers, adjacent,
  troops: 10000, gold: 5000, food: 30000, horses: 3000, crossbows: 3000, armor: 3000,
  agriculture: 50, commerce: 50, popularSupport: 70, training: 80, morale: 80 });
const scenario = { id: "policy-integration", year: 196, month: 6, playerFactionId: "a",
  factions: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "neutral", name: "无主" }],
  cities: [city("home", "a", ["one", "two"], ["enemy"]), city("enemy", "b", [], ["home"])],
  officers: ["one", "two"].map((id) => ({ id, name: id, factionId: "a", locationCityId: "home", status: "active",
    rank: "君主", war: 70, intelligence: 80, leadership: 80, politics: 70, charm: 70, acted: false, merit: 0 })) };
const fixture = () => {
  const state = createInitialState(scenario, rules);
  Object.assign(state.factions[0], { researchPoints: 432, unlockedTechnologies: ["guard"] });
  return state;
};
const march = (officerId = "one") => ({ kind: "march", cityId: "home", officerIds: [officerId], payload: {
  targetId: "enemy", divisions: [{ officerIds: [officerId], troops: 1000, composition: { guard: 1000 } }], supplies: { food: 240, gold: 50 }
} });
const cityResources = (state) => Object.fromEntries(["gold", "food", "troops", "horses", "crossbows", "armor"]
  .map((key) => [key, state.cities[0][key]]));

test("policy migration retains legacy technology and points without retroactive heaven outcomes", () => {
  const old = fixture();
  delete old.policyVersion;
  old.factions.forEach((faction) => { delete faction.heavenCycle; });
  const restored = migrateState(old, scenario, rules);
  assert.equal(restored.policyVersion, 1);
  assert.equal(restored.factions[0].researchPoints, 432);
  assert.deepEqual(restored.factions[0].unlockedTechnologies, ["guard"]);
  assert.ok(unitTypeAvailability("guard", { state: restored, factionId: "a", rules }).available);
  for (const faction of restored.factions) {
    assert.equal(heavenCycleStatus(faction, rules).phase, faction.id === "neutral" ? "neutral" : "victory");
    assert.equal(heavenCycleStatus(faction, rules).multiplier, faction.id === "neutral" ? 1 : 0.9);
    assert.equal(faction.heavenCycle.lastReason, "", "a new default is not a fabricated victory event");
  }
  assert.deepEqual(migrateState(restored, scenario, rules), restored);
  assert.equal(old.policyVersion, undefined, "migration never modifies its source save");
});

test("save round trips preserve defeat momentum after a policy rollback", () => {
  const state = fixture();
  assert.ok(rollbackTechnology(state, "a", "guard", rules).ok);
  const after = heavenCycleStatus(state.factions[0], rules);
  assert.equal(after.phase, "defeat");
  const restored = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  assert.deepEqual(heavenCycleStatus(restored.factions[0], rules), after);
  assert.equal(restored.factions[0].researchPoints, 432, "rollback does not refund points");
  assert.deepEqual(restored.factions[0].unlockedTechnologies, []);
});

test("upgrading policy saves writes a recoverable one-time backup", (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)
  } });
  context.after(() => previous ? Object.defineProperty(globalThis, "localStorage", previous) : delete globalThis.localStorage);
  const state = fixture();
  delete state.policyVersion;
  const raw = JSON.stringify(state), key = storageKey(scenario.id);
  values.set(key, raw);
  const restored = loadState(scenario, rules);
  assert.equal(values.get(`${key}:before-policies-v1`), raw);
  assert.equal(JSON.parse(values.get(key)).policyVersion, 1);
  assert.deepEqual(loadState(scenario, rules), restored);
  assert.equal(values.get(`${key}:before-policies-v1`), raw);
});

test("rollback does not invalidate an already funded march or restore the global unlock", () => {
  const state = fixture();
  const queued = queueTask(state, march(), rules);
  assert.ok(queued.ok, queued.message);
  assert.deepEqual(queued.task.formationTechnologies, ["guard"]);
  const reserved = cityResources(state);
  assert.ok(rollbackTechnology(state, "a", "guard", rules).ok);
  const rejected = queueTask(state, march("two"), rules);
  assert.equal(rejected.ok, false, "new formations cannot use a revoked unlock");
  assert.deepEqual(cityResources(state), reserved);
  const report = settleTasks(state, rules);
  assert.equal(report.failed.length, 0);
  assert.equal(report.battleTask?.status, "awaiting_battle");
  assert.deepEqual(report.battleTask.battle.divisions[0].composition, { guard: 1000 });
  assert.deepEqual(cityResources(state), reserved, "previously reserved troops and cargo are not charged twice");
  assert.deepEqual(state.factions[0].unlockedTechnologies, [], "temporary validation context cannot leak into campaign data");
  const after = structuredClone(state);
  settleTasks(state, rules);
  assert.deepEqual(state, after, "replaying settlement never dispatches the order twice");
});

test("legacy funded orders gain one compatibility snapshot without granting unknown unlocks", () => {
  const state = fixture();
  assert.ok(queueTask(state, march(), rules).ok);
  delete state.policyVersion;
  delete state.tasks[0].formationTechnologies;
  const restored = migrateState(state, scenario, rules);
  assert.deepEqual(restored.tasks[0].formationTechnologies, ["guard"]);
  assert.ok(rollbackTechnology(restored, "a", "guard", rules).ok);
  const reloaded = migrateState(restored, scenario, rules);
  assert.deepEqual(reloaded.tasks[0].formationTechnologies, ["guard"]);
  assert.equal(settleTasks(reloaded, rules).battleTask?.status, "awaiting_battle");

  state.factions[0].unlockedTechnologies = [];
  const invalid = migrateState(state, scenario, rules);
  assert.deepEqual(invalid.tasks[0].formationTechnologies, []);
  assert.equal(settleTasks(invalid, rules).failed.length, 1);
  assert.equal(invalid.tasks[0].reservation.status, "returned");
});

test("preserving an order's technology does not bypass real-time ownership or officer checks", () => {
  const state = fixture();
  assert.ok(queueTask(state, march(), rules).ok);
  assert.ok(rollbackTechnology(state, "a", "guard", rules).ok);
  state.officers[0].status = "captured";
  const report = settleTasks(state, rules);
  assert.equal(report.failed.length, 1);
  assert.equal(state.tasks[0].reservation.status, "returned");
  assert.equal(state.cities[0].troops, 10000);
  assert.equal(state.cities[0].crossbows, 3000);
});
