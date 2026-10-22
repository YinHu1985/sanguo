import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState } from "../src/js/game/state.js";
import { applyAtlasToScenario } from "../src/js/game/atlas.js";
import { advanceMonth, commitArmyDeparture, validateArmy } from "../src/js/game/rules.js";
import { calculateMonthlyIncome, calculateAnnualHarvest, dailyFoodCost, monthlyFoodCost, grainExchangeRate } from "../src/js/game/economy.js";
import { areAllied, autoResolveInvasion, executeDiplomacy, executeEmploy, executeOfficerTransfer, executeSearch,
  getCampaignStatus, resolveOccupation, runWorldTurn } from "../src/js/game/campaign.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const person = (id, factionId, locationCityId, extra = {}) => ({ id, name: id, factionId, locationCityId,
  status: "active", rank: "君主", war: 90, leadership: 90, intelligence: 90, politics: 80, charm: 90, merit: 0, acted: false, ...extra });
const city = (id, factionId, officerIds, adjacent, extra = {}) => ({ id, name: id, factionId, officerIds, adjacent,
  governorId: officerIds[0] ?? null, troops: 10000, gold: 5000, food: 20000, agriculture: 60, commerce: 60,
  popularSupport: 70, training: 80, morale: 80, ...extra });

function fixture() {
  return { year: 196, month: 11, elapsedMonths: 0, playerFactionId: "a", commandsMax: 6, commandsRemaining: 6,
    eventLog: [], factions: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "c", name: "丙" }, { id: "neutral", name: "空城" }],
    cities: [city("a1", "a", ["a-lord", "a-aide"], ["a2", "b1"]), city("a2", "a", [], ["a1"]),
      city("b1", "b", ["b-lord"], ["a1", "b2"]), city("b2", "b", ["b-aide"], ["b1"])],
    officers: [person("a-lord", "a", "a1"), person("a-aide", "a", "a1", { rank: "从事" }),
      person("b-lord", "b", "b1"), person("b-aide", "b", "b2", { rank: "校尉" })] };
}

function assertOfficersLocated(state) {
  const registered = state.cities.flatMap((entry) => entry.officerIds);
  assert.equal(new Set(registered).size, registered.length, "an officer cannot belong to two cities");
  for (const officer of state.officers) {
    const location = state.cities.find((entry) => entry.id === officer.locationCityId);
    assert.ok(location, `${officer.id} needs a real city location`);
    if (officer.status === "active") {
      assert.ok(location.officerIds.includes(officer.id));
      assert.equal(location.factionId, officer.factionId);
    } else assert.ok(!registered.includes(officer.id));
  }
}

function queuedInvasion({ attackerTroops = 6000, defenderTroops = 6000, food = 1000, gold = 150, defenderFood = 20000 } = {}) {
  const state = fixture();
  state.cities = [city("a1", "a", ["a-lord"], ["b1"], { troops: defenderTroops, food: defenderFood }),
    city("b1", "b", ["b-lord"], ["a1"])];
  state.officers = [person("a-lord", "a", "a1"), person("b-lord", "b", "b1")];
  const invasion = { id: "supply-test", sourceId: "b1", targetId: "a1", attackerFactionId: "b", defenderFactionId: "a",
    officerIds: ["b-lord"], troops: attackerTroops, training: 80, morale: 80, supplies: { food, gold }, resolved: false };
  state.cities[1].troops -= attackerTroops;
  state.cities[1].food -= food;
  state.cities[1].gold -= gold;
  state.pendingInvasions = [invasion];
  return { state, invasion, source: state.cities[1], target: state.cities[0] };
}

function storedResources(state) {
  return state.cities.reduce((sum, city) => ({ food: sum.food + city.food, gold: sum.gold + city.gold }), { food: 0, gold: 0 });
}

