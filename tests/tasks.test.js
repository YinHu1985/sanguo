import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { queueTask, settleTasks, getReadyBattleTask, finishBattleTask, busyOfficerIds } from "../src/js/game/tasks.js";
import { advanceMonth, previewDomestic, runGovernorAutomation } from "../src/js/game/rules.js";
import { calculateAnnualHarvest, calculateMonthlyIncome, dailyFoodCost, monthlyFoodCost, monthlySalaryCost } from "../src/js/game/economy.js";
import { runWorldTurn } from "../src/js/game/campaign.js";
import { BattleEngine } from "../src/js/game/battle.js";
import { settlePlayerBattle } from "../src/js/game/battle-result.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const person = (id, factionId = "a", locationCityId = "a1", extra = {}) => ({ id, name: id, factionId, locationCityId,
  status: "active", rank: "君主", war: 90, leadership: 90, intelligence: 90, politics: 80, charm: 90, merit: 0, acted: false, ...extra });
const city = (id, factionId, officerIds = [], adjacent = []) => ({ id, name: id, factionId, officerIds, adjacent,
  governorId: null, troops: 10000, gold: 5000, food: 20000, agriculture: 60, commerce: 60,
  popularSupport: 70, training: 80, morale: 80 });

function fixture() {
  return { year: 196, month: 6, elapsedMonths: 0, playerFactionId: "a", commandsMax: 6, commandsRemaining: 6,
    eventLog: [], factions: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "c", name: "丙" }, { id: "neutral", name: "空城" }],
    cities: [city("a1", "a", ["lord", "aide", "third"], ["a2", "b1"]), city("a2", "a", [], ["a1", "a3"]),
      city("a3", "a", [], ["a2"]), city("b1", "b", ["enemy"], ["a1"])],
    officers: [person("lord"), person("aide"), person("third"), person("enemy", "b", "b1")] };
}
const home = (state) => state.cities.find((entry) => entry.id === "a1");
const officer = (state, id = "lord") => state.officers.find((entry) => entry.id === id);
const domestic = (officerIds = ["lord"], action = "agriculture") => ({ kind: "domestic", cityId: "a1", officerIds, payload: { action } });
const march = (id = "lord") => ({ kind: "march", cityId: "a1", officerIds: [id],
  payload: { targetId: "b1", divisions: [{ officerId: id, troops: 2000, unitType: "infantry" }], supplies: { food: 300, gold: 100 } } });
const resources = (state) => Object.fromEntries(["gold", "food", "troops"].map((key) => [key, home(state)[key]]));
function setTiming(kind, timing, duration) {
  const changed = structuredClone(rules);
  changed.tasks = { defaultTiming: "turn_end", actions: { [kind]: { timing, duration } } };
  return changed;
}

test("default orders reserve costs and actors now but improve cities only once at turn end", () => {
  const state = fixture();
  const cost = previewDomestic("agriculture", [officer(state)], home(state), rules).expense;
  const queued = queueTask(state, domestic(), rules);
  assert.equal(queued.ok, true);
  assert.equal(queued.task.status, "running");
  assert.equal(queued.task.dueTurn, 1);
  assert.equal(queued.task.completedTurn, undefined);
  assert.equal(home(state).gold, 5000 - cost);
  assert.equal(home(state).agriculture, 60);
  assert.equal(officer(state).merit, 0);
  assert.equal(officer(state).taskId, queued.taskId);
  assert.equal(state.commandsRemaining, 5);
  assert.equal(settleTasks(state, rules, { targetTurn: 0 }).completed.length, 0);
  assert.equal(settleTasks(state, rules).completed.length, 1);
  assert.ok(home(state).agriculture > 60);
  assert.equal(home(state).gold, 5000 - cost);
  assert.equal(state.commandsRemaining, 5);
  assert.equal(officer(state).taskId, undefined);
  assert.equal(officer(state).acted, true);
  const snapshot = structuredClone(state);
  settleTasks(state, rules);
  assert.deepEqual(state, snapshot);
});

