import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { settlePlayerBattle } from "../src/js/game/battle-result.js";
import { validateArmy, commitArmyDeparture } from "../src/js/game/rules.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";
import { dailyFoodCost } from "../src/js/game/economy.js";
import { enableWarCampaigns, ensureTaskBattle, ensureInvasionBattle, getBattleEngine, checkpointBattle, advanceBattleMonths } from "../src/js/game/war-campaigns.js";
import { heavenCycleStatus, normalizeHeavenCycle } from "../src/js/game/heaven-cycle.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = { width: 12, height: 8, terrain: Array(96).fill("plain"), attackerStarts: [{ x: 0, y: 2 }], defenderStarts: [{ x: 11, y: 2 }], stronghold: { x: 11, y: 4 } };
const person = (id, factionId, locationCityId) => ({ id, name: id, factionId, locationCityId, status: "active", rank: "君主", war: 80, leadership: 80,
  intelligence: 80, politics: 80, charm: 80, loyalty: 90, merit: 0, acted: false });
const city = (id, factionId, officerIds, adjacent) => ({ id, name: id, factionId, officerIds, adjacent, governorId: null,
  troops: 5000, training: 80, morale: 80, food: 30000, gold: 10000, horses: 2000, armor: 2000, crossbows: 2000,
  agriculture: 60, commerce: 60, popularSupport: 80, wallLevel: 2, defense: 100, wallProgress: 0 });
function fixture() {
  const state = { version: 1, scenarioId: "fate-war-test", started: true, year: 196, month: 6, elapsedMonths: 0,
    playerFactionId: "a", commandsMax: 8, commandsRemaining: 8, tasks: [], nextTaskId: 1, pendingInvasions: [], eventLog: [],
    factions: [{ id: "a", name: "甲", lord: "a" }, { id: "b", name: "乙", lord: "b" }, { id: "c", name: "丙", lord: "c" }],
    cities: [city("a1", "a", ["a"], ["b1"]), city("b1", "b", ["b"], ["a1", "b2"]),
      city("b2", "b", ["b2"], ["b1"]), city("c1", "c", ["c"], ["a1"])],
    officers: [person("a", "a", "a1"), person("b", "b", "b1"), person("b2", "b", "b2"), person("c", "c", "c1")] };
  state.factions.forEach(normalizeHeavenCycle);
  return state;
}
const c = (state, id) => state.cities.find((entry) => entry.id === id);
const status = (state, id) => heavenCycleStatus(state.factions.find((entry) => entry.id === id), rules);
const divisions = () => [{ officerIds: ["a"], troops: 2000, composition: { infantry: 2000 } }];
const supplies = () => ({ food: dailyFoodCost(2000, rules) * 60, gold: 100 });
function exhaustDefender(battle) {
  battle.supplies.enemy.food = 0;
  for (let attempts = 0; battle.status === "active" && attempts < 100; attempts++) assert.equal(battle.wait().ok, true);
  assert.equal(battle.status, "ended"); assert.equal(battle.winner, "ally");
}
function expectCapture(state) {
  assert.equal(c(state, "b1").factionId, "a");
  assert.equal(status(state, "a").phase, "victory"); assert.equal(status(state, "a").strength, 1);
  assert.equal(status(state, "b").phase, "defeat"); assert.equal(status(state, "b").strength, 1);
  assert.equal(status(state, "c").phase, "neutral");
}

test("legacy battlefield settlement commits both faction cycles and refuses duplicate wins", () => {
  const state = fixture(), army = validateArmy(state, "a1", "b1", divisions(), rules, supplies());
  assert.equal(army.ok, true); assert.equal(commitArmyDeparture(state, army).ok, true);
  const battle = new BattleEngine({ sourceCity: army.city, targetCity: army.target, divisions: army.divisions, supplies: army.supplies,
    officers: state.officers, state, rules, map, rng: () => 0.5 });
  battle.armyOfficerIds = ["a"];
  exhaustDefender(battle);
  assert.equal(settlePlayerBattle(state, battle, "ally").ok, true);
  expectCapture(state);
  const before = structuredClone(state);
  assert.equal(settlePlayerBattle(state, battle, "ally").ok, false); assert.deepEqual(state, before);
});

test("a rejected post-occupation battlefield draft does not leak its heaven outcomes", () => {
  const state = fixture(), army = validateArmy(state, "a1", "b1", divisions(), rules, supplies());
  assert.equal(commitArmyDeparture(state, army).ok, true);
  const battle = new BattleEngine({ sourceCity: army.city, targetCity: army.target, divisions: army.divisions, supplies: army.supplies,
    officers: state.officers, state, rules, map, rng: () => 0.5 });
  battle.armyOfficerIds = ["a"]; exhaustDefender(battle);
  c(state, "c1").armor = -1; // Final whole-world balance validation fails after draft occupation.
  const before = structuredClone(state);
  assert.equal(settlePlayerBattle(state, battle, "ally").ok, false);
  assert.deepEqual(state, before); assert.equal(status(state, "a").phase, "neutral");
});

test("persistent player campaign checkpoints retain the faction outcomes through save roundtrips", () => {
  let state = fixture(); enableWarCampaigns(state, map);
  const task = queueTask(state, { kind: "march", cityId: "a1", officerIds: ["a"], payload: { targetId: "b1", divisions: divisions(), supplies: supplies() } }, rules);
  assert.equal(task.ok, true); settleTasks(state, rules, { targetTurn: 1 });
  const created = ensureTaskBattle(state, task.taskId, rules, map, { targetTurn: 1 }); assert.equal(created.ok, true);
  assert.equal(status(state, "a").phase, "neutral");
  state = JSON.parse(JSON.stringify(state)); enableWarCampaigns(state, map);
  const battle = getBattleEngine(state, created.record.id, rules, { targetTurn: 1 }).battle;
  exhaustDefender(battle);
  const result = checkpointBattle(state, created.record.id, battle, { targetTurn: 1 }); assert.equal(result.ok, true, result.message);
  expectCapture(state);
  const before = structuredClone(state);
  assert.equal(checkpointBattle(state, created.record.id, battle, { targetTurn: 1 }).alreadySettled, true);
  assert.deepEqual(state, before);
});

test("background AI campaigns award only their actual city transfer and cannot replay the month", () => {
  const state = fixture(); state.playerFactionId = "c"; enableWarCampaigns(state, map);
  const source = c(state, "a1"), cargo = supplies();
  source.troops -= 2000; source.food -= cargo.food; source.gold -= cargo.gold;
  c(state, "b1").food = dailyFoodCost(c(state, "b1").troops, rules); // Enough for day one only.
  state.pendingInvasions.push({ id: "ai-heaven-war", sourceId: "a1", targetId: "b1", attackerFactionId: "a", defenderFactionId: "b",
    officerIds: ["a"], divisions: divisions(), troops: 2000, training: 80, morale: 80, supplies: cargo, equipment: {}, resolved: false });
  const created = ensureInvasionBattle(state, "ai-heaven-war", rules, map, { targetTurn: 1 }); assert.equal(created.ok, true, created.message);
  assert.equal(status(state, "a").phase, "neutral");
  assert.equal(advanceBattleMonths(state, rules, { targetTurn: 1 }).ok, true);
  expectCapture(state);
  const before = structuredClone(state);
  assert.equal(advanceBattleMonths(state, rules, { targetTurn: 1 }).ok, true); assert.deepEqual(state, before);
});
