import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState, migrateState, loadState, storageKey } from "../src/js/game/state.js";
import { executeDomestic, executeTransfer, previewDomestic, advanceMonth } from "../src/js/game/rules.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";
import { normalizeCityEquipment, EQUIPMENT_KEYS } from "../src/js/game/equipment.js";
import { advanceResearch, normalizeFactionResearch, technologyStatus, unlockTechnology } from "../src/js/game/technology.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const officer = (id) => ({ id, name: id, factionId: "a", locationCityId: "home", rank: "从事", status: "active",
  war: 70, intelligence: 80, leadership: 80, politics: 80, charm: 80, acted: false, merit: 0 });
const city = (id, factionId, adjacent, officerIds = []) => ({ id, name: id, factionId, adjacent, officerIds,
  troops: 10000, gold: 5000, food: 20000, agriculture: 50, commerce: 50, popularSupport: 70,
  morale: 80, training: 80, governorId: null });
const scenario = { id: "equipment-test", year: 196, month: 6, playerFactionId: "a",
  factions: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "fallen", name: "亡国" }, { id: "neutral", name: "空城" }],
  cities: [city("home", "a", ["bridge", "empty"], ["one", "two", "three", "four"]),
    city("bridge", "a", ["home", "ally"]), city("ally", "b", ["bridge"]), city("empty", "neutral", ["home"])],
  officers: ["one", "two", "three", "four"].map(officer) };
const fixture = () => {
  const state = createInitialState(scenario, rules);
  state.relations = { "a|b": { allianceUntil: 99999 } };
  return state;
};
const home = (state) => state.cities.find((entry) => entry.id === "home");
const cargo = (state) => Object.fromEntries(["gold", "food", "troops", ...EQUIPMENT_KEYS].map((key) => [key, home(state)[key]]));
const transferOrder = (values = {}) => ({ kind: "transfer", cityId: "home", officerIds: ["one"],
  payload: { targetId: "ally", troops: 0, gold: 0, food: 0, horses: 200, crossbows: 300, armor: 400, ...values } });

test("new occupied cities receive modest equipment stock while neutral cities receive none", () => {
  const state = fixture();
  assert.deepEqual(EQUIPMENT_KEYS.map((key) => home(state)[key]), [2000, 1500, 2500]);
  const empty = state.cities.find((entry) => entry.id === "empty");
  assert.deepEqual(EQUIPMENT_KEYS.map((key) => empty[key]), [0, 0, 0]);
  assert.equal(state.equipmentVersion, 1);
  assert.equal(state.researchVersion, 1);
  for (const faction of state.factions) {
    assert.equal(faction.researchPoints, 0);
    assert.deepEqual(faction.unlockedTechnologies, []);
  }
  assert.equal(scenario.cities[0].horses, undefined, "scenario data is never modified");
});

test("equipment normalization preserves zero and valid stores and repairs invalid quantities", () => {
  const value = { factionId: "a", troops: 10000, horses: 0, crossbows: 123, armor: -3 };
  normalizeCityEquipment(value, rules);
  assert.deepEqual([value.horses, value.crossbows, value.armor], [0, 123, 0]);
  assert.deepEqual(normalizeCityEquipment({ ...value }, rules), value);
});

for (const [action, key] of [["breedHorses", "horses"], ["craftCrossbows", "crossbows"], ["craftArmor", "armor"]]) {
  test(`${action} is a paid multi-officer domestic task with uncapped stock and deferred output`, () => {
    const state = fixture();
    const city = home(state);
    const before = city[key];
    const preview = previewDomestic(action, state.officers.slice(0, 3), city, rules);
    assert.equal(preview.resource, key);
    assert.equal(preview.targetKey, key);
    assert.equal(preview.gain, 1654);
    assert.equal(preview.expense, rules.development[action].expense * 3);
    const queued = queueTask(state, { kind: "domestic", cityId: city.id, officerIds: ["one", "two", "three"], payload: { action } }, rules);
    assert.equal(queued.ok, true);
    assert.equal(city[key], before);
    assert.equal(city.gold, 5000 - preview.expense);
    assert.equal(state.commandsRemaining, 5);
    assert.equal(queued.task.reservation[key], 0);
    assert.equal(settleTasks(state, rules).completed.length, 1);
    assert.equal(home(state)[key], before + preview.gain);
    assert.equal(home(state).gold, 5000 - preview.expense);
    const after = structuredClone(state);
    settleTasks(state, rules);
    assert.deepEqual(state, after);
  });
}

