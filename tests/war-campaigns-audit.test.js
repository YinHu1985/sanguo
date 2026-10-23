import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { enableWarCampaigns, ensureInvasionBattle, getBattleEngine, checkpointBattle, activeBattleCampaigns, advanceBattleMonths } from "../src/js/game/war-campaigns.js";
import { beginTurnResolution, resumeTurnResolution } from "../src/js/game/turn-flow.js";
import { advanceMonth, availableOfficers } from "../src/js/game/rules.js";
import { dailyFoodCost, monthlyFoodCost } from "../src/js/game/economy.js";
import { applyFormationLosses, sumEquipment, EQUIPMENT_KEYS } from "../src/js/game/troops.js";
import { resolveOccupation } from "../src/js/game/campaign.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = { width: 12, height: 8, terrain: Array(96).fill("plain"), attackerStarts: [{ x: 0, y: 2 }], defenderStarts: [{ x: 11, y: 2 }], stronghold: { x: 11, y: 4 } };
const city = (id, factionId) => ({ id, name: id, factionId, officerIds: [`officer-${id}`], adjacent: [], governorId: null,
  troops: 5000, training: 70, morale: 80, gold: 10000, food: 30000, horses: 2000, crossbows: 2000, armor: 2000,
  agriculture: 60, commerce: 60, popularSupport: 80, wallLevel: 2, defense: 100, wallProgress: 0 });
const person = (place) => ({ id: `officer-${place.id}`, name: place.id, factionId: place.factionId, locationCityId: place.id, status: "active",
  rank: "君主", war: 80, leadership: 80, intelligence: 80, politics: 80, charm: 80, loyalty: 100, merit: 0, acted: false });
const c = (state, id) => state.cities.find((entry) => entry.id === id);
const o = (state, id) => state.officers.find((entry) => entry.id === `officer-${id}`);
function fixture() {
  const cities = [city("p-attack", "player"), city("b-defense", "b"), city("b-attack", "b"), city("p-defense", "player"),
    city("c-attack", "c"), city("d-defense", "d"), city("e-attack", "e"), city("f-defense", "f"), city("p-home", "player"), city("b-home", "b")];
  const state = { version: 1, started: true, scenarioId: "parallel-war-audit", year: 196, month: 2, elapsedMonths: 3,
    playerFactionId: "player", commandsMax: 8, commandsRemaining: 8, tasks: [], nextTaskId: 1, pendingInvasions: [], eventLog: [],
    factions: [...new Set(cities.map((entry) => entry.factionId))].map((id) => ({ id, name: id, researchPoints: 0 })), cities, officers: cities.map(person) };
  enableWarCampaigns(state, map);
  return state;
}
function launch(state, sourceId, targetId, customRules = rules, targetTurn = 4) {
  const source = c(state, sourceId), target = c(state, targetId), troops = 2000;
  const supplies = { food: dailyFoodCost(troops, customRules) * 60, gold: 100 };
  source.troops -= troops; source.food -= supplies.food; source.gold -= supplies.gold;
  const invasion = { id: `audit-${sourceId}-${targetId}`, sourceId, targetId, attackerFactionId: source.factionId, defenderFactionId: target.factionId,
    officerIds: [`officer-${sourceId}`], divisions: [{ officerIds: [`officer-${sourceId}`], troops, composition: { infantry: troops } }],
    troops, training: source.training, morale: source.morale, supplies, equipment: {}, resolved: false };
  state.pendingInvasions.push(invasion);
  const result = ensureInvasionBattle(state, invasion.id, customRules, map, { targetTurn });
  assert.equal(result.ok, true, result.message);
  return result.record;
}
function waitMonth(battle) {
  for (let steps = 0; battle.status === "active" && steps < 300; steps += 1) assert.equal(battle.wait().ok, true);
  assert.equal(battle.status, "paused");
}

