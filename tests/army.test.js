import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { aggregateAbilities, armyLimits, formationCapacity, formationOfficerIds, groupOfficersForArmy, normalizeFormations, createDefenderFormations } from "../src/js/game/army.js";
import { validateArmy, commitArmyDeparture } from "../src/js/game/rules.js";
import { queueTask, settleTasks, finishBattleTask } from "../src/js/game/tasks.js";
import { runWorldTurn } from "../src/js/game/campaign.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
function fixture(count = 25) {
  const officers = Array.from({ length: count }, (_, index) => ({ id: `o${index}`, name: `将${index}`, factionId: "a", locationCityId: "source", status: "active",
    rank: "校尉", war: 70, intelligence: 80, leadership: 90 - index, politics: 70, charm: 80, acted: false, merit: 0 }));
  const city = (id, factionId, officerIds, troops) => ({ id, name: id, factionId, officerIds, troops, training: 80, morale: 80,
    gold: 200000, food: 500000, agriculture: 100, commerce: 100, popularSupport: 100, adjacent: [id === "source" ? "target" : "source"], governorId: null });
  return { year: 196, month: 11, elapsedMonths: 5, playerFactionId: "a", commandsRemaining: 6, commandsMax: 6,
    cities: [city("source", "a", officers.map((officer) => officer.id), 100000), city("target", "b", [], 500)],
    officers, factions: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }], eventLog: [], tasks: [], pendingInvasions: [] };
}
const formations = (count = 8, perGroup = 3) => Array.from({ length: count }, (_, index) => ({ id: `group${index}`, name: `第${index + 1}军`,
  officerIds: Array.from({ length: perGroup }, (_, offset) => `o${index * perGroup + offset}`), troops: 3000, unitType: "infantry" }));

test("legacy and multi-officer groups normalize without splitting the shared troop pool or mutating inputs", () => {
  const original = [{ officerId: "a", troops: 2000 }, { officerId: "ignored", officerIds: ["b", "c"], troops: 5000, unitType: "cavalry" }];
  const snapshot = structuredClone(original);
  const groups = normalizeFormations(original);
  assert.deepEqual(groups[0], { officerId: "a", officerIds: ["a"], troops: 2000, unitType: "infantry" });
  assert.deepEqual(formationOfficerIds(groups[1]), ["b", "c"]);
  assert.equal(groups[1].officerId, "b");
  assert.equal(groups[1].troops, 5000);
  assert.deepEqual(original, snapshot);
});

test("abilities aggregate each of five dimensions independently by maximum, not sum or first officer", () => {
  assert.deepEqual(aggregateAbilities([
    { war: 99, intelligence: 30, leadership: 80, politics: 20, charm: 60 },
    { war: 30, intelligence: 97, leadership: 40, politics: 95, charm: 85 },
    { war: 40, intelligence: 40, leadership: 96, politics: 30, charm: 20 }
  ]), { war: 99, intelligence: 97, leadership: 96, politics: 95, charm: 85 });
  assert.deepEqual(aggregateAbilities([]), { war: 0, intelligence: 0, leadership: 0, politics: 0, charm: 0 });
  assert.equal(formationCapacity([{ rank: "君主" }, { rank: "校尉" }, { rank: "unknown" }], rules), 6000);
  assert.equal(formationCapacity([{ rank: "校尉" }, { rank: "君主" }], rules), 3000);
  assert.equal(formationCapacity([], rules), 0);
});

test("only the first officer commands the troop capacity while deputy abilities remain shared", () => {
  const state = fixture();
  state.officers[0].rank = "君主";
  const group = [{ officerIds: ["o0", "o1"], troops: 6000, unitType: "cavalry" }];
  state.cities[0].horses = 6000;
  const army = validateArmy(state, "source", "target", group, rules);
  assert.equal(army.ok, true, army.message);
  assert.equal(army.divisions.length, 1);
  assert.equal(army.divisions[0].troops, 6000);
  assert.deepEqual(army.divisions[0].officerIds, ["o0", "o1"]);
  assert.equal(validateArmy(state, "source", "target", [{ officerIds: ["o1", "o0"], troops: 6000 }], rules).ok, false);
  assert.equal(validateArmy(state, "source", "target", [{ officerId: "o0", troops: 6000 }], rules).ok, true);
});

