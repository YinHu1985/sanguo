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
  targetCity.officerIds = ["xiahou-dun"];
  targetCity.troops = 1800;
  targetCity.food = 100000;
  targetCity.gold = 10000;
  Object.assign(targetCity, options.targetCity);
  return new BattleEngine({
    sourceCity,
    targetCity,
    divisions: [{ officerId: "guan-yu", troops: 3000, unitType: "cavalry" }],
    officers: structuredClone(scenario.officers),
    rules,
    map,
    supplies: options.supplies ?? { food: 100000, gold: 10000 },
    rng: options.rng ?? (() => 0)
  });
}

function finishDay(battle) {
  const day = battle.day;
  while (battle.status === "active" && battle.day === day) battle.wait();
}

test("staggered grid exposes six neighboring tiles away from edges", () => {
  const battle = makeBattle();
  assert.equal(battle.neighbors({ x: 4, y: 3 }).length, 6);
  assert.equal(battle.distance({ x: 0, y: 3 }, { x: 2, y: 3 }), 2);
});

test("reachable tiles are limited by terrain-weighted action points", () => {
  const battle = makeBattle();
  const unit = battle.livingUnits("ally")[0];
  const reachable = battle.reachableTiles(unit);
  assert.ok(reachable.some((tile) => tile.x === 2 && tile.y === 2));
  assert.ok(!reachable.some((tile) => tile.x === 8 && tile.y === 2));
});

test("movement consumes terrain cost one tile at a time without ending activation", () => {
  const battle = makeBattle();
  const unit = battle.activeUnit;
  const destination = battle.neighbors(unit.position)
    .find((tile) => !battle.unitAt(tile.x, tile.y) && Number.isFinite(battle.movementCostAt(tile.x, tile.y)));
  const startingPoints = unit.actionPoints;
  const cost = battle.movementCostAt(destination.x, destination.y);

  const result = battle.moveStep(destination.x, destination.y);

  assert.equal(result.ok, true);
  assert.equal(result.actionContinues, true);
  assert.equal(battle.activeUnit.id, unit.id);
  assert.deepEqual(unit.position, destination);
  assert.equal(unit.actionPoints, startingPoints - cost);
});

test("auto path is returned as adjacent single-cell steps", () => {
  const battle = makeBattle();
  const unit = battle.activeUnit;
  const path = battle.findPath({ x: 3, y: 2 }, unit);
  let cursor = { ...unit.position };

  assert.ok(path.length > 1);
  for (const step of path) {
    assert.ok(battle.neighbors(cursor).some((neighbor) => neighbor.x === step.x && neighbor.y === step.y));
    cursor = step;
  }
  assert.deepEqual({ x: cursor.x, y: cursor.y }, { x: 3, y: 2 });
});

test("a unit can move and then attack while action points remain", () => {
  const battle = makeBattle();
  const ally = battle.activeUnit;
  const enemy = battle.livingUnits("enemy")[0];
  ally.position = { x: 6, y: 2 };
  enemy.position = { x: 8, y: 2 };
  const startingEnemyTroops = enemy.troops;

  const moveResult = battle.moveStep(7, 2);
  const attackResult = battle.attack(enemy.id);

  assert.equal(moveResult.ok, true);
  assert.equal(attackResult.ok, true);
  assert.ok(enemy.troops < startingEnemyTroops);
  assert.equal(battle.activeUnit.id, ally.id);
  assert.ok(ally.actionPoints > 0);
});

test("battle units carry city training and morale into combat", () => {
  const battle = makeBattle();
  const unit = battle.livingUnits("ally")[0];
  const city = scenario.cities.find((item) => item.id === "xiaopei");
  assert.equal(unit.training, city.training);
  assert.equal(unit.morale, city.morale);
  assert.equal(unit.unitTypeName, "骑兵");
});