test("occupation moves the army and retreats defeated officers without losing or duplicating anyone", () => {
  const state = fixture();
  state.cities[0].troops -= 4000;
  const report = resolveOccupation(state, { sourceId: "a1", targetId: "b1", officerIds: ["a-lord"], troops: 3500, training: 70, morale: 65 });
  assert.equal(report.ok, true);
  assert.deepEqual(report.escapedOfficerIds, ["b-lord"]);
  assert.equal(state.cities[0].troops, 6000, "occupation must not deduct a departing army twice");
  assert.equal(state.cities[0].governorId, null);
  assert.equal(state.cities[2].factionId, "a");
  assert.equal(state.cities[2].troops, 3500);
  assert.equal(state.officers.find((officer) => officer.id === "b-lord").locationCityId, "b2");
  assertOfficersLocated(state);
});

test("last-city defeat produces employable prisoners, and a failed repeat occupation changes nothing", () => {
  const state = fixture();
  state.cities[3].factionId = "c";
  state.officers.find((officer) => officer.id === "b-aide").factionId = "c";
  const input = { sourceId: "a1", targetId: "b1", officerIds: ["a-lord"], troops: 3500, training: 70, morale: 65 };
  const report = resolveOccupation(state, input);
  assert.equal(report.eliminated, true);
  assert.deepEqual(report.capturedOfficerIds, ["b-lord"]);
  const snapshot = structuredClone(state);
  assert.equal(resolveOccupation(state, input).ok, false);
  assert.deepEqual(state, snapshot);
  state.officers.find((officer) => officer.id === "a-lord").acted = false;
  const result = executeEmploy(state, "b1", "a-lord", "b-lord", rules, () => 0);
  assert.equal(result.success, true);
  assert.equal(state.officers.find((officer) => officer.id === "b-lord").factionId, "a");
  assertOfficersLocated(state);
});

test("search reveals a local free officer and employment consumes a separate actor and command", () => {
  const state = fixture();
  state.officers.push(person("scholar", null, "a1", { status: "free", discovered: false }));
  const beforeGold = state.cities[0].gold;
  const search = executeSearch(state, "a1", "a-lord", rules, () => 0);
  assert.equal(search.foundOfficerId, "scholar");
  assert.equal(executeEmploy(state, "a1", "a-lord", "scholar", rules, () => 0).ok, false);
  assert.equal(executeEmploy(state, "a1", "a-aide", "scholar", rules, () => 0).success, true);
  assert.equal(state.commandsRemaining, 4);
  assert.equal(state.cities[0].gold, beforeGold - 300);
  assert.equal(state.officers.find((officer) => officer.id === "scholar").acted, true);
  assertOfficersLocated(state);
});

test("officer transfer moves people without teleporting troops and clears a departing governor", () => {
  const state = fixture();
  const troopCounts = state.cities.map((entry) => entry.troops);
  assert.equal(executeOfficerTransfer(state, "a1", "a2", ["a-lord", "a-aide", "a-lord"], rules).ok, true);
  assert.equal(state.commandsRemaining, 5);
  assert.equal(state.cities[0].gold, 5000 - rules.actions.officerTransfer);
  assert.deepEqual(state.cities[0].officerIds, []);
  assert.equal(state.cities[0].governorId, null);
  assert.deepEqual(state.cities.map((entry) => entry.troops), troopCounts);
  assertOfficersLocated(state);
});

test("officer transfer cannot spend nonexistent local money and fails atomically", () => {
  const state = fixture();
  state.cities[0].gold = rules.actions.officerTransfer - 1;
  const before = structuredClone(state);
  assert.equal(executeOfficerTransfer(state, "a1", "a2", ["a-lord"], rules).ok, false);
  assert.deepEqual(state, before);
});

test("officer transfer cannot cross enemy land and invalid commands are atomic", () => {
  const state = fixture();
  state.cities[1].adjacent = ["b1"];
  state.cities[0].adjacent = ["b1"];
  const snapshot = structuredClone(state);
  assert.equal(executeOfficerTransfer(state, "a1", "a2", ["a-lord"], rules).ok, false);
  assert.deepEqual(state, snapshot);
});

