import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCityDefense, applyWallDevelopment } from "../src/js/game/city-defense.js";
import { createInitialState, migrateState, loadState, storageKey } from "../src/js/game/state.js";
import { executeDomestic, previewDomestic, runGovernorAutomation } from "../src/js/game/rules.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const fixture = () => {
  const state = createInitialState(scenario, rules);
  const city = state.cities.find((entry) => entry.id === "xiaopei");
  city.gold = 10000;
  city.governorId = null;
  return { state, city, officer: state.officers.find((entry) => entry.id === "liu-bei") };
};

test("city defense defaults represent architectural scale and never require an owner or general", () => {
  assert.deepEqual(normalizeCityDefense({ id: "xuchang" }), { wallLevel: 3, defense: 100, wallProgress: 0 });
  assert.deepEqual(normalizeCityDefense({ id: "xuzhou" }), { wallLevel: 2, defense: 100, wallProgress: 0 });
  assert.deepEqual(normalizeCityDefense({ id: "xiaopei", factionId: "neutral", officerIds: [], troops: 0 }), { wallLevel: 1, defense: 100, wallProgress: 0 });
  assert.deepEqual(normalizeCityDefense({ wallLevel: 99, defense: -4, wallProgress: 120 }), { wallLevel: 3, defense: 0, wallProgress: 0 });
  assert.deepEqual(normalizeCityDefense({ wallLevel: 2, defense: 45, wallProgress: 63 }), { wallLevel: 2, defense: 45, wallProgress: 63 });
});

test("fresh scenarios and migrated saves contain bounded wall fields while preserving genuine damage and expansion progress", () => {
  const initial = createInitialState(scenario, rules);
  assert.equal(initial.armyVersion, 1);
  assert.ok(initial.cities.every((city) => city.wallLevel >= 1 && city.wallLevel <= 3 && city.defense === 100 && city.wallProgress === 0));
  const saved = structuredClone(initial);
  delete saved.armyVersion;
  Object.assign(saved.cities[0], { defense: 0, wallLevel: 2, wallProgress: 89 });
  delete saved.cities[1].wallLevel;
  delete saved.cities[1].defense;
  delete saved.cities[1].wallProgress;
  saved.cities[0].gold = 123;
  saved.cities[0].food = 456;
  const before = structuredClone(saved);
  const migrated = migrateState(saved, scenario, rules);
  assert.deepEqual(normalizeCityDefense(migrated.cities[0]), { wallLevel: 2, defense: 0, wallProgress: 89 });
  assert.equal(migrated.cities[0].gold, 123);
  assert.equal(migrated.cities[0].food, 456);
  assert.equal(migrated.cities[1].defense, 100);
  assert.deepEqual(saved, before);
});

test("repairing nearly intact walls never accidentally grants a level or construction progress", () => {
  const city = { wallLevel: 1, defense: 99, wallProgress: 95 };
  const result = applyWallDevelopment(city, 25);
  assert.equal(result.defenseGain, 1);
  assert.equal(result.progressGain, 0);
  assert.deepEqual(city, { wallLevel: 1, defense: 100, wallProgress: 95 });
  const expansion = applyWallDevelopment(city, 25);
  assert.equal(expansion.levelGain, 1);
  assert.deepEqual(city, { wallLevel: 2, defense: 100, wallProgress: 20 });
});

test("architecture rises only at 100 accumulated progress and maximum level can only be repaired", () => {
  const city = { wallLevel: 2, defense: 100, wallProgress: 90 };
  applyWallDevelopment(city, 9);
  assert.deepEqual(city, { wallLevel: 2, defense: 100, wallProgress: 99 });
  applyWallDevelopment(city, 12);
  assert.deepEqual(city, { wallLevel: 3, defense: 100, wallProgress: 0 });
  const snapshot = structuredClone(city);
  assert.equal(applyWallDevelopment(city, 500).progressGain, 0);
  assert.deepEqual(city, snapshot);
  city.defense = 30;
  assert.equal(applyWallDevelopment(city, 15).defenseGain, 15);
  assert.deepEqual(city, { wallLevel: 3, defense: 45, wallProgress: 0 });
});

test("wall command previews match real paid repair, and maximum undamaged walls reject without spending", () => {
  const { state, city, officer } = fixture();
  Object.assign(city, { wallLevel: 2, defense: 42, wallProgress: 95 });
  const preview = previewDomestic("buildWall", [officer], city, rules);
  const gold = city.gold;
  const result = executeDomestic(state, city.id, "buildWall", [officer.id], rules);
  assert.equal(result.ok, true, result.message);
  assert.equal(city.defense, 42 + preview.defenseGain);
  assert.equal(city.wallProgress, 95);
  assert.equal(city.wallLevel, 2);
  assert.equal(city.gold, gold - rules.development.buildWall.expense);
  assert.equal(state.commandsRemaining, rules.commandsPerMonth - 1);
  assert.equal(officer.acted, true);
  Object.assign(city, { wallLevel: 3, defense: 100, wallProgress: 0 });
  officer.acted = false;
  const snapshot = structuredClone(state);
  assert.equal(executeDomestic(state, city.id, "buildWall", [officer.id], rules).ok, false);
  assert.deepEqual(state, snapshot);
});