test("defender deployment respects command caps and retains excess soldiers as a reserve", () => {
  const sourceCity = structuredClone(scenario.cities.find((city) => city.id === "xiaopei"));
  const targetCity = structuredClone(scenario.cities.find((city) => city.id === "puyang"));
  targetCity.officerIds = ["xiahou-dun"];
  targetCity.troops = 30000;
  const battle = new BattleEngine({ sourceCity, targetCity, divisions: [{ officerId: "guan-yu", troops: 3000 }],
    officers: structuredClone(scenario.officers), rules, map, supplies: { food: 100000, gold: 10000 } });
  const units = battle.livingUnits("enemy");
  assert.ok(units.every((unit) => unit.troops <= rules.ranks[unit.rank]));
  assert.equal(units.reduce((sum, unit) => sum + unit.troops, 0) + battle.defenderReserveTroops, 30000);
  assert.ok(battle.defenderReserveTroops > 0);
});

test("an uncommanded garrison defends without creating a placeholder person or rank", () => {
  const sourceCity = structuredClone(scenario.cities.find((city) => city.id === "xiaopei"));
  const targetCity = structuredClone(scenario.cities.find((city) => city.id === "puyang"));
  targetCity.officerIds = [];
  targetCity.troops = 6000;
  const officers = structuredClone(scenario.officers);
  const originalOfficers = structuredClone(officers);
  const battle = new BattleEngine({ sourceCity, targetCity, divisions: [{ officerId: "guan-yu", troops: 3000 }],
    officers, rules, map, supplies: { food: 100000, gold: 10000 } });
  assert.equal(battle.livingUnits("enemy").length, 1);
  const garrison = battle.livingUnits("enemy")[0];
  assert.equal(garrison.troops, 2000);
  assert.equal(battle.defenderReserveTroops, 4000);
  assert.equal(garrison.name, `${targetCity.name}守军`);
  assert.equal(garrison.officerId, null);
  assert.equal(garrison.rank, null);
  assert.equal(garrison.training, targetCity.training);
  assert.equal(garrison.morale, targetCity.morale);
  assert.deepEqual(officers, originalOfficers);
  assert.deepEqual(targetCity.officerIds, []);

  garrison.troops = 0;
  battle.wait();
  assert.equal(battle.status, "active");
  assert.equal(garrison.troops, 2000);
  assert.equal(battle.defenderReserveTroops, 2000);
  assert.equal(garrison.officerId, null);
});

test("an unstaffed city cannot create an attacking unit with a substitute commander", () => {
  const sourceCity = structuredClone(scenario.cities.find((city) => city.id === "xiaopei"));
  const targetCity = structuredClone(scenario.cities.find((city) => city.id === "puyang"));
  sourceCity.officerIds = [];
  assert.throws(() => new BattleEngine({ sourceCity, targetCity,
    divisions: [{ officerId: null, troops: 3000 }], officers: structuredClone(scenario.officers), rules, map,
    supplies: { food: 100000, gold: 10000 } }), /武将/);
});

test("routed field troops do not surrender a city while substantial reserves remain", () => {
  const sourceCity = structuredClone(scenario.cities.find((city) => city.id === "xiaopei"));
  const targetCity = structuredClone(scenario.cities.find((city) => city.id === "puyang"));
  targetCity.officerIds = ["xiahou-dun"];
  targetCity.troops = 30000;
  const battle = new BattleEngine({ sourceCity, targetCity, divisions: [{ officerId: "guan-yu", troops: 3000 }],
    officers: structuredClone(scenario.officers), rules, map, supplies: { food: 100000, gold: 10000 } });
  const originalDeployed = battle.livingUnits("enemy").reduce((sum, unit) => sum + unit.troops, 0);
  battle.livingUnits("enemy").forEach((unit) => {
    unit.troops = 0;
    unit.position = { ...battle.livingUnits("ally")[0].position };
  });
  battle.wait();
  assert.equal(battle.status, "active");
  assert.ok(battle.livingUnits("enemy").length > 0);
  assert.ok(battle.livingUnits("enemy").every((unit) => unit.troops <= unit.commandLimit));
  assert.equal(new Set(battle.livingUnits().map((unit) => `${unit.position.x},${unit.position.y}`)).size, battle.livingUnits().length);
  assert.equal(battle.livingUnits("enemy").reduce((sum, unit) => sum + unit.troops, 0) + battle.defenderReserveTroops, 30000 - originalDeployed);
  let waves = 1;
  while (battle.status === "active" && waves < 10) {
    battle.livingUnits("enemy").forEach((unit) => { unit.troops = 0; });
    battle.wait();
    waves += 1;
  }
  assert.equal(battle.status, "ended", "reserve waves must be finite");
  assert.equal(battle.winner, "ally");
  assert.equal(battle.defenderReserveTroops, 0);
});

