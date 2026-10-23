import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { aggregateTroopStats, applyFormationLosses, compositionEquipment } from "../src/js/game/troops.js";
import { evaluateSiegeDay, interceptionLosses } from "../src/js/game/siege.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const originalRules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const count = (composition) => Object.values(composition).reduce((sum, number) => sum + number, 0);

function makeBattle(options = {}) {
  const rules = structuredClone(originalRules);
  rules.battle.ranged = { ...rules.battle.ranged, ...options.ranged };
  const sourceCity = { ...structuredClone(scenario.cities.find((city) => city.id === "xiaopei")),
    horses: 7000, crossbows: 7000, armor: 7000 };
  const targetCity = { ...structuredClone(scenario.cities.find((city) => city.id === "puyang")),
    troops: 6000, food: 100000, gold: 1000, horses: 7000, crossbows: 7000, armor: 7000, ...options.targetCity };
  const composition = options.composition ?? { infantry: 2500, archer: 2500 };
  const defending = options.defending ?? { infantry: 6000 };
  const battle = new BattleEngine({ sourceCity, targetCity, rules,
    officers: structuredClone(scenario.officers),
    divisions: [{ officerIds: ["guan-yu"], troops: count(composition), composition }],
    ...(options.automaticDefenders ? {} : { defenderDivisions: [{ officerIds: ["xiahou-dun"], troops: count(defending), composition: defending }] }),
    map: { width: 9, height: 7, stronghold: { x: 8, y: 3 }, terrain: Array(63).fill("plain"),
      attackerStarts: [{ x: 0, y: 3 }], defenderStarts: [{ x: 8, y: 3 }] },
    supplies: { food: 100000, gold: 1000 }, mode: options.mode ?? "field", canDefenderRetreat: true,
    playerSide: options.playerSide ?? "ally", rng: options.rng ?? (() => 0.5) });
  return battle;
}

function positionForShot(battle, distance = 2) {
  const actor = battle.livingUnits("ally")[0], target = battle.livingUnits("enemy")[0];
  actor.position = { x: 2, y: 3 };
  target.position = { x: 2 + distance, y: 3 };
  battle.queue = [actor.id, target.id];
  actor.actionPoints = actor.maxActionPoints;
  return { actor, target };
}

function snapshot(battle) {
  return structuredClone({ units: battle.units, supplies: battle.supplies, queue: battle.queue, log: battle.log });
}

function assertConserved(battle) {
  for (const unit of [...battle.units, ...battle.escapedDefenderUnits]) {
    assert.equal(count(unit.composition), unit.troops);
    assert.ok(Object.values(unit.composition).every((number) => Number.isSafeInteger(number) && number >= 0));
  }
}

test("mixed formations retain a single troop pool and derive mobility from troop-weighted stats", () => {
  const composition = { infantry: 2000, archer: 1000, heavyCavalry: 2000 };
  const battle = makeBattle({ composition });
  const actor = battle.livingUnits("ally")[0];
  assert.deepEqual(actor.composition, composition);
  assert.equal(actor.troops, 5000);
  assert.equal(actor.unitTypeName, "混编部队");
  assert.equal(actor.attackRange, 1);
  assert.equal(actor.rangedRange, 2);
  assert.equal(actor.rangedTroops, 1000);
  const stats = aggregateTroopStats(composition, battle.rules);
  const expected = Math.ceil((stats.actionPoints + (actor.leadership >= 85 ? 1 : 0) + (actor.training >= 75 ? 1 : 0)) * 0.5);
  assert.equal(actor.maxActionPoints, expected);
  assertConserved(battle);
});

test("battle construction records equipment commitments without consuming the strategic cities", () => {
  const composition = { infantry: 1000, heavyCavalry: 2000, guard: 2000 };
  const defending = { crossbowman: 2000, cavalry: 4000 };
  const battle = makeBattle({ composition, defending });
  assert.deepEqual(battle.attackerEquipmentCommitted, { horses: 2000, crossbows: 2000, armor: 4000 });
  assert.deepEqual(battle.defenderEquipmentCommitted, { horses: 4000, crossbows: 2000, armor: 0 });
  assert.deepEqual(composition, { infantry: 1000, heavyCavalry: 2000, guard: 2000 }, "caller composition stays detached");
});