test("immediate timing completes effects with one command and no dangling lock", () => {
  const state = fixture();
  const report = queueTask(state, domestic(), setTiming("domestic", "immediate"));
  assert.equal(report.status, "completed");
  assert.equal(report.task.completedTurn, 0);
  assert.ok(home(state).agriculture > 60);
  assert.equal(state.commandsRemaining, 5);
  assert.equal(busyOfficerIds(state).size, 0);
});

test("multi-turn work retains actors across month resets and completes on the configured turn", () => {
  const state = fixture();
  const custom = setTiming("domestic", "multi_turn", 3);
  const task = queueTask(state, domestic(), custom).task;
  for (let turn = 1; turn < 3; turn += 1) {
    assert.equal(settleTasks(state, custom, { targetTurn: turn }).completed.length, 0);
    state.elapsedMonths = turn;
    state.commandsRemaining = 6;
    officer(state).acted = false;
    assert.ok(busyOfficerIds(state).has("lord"));
    assert.equal(queueTask(state, domestic(), rules).ok, false, "task lock survives an acted flag reset");
  }
  const settled = settleTasks(state, custom, { targetTurn: 3 });
  assert.equal(settled.completed[0].id, task.id);
  assert.equal(settled.completed[0].completedTurn, 3);
  assert.equal(home(state).agriculture > 60, true);
  assert.equal(officer(state).acted, true);
  assert.equal(busyOfficerIds(state).size, 0);
});

test("invalid task types, actors, timing and battle actor mismatches are rejected without mutation", () => {
  const cases = [
    { input: { ...domestic(), kind: "unknown" } },
    { input: domestic([]) }, { input: domestic(["lord", "lord"]) },
    { input: { ...domestic(), kind: "recruit", officerIds: ["lord", "aide"], payload: { amount: 500 } } },
    { input: { ...march(), officerIds: ["aide"] } },
    { input: { ...march(), payload: { ...march().payload, supplies: { food: NaN, gold: 0 } } } },
    { input: domestic(), config: setTiming("domestic", "unknown") },
    { input: domestic(), config: setTiming("domestic", "multi_turn", 0) },
    { input: domestic(), config: setTiming("domestic", "multi_turn", 1.5) }
  ];
  for (const { input, config = rules } of cases) {
    const state = fixture();
    const before = structuredClone(state);
    assert.equal(queueTask(state, input, config).ok, false);
    assert.deepEqual(state, before);
  }
});

test("free, captured, foreign and moved officers cannot bypass primitive actor validation", () => {
  for (const alteration of [{ status: "free" }, { status: "captured" }, { factionId: "b" }, { locationCityId: "a2" }]) {
    const state = fixture();
    Object.assign(officer(state), alteration);
    const before = structuredClone(state);
    assert.equal(queueTask(state, domestic(), rules).ok, false);
    assert.deepEqual(state, before);
  }
});

test("unaffordable orders and new orders during resolution do not create task history", () => {
  const state = fixture();
  home(state).gold = 0;
  assert.equal(queueTask(state, domestic(), rules).ok, false);
  assert.equal(state.tasks, undefined);
  home(state).gold = 5000;
  state.turnResolution = { phase: "tasks" };
  const before = structuredClone(state);
  assert.equal(queueTask(state, domestic(), rules).ok, false);
  assert.deepEqual(state, before);
});

test("independent task reservations cannot be double-spent by other officers", () => {
  const state = fixture();
  const cost = rules.development.agriculture.expense;
  home(state).gold = cost;
  assert.equal(queueTask(state, domestic(), rules).ok, true);
  assert.equal(home(state).gold, 0);
  assert.equal(queueTask(state, domestic(["aide"]), rules).ok, false);
  assert.equal(state.commandsRemaining, 5);
  assert.equal(state.tasks.length, 1);
});