test("successful diplomacy costs resources, blocks attacks in both directions, then expires after six months", () => {
  const state = fixture();
  assert.equal(executeDiplomacy(state, "a1", "b", "a-aide", "goodwill", rules, () => 0).success, true);
  const result = executeDiplomacy(state, "a1", "b", "a-lord", "alliance", rules, () => 0);
  assert.equal(result.success, true);
  assert.equal(state.cities[0].gold, 4100);
  assert.equal(state.commandsRemaining, 4);
  assert.equal(areAllied(state, "a", "b"), true);
  assert.equal(areAllied(state, "b", "a"), true);
  const validation = validateArmy(state, "a1", "b1", [{ officerId: "a-lord", troops: 2000 }], rules);
  assert.match(validation.message, /同盟/);
  state.year = 197;
  state.month = 5;
  assert.equal(areAllied(state, "a", "b"), false);
});

test("world turn grants a two-month player grace period and queues later invasions once", () => {
  const state = fixture();
  state.cities = [state.cities[0], state.cities[2]];
  state.cities[0].adjacent = ["b1"];
  state.cities[1].adjacent = ["a1"];
  state.cities[0].troops = 100;
  state.elapsedMonths = 2;
  assert.equal(runWorldTurn(state, rules, () => 0).battles.length, 0);
  advanceMonth(state, rules);
  const beforeEnemy = state.cities[1].troops;
  const beforeCommands = state.commandsRemaining;
  const result = runWorldTurn(state, rules, () => 0);
  assert.equal(result.battles.length, 1);
  assert.equal(state.cities[0].factionId, "a", "invasion needs a player decision before occupation");
  assert.equal(state.cities[1].troops + result.battles[0].troops, beforeEnemy);
  assert.equal(state.commandsRemaining, beforeCommands);
  const snapshot = structuredClone(state);
  assert.equal(runWorldTurn(state, rules, () => 0).battles.length, 1);
  assert.deepEqual(state, snapshot, "the same month cannot run AI recruitment or wars twice");
});

test("a defensive invasion decision settles losses only once and reports defeat after the final city", () => {
  const state = fixture();
  state.cities = [state.cities[0], state.cities[2]];
  state.officers = state.officers.filter((officer) => ["a1", "b1"].includes(officer.locationCityId));
  state.cities[0].adjacent = ["b1"];
  state.cities[1].adjacent = ["a1"];
  state.cities[0].troops = 100;
  state.elapsedMonths = 3;
  const invasion = runWorldTurn(state, rules, () => 0).battles[0];
  const beforeCommands = state.commandsRemaining;
  const result = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(result.attackerWon, true);
  assert.equal(state.commandsRemaining, beforeCommands);
  assert.equal(state.pendingInvasions.length, 0);
  assert.equal(getCampaignStatus(state).status, "defeat");
  const snapshot = structuredClone(state);
  assert.equal(autoResolveInvasion(state, invasion, rules, "defend", () => 0).ok, false);
  assert.deepEqual(state, snapshot);
  assertOfficersLocated(state);
});

test("a held city retains its defenders while the defeated invasion army rejoins its source", () => {
  const state = fixture();
  state.cities = [state.cities[0], state.cities[2]];
  state.cities[0].adjacent = ["b1"];
  state.cities[1].adjacent = ["a1"];
  state.cities[0].troops = 100;
  state.elapsedMonths = 3;
  const invasion = runWorldTurn(state, rules, () => 0).battles[0];
  state.cities[0].troops = 20000;
  const sourceRemaining = state.cities[1].troops;
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(report.attackerWon, false);
  assert.equal(state.cities[0].factionId, "a");
  assert.equal(state.cities[1].troops, sourceRemaining + report.attackerSurvivors);
  assert.ok(report.defenderSurvivors < 20000);
});