test("two AI wars plus player offense and defense advance independently once, including JSON resume", async () => {
  let state = fixture();
  const stationaryRules = structuredClone(rules);
  // Isolate lifecycle/economy from combat balance: no unit can spend 100 AP to cross a tile.
  stationaryRules.terrain.plain.move = 100;
  const records = [["p-attack", "b-defense"], ["b-attack", "p-defense"], ["c-attack", "d-defense"], ["e-attack", "f-defense"]]
    .map(([source, target]) => launch(state, source, target, stationaryRules));
  const allActors = records.flatMap((record) => record.officerIds);
  assert.equal(new Set(allActors).size, allActors.length);
  state.lastWorldTurnMonth = state.year * 12 + state.month;
  beginTurnResolution(state);
  const played = [];
  const callbacks = { onCampaignBattle: (record) => {
    played.push(record.id);
    const restored = getBattleEngine(state, record.id, stationaryRules, { targetTurn: 4 });
    assert.equal(restored.ok, true); waitMonth(restored.battle);
    assert.equal(checkpointBattle(state, record.id, restored.battle, { targetTurn: 4 }).ok, true);
  } };
  const opening = await resumeTurnResolution(state, stationaryRules, callbacks);
  assert.equal(opening.waiting, "opening");
  assert.deepEqual(played, records.slice(0, 2).map((record) => record.id), "AI wars do not ask for player control");
  assert.equal(state.elapsedMonths, 4);
  for (const record of activeBattleCampaigns(state)) {
    assert.equal(record.snapshot.day, 30); assert.equal(record.status, "paused"); assert.equal(record.lastProcessedTurn, 4);
    assert.equal(record.snapshot.supplies.ally.food, dailyFoodCost(2000, stationaryRules) * 30);
    assert.equal(c(state, record.targetCityId).food, 30000 - dailyFoodCost(5000, stationaryRules) * 30);
    for (const id of record.officerIds) {
      const officer = state.officers.find((entry) => entry.id === id);
      assert.equal(officer.battleId, record.id); assert.equal(officer.acted, true);
      assert.equal(availableOfficers(state, c(state, officer.locationCityId)).some((entry) => entry.id === id), false);
    }
  }
  const resourcesBeforeReload = structuredClone(state.cities);
  state = JSON.parse(JSON.stringify(state)); enableWarCampaigns(state, map);
  assert.equal((await resumeTurnResolution(state, stationaryRules, { onOpening: () => {} })).completed, true);
  assert.deepEqual(state.cities, resourcesBeforeReload);
  assert.equal(state.elapsedMonths, 4);
  const beforeRepeated = structuredClone(state);
  assert.equal(advanceBattleMonths(state, stationaryRules, { targetTurn: 4 }).ok, true);
  assert.deepEqual(state, beforeRepeated, "completed background slices cannot run again in the same target turn");
});

test("defender equipment loses exactly its casualties across repeated checkpoints and JSON restore", () => {
  let state = fixture();
  const initial = structuredClone(c(state, "b-defense")), record = launch(state, "p-attack", "b-defense");
  const battle = getBattleEngine(state, record.id, rules, { targetTurn: 4 }).battle;
  const defender = battle.units.find((unit) => unit.side === "enemy");
  const committed = { ...battle.defenderEquipmentCommitted };
  assert.equal(applyFormationLosses(defender, 731, rules, "melee"), 731);
  battle.refreshCombatStats(defender);
  const remaining = sumEquipment(battle.units.filter((unit) => unit.side === "enemy"), rules);
  assert.equal(checkpointBattle(state, record.id, battle).ok, true);
  for (const key of EQUIPMENT_KEYS) assert.equal(c(state, "b-defense")[key], initial[key] - committed[key] + remaining[key]);
  const stores = structuredClone(c(state, "b-defense"));
  assert.equal(checkpointBattle(state, record.id, battle).ok, true);
  assert.deepEqual(c(state, "b-defense"), stores);
  state = JSON.parse(JSON.stringify(state)); enableWarCampaigns(state, map);
  const restored = getBattleEngine(state, record.id, rules, { targetTurn: 4 }).battle;
  assert.equal(checkpointBattle(state, record.id, restored).ok, true);
  assert.deepEqual(c(state, "b-defense"), stores);
});

test("a fallen origin does not capture, reuse or duplicate generals still fighting in a different city", () => {
  const state = fixture(), record = launch(state, "p-attack", "b-defense");
  const capturedOrigin = resolveOccupation(state, { sourceId: "c-attack", targetId: "p-attack", officerIds: ["officer-c-attack"],
    troops: 1000, training: 70, morale: 80 }, () => 0);
  assert.equal(capturedOrigin.ok, true, capturedOrigin.message);
  assert.equal(o(state, "p-attack").factionId, "player"); assert.equal(o(state, "p-attack").status, "active");
  assert.equal(o(state, "p-attack").battleId, record.id);
  assert.equal(state.cities.flatMap((entry) => availableOfficers(state, entry)).includes(o(state, "p-attack")), false);
  const battle = getBattleEngine(state, record.id, rules, { targetTurn: 4 }).battle;
  assert.equal(battle.retreatArmy("ally").ok, true);
  assert.equal(checkpointBattle(state, record.id, battle).ok, true);
  const occurrences = state.cities.filter((entry) => entry.officerIds.includes("officer-p-attack"));
  assert.equal(occurrences.length, 1); assert.equal(occurrences[0].factionId, "player");
  assert.equal(o(state, "p-attack").locationCityId, occurrences[0].id);
  assert.equal(o(state, "p-attack").battleId, undefined);
});