test("archers use explicit shooting at range two; ordinary attack remains adjacent melee", () => {
  const battle = makeBattle({ composition: { archer: 5000 } });
  const { actor, target } = positionForShot(battle);
  assert.deepEqual(battle.attackTargets(actor), []);
  assert.equal(battle.attack(target.id).ok, false);
  assert.equal(battle.shootTargets(actor)[0], target);
  const result = battle.shoot(target.id);
  assert.equal(result.ok, true);
  assert.equal(result.action, "shoot");
  assert.equal(result.actionContinues, true);
  assert.equal(result.cost, battle.actionCost("shoot", actor));
  assert.equal(actor.actionPoints, actor.maxActionPoints - result.cost);
  assert.equal(result.goldCost, 0);
  assert.ok(result.damage > 0);
  assert.equal(result.fireTriggered, false);
  assertConserved(battle);
});

test("shooting at an adjacent enemy has no melee counterattack and can be followed by movement", () => {
  const battle = makeBattle({ rng: () => 0 });
  const { actor, target } = positionForShot(battle, 1);
  const before = actor.troops;
  const result = battle.shoot(target.id);
  assert.equal(result.ok, true);
  assert.equal(actor.troops, before, "zero RNG would guarantee the old melee counter");
  assert.equal(battle.moveStep(1, 3).ok, true);
  assertConserved(battle);
});

test("non-ranged soldiers cannot shoot or use fire arrows even with enough AP and gold", () => {
  const battle = makeBattle({ composition: { heavyInfantry: 2000, cavalry: 3000 } });
  const { actor, target } = positionForShot(battle);
  const before = snapshot(battle);
  assert.deepEqual(battle.shootTargets(actor), []);
  assert.deepEqual(battle.fireArrowTargets(actor), []);
  assert.equal(battle.shoot(target.id).ok, false);
  assert.equal(battle.fireArrow(target.id).ok, false);
  assert.deepEqual(snapshot(battle), before);
});

test("a token archer does not grant full-formation ranged damage or a full-strength fire proc", () => {
  const shoot = (composition, action = "shoot") => {
    const battle = makeBattle({ composition, rng: () => 0 });
    const { target } = positionForShot(battle);
    return battle[action](target.id);
  };
  const all = shoot({ archer: 5000 });
  const half = shoot({ archer: 2500, infantry: 2500 });
  const token = shoot({ archer: 1, infantry: 4999 }, "fireArrow");
  assert.ok(Math.abs(all.damage / 2 - half.damage) <= 1);
  assert.ok(token.rangedDamage <= 1);
  assert.ok(token.fireDamage <= 1);
  assert.ok(token.damage < all.damage / 100);
});

test("crossbows have stronger weighted shooting than equal-size basic archers", () => {
  const fire = (composition) => {
    const battle = makeBattle({ composition });
    const { target } = positionForShot(battle);
    return battle.shoot(target.id).damage;
  };
  assert.ok(fire({ crossbowman: 5000 }) > fire({ archer: 5000 }));
});

test("fire arrows charge once, test ignition once and reuse the successful fire effect", () => {
  let rolls = 0;
  const battle = makeBattle({ composition: { archer: 5000 }, rng: () => { rolls += 1; return 0; } });
  const { actor, target } = positionForShot(battle);
  const beforeGold = battle.supplies.ally.gold, beforeAP = actor.actionPoints, beforeTroops = target.troops;
  const result = battle.fireArrow(target.id);
  assert.equal(result.ok, true);
  assert.equal(result.fireTriggered, true);
  assert.equal(rolls, 2, "one damage roll plus one ignition roll, never fire()'s success roll");
  assert.equal(battle.supplies.ally.gold, beforeGold - battle.strategyGoldCost("fireArrow"));
  assert.equal(actor.actionPoints, beforeAP - battle.actionCost("fireArrow", actor));
  assert.equal(result.damage, result.rangedDamage + result.fireDamage);
  assert.equal(target.troops, beforeTroops - result.damage);
  assert.equal(result.fireDamage, Math.max(1, Math.round(actor.combatStats.rangedFirePower)), "fire-arrow ignition reads absolute shooter firepower");
  const ordinary = makeBattle({ composition: { archer: 5000 }, rng: () => 0 });
  const other = positionForShot(ordinary, 1);
  assert.equal(ordinary.fire(other.target.id).damage, Math.round(other.actor.combatStats.firePower), "ordinary fire keeps its own command-derived effect power");
  assertConserved(battle);
});

