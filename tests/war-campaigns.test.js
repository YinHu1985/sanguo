import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { enableWarCampaigns, ensureTaskBattle, ensureInvasionBattle, getBattleEngine, checkpointBattle, advanceBattleMonths, activeBattleCampaigns, archiveBattleSnapshot } from "../src/js/game/war-campaigns.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";
import { advanceMonth, executeDomestic, executeTransfer, executeRecruit, validateArmy } from "../src/js/game/rules.js";
import { dailyFoodCost, calculateMonthlyIncome, monthlySalaryCost, calculateAnnualHarvest } from "../src/js/game/economy.js";
import { resolveOccupation, runWorldTurn } from "../src/js/game/campaign.js";
import { beginTurnResolution, resumeTurnResolution } from "../src/js/game/turn-flow.js";
import { findFriendlyRoute } from "../src/js/game/routes.js";
import { BattleEngine } from "../src/js/game/battle.js";
import { simulateBattleMonth } from "../src/js/game/battle-simulation.js";
import { saveManualSlot } from "../src/js/game/save-slots.js";
import { warLedgerRows } from "../src/js/ui/war-windows.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = { width: 12, height: 8, terrain: Array(96).fill("plain"), attackerStarts: [{ x: 0, y: 2 }], defenderStarts: [{ x: 11, y: 2 }], stronghold: { x: 11, y: 4 } };
const person = (id, factionId, locationCityId) => ({ id, name: id, factionId, locationCityId, status: "active", rank: "君主", war: 80, leadership: 80,
  intelligence: 80, politics: 80, charm: 80, loyalty: 90, merit: 0, acted: false });
const city = (id, factionId, officerIds, adjacent) => ({ id, name: id, factionId, officerIds, adjacent, governorId: null,
  troops: 5000, training: 80, morale: 80, food: 30000, gold: 10000, horses: 2000, armor: 2000, crossbows: 2000,
  agriculture: 60, commerce: 60, popularSupport: 80, wallLevel: 2, defense: 100, wallProgress: 0 });
function fixture() {
  const state = { version: 1, scenarioId: "war-test", started: true, year: 196, month: 6, elapsedMonths: 0,
    playerFactionId: "a", commandsMax: 8, commandsRemaining: 8, tasks: [], nextTaskId: 1, pendingInvasions: [], eventLog: [],
    factions: [{ id: "a", name: "甲", lord: "a" }, { id: "b", name: "乙", lord: "b" }, { id: "c", name: "丙", lord: "c" }],
    cities: [city("a1", "a", ["a", "aide"], ["b1", "a2"]), city("b1", "b", ["b"], ["a1", "b2"]),
      city("a2", "a", ["a2"], ["a1", "b2"]), city("b2", "b", ["b2"], ["a2", "b1"]), city("c1", "c", ["c"], ["a1"])],
    officers: [person("a", "a", "a1"), person("aide", "a", "a1"), person("b", "b", "b1"), person("a2", "a", "a2"), person("b2", "b", "b2"), person("c", "c", "c1")] };
  enableWarCampaigns(state, map); return state;
}
const c = (state, id) => state.cities.find((entry) => entry.id === id);
const o = (state, id) => state.officers.find((entry) => entry.id === id);
function launch(state, { source = "a1", target = "b1", officer = "a", targetTurn = 1 } = {}) {
  const task = queueTask(state, { kind: "march", cityId: source, officerIds: [officer], payload: { targetId: target,
    divisions: [{ officerIds: [officer], troops: 2000, composition: { infantry: 1000, heavyInfantry: 1000 } }],
    supplies: { food: dailyFoodCost(2000, rules) * 60, gold: 100 } } }, rules);
  assert.equal(task.ok, true, task.message); settleTasks(state, rules, { targetTurn });
  const created = ensureTaskBattle(state, task.taskId, rules, map, { targetTurn });
  assert.equal(created.ok, true, created.message); return created.record;
}
function waitMonth(battle) {
  for (let count = 0; battle.status === "active" && count < 500; count += 1) {
    const result = battle.wait(); assert.equal(result.ok, true, result.message);
  }
  assert.equal(battle.status, "paused");
}