test("a one-day retreat credits already-paid tactical rations against that month's city upkeep", () => {
  const state = fixture(), startFood = c(state, "p-attack").food + c(state, "b-defense").food;
  const expectedMonthFood = monthlyFoodCost(c(state, "p-attack").troops, rules) + monthlyFoodCost(c(state, "b-defense").troops, rules);
  const record = launch(state, "p-attack", "b-defense");
  const battle = getBattleEngine(state, record.id, rules, { targetTurn: 4 }).battle;
  assert.equal(battle.day, 1); assert.equal(battle.retreatArmy("ally").ok, true);
  assert.equal(checkpointBattle(state, record.id, battle).ok, true);
  advanceMonth(state, rules);
  const spent = startFood - c(state, "p-attack").food - c(state, "b-defense").food;
  assert.equal(spent, expectedMonthFood, "same living soldiers must pay 30 days total, not 1 tactical day plus 30 city days");
});

test("sixty carried days cover two monthly slices, and day 61 withdrawal charges no phantom defender day", () => {
  const state = fixture(), record = launch(state, "p-attack", "b-defense");
  for (const targetTurn of [4, 5]) {
    const restored = getBattleEngine(state, record.id, rules, { targetTurn });
    assert.equal(restored.ok, true); waitMonth(restored.battle);
    assert.equal(checkpointBattle(state, record.id, restored.battle, { targetTurn }).ok, true);
    assert.equal(record.snapshot.day, (targetTurn - 3) * 30);
    advanceMonth(state, rules);
  }
  assert.equal(record.snapshot.supplies.ally.food, 0);
  assert.equal(record.snapshot.rationDaysPaid.ally, 60);
  assert.equal(record.snapshot.rationDaysPaid.enemy, 60);
  const defenderFood = c(state, "b-defense").food;
  const third = getBattleEngine(state, record.id, rules, { targetTurn: 6 }).battle;
  assert.equal(third.status, "ended"); assert.equal(third.day, 61); assert.equal(third.winner, "enemy");
  assert.equal(third.supplies.enemy.food, defenderFood);
  assert.equal(checkpointBattle(state, record.id, third, { targetTurn: 6 }).ok, true);
  assert.equal(c(state, "p-attack").troops, 5000);
  const report = advanceMonth(state, rules);
  assert.equal(report.monthly.find((entry) => entry.cityId === "p-attack").foodSpent, monthlyFoodCost(5000, rules));
  assert.equal(report.monthly.find((entry) => entry.cityId === "b-defense").foodSpent, monthlyFoodCost(5000, rules));
});

test("safe defender withdrawal transfers survivor equipment and officers once, never into another besieged city", () => {
  const state = fixture();
  const record = launch(state, "p-attack", "b-defense");
  // The first friendly city in array order is also besieged, so it cannot receive the escaped army.
  const otherWar = launch(state, "c-attack", "b-attack");
  const before = structuredClone(c(state, "b-home"));
  const battle = getBattleEngine(state, record.id, rules, { targetTurn: 4 }).battle;
  const escapedEquipment = sumEquipment(battle.units.filter((unit) => unit.side === "enemy"), rules);
  assert.equal(battle.retreatArmy("enemy").ok, true);
  assert.equal(checkpointBattle(state, record.id, battle).ok, true);
  assert.equal(c(state, "b-defense").factionId, "player");
  assert.equal(c(state, "b-home").troops, before.troops + 5000);
  assert.equal(c(state, "b-attack").troops, 5000);
  assert.equal(c(state, "b-attack").battleId, otherWar.id);
  for (const key of EQUIPMENT_KEYS) assert.equal(c(state, "b-home")[key], before[key] + escapedEquipment[key]);
  assert.equal(o(state, "b-defense").locationCityId, "b-home");
  assert.equal(o(state, "b-defense").factionId, "b"); assert.equal(o(state, "b-defense").battleId, undefined);
  const after = structuredClone(state);
  assert.equal(checkpointBattle(state, record.id, battle).alreadySettled, true);
  assert.deepEqual(state, after);
});

test("modern month checkpoints reject skipped or noninteger month numbers before changing tasks or stores", async () => {
  for (const elapsedMonths of [3, -1, 1.5, Number.NaN]) {
    const state = fixture(); state.elapsedMonths = elapsedMonths;
    state.turnResolution = { stage: "tasks", targetTurn: elapsedMonths === 3 ? 6 : 1 };
    const before = structuredClone(state);
    const result = await resumeTurnResolution(state, rules, { onOpening: () => {} });
    assert.equal(result.ok, false, `invalid elapsed=${elapsedMonths} target=${before.turnResolution.targetTurn} must not settle a month`);
    assert.deepEqual(state, before);
  }
});
