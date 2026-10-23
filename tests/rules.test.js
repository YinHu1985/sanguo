import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState } from "../src/js/game/state.js";
import { advanceMonth, appointGovernor, commitArmyDeparture, executeDomestic, executeRecruit, executeTransfer,
  mergeTroops, previewDomestic, runEnemyAdministration, validateArmy } from "../src/js/game/rules.js";
import { calculateMonthlyIncome, monthlyFoodCost } from "../src/js/game/economy.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));

test("domestic command consumes one command and marks all assigned officers", () => {
  const state = createInitialState(scenario, rules);
  const city = state.cities.find((item) => item.id === "xiaopei");
  const preview = previewDomestic("agriculture", [state.officers.find((item) => item.id === "liu-bei"), state.officers.find((item) => item.id === "jian-yong")], city, rules);
  const before = city.agriculture;
  const result = executeDomestic(state, city.id, "agriculture", ["liu-bei", "jian-yong"], rules);

  assert.equal(result.ok, true);
  assert.equal(state.commandsRemaining, rules.commandsPerMonth - 1);
  assert.equal(city.agriculture, before + preview.gain);
  assert.equal(state.officers.find((item) => item.id === "liu-bei").acted, true);
  assert.equal(state.officers.find((item) => item.id === "jian-yong").acted, true);
});

test("a governor develops the weakest city metric before the month advances", () => {
  const state = createInitialState(scenario, rules);
  const city = state.cities.find((item) => item.id === "xuzhou");
  city.agriculture = 80;
  city.commerce = 35;
  city.popularSupport = 75;
  city.training = 70;
  const before = city.commerce;

  advanceMonth(state, rules);

  assert.ok(city.commerce > before);
  assert.equal(state.month, 2);
  assert.equal(state.officers.every((officer) => officer.acted === false), true);
});

test("merging troops blends training and morale by troop count", () => {
  const city = { troops: 1000, training: 80, morale: 60 };
  mergeTroops(city, 3000, 40, 80);
  assert.deepEqual(city, { troops: 4000, training: 50, morale: 75 });
});

test("transferring troops between friendly neighbors blends destination quality", () => {
  const state = createInitialState(scenario, rules);
  const source = state.cities.find((city) => city.id === "xiaopei");
  const target = state.cities.find((city) => city.id === "xuzhou");
  const beforeTargetTroops = target.troops;
  const beforeGold = source.gold;
  const result = executeTransfer(state, source.id, target.id, "liu-bei", 2000, rules);

  assert.equal(result.ok, true);
  assert.equal(source.troops, 8500);
  assert.equal(target.troops, beforeTargetTroops + 2000);
  assert.equal(target.training, 58);
  assert.equal(target.morale, 69);
  assert.equal(state.commandsRemaining, 5);
  assert.equal(source.gold, beforeGold - rules.actions.transfer);
});

test("an unstaffed city keeps its garrison and receives income without automatic development", () => {
  const state = createInitialState(scenario, rules);
  const city = state.cities.find((item) => item.id === "xiaopei");
  city.officerIds = [];
  city.governorId = null;
  state.month = 3;
  const before = structuredClone(city);
  const officerCount = state.officers.length;
  const income = calculateMonthlyIncome(city, rules);
  advanceMonth(state, rules);
  assert.equal(city.troops, before.troops);
  assert.equal(city.gold, before.gold + income);
  assert.equal(city.food, before.food - monthlyFoodCost(before.troops, rules));
  for (const field of ["agriculture", "commerce", "popularSupport", "training", "morale"]) assert.equal(city[field], before[field]);
  assert.equal(city.governorId, null);
  assert.deepEqual(city.officerIds, []);
  assert.equal(state.officers.length, officerCount);
});

test("an unstaffed city cannot issue commands, appoint a governor or send an army", () => {
  const state = createInitialState(scenario, rules);
  const source = state.cities.find((item) => item.id === "xiaopei");
  source.officerIds = [];
  source.governorId = null;
  const snapshot = structuredClone(state);
  assert.equal(executeDomestic(state, source.id, "agriculture", [], rules).ok, false);
  assert.equal(executeRecruit(state, source.id, null, 1000, rules).ok, false);
  assert.equal(executeTransfer(state, source.id, "xuzhou", null, 1000, rules).ok, false);
  assert.equal(appointGovernor(state, source.id, null, rules).ok, false);
  assert.equal(validateArmy(state, source.id, "puyang", [], rules).ok, false);
  assert.equal(validateArmy(state, source.id, "puyang", [{ officerId: "guan-yu", troops: 1000 }], rules).ok, false);
  assert.deepEqual(state, snapshot);
});