test("wall work defaults to turn-end tasks, reserves money immediately and applies improvements only once", () => {
  const { state, city, officer } = fixture();
  Object.assign(city, { wallLevel: 1, defense: 100, wallProgress: 95 });
  const preview = previewDomestic("buildWall", [officer], city, rules);
  const result = queueTask(state, { kind: "domestic", cityId: city.id, officerIds: [officer.id], payload: { action: "buildWall" } }, rules);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.task.title, "修筑城防");
  assert.equal(city.wallLevel, 1);
  assert.equal(city.wallProgress, 95);
  assert.equal(city.gold, 10000 - preview.expense);
  const completed = settleTasks(state, rules);
  assert.equal(completed.completed.length, 1);
  const target = state.cities.find((entry) => entry.id === city.id);
  assert.equal(target.wallLevel, 2);
  assert.equal(target.wallProgress, 95 + preview.work - 100);
  assert.equal(target.gold, 10000 - preview.expense);
  const snapshot = structuredClone(state);
  settleTasks(state, rules);
  assert.deepEqual(state, snapshot);
});

test("governors can repair badly damaged walls without spending a ruler command or producing upgrade progress", () => {
  const { state, city, officer } = fixture();
  Object.assign(city, { governorId: officer.id, wallLevel: 2, defense: 10, wallProgress: 95,
    agriculture: 100, commerce: 100, popularSupport: 100, training: 100 });
  const commands = state.commandsRemaining;
  const gold = city.gold;
  const reports = runGovernorAutomation(state, rules);
  assert.equal(reports.find((entry) => entry.cityId === city.id).action, "buildWall");
  assert.ok(city.defense > 10);
  assert.equal(city.wallProgress, 95);
  assert.equal(city.wallLevel, 2);
  assert.equal(city.gold, gold - rules.development.buildWall.expense);
  assert.equal(state.commandsRemaining, commands);
});

test("formation migration keeps pending army troops, escrow and every commander without replaying departure", () => {
  const { state, city } = fixture();
  delete state.armyVersion;
  state.pendingInvasions = [{ id: "old-army", sourceId: "puyang", targetId: city.id, attackerFactionId: "cao-cao", defenderFactionId: state.playerFactionId,
    troops: 2000, supplies: { food: 80, gold: 15 }, officerIds: ["xiahou-dun"], divisions: [{ officerId: "xiahou-dun", troops: 2000 }] }];
  const order = queueTask(state, { kind: "march", cityId: city.id, officerIds: ["guan-yu", "zhang-fei"],
    payload: { targetId: "puyang", divisions: [{ officerIds: ["guan-yu", "zhang-fei"], troops: 3000 }], supplies: { food: 100, gold: 0 } } }, rules);
  assert.equal(order.ok, true, order.message);
  const snapshot = structuredClone(state);
  const migrated = migrateState(state, scenario, rules);
  assert.deepEqual(migrated.pendingInvasions[0].divisions[0].officerIds, ["xiahou-dun"]);
  assert.equal(migrated.pendingInvasions[0].troops, 2000);
  assert.deepEqual(migrated.pendingInvasions[0].supplies, { food: 80, gold: 15 });
  assert.deepEqual(migrated.tasks[0].payload.divisions[0].officerIds, ["guan-yu", "zhang-fei"]);
  assert.equal(migrated.cities.find((entry) => entry.id === city.id).troops, snapshot.cities.find((entry) => entry.id === city.id).troops);
  assert.equal(migrated.cities.find((entry) => entry.id === city.id).gold, snapshot.cities.find((entry) => entry.id === city.id).gold);
  assert.deepEqual(migrated.tasks[0].reservation, snapshot.tasks[0].reservation);
  assert.deepEqual(state, snapshot);
});

test("old army saves receive a recoverable one-time backup without overwriting treasury or existing snapshots", (context) => {
  const priorStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  context.after(() => { globalThis.localStorage = priorStorage; });
  const { state, city } = fixture();
  delete state.armyVersion;
  delete city.wallLevel;
  delete city.defense;
  delete city.wallProgress;
  const key = storageKey(scenario.id);
  const raw = JSON.stringify(state);
  values.set(key, raw);
  const loaded = loadState(scenario, rules);
  assert.equal(values.get(`${key}:before-army-v1`), raw);
  assert.equal(loaded.cities.find((entry) => entry.id === city.id).gold, city.gold);
  assert.equal(loaded.cities.find((entry) => entry.id === city.id).wallLevel, 1);
  loadState(scenario, rules);
  assert.equal(values.get(`${key}:before-army-v1`), raw);
});