test("recruitment reserves food and gold without premature troops or support loss", () => {
  const state = fixture();
  const report = queueTask(state, { kind: "recruit", cityId: "a1", officerIds: ["lord"], payload: { amount: 1000 } }, rules);
  assert.equal(report.ok, true);
  assert.equal(home(state).troops, 10000);
  assert.equal(home(state).popularSupport, 70);
  assert.equal(home(state).food, 20000 - 10 * rules.recruit.foodPerHundred);
  const reserved = resources(state);
  settleTasks(state, rules);
  assert.equal(home(state).troops, 11000);
  assert.ok(home(state).training < 80);
  assert.ok(home(state).popularSupport < 70);
  assert.equal(home(state).gold, reserved.gold);
  assert.equal(home(state).food, reserved.food);
});

test("transfer delivers combined troops and cargo across connected friendly cities at turn end", () => {
  const state = fixture();
  const report = queueTask(state, { kind: "transfer", cityId: "a1", officerIds: ["lord"],
    payload: { targetId: "a3", troops: 2000, gold: 500, food: 1000 } }, rules);
  assert.equal(report.ok, true, report.message);
  assert.deepEqual(resources(state), { gold: 5000 - 500 - rules.actions.transfer, food: 19000, troops: 8000 });
  assert.equal(state.cities[2].troops, 10000);
  assert.equal(state.cities[2].food, 20000);
  settleTasks(state, rules);
  assert.equal(state.cities[2].troops, 12000);
  assert.equal(state.cities[2].gold, 5500);
  assert.equal(state.cities[2].food, 21000);
  assert.equal(state.commandsRemaining, 5);
});

test("transport freezes troop quality even if the home garrison trains before arrival", () => {
  const state = fixture();
  state.cities[2].training = 0;
  state.cities[2].morale = 0;
  state.cities[2].troops = 2000;
  assert.equal(queueTask(state, { kind: "transfer", cityId: "a1", officerIds: ["lord"],
    payload: { targetId: "a3", troops: 2000, gold: 0, food: 0 } }, rules).ok, true);
  home(state).training = 100;
  home(state).morale = 100;
  settleTasks(state, rules);
  assert.equal(home(state).training, 100);
  assert.equal(home(state).morale, 100);
  assert.equal(state.cities[2].training, 40);
  assert.equal(state.cities[2].morale, 40);
});

test("a broken transport route refunds its reservation once without crediting the target", () => {
  const state = fixture();
  assert.equal(queueTask(state, { kind: "transfer", cityId: "a1", officerIds: ["lord"],
    payload: { targetId: "a3", troops: 2000, gold: 500, food: 1000 } }, rules).ok, true);
  state.cities[1].factionId = "neutral";
  const report = settleTasks(state, rules);
  assert.equal(report.failed.length, 1);
  assert.deepEqual(resources(state), { gold: 5000, food: 20000, troops: 10000 });
  assert.equal(state.cities[2].food, 20000);
  assert.equal(officer(state).taskId, undefined);
  assert.equal(state.commandsRemaining, 5);
  const before = structuredClone(state);
  settleTasks(state, rules);
  assert.deepEqual(state, before);
});

test("lost origin cannot refund its reserved resources into enemy stores or another city", () => {
  const state = fixture();
  queueTask(state, domestic(), rules);
  const reserved = resources(state);
  home(state).factionId = "b";
  assert.equal(settleTasks(state, rules).failed.length, 1);
  assert.deepEqual(resources(state), reserved);
  assert.equal(state.tasks[0].reservation.status, "forfeited");
  assert.equal(state.cities[1].gold, 5000);
  assert.equal(officer(state).taskId, undefined);
});

test("an actor captured after acceptance fails the task and returns still-owned city funds", () => {
  const state = fixture();
  queueTask(state, domestic(), rules);
  officer(state).status = "captured";
  const result = settleTasks(state, rules);
  assert.equal(result.failed.length, 1);
  assert.equal(home(state).gold, 5000);
  assert.equal(home(state).agriculture, 60);
  assert.equal(officer(state).taskId, undefined);
});