test("eight groups of three generals depart with one fee and every assigned commander marked acted", () => {
  const state = fixture();
  const army = validateArmy(state, "source", "target", formations(), rules, { food: 500, gold: 100 });
  assert.equal(army.ok, true, army.message);
  assert.equal(army.total, 24000);
  assert.equal(commitArmyDeparture(state, army).ok, true);
  assert.equal(state.cities[0].troops, 76000);
  assert.equal(state.cities[0].food, 499500);
  assert.equal(state.cities[0].gold, 200000 - 100 - rules.actions.march);
  assert.equal(state.commandsRemaining, 5);
  assert.ok(state.officers.slice(0, 24).every((officer) => officer.acted));
  assert.equal(state.officers[24].acted, false);
  const snapshot = structuredClone(state);
  assert.equal(commitArmyDeparture(state, army).ok, false);
  assert.deepEqual(state, snapshot);
});

test("formation limits, global duplicate officers and unavailable secondary commanders fail atomically", () => {
  const invalid = [formations(9, 1), formations(1, 4), [{ officerIds: [], troops: 1000 }],
    [{ officerIds: ["o0", "o0"], troops: 1000 }],
    [{ officerIds: ["o0", "o1"], troops: 1000 }, { officerIds: ["o1", "o2"], troops: 1000 }],
    [{ id: "same", officerIds: ["o0"], troops: 1000 }, { id: "same", officerIds: ["o1"], troops: 1000 }]];
  for (const groups of invalid) {
    const state = fixture();
    const snapshot = structuredClone(state);
    assert.equal(validateArmy(state, "source", "target", groups, rules).ok, false);
    assert.deepEqual(state, snapshot);
  }
  for (const change of [{ acted: true }, { factionId: "b" }, { locationCityId: "target" }, { status: "captured" }, { status: "free" }, { taskId: "busy" }]) {
    const state = fixture();
    Object.assign(state.officers[1], change);
    assert.equal(validateArmy(state, "source", "target", formations(1, 2), rules).ok, false);
  }
});

test("malformed city balances cannot create nonfinite soldiers or bypass transport payment", () => {
  for (const key of ["gold", "food", "troops"]) {
    const state = fixture();
    state.cities[0][key] = NaN;
    const snapshot = structuredClone(state);
    assert.equal(validateArmy(state, "source", "target", formations(1, 2), rules).ok, false);
    assert.deepEqual(state, snapshot);
  }
});

test("departure rechecks every group member rather than only its compatibility leader field", () => {
  const state = fixture();
  const army = validateArmy(state, "source", "target", formations(1, 2), rules);
  assert.equal(army.ok, true);
  state.officers[1].acted = true;
  const snapshot = structuredClone(state);
  assert.equal(commitArmyDeparture(state, army).ok, false);
  assert.deepEqual(state, snapshot);
});

test("army limits default to eight units, three officers, sixty supply days and remain configurable", () => {
  assert.deepEqual(armyLimits({}), { maxUnits: 8, maxOfficersPerUnit: 3, maxSupplyDays: 60 });
  const state = fixture();
  const custom = structuredClone(rules);
  custom.army = { maxUnits: 2, maxOfficersPerUnit: 3 };
  assert.equal(validateArmy(state, "source", "target", formations(2, 3), custom).ok, true);
  assert.equal(validateArmy(state, "source", "target", formations(3, 1), custom).ok, false);
  assert.equal(validateArmy(state, "source", "target", formations(1, 4), custom).ok, false);
});