test("AI departure takes real cargo and its own march expense while reserving the origin garrison's monthly grain", () => {
  const state = fixture();
  state.cities = [state.cities[0], state.cities[2]];
  state.cities[0].adjacent = ["b1"];
  state.cities[0].troops = 100;
  state.cities[1].adjacent = ["a1"];
  state.elapsedMonths = 3;
  const before = structuredClone(state.cities[1]);
  const invasion = runWorldTurn(state, rules, () => 0).battles[0];
  assert.ok(invasion);
  assert.equal(invasion.supplies.food, dailyFoodCost(invasion.troops, rules) * rules.battleDayLimit);
  assert.ok(state.cities[1].food >= monthlyFoodCost(state.cities[1].troops, rules));
  assert.equal(state.cities[1].food + invasion.supplies.food, before.food);
  assert.equal(state.cities[1].gold + invasion.supplies.gold + rules.actions.march, before.gold);
});

test("automatic battles consume grain daily from living soldiers and return all unspent army cargo on retreat", () => {
  const { state, invasion, source, target } = queuedInvasion({ food: 100 });
  const before = storedResources(state);
  const initialCargo = { ...invasion.supplies };
  const sourceBefore = { food: source.food, gold: source.gold };
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(report.attackerWon, false);
  assert.equal(report.endReason, "attacker-food");
  assert.ok(report.days > 1 && report.days < 30);
  let attacker = 6000;
  let defender = 6000;
  for (const day of report.dailyLog) {
    assert.equal(day.attackerFood, dailyFoodCost(attacker, rules));
    assert.equal(day.defenderFood, dailyFoodCost(defender, rules));
    attacker = day.attackerSurvivors;
    defender = day.defenderSurvivors;
  }
  assert.ok(report.dailyLog.at(-1).attackerFood < report.dailyLog[0].attackerFood);
  assert.equal(source.food, sourceBefore.food + report.remainingSupplies.food);
  assert.equal(source.gold, sourceBefore.gold + initialCargo.gold);
  const after = storedResources(state);
  assert.equal(after.food, before.food + initialCargo.food - report.foodConsumed.attacker - report.foodConsumed.defender);
  assert.equal(after.gold, before.gold + initialCargo.gold);
  assert.equal(target.troops, report.defenderSurvivors);
  assert.deepEqual(invasion.supplies, { food: 0, gold: 0 });
});

test("a fed attacker defeats a defender with insufficient daily food before either side takes the next day's action", () => {
  const { state, invasion, target } = queuedInvasion({ food: 100, defenderFood: 1 });
  const oldGold = target.gold;
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(report.attackerWon, true);
  assert.equal(report.endReason, "defender-food");
  assert.equal(report.days, 0);
  assert.equal(report.attackerLosses, 0);
  assert.equal(target.food, 100 - dailyFoodCost(6000, rules), "the defender's partial rations are exhausted; only the victors' unused cargo enters the city");
  assert.equal(target.gold, oldGold + 150);
  assert.deepEqual(report.foodConsumed, { attacker: dailyFoodCost(6000, rules), defender: 1 });
});

test("if both sides lack the next day's food, the attacker exhausts its remnants and withdraws first", () => {
  const { state, invasion, source, target } = queuedInvasion({ food: 1, defenderFood: 1 });
  const beforeSourceFood = source.food;
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(report.attackerWon, false);
  assert.equal(report.endReason, "attacker-food");
  assert.equal(report.days, 0);
  assert.equal(report.attackerLosses, 0);
  assert.equal(target.food, 1);
  assert.equal(source.food, beforeSourceFood);
  assert.deepEqual(report.foodConsumed, { attacker: 1, defender: 0 });
});

test("a victorious army deposits only its remaining cargo and preserves the captured city's remaining treasury", () => {
  const { state, invasion, target } = queuedInvasion({ attackerTroops: 6000, defenderTroops: 100, food: 700, defenderFood: 10000 });
  const before = storedResources(state);
  const oldTargetGold = target.gold;
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(report.attackerWon, true);
  assert.ok(report.days > 0);
  assert.equal(target.gold, oldTargetGold + 150);
  assert.equal(target.food, 10000 - report.foodConsumed.defender + report.remainingSupplies.food);
  assert.equal(storedResources(state).food, before.food + 700 - report.foodConsumed.attacker - report.foodConsumed.defender);
  assert.equal(storedResources(state).gold, before.gold + 150);
});