test("a fire arrow that fails to ignite still shoots and spends its AP and carried gold", () => {
  const battle = makeBattle({ rng: () => 0.99 });
  const { actor, target } = positionForShot(battle);
  const result = battle.fireArrow(target.id);
  assert.equal(result.ok, true);
  assert.equal(result.fireTriggered, false);
  assert.equal(result.fireDamage, 0);
  assert.ok(result.rangedDamage > 0);
  assert.equal(battle.supplies.ally.gold, 1000 - result.goldCost);
  assert.equal(actor.actionPoints, actor.maxActionPoints - result.cost);
});

test("ranged targeting rejects hidden, friendly, dead, out-of-range and city units without side effects", () => {
  for (const invalid of ["hidden", "friendly", "dead", "far", "city", "missing"]) {
    const battle = makeBattle();
    const { actor, target } = positionForShot(battle);
    if (invalid === "hidden") battle.map.terrain[target.position.y * battle.map.width + target.position.x] = "forest";
    if (invalid === "dead") applyFormationLosses(target, target.troops, battle.rules);
    if (invalid === "far") target.position = { x: 7, y: 3 };
    if (invalid === "city") target.inCity = true;
    const id = invalid === "friendly" ? actor.id : invalid === "missing" ? "missing" : target.id;
    const before = snapshot(battle);
    assert.equal(battle.shoot(id).ok, false, invalid);
    assert.equal(battle.fireArrow(id).ok, false, invalid);
    assert.deepEqual(snapshot(battle), before, invalid);
  }
});

test("unaffordable ranged orders are transactional and AP and ignition costs are configurable", () => {
  const battle = makeBattle({ ranged: { shootActionPoints: 1, fireArrowActionPoints: 2, fireArrowGoldCost: 17, fireArrowChance: 1 }, rng: () => 0.99 });
  const { actor, target } = positionForShot(battle);
  actor.actionPoints = 0;
  let before = snapshot(battle);
  assert.equal(battle.shoot(target.id).ok, false);
  assert.deepEqual(snapshot(battle), before);
  actor.actionPoints = 2;
  battle.supplies.ally.gold = 16;
  before = snapshot(battle);
  assert.equal(battle.fireArrow(target.id).ok, false);
  assert.deepEqual(battle.fireArrowTargets(actor), []);
  assert.deepEqual(snapshot(battle), before);
  battle.supplies.ally.gold = 17;
  const result = battle.fireArrow(target.id);
  assert.equal(result.fireTriggered, true);
  assert.equal(result.goldCost, 17);
  assert.equal(result.cost, 2);
});

test("AI shoots visible targets, spends its own money for fire arrows and cannot shoot concealed targets", () => {
  const battle = makeBattle({ defending: { archer: 6000 }, rng: () => 0 });
  const { actor, target } = positionForShot(battle);
  battle.queue = [target.id, actor.id];
  const result = battle.runEnemyTurn();
  assert.equal(result.action, "fireArrow");
  assert.equal(result.actorId, target.id);
  assert.equal(battle.supplies.enemy.gold, 1000 - result.goldCost);
  assert.equal(battle.supplies.ally.gold, 1000);

  const hidden = makeBattle({ defending: { archer: 6000 }, rng: () => 0 });
  const placed = positionForShot(hidden);
  hidden.queue = [placed.target.id, placed.actor.id];
  hidden.map.terrain[placed.actor.position.y * hidden.map.width + placed.actor.position.x] = "forest";
  assert.deepEqual(hidden.shootTargets(placed.target), []);
  const hiddenResult = hidden.runEnemyTurn();
  assert.ok(!["shoot", "fireArrow", "fire", "attack"].includes(hiddenResult.action));
  assert.equal(hidden.supplies.enemy.gold, 1000);
});