test("thirty days pause instead of returning soldiers; month economy never double-feeds the besieged garrison", () => {
  const state = fixture(), record = launch(state);
  const result = getBattleEngine(state, record.id, rules, { targetTurn: 1 });
  assert.equal(result.ok, true); waitMonth(result.battle);
  assert.equal(checkpointBattle(state, record.id, result.battle, { targetTurn: 1 }).ok, true);
  assert.equal(record.status, "paused"); assert.equal(record.snapshot.day, 30);
  assert.equal(c(state, "a1").troops, 3000); assert.equal(state.tasks[0].status, "in_battle");
  assert.equal(o(state, "a").battleId, record.id); assert.equal(o(state, "b").battleId, record.id);
  const food = c(state, "b1").food, gold = c(state, "b1").gold;
  const expectedGold = gold + calculateMonthlyIncome(c(state, "b1"), rules) - monthlySalaryCost(state, c(state, "b1"), rules);
  const harvest = calculateAnnualHarvest(c(state, "b1"), rules);
  advanceMonth(state, rules);
  assert.equal(c(state, "b1").food, food + harvest); assert.equal(c(state, "b1").gold, expectedGold);
  assert.deepEqual(record.snapshot.supplies.enemy, { food: food + harvest, gold: expectedGold });
  assert.equal(o(state, "a").acted, true); assert.equal(o(state, "b").acted, true);
  const next = getBattleEngine(state, record.id, rules, { targetTurn: 2 });
  assert.equal(next.battle.day, 31); assert.equal(next.battle.supplies.enemy.food, food + harvest - dailyFoodCost(5000, rules));
  assert.equal(next.battle.supplies.ally.food, dailyFoodCost(2000, rules) * 29);
});

test("a checkpoint restores the exact battle, does not recharge day one, and rejects stale engine writes", () => {
  const state = fixture(), record = launch(state);
  const first = getBattleEngine(state, record.id, rules, { targetTurn: 1 }).battle;
  const stale = getBattleEngine(state, record.id, rules, { targetTurn: 1 }).battle;
  first.wait(); assert.equal(checkpointBattle(state, record.id, first).ok, true);
  const raw = JSON.stringify(state), reloaded = JSON.parse(raw); enableWarCampaigns(reloaded, map);
  const restored = getBattleEngine(reloaded, record.id, rules, { targetTurn: 1 }).battle;
  assert.deepEqual(restored.snapshot(), first.snapshot());
  assert.equal(checkpointBattle(state, record.id, stale).ok, false);
  assert.equal(JSON.stringify(state), raw);
});

test("paused battles may be manually saved; a currently active combat cannot", () => {
  const state = fixture(), record = launch(state), storage = { setItem: () => {} };
  assert.throws(() => saveManualSlot("manual-1", state, storage), /战斗/);
  const battle = getBattleEngine(state, record.id, rules, { targetTurn: 1 }).battle;
  waitMonth(battle); checkpointBattle(state, record.id, battle);
  assert.equal(saveManualSlot("manual-1", state, storage).ok, true);
});

test("besieged cities and deployed officers reject commands, transports and route traversal", () => {
  const state = fixture(), record = launch(state);
  const before = structuredClone(state);
  assert.equal(executeDomestic(state, "a1", "agriculture", ["a"], rules).ok, false);
  state.playerFactionId = "b"; state.commandsRemaining = 8; o(state, "b").acted = false;
  assert.equal(executeDomestic(state, "b1", "agriculture", ["b"], rules).ok, false);
  assert.equal(executeRecruit(state, "b1", "b", 500, rules).ok, false);
  assert.equal(executeTransfer(state, "b2", "b1", "b2", 0, rules, { gold: 10, food: 0 }).ok, false);
  assert.equal(findFriendlyRoute(state, "b2", "b1"), null);
  assert.equal(activeBattleCampaigns(state)[0].id, record.id);
  assert.equal(c(state, "a1").gold, c(before, "a1").gold);
});

test("one city cannot host two independent wars; independent cities can each continue their own month", async () => {
  const state = fixture();
  const first = launch(state), second = launch(state, { source: "a2", target: "b2", officer: "a2" });
  assert.equal(validateArmy(state, "a1", "b1", [{ officerId: "aide", troops: 500 }], rules, { food: 0, gold: 0 }).ok, false);
  state.lastWorldTurnMonth = 196 * 12 + 7;
  beginTurnResolution(state);
  const calls = [];
  const result = await resumeTurnResolution(state, rules, { battleMap: map, onCampaignBattle: async (record) => {
    calls.push(record.id); const battle = getBattleEngine(state, record.id, rules, { targetTurn: 1 }).battle;
    waitMonth(battle); assert.equal(checkpointBattle(state, record.id, battle, { targetTurn: 1 }).ok, true);
  }, onOpening: () => {} });
  assert.equal(result.completed, true); assert.deepEqual(calls, [first.id, second.id]);
  assert.equal(state.elapsedMonths, 1); assert.equal(state.turnResolution, null);
  assert.deepEqual(activeBattleCampaigns(state).map((record) => record.lastProcessedTurn), [1, 1]);
});