test("grain purchases and sales preserve the accepted seasonal quote over later months", () => {
  for (const direction of ["buy", "sell"]) {
    const state = fixture();
    const custom = setTiming("trade", "multi_turn", 3);
    const report = queueTask(state, { kind: "trade", cityId: "a1", officerIds: ["lord"], payload: { direction, goldAmount: 100 } }, custom);
    assert.equal(report.ok, true);
    assert.equal(report.task.tradeRate, 5);
    assert.equal(home(state).gold, direction === "buy" ? 4900 : 5000);
    assert.equal(home(state).food, direction === "sell" ? 19500 : 20000);
    state.month = 7;
    settleTasks(state, custom, { targetTurn: 3 });
    assert.equal(home(state).gold, direction === "buy" ? 4900 : 5100);
    assert.equal(home(state).food, direction === "sell" ? 19500 : 20500);
    assert.equal(state.tasks[0].result.rate, 5);
  }
});

test("search and employment defer random outcomes until settlement, not preview", () => {
  const state = fixture();
  state.officers.push(person("free", null, "a1", { status: "free", discovered: false }));
  queueTask(state, { kind: "search", cityId: "a1", officerIds: ["lord"], payload: {} }, rules);
  assert.equal(officer(state, "free").discovered, false);
  settleTasks(state, rules, { rng: () => 0.99 });
  assert.equal(officer(state, "free").discovered, false);
  assert.equal(state.tasks[0].result.foundOfficerId, null);
  officer(state, "free").discovered = true;
  queueTask(state, { kind: "employ", cityId: "a1", officerIds: ["aide"], payload: { targetId: "free" } }, rules);
  assert.equal(officer(state, "free").status, "free");
  settleTasks(state, rules, { rng: () => 0 });
  assert.equal(officer(state, "free").status, "active");
  assert.equal(state.tasks[1].result.success, true);
});

test("governor appointments, diplomacy and officer migrations take effect at settlement", () => {
  const state = fixture();
  queueTask(state, { kind: "governor", cityId: "a1", officerIds: ["lord"], payload: {} }, rules);
  queueTask(state, { kind: "diplomacy", cityId: "a1", officerIds: ["aide"], payload: { targetFactionId: "b", action: "goodwill" } }, rules);
  queueTask(state, { kind: "officerTransfer", cityId: "a1", officerIds: ["third"], payload: { targetId: "a3" } }, rules);
  assert.equal(home(state).governorId, null);
  assert.equal(state.relations, undefined);
  assert.equal(officer(state, "third").locationCityId, "a1");
  assert.equal(settleTasks(state, rules).completed.length, 3);
  assert.equal(home(state).governorId, "lord");
  assert.ok(state.relations["a|b"].friendliness > 20);
  assert.equal(officer(state, "third").locationCityId, "a3");
  assert.equal(state.commandsRemaining, 3);
});

test("march reserves army and cargo once, pauses following tasks, and resumes after battle", () => {
  const state = fixture();
  const queued = queueTask(state, march(), rules);
  assert.equal(queued.ok, true);
  assert.deepEqual(resources(state), { gold: 4800, food: 19700, troops: 8000 });
  queueTask(state, domestic(["aide"]), rules);
  home(state).training = 98;
  const first = settleTasks(state, rules);
  assert.equal(first.battleTask.id, queued.taskId);
  assert.equal(first.battleTask.battle.training, 80);
  assert.equal(home(state).training, 98);
  assert.deepEqual(first.battleTask.battle.supplies, { food: 300, gold: 100 });
  assert.equal(home(state).agriculture, 60);
  assert.equal(home(state).troops, 8000);
  assert.equal(home(state).food, 19700);
  assert.equal(state.commandsRemaining, 4);
  assert.equal(getReadyBattleTask(state).id, queued.taskId);
  const before = structuredClone(state);
  assert.equal(settleTasks(state, rules).battleTask.id, queued.taskId);
  assert.deepEqual(state, before);
  assert.equal(queueTask(state, domestic(["third"]), rules).ok, false);
  assert.equal(finishBattleTask(state, queued.taskId, { success: false, message: "主动撤退" }, 1).ok, true);
  assert.equal(state.tasks[0].status, "completed");
  assert.equal(state.tasks[0].result.success, false);
  assert.equal(officer(state).taskId, undefined);
  assert.equal(officer(state).acted, true);
  assert.equal(settleTasks(state, rules).completed.length, 1);
  assert.ok(home(state).agriculture > 60);
  assert.equal(finishBattleTask(state, queued.taskId, {}, 1).ok, false);
});