test("queued grouped march reserves once, locks all commanders and preserves groups through battle completion", () => {
  const state = fixture();
  const groups = formations(2, 3);
  const ids = groups.flatMap(formationOfficerIds);
  const result = queueTask(state, { kind: "march", cityId: "source", officerIds: ids,
    payload: { targetId: "target", divisions: groups, supplies: { food: 500, gold: 100 } } }, rules);
  assert.equal(result.ok, true, result.message);
  assert.equal(state.cities[0].troops, 94000);
  assert.equal(state.commandsRemaining, 5);
  assert.ok(state.officers.slice(0, 6).every((officer) => officer.taskId === result.taskId));
  const resources = { troops: state.cities[0].troops, gold: state.cities[0].gold, food: state.cities[0].food };
  const report = settleTasks(state, rules);
  assert.equal(report.battleTask.status, "awaiting_battle");
  assert.deepEqual(report.battleTask.battle.armyOfficerIds, ids);
  assert.equal(report.battleTask.battle.divisions.length, 2);
  assert.deepEqual(Object.fromEntries(Object.keys(resources).map((key) => [key, state.cities[0][key]])), resources);
  assert.equal(finishBattleTask(state, result.taskId, { message: "结束" }).ok, true);
  assert.ok(state.officers.slice(0, 6).every((officer) => !officer.taskId && officer.acted));
});

test("task executors must include every attached general, not only the group leader", () => {
  const state = fixture();
  const snapshot = structuredClone(state);
  const result = queueTask(state, { kind: "march", cityId: "source", officerIds: ["o0"],
    payload: { targetId: "target", divisions: formations(1, 2), supplies: { food: 50, gold: 0 } } }, rules);
  assert.equal(result.ok, false);
  assert.deepEqual(state, snapshot);
});

test("automatic defense groups up to 24 real commanders under eight leader-only caps and leaves reserves", () => {
  const state = fixture(27);
  const groups = createDefenderFormations(state.cities[0], state.officers, rules);
  assert.equal(groups.length, 8);
  assert.ok(groups.every((group) => group.officerIds.length === 3 && group.troops === 3000));
  assert.equal(new Set(groups.flatMap(formationOfficerIds)).size, 24);
  assert.equal(state.cities[0].troops - groups.reduce((sum, group) => sum + group.troops, 0), 76000);
  assert.equal(state.officers.length, 27);
  state.cities[0].officerIds = [];
  const garrison = createDefenderFormations(state.cities[0], state.officers, rules);
  assert.equal(garrison.length, 1);
  assert.deepEqual(garrison[0].officerIds, []);
  assert.equal(garrison[0].troops, 2000);
  assert.equal(garrison[0].officerId, null);
});

test("AI invasions also aggregate commanders without changing strategic resource or command accounting", () => {
  const state = fixture(10);
  state.playerFactionId = "b";
  state.officers.forEach((officer) => { officer.leadership = 100; });
  const commands = state.commandsRemaining;
  const before = structuredClone(state.cities[0]);
  const report = runWorldTurn(state, rules, () => 0);
  const invasion = report.battles.find((entry) => entry.targetId === "target");
  assert.ok(invasion);
  assert.equal(invasion.divisions.length, 8);
  assert.ok(invasion.divisions.every((group) => group.officerIds.length <= 3 && group.troops === 3000));
  assert.equal(invasion.officerIds.length, 10);
  assert.equal(state.cities[0].troops, before.troops - invasion.troops);
  assert.equal(state.cities[0].food, before.food - invasion.supplies.food);
  assert.equal(state.cities[0].gold, before.gold - invasion.supplies.gold - rules.actions.march);
  assert.equal(state.commandsRemaining, commands);
  assert.ok(state.officers.every((officer) => officer.acted));
});

test("shared automatic grouping prefers commanding capacity and assigns unused officers as deputies", () => {
  const state = fixture(5);
  state.officers[4].rank = "君主";
  const groups = groupOfficersForArmy(state.officers, rules, { troops: 6000, minTroops: 500 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0].id, "o4");
  assert.equal(groups[0].length, 3);
  assert.equal(formationCapacity(groups[0], rules), 6000);
  const formation = createDefenderFormations({ ...state.cities[0], troops: 6000 }, state.officers, rules)[0];
  assert.deepEqual(formation.officerIds, groups[0].map((officer) => officer.id));
  assert.equal(formation.officerId, "o4");
});

test("legacy oversized saved formations remain readable but cannot become a new order", () => {
  const state = fixture();
  const legacy = [{ officerIds: ["o0", "o1", "o2", "o3", "o4"], troops: 15000 }];
  const normalized = normalizeFormations(legacy);
  assert.deepEqual(normalized[0].officerIds, legacy[0].officerIds);
  assert.equal(normalized[0].troops, 15000);
  assert.equal(validateArmy(state, "source", "target", normalized, rules).ok, false);
});