test("the first day's food is charged immediately without mutating either strategic city", () => {
  const sourceCity = structuredClone(scenario.cities.find((city) => city.id === "xiaopei"));
  const targetCity = structuredClone(scenario.cities.find((city) => city.id === "puyang"));
  targetCity.officerIds = ["xiahou-dun"];
  targetCity.troops = 1800;
  targetCity.food = 1000;
  targetCity.gold = 200;
  const sourceBefore = structuredClone(sourceCity);
  const targetBefore = structuredClone(targetCity);
  const carried = { food: 360, gold: 150 };
  const battle = new BattleEngine({ sourceCity, targetCity, divisions: [{ officerId: "guan-yu", troops: 3000 }],
    officers: structuredClone(scenario.officers), rules, map, supplies: carried });

  assert.equal(battle.dailyFoodNeed("ally"), 12);
  assert.equal(battle.dailyFoodNeed("enemy"), 8);
  assert.deepEqual(battle.supplies, { ally: { food: 348, gold: 150 }, enemy: { food: 992, gold: 200 } });
  assert.equal(battle.estimateSupplyDays("ally"), 29);
  assert.deepEqual(carried, { food: 360, gold: 150 });
  assert.deepEqual(sourceCity, sourceBefore);
  assert.deepEqual(targetCity, targetBefore);
});

test("zero initial food forces an immediate defeat, with attacking shortage taking precedence", () => {
  const attackerStarves = makeBattle({ supplies: { food: 0, gold: 100 } });
  assert.equal(attackerStarves.day, 1);
  assert.equal(attackerStarves.status, "ended");
  assert.equal(attackerStarves.winner, "enemy");
  assert.equal(attackerStarves.outcomeType, "supply");
  assert.match(attackerStarves.outcomeReason, /攻方军粮/);
  assert.equal(attackerStarves.supplies.enemy.food, 100000, "a first-day retreat does not charge defending rations");

  const defenderStarves = makeBattle({ targetCity: { food: 0 } });
  assert.equal(defenderStarves.status, "ended");
  assert.equal(defenderStarves.winner, "ally");
  assert.match(defenderStarves.outcomeReason, /守方军粮/);
  assert.equal(defenderStarves.supplies.ally.food, 99988, "the attacker pays before the defending shortage is checked");

  const bothStarve = makeBattle({ supplies: { food: 0, gold: 0 }, targetCity: { food: 0 } });
  assert.equal(bothStarve.winner, "enemy");
  assert.equal(bothStarve.supplies.ally.food, 0);
  assert.equal(bothStarve.supplies.enemy.food, 0);
});

test("an attacker's partial-day food shortage exhausts only its own cargo before the defender's day begins", () => {
  const battle = makeBattle({ supplies: { food: 6, gold: 100 }, targetCity: { food: 3 } });
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.supplies.ally.food, 0);
  assert.equal(battle.supplies.enemy.food, 3, "even simultaneous shortages leave defending stores untouched if the attacker retreats first");
  assert.equal(battle.supplies.ally.gold, 100);

  const defenderShort = makeBattle({ supplies: { food: 12, gold: 0 }, targetCity: { food: 3 } });
  assert.equal(defenderShort.winner, "ally");
  assert.equal(defenderShort.supplies.ally.food, 0);
  assert.equal(defenderShort.supplies.enemy.food, 0, "a defending shortage consumes the defender's remaining partial-day ration");
});