test("equipment production rejects unavailable actors, excessive staffing and inadequate funds atomically", () => {
  for (const mutate of [
    (state) => { home(state).gold = 0; },
    (state) => { state.officers[0].acted = true; },
    (state) => { state.officers[0].taskId = "busy"; },
    (state) => { home(state).armor = Number.MAX_SAFE_INTEGER; }
  ]) {
    const state = fixture();
    mutate(state);
    const before = structuredClone(state);
    assert.equal(executeDomestic(state, "home", "craftArmor", ["one"], rules).ok, false);
    assert.deepEqual(state, before);
  }
  const state = fixture();
  const before = structuredClone(state);
  assert.equal(executeDomestic(state, "home", "craftArmor", ["one", "two", "three", "four"], rules).ok, false);
  assert.deepEqual(state, before);
});

test("equipment-only transports travel across connected friendly territory to allied cities", () => {
  const state = fixture();
  const target = state.cities.find((entry) => entry.id === "ally");
  const before = { ...target };
  const result = executeTransfer(state, "home", "ally", "one", 0, rules, { horses: 200, armor: "300", crossbows: 400 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.path, ["home", "bridge", "ally"]);
  assert.deepEqual([home(state).horses, home(state).armor, home(state).crossbows], [1800, 2200, 1100]);
  assert.deepEqual([target.horses, target.armor, target.crossbows], [before.horses + 200, before.armor + 300, before.crossbows + 400]);
  assert.equal(target.troops, before.troops);
  assert.equal(target.training, before.training);
  assert.equal(target.morale, before.morale);
  assert.equal(home(state).gold, 5000 - rules.actions.transfer);
});

test("queued equipment reserves once, survives JSON restore, and arrives exactly once", () => {
  let state = fixture();
  const before = structuredClone(state);
  const result = queueTask(state, transferOrder(), rules);
  assert.equal(result.ok, true);
  assert.deepEqual(EQUIPMENT_KEYS.map((key) => home(state)[key]), [1800, 1200, 2100]);
  assert.deepEqual(EQUIPMENT_KEYS.map((key) => result.task.reservation[key]), [200, 300, 400]);
  assert.equal(state.cities[2].armor, before.cities[2].armor);
  state = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  assert.equal(state.officers[0].taskId, result.task.id);
  assert.equal(settleTasks(state, rules).completed.length, 1);
  assert.equal(state.cities[2].horses, before.cities[2].horses + 200);
  assert.equal(state.cities[2].crossbows, before.cities[2].crossbows + 300);
  assert.equal(state.cities[2].armor, before.cities[2].armor + 400);
  const after = structuredClone(state);
  settleTasks(state, rules);
  assert.deepEqual(state, after);
});

test("broken routes refund all reserved equipment and fee once; captured sources receive no refund", () => {
  for (const captured of [false, true]) {
    const state = fixture();
    const before = cargo(state);
    const targetBefore = structuredClone(state.cities[2]);
    queueTask(state, transferOrder(), rules);
    state.cities[1].factionId = "neutral";
    if (captured) home(state).factionId = "b";
    const reserved = cargo(state);
    assert.equal(settleTasks(state, rules).failed.length, 1);
    assert.deepEqual(cargo(state), captured ? reserved : before);
    assert.equal(state.tasks[0].reservation.status, captured ? "forfeited" : "returned");
    assert.deepEqual(state.cities[2], targetBefore);
    const after = structuredClone(state);
    settleTasks(state, rules);
    assert.deepEqual(state, after);
  }
});

test("equipment cannot be double-reserved or transported in malformed quantities", () => {
  for (const key of EQUIPMENT_KEYS) {
    for (const amount of [-1, 0.1, NaN, Infinity, null, true, {}, Number.MAX_SAFE_INTEGER]) {
      const state = fixture();
      const before = structuredClone(state);
      assert.equal(executeTransfer(state, "home", "ally", "one", 0, rules, { [key]: amount }).ok, false);
      assert.deepEqual(state, before);
    }
    const state = fixture();
    const result = queueTask(state, transferOrder({ [key]: home(state)[key] }), rules);
    assert.equal(result.ok, true);
    const next = transferOrder({ horses: 0, crossbows: 0, armor: 0, [key]: 1 });
    next.officerIds = ["two"];
    const before = structuredClone(state);
    assert.equal(queueTask(state, next, rules).ok, false);
    assert.deepEqual(state, before);
  }
});

test("research accrues monthly to every surviving faction, never to neutral or eliminated factions", () => {
  const state = fixture();
  const report = advanceMonth(state, rules);
  assert.deepEqual(report.research.map((entry) => entry.factionId), ["a", "b"]);
  assert.deepEqual(state.factions.map((faction) => faction.researchPoints), [100, 100, 0, 0]);
  state.factions[0].researchPoints = 1000000;
  advanceResearch(state, rules);
  assert.equal(state.factions[0].researchPoints, 1000100, "no gameplay accumulation limit");
});

test("all six advanced troop technologies start locked and can be unlocked without a city action", () => {
  const state = fixture();
  assert.deepEqual(Object.keys(rules.technologies).sort(), ["raiderCavalry", "heavyCavalry", "guard", "dragoon", "elephant", "rattan"].sort());
  for (const id of Object.keys(rules.technologies)) assert.equal(technologyStatus(state, "a", id, rules).unlocked, false);
  state.factions[0].researchPoints = 10000;
  const officersBefore = structuredClone(state.officers);
  const citiesBefore = structuredClone(state.cities);
  const commandsBefore = state.commandsRemaining;
  let totalCost = 0;
  for (const [id, config] of Object.entries(rules.technologies)) {
    assert.equal(technologyStatus(state, "a", id, rules).ok, true);
    const result = unlockTechnology(state, "a", id, rules);
    assert.equal(result.ok, true);
    assert.equal(result.cost, config.cost);
    assert.equal(technologyStatus(state, "a", id, rules).unlocked, true);
    totalCost += config.cost;
  }
  assert.equal(state.factions[0].researchPoints, 10000 - totalCost);
  assert.equal(state.commandsRemaining, commandsBefore);
  assert.deepEqual(state.officers, officersBefore);
  assert.deepEqual(state.cities, citiesBefore);
  const after = structuredClone(state);
  assert.equal(unlockTechnology(state, "a", "dragoon", rules).ok, false);
  assert.deepEqual(state, after);
});

test("research validation is read-only and rejects invalid, unavailable and mid-resolution purchases", () => {
  const state = fixture();
  let before = structuredClone(state);
  assert.equal(technologyStatus(state, "a", "dragoon", rules).affordable, false);
  assert.equal(unlockTechnology(state, "a", "dragoon", rules).ok, false);
  assert.deepEqual(state, before);
  state.factions[0].researchPoints = 1000;
  for (const [factionId, id] of [["b", "dragoon"], ["neutral", "dragoon"], ["fallen", "dragoon"], ["missing", "dragoon"], ["a", "missing"]]) {
    before = structuredClone(state);
    assert.equal(unlockTechnology(state, factionId, id, rules).ok, false);
    assert.deepEqual(state, before);
  }
  for (const patch of [{ turnResolution: { stage: "tasks" } }, { tasks: [{ status: "awaiting_battle" }] }]) {
    const blocked = { ...structuredClone(state), ...patch };
    before = structuredClone(blocked);
    assert.equal(unlockTechnology(blocked, "a", "dragoon", rules).ok, false);
    assert.deepEqual(blocked, before);
  }
  const normalized = normalizeFactionResearch({ researchPoints: -2, unlockedTechnologies: ["guard", "guard", null, 4] }, rules);
  assert.deepEqual(normalized, { researchPoints: 0, unlockedTechnologies: ["guard"] });
});

test("old saves seed absent equipment from current garrison, preserve progress and keep legacy tasks funded", () => {
  const state = fixture();
  queueTask(state, { kind: "domestic", cityId: "home", officerIds: ["one"], payload: { action: "agriculture" } }, rules);
  delete state.equipmentVersion;
  delete state.researchVersion;
  home(state).troops = 2000;
  home(state).horses = 0;
  delete home(state).armor;
  delete home(state).crossbows;
  state.factions[0].researchPoints = 432;
  state.factions[0].unlockedTechnologies = ["guard"];
  for (const key of EQUIPMENT_KEYS) delete state.tasks[0].reservation[key];
  const before = structuredClone(state);
  const migrated = migrateState(state, scenario, rules);
  assert.deepEqual(EQUIPMENT_KEYS.map((key) => home(migrated)[key]), [0, 300, 500]);
  assert.equal(migrated.factions[0].researchPoints, 432);
  assert.deepEqual(migrated.factions[0].unlockedTechnologies, ["guard"]);
  assert.deepEqual(EQUIPMENT_KEYS.map((key) => migrated.tasks[0].reservation[key]), [0, 0, 0]);
  assert.deepEqual(state, before);
  assert.deepEqual(migrateState(migrated, scenario, rules), migrated);
  assert.equal(settleTasks(migrated, rules).completed.length, 1);
});

test("equipment/research upgrade saves recoverable snapshots without overwriting existing snapshots", (context) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value)
  } });
  context.after(() => original ? Object.defineProperty(globalThis, "localStorage", original) : delete globalThis.localStorage);
  const state = fixture();
  delete state.equipmentVersion;
  delete state.researchVersion;
  const raw = JSON.stringify(state);
  const key = storageKey(scenario.id);
  data.set(key, raw);
  const loaded = loadState(scenario, rules);
  assert.equal(data.get(`${key}:before-equipment-v1`), raw);
  assert.equal(data.get(`${key}:before-research-v1`), raw);
  assert.equal(JSON.parse(data.get(key)).equipmentVersion, 1);
  loaded.month = 12;
  data.set(key, JSON.stringify(loaded));
  loadState(scenario, rules);
  assert.equal(data.get(`${key}:before-equipment-v1`), raw);
});

