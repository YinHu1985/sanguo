import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { simulateBattleMonth } from "../src/js/game/battle-simulation.js";
import { applyBattleStatus } from "../src/js/game/battle-statuses.js";
import { fieldTilesMarkup } from "../src/js/ui/field-view.js";

const baseRules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));

function fixture(options = {}) {
  const rules = structuredClone(baseRules);
  if (options.stableSiege) Object.assign(rules.battle.siege, {
    baseProgressPerThousand: 0, attackerLossRate: 0, defenderLossRate: 0
  });
  const map = { width: 11, height: 7, terrain: Array(77).fill("plain"),
    stronghold: { x: 10, y: 3 }, attackerCamp: { x: 0, y: 3 },
    attackerStarts: [{ x: 2, y: 3 }], defenderStarts: [{ x: 8, y: 3 }], ...options.map };
  const officers = ["a", "d"].map((id) => ({ id, name: id, factionId: id, status: "active", rank: "君主",
    war: 50, intelligence: 50, leadership: 50, politics: 50, charm: 50 }));
  return new BattleEngine({
    sourceCity: { id: "source", name: "出发城", factionId: "a", officerIds: ["a"], troops: 10000, training: 50, morale: 80 },
    targetCity: { id: "target", name: "目标城", factionId: "d", officerIds: ["d"], troops: 10000,
      training: 50, morale: 80, food: 100000, gold: 2000, wallLevel: 3, defense: 50 },
    divisions: [{ officerIds: ["a"], troops: 10000, composition: { infantry: 7000, archer: 3000 } }],
    defenderDivisions: [{ officerIds: ["d"], troops: 10000, composition: { infantry: 8000, heavyInfantry: 2000 } }],
    officers, rules, map, supplies: { food: 100000, gold: 2000 }, campaignMode: true, seed: 78241,
    ...options, ...(options.map ? { map } : {})
  });
}

function completeMonthWaiting(battle) {
  let steps = 0;
  while (battle.status === "active") {
    assert.equal(battle.wait().ok, true);
    assert.ok(++steps <= 100, "one month has a bounded number of waiting activations");
  }
}

function readySiege(options = {}) {
  const battle = fixture({ ...options, mode: "siege" });
  assert.equal(battle.chooseTransition("open").ok, true);
  return battle;
}

test("JSON snapshots preserve the entire live state without charging food, consuming statuses or advancing RNG", () => {
  const original = fixture();
  const attacker = original.getUnit("ally-a");
  applyBattleStatus(attacker, "provocation", { sourceId: "enemy-d", remainingActivations: 3,
    lastKnownPosition: { x: 8, y: 3 }, active: false });
  original.getVisibility("ally");
  original.rng();
  original.taskId = "task-12";
  original.invasionId = "invasion-4";
  original.ledger = { horses: 150, armor: 2000, settled: false };
  const saved = JSON.parse(JSON.stringify(original.snapshot()));
  const untouched = structuredClone(saved);
  const restored = BattleEngine.fromSnapshot(saved, { rules: original.rules });
  assert.deepEqual(restored.snapshot(), saved);
  assert.deepEqual(saved, untouched, "restoration never mutates caller-owned save data");
  assert.ok(restored.exploredTiles.ally instanceof Set);
  assert.equal(restored.getUnit("ally-a").provocation.remainingActivations, 3);
  assert.equal(Object.keys(restored.getUnit("ally-a")).includes("provocation"), false);
  assert.deepEqual(Array.from({ length: 12 }, () => restored.rng()), Array.from({ length: 12 }, () => original.rng()));
  restored.units[0].composition.infantry -= 1;
  restored.supplies.ally.food -= 1;
  restored.exploredTiles.ally.add("10,6");
  assert.equal(original.units[0].composition.infantry, 7000);
  assert.equal(original.supplies.ally.food, saved.supplies.ally.food);
  assert.equal(saved.units[0].composition.infantry, 7000);
});