test("an empty city can be occupied without paying a battle day's rations", () => {
  const battle = makeBattle({ supplies: { food: 0, gold: 0 }, targetCity: { troops: 0, officerIds: [], food: 0 } });
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "ally");
  assert.equal(battle.outcomeType, "rout");
  assert.equal(battle.supplies.ally.food, 0);
  assert.equal(battle.supplies.enemy.food, 0);
});

test("food buys complete fighting days and insufficient next-day rations never go negative", () => {
  const battle = makeBattle({ supplies: { food: 29, gold: 0 } });
  assert.equal(battle.supplies.ally.food, 17);
  finishDay(battle);
  assert.equal(battle.day, 2);
  assert.equal(battle.status, "active");
  assert.equal(battle.supplies.ally.food, 5);
  finishDay(battle);
  assert.equal(battle.day, 3);
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.supplies.ally.food, 0);
  assert.equal(battle.supplies.enemy.food, 99984, "defenders pay only for the two days before the attacker's retreat");
});

test("casualties reduce the following day's consumption and update remaining-day estimates", () => {
  const battle = makeBattle({ supplies: { food: 36, gold: 0 } });
  assert.equal(battle.estimateSupplyDays("ally"), 2);
  battle.livingUnits("ally")[0].troops = 1000;
  assert.equal(battle.dailyFoodNeed("ally"), 4);
  assert.equal(battle.estimateSupplyDays("ally"), 6);
  finishDay(battle);
  assert.equal(battle.supplies.ally.food, 20);
  assert.equal(battle.status, "active");
});

test("defender reserves eat along with deployed troops", () => {
  const battle = makeBattle({ targetCity: { troops: 30000, food: 1000 } });
  assert.ok(battle.defenderReserveTroops > 0);
  assert.equal(battle.dailyFoodNeed("enemy"), 120);
  assert.equal(battle.supplies.enemy.food, 880);
  battle.livingUnits("enemy")[0].troops -= 1000;
  assert.equal(battle.dailyFoodNeed("enemy"), 116);
  finishDay(battle);
  assert.equal(battle.supplies.enemy.food, 764);
});

test("changing supply stock during battle changes survival instead of using a precomputed deadline", () => {
  const reinforced = makeBattle({ supplies: { food: 12, gold: 0 } });
  assert.equal(reinforced.estimateSupplyDays("ally"), 0);
  reinforced.supplies.ally.food += 24;
  finishDay(reinforced);
  assert.equal(reinforced.status, "active");
  assert.equal(reinforced.day, 2);
  assert.equal(reinforced.supplies.ally.food, 12);

  const raided = makeBattle();
  raided.supplies.ally.food = 1;
  finishDay(raided);
  assert.equal(raided.status, "ended");
  assert.equal(raided.day, 2);
  assert.equal(raided.winner, "enemy");
});

test("fire spends the acting side's money as well as action points", () => {
  const battle = makeBattle({ supplies: { food: 1000, gold: 100 }, targetCity: { gold: 100 } });
  const ally = battle.livingUnits("ally")[0];
  const enemy = battle.livingUnits("enemy")[0];
  ally.position = { x: 6, y: 2 };
  enemy.position = { x: 7, y: 2 };
  battle.queue = [ally.id, enemy.id];
  const startingAP = ally.actionPoints;
  const attack = battle.fire(enemy.id);
  assert.equal(attack.ok, true);
  assert.equal(attack.goldCost, battle.strategyGoldCost("fire"));
  assert.equal(ally.actionPoints, startingAP - battle.actionCost("fire", ally));
  assert.equal(battle.supplies.ally.gold, 50);
  assert.equal(battle.supplies.enemy.gold, 100);

  battle.queue = [enemy.id, ally.id];
  const defense = battle.fire(ally.id);
  assert.equal(defense.ok, true);
  assert.equal(battle.supplies.enemy.gold, 50);
  assert.equal(battle.supplies.ally.gold, 50);
});