test("a mixed army reserves its loadout once and carries an explicit equipment ledger into battle", () => {
  const state = fixture();
  state.relations = {};
  home(state).adjacent.push("ally");
  const initial = cargo(state);
  const result = queueTask(state, { kind: "march", cityId: "home", officerIds: ["one"], payload: {
    targetId: "ally", supplies: { food: 100, gold: 50 }, divisions: [{ officerIds: ["one"], troops: 1000,
      composition: { infantry: 100, cavalry: 400, crossbowman: 300, heavyInfantry: 200 } }]
  } }, rules);
  assert.equal(result.ok, true);
  assert.deepEqual(EQUIPMENT_KEYS.map((key) => result.task.reservation[key]), [400, 300, 200]);
  assert.deepEqual(EQUIPMENT_KEYS.map((key) => home(state)[key]), [initial.horses - 400, initial.crossbows - 300, initial.armor - 200]);
  const reserved = cargo(state);
  const report = settleTasks(state, rules);
  assert.equal(report.battleTask.id, result.task.id);
  assert.deepEqual(report.battleTask.battle.equipment, { horses: 400, crossbows: 300, armor: 200 });
  assert.deepEqual(cargo(state), reserved, "departure at settlement never withdraws equipment a second time");
});

test("cancelled mixed-army departure refunds troops, money, grain and all equipment exactly once", () => {
  const state = fixture();
  state.relations = {};
  home(state).adjacent.push("ally");
  const before = cargo(state);
  const result = queueTask(state, { kind: "march", cityId: "home", officerIds: ["one"], payload: {
    targetId: "ally", supplies: { food: 100, gold: 50 }, divisions: [{ officerIds: ["one"], troops: 1000,
      composition: { cavalry: 400, crossbowman: 300, heavyInfantry: 300 } }]
  } }, rules);
  assert.equal(result.ok, true);
  state.relations = { "a|b": { allianceUntil: 99999 } };
  assert.equal(settleTasks(state, rules).failed.length, 1);
  assert.deepEqual(cargo(state), before);
  assert.equal(state.tasks[0].reservation.status, "returned");
  const after = structuredClone(state);
  settleTasks(state, rules);
  assert.deepEqual(state, after);
});