test("a partial field activation restores AP, per-activation attack budget and deterministic subsequent combat", () => {
  const original = fixture();
  original.getUnit("enemy-d").position = { x: 3, y: 3 };
  original.queue = ["ally-a", "enemy-d"];
  assert.equal(original.shoot("enemy-d").ok, true);
  const restored = BattleEngine.fromSnapshot(original.snapshot(), { rules: original.rules });
  assert.equal(restored.activeUnit.actionPoints, original.activeUnit.actionPoints);
  const nextA = original.hasForcedAction() ? original.runForcedTurn() : original.runAITurn(original.activeUnit.side);
  const nextB = restored.hasForcedAction() ? restored.runForcedTurn() : restored.runAITurn(restored.activeUnit.side);
  assert.deepEqual(nextA, nextB);
  assert.deepEqual(restored.snapshot(), original.snapshot());
});

test("month end pauses after day 30, never charges day 31 early, and resumes exactly once", () => {
  const battle = fixture();
  const daily = { ally: battle.dailyFoodNeed("ally"), enemy: battle.dailyFoodNeed("enemy") };
  completeMonthWaiting(battle);
  assert.equal(battle.status, "paused");
  assert.equal(battle.day, 30);
  assert.equal(battle.winner, null);
  assert.equal(battle.outcomeType, null);
  assert.deepEqual(battle.queue, []);
  assert.equal(battle.supplies.ally.food, 100000 - 30 * daily.ally);
  assert.equal(battle.supplies.enemy.food, 100000 - 30 * daily.enemy);
  assert.deepEqual(battle.rationDaysPaid, { ally: 30, enemy: 30 });
  const restored = BattleEngine.fromSnapshot(battle.snapshot(), { rules: battle.rules });
  assert.equal(restored.wait().ok, false);
  assert.equal(restored.resumeMonth().ok, true);
  assert.equal(restored.day, 31);
  assert.equal(restored.nextPauseDay, 60);
  assert.equal(restored.supplies.ally.food, 100000 - 31 * daily.ally);
  const food = restored.supplies.ally.food;
  assert.equal(restored.resumeMonth().ok, false);
  assert.equal(restored.supplies.ally.food, food);
  completeMonthWaiting(restored);
  assert.equal(restored.day, 60);
  assert.equal(restored.status, "paused");
  assert.equal(restored.supplies.ally.food, 100000 - 60 * daily.ally);
  assert.deepEqual(restored.rationDaysPaid, { ally: 60, enemy: 60 });
});

test("multi-activation statuses cross the month boundary without ticking during pause or restoration", () => {
  const battle = fixture();
  while (battle.day < 30) battle.wait();
  const unit = battle.activeUnit;
  applyBattleStatus(unit, "doubt", { sourceId: "enemy-d", remainingActivations: 3 });
  assert.equal(battle.runForcedTurn().action, "doubt-skip");
  while (battle.status === "active") battle.wait();
  assert.equal(unit.doubt.remainingActivations, 2);
  const restored = BattleEngine.fromSnapshot(battle.snapshot(), { rules: battle.rules });
  assert.equal(restored.getUnit(unit.id).doubt.remainingActivations, 2);
  restored.resumeMonth();
  assert.equal(restored.getUnit(unit.id).doubt.remainingActivations, 2);
  assert.equal(restored.runForcedTurn().action, "doubt-skip");
  assert.equal(restored.getUnit(unit.id).doubt.remainingActivations, 1);
});

test("a month-resumption grain shortage ends the battle and does not charge the unstarted defender day", () => {
  const battle = fixture();
  completeMonthWaiting(battle);
  battle.supplies.ally.food = battle.dailyFoodNeed("ally") - 1;
  const defendingFood = battle.supplies.enemy.food;
  const result = battle.resumeMonth();
  assert.equal(result.battleEnded, true);
  assert.equal(battle.status, "ended");
  assert.equal(battle.day, 31);
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.outcomeType, "supply");
  assert.equal(battle.supplies.ally.food, 0);
  assert.equal(battle.supplies.enemy.food, defendingFood);
  assert.deepEqual(battle.rationDaysPaid, { ally: 30, enemy: 30 });
  const restored = BattleEngine.fromSnapshot(battle.snapshot(), { rules: battle.rules });
  assert.deepEqual(restored.snapshot(), battle.snapshot());
});