test("a countered strategy still costs money and AP, but illegal fire actions are transactional", () => {
  const battle = makeBattle({ rng: () => 1, supplies: { food: 1000, gold: 100 } });
  const ally = battle.livingUnits("ally")[0];
  const enemy = battle.livingUnits("enemy")[0];
  battle.queue = [ally.id, enemy.id];
  const originalAP = ally.actionPoints;
  const originalTroops = enemy.troops;
  assert.equal(battle.fire("missing-unit").ok, false);
  assert.equal(battle.fire(enemy.id).ok, false, "distant units are not legal targets");
  assert.equal(battle.fire(ally.id).ok, false, "friendly fire is not a legal order");
  assert.equal(ally.actionPoints, originalAP);
  assert.equal(battle.supplies.ally.gold, 100);

  ally.position = { x: 6, y: 2 };
  enemy.position = { x: 7, y: 2 };
  const insufficientAP = battle.actionCost("fire", ally) - 1;
  ally.actionPoints = insufficientAP;
  assert.equal(battle.fire(enemy.id).ok, false);
  assert.equal(ally.actionPoints, insufficientAP);
  assert.equal(battle.supplies.ally.gold, 100);

  ally.actionPoints = originalAP;
  battle.supplies.ally.gold = 49;
  assert.equal(battle.fire(enemy.id).ok, false);
  assert.equal(ally.actionPoints, originalAP);
  assert.equal(battle.supplies.ally.gold, 49);

  battle.supplies.ally.gold = 100;
  const result = battle.fire(enemy.id);
  assert.equal(result.ok, true);
  assert.equal(result.damage, 0);
  assert.equal(enemy.troops, originalTroops);
  assert.equal(battle.supplies.ally.gold, 50);
  assert.equal(ally.actionPoints, originalAP - battle.actionCost("fire", ally));
});

test("an AI without strategy money takes another action instead of repeating an unaffordable fire order", () => {
  const battle = makeBattle({ targetCity: { gold: 0 } });
  const ally = battle.livingUnits("ally")[0];
  const enemy = battle.livingUnits("enemy")[0];
  ally.position = { x: 6, y: 2 };
  enemy.position = { x: 8, y: 2 };
  enemy.intelligence = 100;
  battle.queue = [enemy.id, ally.id];
  assert.deepEqual(battle.fireTargets(enemy), []);
  const action = battle.runEnemyTurn();
  assert.equal(action.ok, true);
  assert.notEqual(action.action, "fire");
  assert.equal(battle.supplies.enemy.gold, 0);
});

test("thirty funded days end at the day limit without a thirty-first food deduction", () => {
  const battle = makeBattle({ supplies: { food: 360, gold: 0 }, targetCity: { food: 240 } });
  for (let day = 1; day <= 30; day += 1) {
    assert.equal(battle.day, day);
    assert.equal(battle.status, "active");
    finishDay(battle);
  }
  assert.equal(battle.day, 30);
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.outcomeType, "time");
  assert.equal(battle.supplies.ally.food, 0);
  assert.equal(battle.supplies.enemy.food, 0);
  assert.equal(battle.log.some((entry) => entry.day === 31), false);
});

test("battles that ended during construction reject all subsequent actions", () => {
  const battle = makeBattle({ supplies: { food: 0, gold: 100 } });
  const enemy = battle.livingUnits("enemy")[0];
  const before = structuredClone({ units: battle.units, supplies: battle.supplies, log: battle.log });
  assert.equal(battle.activeUnit, undefined);
  assert.equal(battle.moveStep(1, 2).ok, false);
  assert.equal(battle.attack(enemy.id).ok, false);
  assert.equal(battle.fire(enemy.id).ok, false);
  assert.equal(battle.wait().ok, false);
  assert.equal(battle.runEnemyTurn().ok, false);
  assert.deepEqual(battle.reachableTiles(battle.units[0]), []);
  assert.deepEqual(battle.findPath({ x: 2, y: 2 }, battle.units[0]), []);
  assert.deepEqual({ units: battle.units, supplies: battle.supplies, log: battle.log }, before);
});