test("loss of the original base neither captures its deployed generals nor prevents a safe return elsewhere", () => {
  const state = fixture(), record = launch(state);
  assert.equal(resolveOccupation(state, { sourceId: "c1", targetId: "a1", officerIds: ["c"], troops: 1000, training: 80, morale: 80 }, () => 0).ok, true);
  assert.equal(o(state, "a").status, "active"); assert.equal(o(state, "a").factionId, "a"); assert.equal(o(state, "a").battleId, record.id);
  const homeBefore = c(state, "a2").troops;
  const battle = getBattleEngine(state, record.id, rules, { targetTurn: 1 }).battle;
  assert.equal(battle.retreatArmy("ally").ok, true);
  const settled = checkpointBattle(state, record.id, battle); assert.equal(settled.ok, true, settled.message);
  assert.equal(c(state, "a2").troops, homeBefore + 2000); assert.equal(o(state, "a").locationCityId, "a2");
  assert.equal(o(state, "a").battleId, undefined); assert.equal(state.tasks[0].status, "completed");
  const before = structuredClone(state); assert.equal(checkpointBattle(state, record.id, battle).alreadySettled, true); assert.deepEqual(state, before);
});

test("an army can still capture its target after its departure base falls", () => {
  const state = fixture(), record = launch(state);
  resolveOccupation(state, { sourceId: "c1", targetId: "a1", officerIds: ["c"], troops: 1000, training: 80, morale: 80 }, () => 0);
  const battle = getBattleEngine(state, record.id, rules, { targetTurn: 1 }).battle;
  battle.supplies.enemy.food = 0;
  while (battle.status === "active") assert.equal(battle.wait().ok, true);
  assert.equal(battle.winner, "ally");
  const result = checkpointBattle(state, record.id, battle); assert.equal(result.ok, true, result.message);
  assert.equal(c(state, "b1").factionId, "a"); assert.equal(o(state, "a").locationCityId, "b1");
  assert.equal(state.cities.some((city) => city.id.startsWith("detached-")), false);
});

test("AI versus AI uses the same saved BattleEngine simulation and does not simulate a month twice", () => {
  const state = fixture(); state.playerFactionId = "c";
  const troops = 2000, supplies = { food: dailyFoodCost(troops, rules) * 60, gold: 100 };
  c(state, "a1").troops -= troops; c(state, "a1").food -= supplies.food; c(state, "a1").gold -= 100;
  state.pendingInvasions.push({ id: "ai-war", sourceId: "a1", targetId: "b1", attackerFactionId: "a", defenderFactionId: "b", officerIds: ["a"],
    divisions: [{ officerIds: ["a"], troops, composition: { infantry: troops } }], troops, training: 80, morale: 80, supplies, equipment: {}, resolved: false });
  const created = ensureInvasionBattle(state, "ai-war", rules, map, { targetTurn: 1 }); assert.equal(created.ok, true, created.message);
  const expected = BattleEngine.fromSnapshot(created.record.snapshot, { rules }); assert.equal(simulateBattleMonth(expected).ok, true);
  assert.equal(advanceBattleMonths(state, rules, { targetTurn: 1 }).ok, true);
  assert.equal(created.record.snapshot.day, expected.day); assert.equal(created.record.snapshot.status, expected.status);
  assert.deepEqual(created.record.snapshot.units, expected.status === "ended" ? archiveBattleSnapshot(expected.snapshot()).units : expected.snapshot().units);
  const before = structuredClone(state); assert.equal(advanceBattleMonths(state, rules, { targetTurn: 1 }).ok, true); assert.deepEqual(state, before);
});

test("new campaign marches cannot carry more than sixty days of grain", () => {
  const state = fixture(), food = dailyFoodCost(2000, rules) * 60;
  const divisions = [{ officerIds: ["a"], troops: 2000, composition: { infantry: 2000 } }];
  assert.equal(validateArmy(state, "a1", "b1", divisions, rules, { food, gold: 0 }).ok, true);
  assert.equal(validateArmy(state, "a1", "b1", divisions, rules, { food: food + 1, gold: 0 }).ok, false);
});

test("old funded orders retain their signed four-officer formation and excess cargo without relaxing new orders", () => {
  const state = fixture();
  for (const id of ["old-3", "old-4"]) { state.officers.push(person(id, "a", "a1")); c(state, "a1").officerIds.push(id); }
  const officerIds = ["a", "aide", "old-3", "old-4"], troops = 2000;
  const legacyRules = structuredClone(rules); legacyRules.army.maxOfficersPerUnit = 5; legacyRules.army.maxSupplyDays = 120;
  const supplies = { food: dailyFoodCost(troops, rules) * 100, gold: 100 };
  const divisions = [{ officerIds, troops, composition: { infantry: troops } }];
  assert.equal(validateArmy(state, "a1", "b1", divisions, rules, supplies).ok, false);
  const queued = queueTask(state, { kind: "march", cityId: "a1", officerIds, payload: { targetId: "b1", divisions, supplies } }, legacyRules);
  assert.equal(queued.ok, true, queued.message);
  delete queued.task.armyOrderVersion;
  const before = c(state, "a1").food;
  const settled = settleTasks(state, rules, { targetTurn: 1 });
  assert.equal(settled.battleTask?.status, "awaiting_battle");
  assert.deepEqual(settled.battleTask.battle.supplies, supplies);
  assert.equal(c(state, "a1").food, before);
  assert.equal(ensureTaskBattle(state, queued.taskId, rules, map, { targetTurn: 1 }).ok, true);
});