test("an unopposed empty city can be entered without food, combat days or fabricated combat losses", () => {
  const { state, invasion, target } = queuedInvasion({ defenderTroops: 0, food: 0, defenderFood: 0 });
  target.factionId = "neutral";
  target.officerIds = [];
  target.governorId = null;
  state.officers = state.officers.filter((officer) => officer.id !== "a-lord");
  invasion.defenderFactionId = "neutral";
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(report.endReason, "unopposed");
  assert.equal(report.days, 0);
  assert.equal(report.attackerLosses, 0);
  assert.equal(target.troops, 6000);
  assert.equal(target.morale, 80);
  assert.deepEqual(report.foodConsumed, { attacker: 0, defender: 0 });
});

test("cancelled and newly allied invasion orders return their real troops and cargo exactly once", () => {
  for (const cancellation of ["changed-owner", "new-alliance"]) {
    const { state, invasion, source, target } = queuedInvasion();
    if (cancellation === "changed-owner") target.factionId = "c";
    else state.relations = { "a|b": { friendliness: 80, allianceUntil: state.year * 12 + state.month + 1 } };
    const before = { troops: source.troops, food: source.food, gold: source.gold };
    const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
    assert.equal(report.cancelled, true);
    assert.equal(source.troops, before.troops + 6000);
    assert.equal(source.food, before.food + 1000);
    assert.equal(source.gold, before.gold + 150);
    const snapshot = structuredClone(state);
    assert.equal(autoResolveInvasion(state, invasion, rules).ok, false);
    assert.deepEqual(state, snapshot);
  }
});

test("an old order lacking cargo does not invent grain or gold and withdraws before fighting", () => {
  const { state, invasion, source } = queuedInvasion({ food: 0, gold: 0 });
  delete invasion.supplies;
  const before = { food: source.food, gold: source.gold };
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(report.endReason, "attacker-food");
  assert.equal(report.days, 0);
  assert.equal(report.attackerLosses, 0);
  assert.equal(source.food, before.food);
  assert.equal(source.gold, before.gold);
});

test("automatic warfare still ends at thirty days if both surviving armies retain food", () => {
  const { state, invasion, target } = queuedInvasion({ food: 2000 });
  invasion.training = 0;
  invasion.morale = 0;
  target.training = 0;
  target.morale = 0;
  state.officers.forEach((officer) => { officer.leadership = 0; });
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(report.endReason, "day-limit");
  assert.equal(report.days, 30);
  assert.equal(report.attackerWon, false);
  assert.ok(report.attackerSurvivors > 0 && report.defenderSurvivors > 0);
  assert.ok(report.remainingSupplies.food > 0);
});

test("a garrison can hold a city without any officer, but cannot sally without a commander", () => {
  const state = fixture();
  state.cities = [city("a1", "a", [], ["b1"], { troops: 100 }), city("b1", "b", ["b-lord"], ["a1"])];
  state.officers = [person("b-lord", "b", "b1")];
  state.elapsedMonths = 3;
  const invasion = runWorldTurn(state, rules, () => 0).battles[0];
  assert.ok(invasion);
  state.cities[0].troops = 20000;
  const snapshot = structuredClone(state);
  const sally = autoResolveInvasion(state, invasion, rules, "sally", () => 0);
  assert.equal(sally.ok, false);
  assert.match(sally.message, /没有将领/);
  assert.deepEqual(state, snapshot);
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0);
  assert.equal(report.ok, true);
  assert.equal(report.attackerWon, false);
  assert.ok(report.defenderSurvivors > 0 && report.defenderSurvivors < 20000);
  assert.equal(state.cities[0].factionId, "a");
  assert.equal(state.cities[0].governorId, null);
  assert.deepEqual(state.cities[0].officerIds, []);
  assert.equal(state.officers.length, 1);
  assertOfficersLocated(state);
});