test("legacy enemy administration also skips cities with no available officer", () => {
  const state = createInitialState(scenario, rules);
  const city = state.cities.find((item) => item.id === "puyang");
  city.officerIds = [];
  city.governorId = null;
  const snapshot = structuredClone(city);
  runEnemyAdministration(state, rules);
  assert.deepEqual(city, snapshot);
});

test("governor appointments have a real local fee and fail atomically without funds", () => {
  const state = createInitialState(scenario, rules);
  const city = state.cities.find((entry) => entry.id === "xiaopei");
  city.gold = rules.actions.appointGovernor - 1;
  const snapshot = structuredClone(state);
  assert.equal(appointGovernor(state, city.id, "liu-bei", rules).ok, false);
  assert.deepEqual(state, snapshot);
  city.gold = rules.actions.appointGovernor;
  assert.equal(appointGovernor(state, city.id, "liu-bei", rules).ok, true);
  assert.equal(city.gold, 0);
  assert.equal(city.governorId, "liu-bei");
  assert.equal(state.commandsRemaining, rules.commandsPerMonth - 1);
});

test("troop transfer cannot borrow its fee from a different city", () => {
  const state = createInitialState(scenario, rules);
  const city = state.cities.find((entry) => entry.id === "xiaopei");
  city.gold = 0;
  const snapshot = structuredClone(state);
  assert.equal(executeTransfer(state, city.id, "xuzhou", "liu-bei", 1000, rules).ok, false);
  assert.deepEqual(state, snapshot);
});

test("army departure pays its fee and loaded supplies exactly once", () => {
  const state = createInitialState(scenario, rules);
  const city = state.cities.find((entry) => entry.id === "xiaopei");
  const before = structuredClone(city);
  const army = validateArmy(state, city.id, "puyang", [{ officerId: "liu-bei", troops: 2000 }], rules, { food: 720, gold: 200 });
  assert.equal(army.ok, true);
  assert.deepEqual(army.supplies, { food: 720, gold: 200 });
  assert.equal(army.expense, rules.actions.march);
  assert.equal(commitArmyDeparture(state, army).ok, true);
  assert.equal(city.troops, before.troops - 2000);
  assert.equal(city.food, before.food - 720);
  assert.equal(city.gold, before.gold - 200 - rules.actions.march);
  const departed = structuredClone(state);
  assert.equal(commitArmyDeparture(state, army).ok, false);
  assert.deepEqual(state, departed);
});

test("army supplies can be zero but cannot be negative, fractional, invalid or unaffordable", () => {
  const state = createInitialState(scenario, rules);
  const city = state.cities.find((entry) => entry.id === "xiaopei");
  const divisions = [{ officerId: "liu-bei", troops: 2000 }];
  const snapshot = structuredClone(state);
  assert.equal(validateArmy(state, city.id, "puyang", divisions, rules, { food: 0, gold: 0 }).ok, true);
  for (const supplies of [{ food: -1, gold: 0 }, { food: 0.5, gold: 0 }, { food: 1, gold: NaN }, { food: 1, gold: -1 },
    { food: city.food + 1, gold: 0 }, { food: 1, gold: city.gold }, { food: Infinity, gold: 0 }]) {
    assert.equal(validateArmy(state, city.id, "puyang", divisions, rules, supplies).ok, false);
  }
  assert.deepEqual(state, snapshot);
});

test("army departure rechecks resources and commander availability after validation", () => {
  for (const alter of [
    (state, city) => { city.food = 0; },
    (state, city) => { city.gold = 0; },
    (state, city) => { city.troops = 0; },
    (state) => { state.commandsRemaining = 0; },
    (state) => { state.officers.find((officer) => officer.id === "liu-bei").acted = true; }
  ]) {
    const state = createInitialState(scenario, { ...rules, commandLimitEnabled: true });
    const city = state.cities.find((entry) => entry.id === "xiaopei");
    const army = validateArmy(state, city.id, "puyang", [{ officerId: "liu-bei", troops: 2000 }], rules, { food: 720, gold: 200 });
    alter(state, city);
    const snapshot = structuredClone(state);
    assert.equal(commitArmyDeparture(state, army).ok, false);
    assert.deepEqual(state, snapshot);
  }
});