test("unfunded legacy cavalry orders migrate to infantry without minting horses", () => {
  const state = fixture();
  const cavalry = { officerId: "one", troops: 1000, unitType: "cavalry" };
  state.pendingInvasions = [{ id: "old", sourceId: "ally", targetId: "home", attackerFactionId: "b",
    resolved: false, divisions: [{ ...cavalry }], supplies: { gold: 0, food: 100 } }];
  state.tasks = [{ id: "old-task", status: "awaiting_battle", officerIds: ["one"],
    payload: { divisions: [{ ...cavalry }] }, battle: { divisions: [{ ...cavalry }] },
    reservation: { gold: 0, food: 100, troops: 1000, training: 80, morale: 80, status: "consumed" } }];
  const migrated = migrateState(state, scenario, rules);
  assert.equal(migrated.pendingInvasions[0].divisions[0].unitType, "infantry");
  assert.equal(migrated.tasks[0].payload.divisions[0].unitType, "infantry");
  assert.equal(migrated.tasks[0].battle.divisions[0].unitType, "infantry");
  assert.equal(home(migrated).horses, home(state).horses);
  assert.deepEqual(migrateState(migrated, scenario, rules), migrated);
  const funded = structuredClone(state);
  funded.pendingInvasions[0].equipment = { horses: 1000, crossbows: 0, armor: 0 };
  funded.tasks[0].reservation.horses = 1000;
  funded.tasks[0].battle.equipment = { horses: 1000, crossbows: 0, armor: 0 };
  const retained = migrateState(funded, scenario, rules);
  assert.equal(retained.pendingInvasions[0].divisions[0].unitType, "cavalry");
  assert.equal(retained.tasks[0].payload.divisions[0].unitType, "cavalry");
  assert.equal(retained.tasks[0].battle.divisions[0].unitType, "cavalry");
});