test("immediate march still waits for battle and does not claim victory at acceptance", () => {
  const state = fixture();
  const result = queueTask(state, march(), setTiming("march", "immediate"));
  assert.equal(result.status, "awaiting_battle");
  assert.equal(result.task.completedTurn, undefined);
  assert.equal(state.cities[3].factionId, "b");
  assert.equal(state.commandsRemaining, 5);
});

test("save-load round trips preserve reservations, stable identifiers, locks and one-time execution", () => {
  let state = fixture();
  const first = queueTask(state, domestic(), rules);
  state = JSON.parse(JSON.stringify(state));
  const second = queueTask(state, domestic(["aide"], "commerce"), rules);
  assert.notEqual(first.taskId, second.taskId);
  assert.equal(state.nextTaskId, 3);
  assert.equal(busyOfficerIds(state).size, 2);
  assert.equal(settleTasks(state, rules).completed.length, 2);
  state = JSON.parse(JSON.stringify(state));
  const before = structuredClone(state);
  assert.equal(settleTasks(state, rules).completed.length, 0);
  assert.deepEqual(state, before);
});

test("saved awaiting battles replay neither departure nor following work", () => {
  let state = fixture();
  queueTask(state, march(), rules);
  queueTask(state, domestic(["aide"]), rules);
  settleTasks(state, rules);
  state = JSON.parse(JSON.stringify(state));
  const before = structuredClone(state);
  const report = settleTasks(state, rules);
  assert.ok(report.battleTask);
  assert.equal(report.completed.length, 0);
  assert.deepEqual(state, before);
});

test("malformed saved reservation fails safely without manufacturing non-finite resources", () => {
  const state = fixture();
  queueTask(state, domestic(), rules);
  delete state.tasks[0].reservation.gold;
  const before = resources(state);
  assert.equal(settleTasks(state, rules).failed.length, 1);
  assert.deepEqual(resources(state), before);
  assert.equal(state.tasks[0].reservation.status, "forfeited");
});

test("development completed before month end enters that closing month's taxes and July harvest exactly once", () => {
  const state = fixture();
  queueTask(state, domestic(["lord"], "agriculture"), rules);
  queueTask(state, domestic(["aide"], "commerce"), rules);
  assert.equal(home(state).agriculture, 60);
  assert.equal(home(state).commerce, 60);
  settleTasks(state, rules);
  const beforeEconomy = structuredClone(home(state));
  const salary = monthlySalaryCost(state, home(state), rules);
  const income = calculateMonthlyIncome(home(state), rules);
  const harvest = calculateAnnualHarvest(home(state), rules);
  const report = advanceMonth(state, rules);
  assert.equal(home(state).gold, beforeEconomy.gold + income - salary);
  assert.equal(home(state).food, beforeEconomy.food - monthlyFoodCost(beforeEconomy.troops, rules) + harvest);
  assert.equal(report.monthly.find((entry) => entry.cityId === "a1").goldIncome, income);
  assert.equal(report.harvest.find((entry) => entry.cityId === "a1").food, harvest);
  assert.equal(state.tasks.every((task) => task.completedTurn === state.elapsedMonths), true);
  const after = structuredClone(state);
  settleTasks(state, rules, { targetTurn: state.elapsedMonths });
  assert.deepEqual(state, after);
});

test("new recruits eat at closing-month strength, while transported troops eat only at their destination", () => {
  const state = fixture();
  state.month = 1;
  queueTask(state, { kind: "recruit", cityId: "a1", officerIds: ["lord"], payload: { amount: 1000 } }, rules);
  queueTask(state, { kind: "transfer", cityId: "a1", officerIds: ["aide"], payload: { targetId: "a3", troops: 2000, gold: 500, food: 1000 } }, rules);
  assert.equal(home(state).troops, 8000, "outbound troops are reserved, recruits do not exist early");
  settleTasks(state, rules);
  const beforeEconomy = structuredClone(state.cities);
  assert.equal(home(state).troops, 9000);
  assert.equal(state.cities[2].troops, 12000);
  const report = advanceMonth(state, rules);
  assert.equal(report.monthly.find((entry) => entry.cityId === "a1").foodCost, monthlyFoodCost(9000, rules));
  assert.equal(report.monthly.find((entry) => entry.cityId === "a3").foodCost, monthlyFoodCost(12000, rules));
  assert.equal(home(state).food, beforeEconomy[0].food - monthlyFoodCost(9000, rules));
  assert.equal(state.cities[2].food, beforeEconomy[2].food - monthlyFoodCost(12000, rules));
});