test("unstaffed AI cities receive normal income but cannot develop, recruit or attack", () => {
  const state = fixture();
  state.officers = state.officers.filter((officer) => officer.factionId === "a");
  for (const city of state.cities.filter((entry) => entry.factionId === "b")) {
    city.officerIds = [];
    city.governorId = null;
  }
  state.month = 6;
  state.elapsedMonths = 3;
  const citiesBefore = structuredClone(state.cities.filter((entry) => entry.factionId === "b"));
  const officerCount = state.officers.length;
  advanceMonth(state, rules);
  const report = runWorldTurn(state, rules, () => 0);
  assert.equal(report.battles.length, 0);
  for (const before of citiesBefore) {
    const city = state.cities.find((entry) => entry.id === before.id);
    assert.equal(city.gold, before.gold + calculateMonthlyIncome(before, rules));
    assert.equal(city.food, before.food + calculateAnnualHarvest(before, rules) - monthlyFoodCost(before.troops, rules));
    for (const field of ["troops", "agriculture", "commerce", "popularSupport", "training", "morale"]) assert.equal(city[field], before[field]);
    assert.deepEqual(city.officerIds, []);
    assert.equal(city.governorId, null);
  }
  assert.equal(state.officers.length, officerCount);
});

test("unstaffed cities cannot invent an executor for personnel or diplomacy commands", () => {
  const state = fixture();
  const snapshot = structuredClone(state);
  assert.equal(executeSearch(state, "a2", null, rules).ok, false);
  assert.equal(executeEmploy(state, "a2", null, "b-lord", rules).ok, false);
  assert.equal(executeOfficerTransfer(state, "a2", "a1", [], rules).ok, false);
  assert.equal(executeDiplomacy(state, "a2", "b", null, "goodwill", rules).ok, false);
  assert.deepEqual(state, snapshot);
});

test("an unowned empty city stays empty through month-end and can be occupied by a led army", () => {
  const state = fixture();
  state.cities.push(city("empty", "neutral", [], ["a1"], { troops: 0 }));
  state.cities[0].adjacent.push("empty");
  const neutral = state.cities.at(-1);
  const before = structuredClone(neutral);
  const officerCount = state.officers.length;
  advanceMonth(state, rules);
  runWorldTurn(state, rules, () => 0.9);
  assert.deepEqual(neutral, before);
  const army = validateArmy(state, "a1", "empty", [{ officerId: "a-lord", troops: 2000 }], rules);
  assert.equal(army.ok, true);
  commitArmyDeparture(state, army);
  const report = resolveOccupation(state, { sourceId: "a1", targetId: "empty", officerIds: ["a-lord"],
    troops: army.total, training: army.city.training, morale: army.city.morale });
  assert.equal(report.ok, true);
  assert.equal(neutral.factionId, "a");
  assert.deepEqual(neutral.officerIds, ["a-lord"]);
  assert.equal(neutral.troops, 2000);
  assert.equal(state.officers.length, officerCount);
  assertOfficersLocated(state);
});

test("AI wars are capped globally, honor rank capacities, and never spend the player's commands", () => {
  const state = fixture();
  state.cities = [city("a1", "a", ["a-lord", "a-aide"], [])];
  state.officers = state.officers.filter((officer) => officer.factionId === "a");
  for (let index = 0; index < 7; index += 1) {
    const factionId = `ai-${index}`;
    const sourceId = `source-${index}`;
    const targetId = `target-${index}`;
    const officerId = `general-${index}`;
    state.factions.push({ id: factionId, name: factionId });
    state.cities.push(city(sourceId, factionId, [officerId], [targetId], { troops: 20000 }), city(targetId, "neutral", [], [sourceId], { troops: 0 }));
    state.officers.push(person(officerId, factionId, sourceId, { rank: "从事" }));
  }
  const report = runWorldTurn(state, rules, () => 0);
  assert.equal(report.summary.length, 4);
  assert.equal(state.commandsRemaining, 6);
  const conquered = state.cities.filter((entry) => entry.id.startsWith("target") && entry.factionId !== "neutral");
  assert.equal(conquered.length, 4);
  assert.ok(conquered.every((entry) => entry.troops <= rules.ranks["从事"]));
  assertOfficersLocated(state);
});