test("paid-ration counters exclude unfed armies and legacy restoration does not fabricate feedings", () => {
  const battle = fixture();
  completeMonthWaiting(battle);
  battle.supplies.enemy.food = battle.dailyFoodNeed("enemy") - 1;
  battle.resumeMonth();
  assert.equal(battle.outcomeType, "supply");
  assert.equal(battle.winner, "ally");
  assert.deepEqual(battle.rationDaysPaid, { ally: 31, enemy: 30 });
  const saved = battle.snapshot();
  delete saved.rationDaysPaid;
  const restored = BattleEngine.fromSnapshot(saved, { rules: battle.rules });
  assert.deepEqual(restored.rationDaysPaid, { ally: 0, enemy: 0 });
  assert.deepEqual(restored.supplies, battle.supplies);
});

test("legacy noncampaign battles retain their explicit thirty-day terminal rule", () => {
  const battle = fixture({ campaignMode: false });
  completeMonthWaiting(battle);
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.outcomeType, "time");
  assert.equal(battle.resumeMonth().ok, false);
});

test("siege transition decisions and a half-submitted daily order restore without double execution", () => {
  const original = fixture();
  original.enterSiege();
  for (const decision of ["return", "intercept", "open"]) {
    const restored = BattleEngine.fromSnapshot(original.snapshot(), { rules: original.rules });
    assert.deepEqual(restored.snapshot(), original.snapshot());
    assert.deepEqual(restored.chooseTransition(decision), original.chooseTransition(decision));
    assert.deepEqual(restored.snapshot(), original.snapshot());
  }
  assert.equal(original.siegeOrder("ally", "tunnel").waiting, true);
  const restored = BattleEngine.fromSnapshot(original.snapshot(), { rules: original.rules });
  assert.equal(restored.siege.orders.ally, "tunnel");
  assert.deepEqual(restored.siegeOrder("enemy", "sortie"), original.siegeOrder("enemy", "sortie"));
  assert.deepEqual(restored.snapshot(), original.snapshot());
});

test("legacy layered siege saves migrate to one HP pool without resetting completed work", () => {
  const battle = readySiege();
  const saved = battle.snapshot();
  delete saved.siege.hp;
  delete saved.siege.maxHp;
  delete saved.siege.breachedMilestones;
  saved.siege.layers = [
    { id: "barbican", name: "瓮城", hp: 0, maxHp: 100 },
    { id: "outer", name: "外城", hp: 40, maxHp: 100 },
    { id: "inner", name: "内城", hp: 100, maxHp: 100 }
  ];
  saved.siege.activeLayerIndex = 1;
  const restored = BattleEngine.fromSnapshot(saved, { rules: battle.rules });
  assert.equal(restored.siege.hp, 140);
  assert.equal(restored.siege.maxHp, 300);
  assert.deepEqual(restored.siege.breachedMilestones, ["barbican"]);
  assert.equal(restored.siege.layers, undefined);
  assert.equal(restored.siege.activeLayerIndex, undefined);
  assert.deepEqual(restored.supplies, battle.supplies);
});

test("headless simulation runs both sides deterministically and never resumes a paused month implicitly", () => {
  const first = fixture();
  applyBattleStatus(first.units[0], "doubt", { remainingActivations: 2 });
  const second = BattleEngine.fromSnapshot(first.snapshot(), { rules: first.rules });
  const result = simulateBattleMonth(first);
  assert.equal(result.ok, true, result.message);
  assert.ok(["paused", "ended"].includes(first.status));
  assert.deepEqual(simulateBattleMonth(second), result);
  assert.deepEqual(second.snapshot(), first.snapshot());
  const siege = readySiege({ stableSiege: true });
  assert.equal(simulateBattleMonth(siege).paused, true);
  assert.equal(siege.day, 30);
  const saved = siege.snapshot();
  assert.equal(simulateBattleMonth(siege).steps, 0);
  assert.deepEqual(siege.snapshot(), saved);
  siege.resumeMonth();
  assert.equal(simulateBattleMonth(siege).paused, true);
  assert.equal(siege.day, 60);
  assert.equal(simulateBattleMonth(fixture(), { maxSteps: 0 }).ok, false);
});