test("arriving officers take salaries from their destination, not twice from both cities", () => {
  const state = fixture();
  queueTask(state, { kind: "officerTransfer", cityId: "a1", officerIds: ["lord", "aide"], payload: { targetId: "a3" } }, rules);
  assert.equal(home(state).officerIds.length, 3);
  assert.equal(state.cities[2].officerIds.length, 0);
  settleTasks(state, rules);
  assert.equal(home(state).officerIds.length, 1);
  assert.equal(state.cities[2].officerIds.length, 2);
  const report = advanceMonth(state, rules);
  const salary = rules.economy.salaryByRank["君主"];
  assert.equal(report.monthly.find((entry) => entry.cityId === "a1").salaryCost, salary);
  assert.equal(report.monthly.find((entry) => entry.cityId === "a3").salaryCost, salary * 2);
  assert.equal(officer(state).acted, false, "an arrived officer may act in the new month");
  assert.equal(officer(state).taskId, undefined);
});

test("new governors and working governors do not perform an additional autonomous order", () => {
  const state = fixture();
  queueTask(state, { kind: "governor", cityId: "a1", officerIds: ["lord"], payload: {} }, rules);
  settleTasks(state, rules);
  const before = structuredClone(home(state));
  assert.equal(runGovernorAutomation(state, rules).find((entry) => entry.cityId === "a1").skipped, true);
  assert.deepEqual(home(state), before);
  advanceMonth(state, rules);
  const custom = setTiming("domestic", "multi_turn", 3);
  queueTask(state, domestic(), custom);
  const originalAgriculture = home(state).agriculture;
  for (let turn = 2; turn < 4; turn += 1) {
    settleTasks(state, custom, { targetTurn: turn });
    advanceMonth(state, custom);
    assert.equal(home(state).agriculture, originalAgriculture);
    assert.equal(officer(state).acted, true);
    assert.ok(officer(state).taskId);
  }
  settleTasks(state, custom, { targetTurn: 4 });
  const completedAgriculture = home(state).agriculture;
  advanceMonth(state, custom);
  assert.equal(home(state).agriculture, completedAgriculture, "finishing the task also consumes that month's governor action");
  assert.equal(officer(state).acted, false);
});

test("AI world turns leave locked player task actors, cities and reservations alone", () => {
  const state = fixture();
  const custom = setTiming("domestic", "multi_turn", 3);
  state.relations = { "a|b": { friendliness: 70, allianceUntil: 9999 } };
  queueTask(state, domestic(), custom);
  settleTasks(state, custom, { targetTurn: 1 });
  advanceMonth(state, custom);
  const beforeCity = structuredClone(home(state));
  const beforeOfficer = structuredClone(officer(state));
  const beforeTask = structuredClone(state.tasks[0]);
  runWorldTurn(state, custom, () => 0.5);
  assert.deepEqual(home(state), beforeCity);
  assert.deepEqual(officer(state), beforeOfficer);
  assert.deepEqual(state.tasks[0], beforeTask);
  assert.equal(officer(state).acted, true);
});

test("a preceding successful alliance invalidates a march and refunds all departure reservations", () => {
  const state = fixture();
  state.relations = { "a|b": { friendliness: 60, allianceUntil: 0 } };
  const before = resources(state);
  queueTask(state, { kind: "diplomacy", cityId: "a1", officerIds: ["aide"], payload: { targetFactionId: "b", action: "alliance" } }, rules);
  queueTask(state, march(), rules);
  const report = settleTasks(state, rules, { rng: () => 0 });
  assert.equal(report.completed.length, 1);
  assert.equal(report.failed.length, 1);
  assert.equal(report.battleTask, null);
  assert.equal(home(state).troops, before.troops);
  assert.equal(home(state).food, before.food);
  assert.equal(home(state).gold, before.gold - rules.diplomacy.allianceCost);
  assert.equal(state.tasks[1].reservation.status, "returned");
});