test("owning every occupied city wins while empty neutral cities do not prevent victory", () => {
  const state = fixture();
  state.cities.forEach((entry) => { entry.factionId = "a"; });
  state.cities.push(city("unsettled", "neutral", [], []));
  assert.equal(getCampaignStatus(state).status, "victory");
});

test("AI respects a current alliance even when the allied border is nearly undefended", () => {
  const state = fixture();
  state.cities = [state.cities[0], state.cities[2]];
  state.cities[0].adjacent = ["b1"];
  state.cities[1].adjacent = ["a1"];
  state.cities[0].troops = 100;
  state.elapsedMonths = 8;
  state.relations = { "a|b": { friendliness: 70, allianceUntil: state.year * 12 + state.month + 3 } };
  assert.equal(runWorldTurn(state, rules, () => 0).battles.length, 0);
  assert.equal(state.cities[0].factionId, "a");
});

test("a multi-year campaign keeps finite resources and every officer at exactly one valid location", () => {
  const state = fixture();
  state.cities.push(city("c1", "c", ["c-lord"], ["b2"], { troops: 1000 }));
  state.cities[3].adjacent.push("c1");
  state.officers.push(person("c-lord", "c", "c1"));
  for (let month = 0; month < 36; month += 1) {
    advanceMonth(state, rules);
    const world = runWorldTurn(state, rules, () => 0.2);
    for (const invasion of world.battles) autoResolveInvasion(state, invasion, rules, "defend", () => 0.2);
    assertOfficersLocated(state);
    for (const city of state.cities) {
      for (const field of ["troops", "gold", "food", "training", "morale"]) assert.ok(Number.isFinite(city[field]) && city[field] >= 0, `${city.id}.${field} is valid`);
      if (city.governorId) assert.ok(city.officerIds.includes(city.governorId));
    }
  }
});

test("AI restaffs a connected city vacated by conquest without creating new officers or spending player commands", () => {
  const state = fixture();
  const abandoned = state.cities[2];
  const staffed = state.cities[3];
  abandoned.officerIds = [];
  abandoned.governorId = null;
  staffed.officerIds.push("b-lord");
  state.officers.find((officer) => officer.id === "b-lord").locationCityId = staffed.id;
  const numberOfOfficers = state.officers.length;
  runWorldTurn(state, rules, () => 0.9);
  assert.equal(abandoned.officerIds.length, 1);
  assert.equal(staffed.officerIds.length, 1);
  assert.equal(state.officers.length, numberOfOfficers);
  assert.equal(state.commandsRemaining, 6);
  assert.ok(state.officers.find((officer) => officer.id === abandoned.officerIds[0]).acted);
  assertOfficersLocated(state);
});

test("AI border assembly preserves soldiers, blends quality, leaves 3000 guards and consumes a transport officer", () => {
  const state = fixture();
  const front = state.cities[2];
  const interior = state.cities[3];
  front.gold = 0;
  interior.training = 20;
  interior.morale = 40;
  const total = front.troops + interior.troops;
  const donorGold = interior.gold;
  runWorldTurn(state, rules, () => 0.9);
  assert.equal(interior.troops, 3000);
  assert.equal(front.troops, 17000);
  assert.equal(front.troops + interior.troops, total);
  assert.equal(front.training, Math.round((80 * 10000 + 20 * 7000) / 17000));
  assert.equal(front.morale, Math.round((80 * 10000 + 40 * 7000) / 17000));
  assert.equal(front.assemblyReady, true);
  assert.equal(state.officers.find((officer) => officer.id === "b-aide").acted, true);
  assert.equal(interior.gold, donorGold - rules.actions.transfer);
  assert.equal(state.commandsRemaining, 6);
});