test("pending invasion generals are not captured or duplicated when their departure base falls before the defense choice", () => {
  const state = fixture(), source = c(state, "a1"), troops = 2000;
  const supplies = { food: dailyFoodCost(troops, rules) * 60, gold: 100 };
  source.troops -= troops; source.food -= supplies.food; source.gold -= supplies.gold;
  state.pendingInvasions.push({ id: "pending-detached", sourceId: "a1", targetId: "b1", attackerFactionId: "a", defenderFactionId: "b",
    officerIds: ["a"], divisions: [{ officerIds: ["a"], troops, composition: { infantry: troops } }], troops,
    training: 80, morale: 80, supplies, equipment: {}, resolved: false });
  assert.equal(resolveOccupation(state, { sourceId: "c1", targetId: "a1", officerIds: ["c"], troops: 1000, training: 80, morale: 80 }, () => 0).ok, true);
  assert.equal(o(state, "a").status, "active"); assert.equal(o(state, "a").factionId, "a");
  const created = ensureInvasionBattle(state, "pending-detached", rules, map, { targetTurn: 1 });
  assert.equal(created.ok, true, created.message);
  assert.equal(created.record.attackerFactionId, "a"); assert.equal(created.record.snapshot.attackerFactionId, "a");
  assert.equal(created.record.attackerOfficerIds.includes("a"), true);
});

test("arrival cancels a defender's uncompleted city order and restores its reserved stock before freezing the war ledger", () => {
  const state = fixture(); state.playerFactionId = "b";
  const initialGold = c(state, "b1").gold;
  const queued = queueTask(state, { kind: "domestic", cityId: "b1", officerIds: ["b"], payload: { action: "agriculture" } }, rules);
  assert.equal(queued.ok, true); assert.ok(c(state, "b1").gold < initialGold);
  state.playerFactionId = "a";
  const source = c(state, "a1"), troops = 2000, supplies = { food: 480, gold: 100 };
  source.troops -= troops; source.food -= supplies.food; source.gold -= supplies.gold;
  state.pendingInvasions.push({ id: "surprise", sourceId: "a1", targetId: "b1", attackerFactionId: "a", defenderFactionId: "b",
    officerIds: ["a"], divisions: [{ officerIds: ["a"], troops, composition: { infantry: troops } }], troops, training: 80, morale: 80, supplies, equipment: {} });
  // The player remains the defending side while the enemy arrives.
  state.playerFactionId = "b";
  const result = ensureInvasionBattle(state, "surprise", rules, map, { targetTurn: 1 });
  assert.equal(result.ok, true, result.message);
  assert.equal(state.tasks[0].status, "failed"); assert.equal(state.tasks[0].reservation.status, "returned");
  assert.equal(c(state, "b1").gold, initialGold); assert.equal(result.record.snapshot.supplies.enemy.gold, initialGold);
});

test("a pre-economy tactical instance cannot erase the new month's income or harvest", () => {
  const state = fixture(), record = launch(state), battle = getBattleEngine(state, record.id, rules, { targetTurn: 1 }).battle;
  waitMonth(battle); assert.equal(checkpointBattle(state, record.id, battle).ok, true);
  advanceMonth(state, rules);
  const before = structuredClone(state);
  assert.equal(checkpointBattle(state, record.id, battle).ok, false);
  assert.deepEqual(state, before);
});

test("completed battle archives keep the ledger fields but not engines, maps or officer rosters", () => {
  const state = fixture(), record = launch(state), battle = getBattleEngine(state, record.id, rules, { targetTurn: 1 }).battle;
  waitMonth(battle);
  const full = battle.snapshot(); full.status = "ended"; full.winner = "enemy";
  const expected = warLedgerRows({ ...state, battles: [{ ...record, status: "ended", snapshot: full }] });
  const archived = archiveBattleSnapshot(full);
  const actual = warLedgerRows({ ...state, battles: [{ ...record, status: "ended", snapshot: archived }] });
  assert.deepEqual(actual, expected);
  assert.equal(archived.archiveSchemaVersion, 1);
  for (const key of ["map", "officers", "queue", "random", "exploredTiles"]) assert.equal(archived[key], undefined);
  const history = Array.from({ length: 300 }, (_, i) => ({ ...record, id: `archive-${i}`, status: "ended", snapshot: archived }));
  assert.ok(JSON.stringify({ ...state, battles: history }).length * 2 < 5 * 1024 * 1024, "300 complete reports fit a conservative UTF-16 localStorage budget");
});