test("headless siege can complete every field-transition decision and honors forced actions for either player side", () => {
  for (const playerSide of ["ally", "enemy"]) {
    const battle = fixture({ playerSide });
    battle.enterSiege();
    const result = simulateBattleMonth(battle);
    assert.equal(result.ok, true, result.message);
    assert.ok(["paused", "ended"].includes(battle.status));
    assert.equal(battle.pendingDecision, null);
    assert.ok(battle.siege.history.length > 0);
  }
});

test("invalid core snapshot fields reject before mutation or food consumption", () => {
  const battle = fixture();
  const saved = battle.snapshot();
  const corruptions = [
    (copy) => { copy.units[0].troops = -1; },
    (copy) => { copy.supplies.ally.food = -1; },
    (copy) => { copy.queue.push(copy.queue[0]); },
    (copy) => { copy.map.terrain.pop(); },
    (copy) => { copy.attackerCamp = { x: -1, y: 2 }; },
    (copy) => { copy.units[0].position.x = 999; },
    (copy) => { copy.playerSide = "third"; },
    (copy) => { copy.nextPauseDay = 0; }
  ];
  for (const corrupt of corruptions) {
    const copy = structuredClone(saved);
    corrupt(copy);
    const before = structuredClone(copy);
    assert.throws(() => BattleEngine.fromSnapshot(copy, { rules: battle.rules }), /存档/);
    assert.deepEqual(copy, before);
  }
  assert.deepEqual(battle.snapshot(), saved);
});

test("the attacker camp is unique, public terrain and never reveals a hidden occupant", () => {
  const battle = fixture({ playerSide: "enemy" });
  assert.notDeepEqual(battle.attackerCamp, battle.stronghold);
  const hidden = battle.getUnit("ally-a");
  hidden.position = { ...battle.attackerCamp };
  const markup = fieldTilesMarkup(battle);
  assert.ok(markup.includes("攻方大本营"));
  assert.equal(markup.includes(`data-unit-id="${hidden.id}"`), false);
  const oldMap = fixture({ map: { attackerCamp: undefined } });
  assert.ok(oldMap.attackerCamp);
  assert.notDeepEqual(oldMap.attackerCamp, oldMap.stronghold);
  assert.equal(oldMap.unitAt(oldMap.attackerCamp.x, oldMap.attackerCamp.y), undefined);
});

test("a defending unit captures the attacker camp instantly, while its own side may safely occupy it", () => {
  const battle = fixture();
  const defender = battle.getUnit("enemy-d");
  defender.position = { x: 1, y: 3 };
  battle.getUnit("ally-a").position = { x: 8, y: 6 };
  battle.queue = [defender.id];
  const result = battle.moveStep(0, 3);
  assert.equal(result.battleEnded, true);
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.outcomeType, "camp");
  const restored = BattleEngine.fromSnapshot(battle.snapshot(), { rules: battle.rules });
  assert.deepEqual(restored.attackerCamp, { x: 0, y: 3 }, "restoring an occupied camp never relocates it");
  assert.deepEqual(restored.snapshot(), battle.snapshot());
  const own = fixture();
  own.getUnit("ally-a").position = { x: 1, y: 3 };
  own.queue = ["ally-a", "enemy-d"];
  assert.equal(own.moveStep(0, 3).ok, true);
  assert.equal(own.status, "active");
});

test("an ambush is resolved before deciding whether the camp-entering unit survived to capture it", () => {
  for (const tinyDefender of [false, true]) {
    const battle = fixture();
    battle.attackerCamp = { x: 4, y: 3 };
    const defender = battle.getUnit("enemy-d");
    const ambusher = battle.getUnit("ally-a");
    ambusher.position = { x: 3, y: 3 };
    battle.map.terrain[3 * battle.map.width + 3] = "forest";
    ambusher.ambushing = true;
    defender.position = { x: 5, y: 3 };
    if (tinyDefender) {
      defender.troops = 1;
      defender.composition = { infantry: 1 };
      battle.refreshCombatStats(defender);
    }
    battle.queue = [defender.id, ambusher.id];
    const result = battle.moveStep(4, 3);
    assert.equal(result.ok, true);
    assert.equal(result.ambushes.length, 1);
    assert.equal(battle.winner, tinyDefender ? "ally" : "enemy");
    assert.equal(battle.outcomeType, tinyDefender ? "rout" : "camp");
  }
});