test("melee, counterattacks, successful fire and ambush all conserve mixed sub-counts", () => {
  for (const action of ["attack", "fire", "ambush"]) {
    const battle = makeBattle({ composition: { archer: 1500, heavyInfantry: 3500 },
      defending: { cavalry: 2000, crossbowman: 4000 }, rng: () => 0 });
    const { actor, target } = positionForShot(battle, action === "ambush" ? 2 : 1);
    if (action === "ambush") {
      target.ambushing = true;
      battle.map.terrain[target.position.y * battle.map.width + target.position.x] = "forest";
      assert.ok(battle.moveStep(3, 3).ambushes.length);
    } else {
      const initial = actor.troops;
      assert.equal(battle[action](target.id).ok, true);
      if (action === "attack") assert.ok(actor.troops < initial, "counterattack inflicted a mixed-unit loss");
    }
    assertConserved(battle);
  }
});

test("reserves reinforce only as infantry and never replace lost equipment", () => {
  const battle = makeBattle({ automaticDefenders: true, targetCity: { troops: 50000 } });
  const target = battle.livingUnits("enemy")[0];
  applyFormationLosses(target, 700, battle.rules);
  const equipment = compositionEquipment(target.composition, battle.rules);
  const infantry = target.composition.infantry ?? 0, before = target.troops;
  const day = battle.day;
  while (battle.day === day && battle.status === "active") battle.wait();
  assert.ok(target.troops > before);
  assert.equal(target.composition.infantry - infantry, target.troops - before);
  assert.deepEqual(compositionEquipment(target.composition, battle.rules), equipment);
  assertConserved(battle);
});

test("siege armies include infantry reserves in weighted capabilities", () => {
  const battle = makeBattle({ defending: { heavyInfantry: 2000 }, targetCity: { troops: 6000 } });
  const stats = battle.getArmyStats("enemy");
  assert.deepEqual(stats.composition, { infantry: 4000, heavyInfantry: 2000 });
  assert.equal(stats.troopDefense, (4000 + 2000 * originalRules.troopTypes.heavyInfantry.defense) / 6000);
});

test("troop type quality influences siege damage, progress and interception with legacy defaults unchanged", () => {
  const army = { troops: 10000, leadership: 80, war: 80, intelligence: 80, training: 80, morale: 80 };
  const evaluate = (type) => evaluateSiegeDay({ attacker: { ...army, composition: { [type]: 10000 } }, defender: army,
    attackOrder: "ram", defenseOrder: "rotate", wallLevel: 2, cityDefense: 80 }, originalRules);
  const ordinary = evaluate("infantry"), heavy = evaluate("heavyCavalry"), archer = evaluate("archer");
  assert.ok(heavy.progress > ordinary.progress && ordinary.progress > archer.progress);
  assert.ok(heavy.attackerLoss < ordinary.attackerLoss);
  assert.ok(heavy.defenderLoss > ordinary.defenderLoss);
  const intercepted = interceptionLosses({ ...army, composition: { heavyCavalry: 10000 } }, army, 2, originalRules);
  const base = interceptionLosses(army, army, 2, originalRules);
  assert.ok(intercepted.attackerLoss < base.attackerLoss);
  assert.ok(intercepted.defenderLoss > base.defenderLoss);
});

test("siege losses, outside interception and encircled retreat preserve equipment-bearing compositions", () => {
  const battle = makeBattle({ composition: { archer: 2500, heavyCavalry: 2500 },
    defending: { crossbowman: 2000, heavyInfantry: 4000 } });
  battle.enterSiege();
  assert.equal(battle.chooseTransition("return").ok, true);
  assert.equal(battle.chooseTransition("intercept").ok, true);
  assertConserved(battle);
  assert.equal(battle.chooseTransition("encircle").ok, true);
  battle.siegeOrder("ally", "ram");
  battle.siegeOrder("enemy", "rotate");
  assertConserved(battle);
  const result = battle.retreatArmy("enemy");
  assert.equal(result.ok, true);
  assert.ok(result.losses > 0);
  assert.ok(battle.escapedDefenderUnits.length > 0);
  assertConserved(battle);
});

test("ranged actions remain disabled outside active field battles", () => {
  const battle = makeBattle({ mode: "siege" });
  const target = battle.livingUnits("enemy")[0];
  const before = snapshot(battle);
  assert.equal(battle.shoot(target.id).ok, false);
  assert.equal(battle.fireArrow(target.id).ok, false);
  assert.deepEqual(snapshot(battle), before);
});