test("queued departure, actual retreat and next-month economy return and consume resources exactly once", () => {
  const state = fixture();
  state.month = 1;
  const order = queueTask(state, march(), rules);
  settleTasks(state, rules);
  const descriptor = getReadyBattleTask(state).battle;
  const map = { width: 3, height: 3, terrain: Array(9).fill("plain"), attackerStarts: [{ x: 0, y: 1 }], defenderStarts: [{ x: 2, y: 1 }] };
  const battle = new BattleEngine({ sourceCity: { ...home(state), training: descriptor.training, morale: descriptor.morale },
    targetCity: state.cities[3], divisions: descriptor.divisions, supplies: descriptor.supplies, officers: state.officers, rules, map, rng: () => 0 });
  battle.armyOfficerIds = descriptor.armyOfficerIds;
  assert.equal(settlePlayerBattle(state, battle, "enemy").ok, true);
  assert.equal(finishBattleTask(state, order.taskId, { success: false, message: "撤军" }, 1).ok, true);
  assert.equal(home(state).troops, 10000);
  assert.equal(home(state).gold, 5000 - rules.actions.march);
  assert.equal(home(state).food, 20000 - dailyFoodCost(2000, rules));
  const beforeEconomy = structuredClone(home(state));
  const report = advanceMonth(state, rules);
  assert.equal(home(state).food, beforeEconomy.food - monthlyFoodCost(10000, rules));
  assert.equal(report.monthly.find((entry) => entry.cityId === "a1").foodCost, monthlyFoodCost(10000, rules));
  assert.equal(state.tasks[0].completedTurn, state.elapsedMonths);
  assert.equal(officer(state).taskId, undefined);
  assert.equal(officer(state).acted, false);
  const after = structuredClone(state);
  settleTasks(state, rules);
  assert.equal(finishBattleTask(state, order.taskId, {}, 1).ok, false);
  assert.deepEqual(state, after);
});

test("capturing a task's target makes a later duplicate march refund instead of fighting a friendly city", () => {
  const state = fixture();
  state.cities[3].troops = 0;
  const first = queueTask(state, march(), rules);
  const second = queueTask(state, march("aide"), rules);
  const report = settleTasks(state, rules);
  assert.equal(report.battleTask.id, first.taskId);
  const descriptor = report.battleTask.battle;
  const map = { width: 3, height: 3, terrain: Array(9).fill("plain"), attackerStarts: [{ x: 0, y: 1 }], defenderStarts: [{ x: 2, y: 1 }] };
  const battle = new BattleEngine({ sourceCity: home(state), targetCity: state.cities[3], divisions: descriptor.divisions,
    supplies: descriptor.supplies, officers: state.officers, rules, map, rng: () => 0 });
  battle.armyOfficerIds = descriptor.armyOfficerIds;
  assert.equal(battle.winner, "ally");
  assert.equal(settlePlayerBattle(state, battle, battle.winner).ok, true);
  assert.equal(finishBattleTask(state, first.taskId, { success: true, message: "入城" }, 1).ok, true);
  const continuation = settleTasks(state, rules);
  assert.equal(continuation.failed[0].id, second.taskId);
  assert.equal(home(state).troops, 8000);
  assert.equal(state.cities[3].troops, 2000);
  assert.equal(home(state).gold, 5000 - rules.actions.march - 100);
  assert.equal(home(state).food, 19700);
  assert.equal(state.cities[3].gold, 5100);
  assert.equal(state.cities[3].food, 20300);
  assert.equal(officer(state).locationCityId, "b1");
  assert.equal(officer(state).taskId, undefined);
  assert.equal(officer(state, "aide").taskId, undefined);
});
