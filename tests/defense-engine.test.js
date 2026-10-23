import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = JSON.parse(await readFile(new URL("./fixtures/battle-map-small.json", import.meta.url), "utf8"));

function makeBattle(options = {}) {
  const sourceCity = structuredClone(scenario.cities.find((city) => city.id === "xiaopei"));
  const targetCity = structuredClone(scenario.cities.find((city) => city.id === "puyang"));
  Object.assign(targetCity, { officerIds: ["xiahou-dun"], troops: 5000, food: 100000, gold: 1000 }, options.targetCity);
  return new BattleEngine({
    sourceCity,
    targetCity,
    divisions: [{ officerId: "guan-yu", troops: 5000, unitType: "cavalry" }],
    officers: structuredClone(scenario.officers), rules, map,
    supplies: { food: 100000, gold: 1000, ...options.supplies },
    playerSide: options.playerSide ?? "enemy", rng: options.rng ?? (() => 0)
  });
}

function activate(battle, side) {
  const unit = battle.livingUnits(side)[0];
  battle.queue = [unit.id, ...battle.queue.filter((id) => id !== unit.id)];
  return unit;
}

function finishDay(battle) {
  const day = battle.day;
  while (battle.status === "active" && battle.day === day) battle.wait();
}

test("defending player controls the defender without swapping battlefield roles or starts", () => {
  const battle = makeBattle();
  assert.equal(battle.playerSide, "enemy");
  assert.equal(battle.aiSide, "ally");
  assert.equal(battle.sourceCityId, "xiaopei");
  assert.equal(battle.targetCityId, "puyang");
  assert.deepEqual(battle.livingUnits("ally")[0].position, map.attackerStarts[0]);
  assert.deepEqual(battle.livingUnits("enemy")[0].position, map.defenderStarts[0]);
  assert.equal(battle.supplies.enemy.gold, 1000);
});

test("default attacking player behavior remains unchanged", () => {
  const battle = makeBattle({ playerSide: "ally" });
  assert.equal(battle.playerSide, "ally");
  assert.equal(battle.aiSide, "enemy");
  activate(battle, "ally");
  assert.equal(battle.runEnemyTurn().ok, false);
  activate(battle, "enemy");
  assert.equal(battle.runEnemyTurn().ok, true);
});

test("manual defender can move then attack the invading army within one activation", () => {
  const battle = makeBattle();
  const defender = activate(battle, "enemy");
  const invader = battle.livingUnits("ally")[0];
  defender.position = { x: 8, y: 2 };
  invader.position = { x: 6, y: 2 };
  const startingTroops = invader.troops;
  const startingAP = defender.actionPoints;
  const cost = battle.movementCostAt(7, 2);
  assert.equal(battle.moveStep(7, 2).ok, true);
  assert.equal(battle.attack(invader.id).ok, true);
  assert.ok(invader.troops < startingTroops);
  assert.equal(defender.actionPoints, startingAP - cost - battle.actionCost("attack", defender));
  assert.equal(battle.activeUnit.id, defender.id);
});

test("manual defender can fire using city money and can move after attacking", () => {
  const battle = makeBattle();
  const defender = activate(battle, "enemy");
  const invader = battle.livingUnits("ally")[0];
  defender.position = { x: 8, y: 2 };
  // All active stratagems now require adjacency; this clear tile isolates costs.
  invader.position = { x: 8, y: 1 };
  const startingTroops = invader.troops;
  assert.ok(battle.fireTargets().includes(invader));
  const result = battle.fire(invader.id);
  assert.equal(result.ok, true);
  assert.ok(invader.troops < startingTroops);
  assert.equal(battle.supplies.enemy.gold, 1000 - battle.strategyGoldCost("fire"));
  assert.equal(battle.supplies.ally.gold, 1000, "invading purse is not charged for player fire");
  assert.equal(battle.moveStep(7, 2).ok, true);
});

test("AI cannot take over a player-controlled defending activation", () => {
  const battle = makeBattle();
  const defender = activate(battle, "enemy");
  const before = structuredClone(defender);
  assert.equal(battle.runEnemyTurn().ok, false);
  assert.deepEqual(defender, before);
});