test("AI grain trading uses the current same-price exchange, no fee, a real actor, and no player command", () => {
  for (const direction of ["buy", "sell"]) {
    const state = fixture();
    const market = city("b1", "b", ["b-lord"], [], { food: direction === "buy" ? 0 : 20000, gold: direction === "buy" ? 5000 : 0 });
    state.cities = [city("a1", "a", ["a-lord"], []), market];
    state.officers = [person("a-lord", "a", "a1"), person("b-lord", "b", "b1")];
    const before = { food: market.food, gold: market.gold };
    runWorldTurn(state, rules, () => 0.9);
    const rate = grainExchangeRate(state.month, rules);
    assert.equal(market.food - before.food, -(market.gold - before.gold) * rate);
    assert.ok(direction === "buy" ? market.food > before.food : market.gold > before.gold);
    assert.equal(state.officers[1].acted, true);
    assert.equal(state.commandsRemaining, 6);
    assert.equal(market.troops, 10000);
  }
});

test("AI cannot invent an unstaffed city's trader or pay transport and migration from another city's treasury", () => {
  const state = fixture();
  state.cities[2].officerIds = [];
  state.cities[2].governorId = null;
  state.cities[2].food = 0;
  state.cities[2].gold = 5000;
  state.officers = state.officers.filter((officer) => officer.id !== "b-lord");
  state.cities[3].officerIds.push("b-extra");
  state.officers.push(person("b-extra", "b", "b2"));
  state.cities[3].food = 0;
  state.cities[3].gold = 0;
  const before = structuredClone(state.cities.filter((city) => city.factionId === "b"));
  runWorldTurn(state, rules, () => 0.9);
  assert.deepEqual(state.cities.filter((city) => city.factionId === "b"), before);
  assert.ok(state.officers.filter((officer) => officer.factionId === "b").every((officer) => !officer.acted));
});

test("the full 196 atlas keeps valid officer locations, resources and activity through 72 months under three seeded simulations", async () => {
  const scenario = JSON.parse(await readFile(new URL("../src/data/scenario.json", import.meta.url), "utf8"));
  const atlas = JSON.parse(await readFile(new URL("../src/data/strategic-atlas.json", import.meta.url), "utf8"));
  for (const seed of [17, 43, 91]) {
    const state = createInitialState(applyAtlasToScenario(scenario, atlas), rules);
    let cursor = seed;
    const rng = () => { cursor = (cursor * 1664525 + 1013904223) >>> 0; return cursor / 4294967296; };
    const initialOfficerCount = state.officers.length;
    let wars = 0;
    let lateWars = 0;
    for (let month = 1; month <= 72; month += 1) {
      advanceMonth(state, rules);
      const report = runWorldTurn(state, rules, rng);
      const monthlyWars = report.summary.filter((message) => !message.startsWith("诸势力")).length;
      assert.ok(monthlyWars <= 4);
      wars += monthlyWars;
      if (month > 48) lateWars += monthlyWars;
      if (month <= 2) assert.equal(report.battles.length, 0);
      for (const invasion of report.battles) assert.equal(autoResolveInvasion(state, invasion, rules, "defend", rng).ok, true);
      assert.equal(state.officers.length, initialOfficerCount);
      assertOfficersLocated(state);
      for (const city of state.cities) {
        for (const field of ["troops", "food", "gold", "training", "morale"]) assert.ok(Number.isFinite(city[field]) && city[field] >= 0);
        if (city.governorId) assert.ok(city.officerIds.includes(city.governorId));
      }
    }
    assert.ok(wars > 20, `seed ${seed} should have an active world`);
    assert.ok(lateWars > 0, `seed ${seed} should not become permanently frozen after four years`);
    assert.ok(state.cities.filter((city) => city.food === 0).length < state.cities.length / 4, "the economy must not collapse into widespread starvation");
  }
});