test("AI drives the invading side toward player defenders one grid step at a time", () => {
  const battle = makeBattle();
  const invader = activate(battle, "ally");
  const defender = battle.livingUnits("enemy")[0];
  const from = { ...invader.position };
  const oldDistance = battle.distance(invader.position, defender.position);
  const result = battle.runEnemyTurn();
  assert.equal(result.ok, true);
  assert.equal(result.action, "move");
  assert.equal(result.actorId, invader.id);
  assert.equal(battle.distance(from, invader.position), 1);
  assert.ok(battle.distance(invader.position, defender.position) < oldDistance);
});

test("AI invading troops attack the player instead of targeting their own side", () => {
  // Decline the optional stratagem branch to exercise the normal melee choice.
  const battle = makeBattle({ rng: () => 0.99 });
  const invader = activate(battle, "ally");
  const defender = battle.livingUnits("enemy")[0];
  invader.position = { x: 7, y: 2 };
  defender.position = { x: 8, y: 2 };
  const oldTroops = defender.troops;
  const result = battle.runEnemyTurn();
  assert.equal(result.ok, true);
  assert.equal(result.action, "attack");
  assert.equal(result.actorId, invader.id);
  assert.equal(result.targetId, defender.id);
  assert.ok(defender.troops < oldTroops);
});

test("AI invading officers can use fire with their own carried money", () => {
  const battle = makeBattle();
  const invader = activate(battle, "ally");
  const defender = battle.livingUnits("enemy")[0];
  invader.position = { x: 8, y: 1 };
  defender.position = { x: 8, y: 2 };
  const result = battle.runEnemyTurn();
  assert.equal(result.ok, true);
  assert.equal(result.action, "fire");
  assert.equal(result.targetId, defender.id);
  assert.equal(battle.supplies.ally.gold, 1000 - battle.strategyGoldCost("fire"));
  assert.equal(battle.supplies.enemy.gold, 1000);
});

test("thirty-day limit is a defending player victory, not a player-relative loss", () => {
  const battle = makeBattle();
  while (battle.status === "active") finishDay(battle);
  assert.equal(battle.day, 30);
  assert.equal(battle.winner, battle.playerSide);
  assert.equal(battle.outcomeType, "time");
});

test("invading food shortage gives defending player victory without consuming city food", () => {
  const battle = makeBattle({ supplies: { food: 0 } });
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, battle.playerSide);
  assert.equal(battle.outcomeType, "supply");
  assert.equal(battle.supplies.enemy.food, 100000);
});

test("city food shortage defeats defending player despite invading army having supplies", () => {
  const battle = makeBattle({ targetCity: { food: 0 } });
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, battle.aiSide);
  assert.equal(battle.outcomeType, "supply");
  assert.equal(battle.supplies.ally.food, 99980);
});

test("player defender reserves reinforce losses and all remaining defenders consume city food", () => {
  const battle = makeBattle({ targetCity: { troops: 30000, food: 1000 } });
  const defender = battle.livingUnits("enemy")[0];
  const originalReserve = battle.defenderReserveTroops;
  assert.ok(originalReserve > 0);
  assert.equal(battle.dailyFoodNeed("enemy"), 120);
  assert.equal(battle.supplies.enemy.food, 880);
  const deployedBefore = defender.troops;
  defender.troops -= 1000;
  assert.equal(battle.dailyFoodNeed("enemy"), 116);
  finishDay(battle);
  assert.equal(defender.troops, deployedBefore);
  assert.equal(battle.defenderReserveTroops, originalReserve - 1000);
  assert.equal(battle.supplies.enemy.food, 764);
  assert.equal(battle.status, "active");
});

test("a player may defend an unstaffed garrison without inventing a commander", () => {
  const battle = makeBattle({ targetCity: { officerIds: [], troops: 6000 } });
  const garrison = activate(battle, "enemy");
  assert.equal(garrison.officerId, null);
  assert.equal(garrison.rank, null);
  assert.equal(battle.defenderReserveTroops, 4000);
  assert.equal(battle.runEnemyTurn().ok, false);
  assert.equal(battle.wait().ok, true);
});
