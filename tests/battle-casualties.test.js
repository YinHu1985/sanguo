import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { calculateCombatStats, getCombatConfig } from "../src/js/game/combat-stats.js";
import { allocateTroopLosses, applyArmyLosses, applyFormationLosses } from "../src/js/game/troops.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const mixed = () => ({ infantry: 1000, heavyInfantry: 1000, crossbowman: 1000, cavalry: 1000 });
const total = (composition) => Object.values(composition).reduce((sum, count) => sum + count, 0);
const formation = (officerId, composition) => ({ officerIds: [officerId], troops: total(composition), composition });
const officers = ["leader", "aide", "guard", "guard-aide"].map((id, index) => ({ id, name: id,
  factionId: index < 2 ? "a" : "b", locationCityId: index < 2 ? "source" : "target", status: "active", rank: "大将",
  war: 80, intelligence: 80, leadership: 80, politics: 80, charm: 80 }));

function fixture(options = {}) {
  const divisions = options.divisions ?? [formation("leader", mixed())];
  const defenderDivisions = options.defenders ?? [formation("guard", mixed())];
  const city = (id, factionId, ids, troops) => ({ id, name: id, factionId, officerIds: ids, troops,
    food: 100000, gold: 10000, horses: 10000, crossbows: 10000, armor: 10000, training: 80, morale: 80, wallLevel: 2, defense: 80 });
  const battle = new BattleEngine({ sourceCity: city("source", "a", ["leader", "aide"], divisions.reduce((sum, unit) => sum + unit.troops, 0)),
    targetCity: city("target", "b", ["guard", "guard-aide"], defenderDivisions.reduce((sum, unit) => sum + unit.troops, 0) + (options.reserve ?? 0)),
    divisions, defenderDivisions, officers, rules, mode: options.mode ?? "field", canDefenderRetreat: true,
    supplies: { food: 100000, gold: 1000 }, rng: options.rng ?? (() => 0.99),
    map: { width: 9, height: 7, stronghold: { x: 8, y: 3 }, terrain: Array(63).fill("plain"),
      attackerStarts: [{ x: 2, y: 3 }, { x: 0, y: 5 }], defenderStarts: [{ x: 4, y: 3 }, { x: 8, y: 5 }] } });
  return { battle, actor: battle.livingUnits("ally")[0], target: battle.livingUnits("enemy")[0] };
}

function expectedAfter(composition, loss, damageType) {
  const allocated = allocateTroopLosses(composition, loss, rules, damageType);
  return Object.fromEntries(Object.entries(composition).map(([id, count]) => [id, count - (allocated[id] ?? 0)]).filter(([, count]) => count > 0));
}

function assertPanel(unit, battle) {
  assert.equal(total(unit.composition), unit.troops);
  assert.ok(Object.values(unit.composition).every((count) => Number.isSafeInteger(count) && count >= 0));
  assert.deepEqual(unit.combatStats, calculateCombatStats(unit, battle.rules));
}

function armySnapshot(battle, side) {
  const units = structuredClone(battle.livingUnits(side));
  if (side === "enemy" && battle.defenderReserveTroops) units.push({ id: "reserves", troops: battle.defenderReserveTroops,
    composition: { infantry: battle.defenderReserveTroops }, unitType: "infantry" });
  return units;
}

function assertArmy(battle, side, expected) {
  for (const unit of expected) {
    if (unit.id === "reserves") assert.equal(battle.defenderReserveTroops, unit.troops);
    else {
      const actual = battle.getUnit(unit.id);
      assert.equal(actual.troops, unit.troops);
      assert.deepEqual(actual.composition, unit.composition);
      assertPanel(actual, battle);
    }
  }
}

test("melee applies the per-activation damage budget while front-line types take its larger casualty share", () => {
  const { battle, actor, target } = fixture();
  target.position = { x: 3, y: 3 };
  const before = structuredClone(target.composition);
  const expectedDamage = Math.max(1, Math.round(actor.combatStats.meleeAttack / target.combatStats.meleeDefense
    * getCombatConfig(rules).meleeDamageRate / Math.max(1, Math.floor(actor.activationActionPoints / actor.combatStats.attackCost)) * (0.88 + 0.99 * 0.24)));
  const result = battle.attack(target.id);
  assert.equal(result.ok, true);
  assert.equal(result.damage, expectedDamage);
  assert.deepEqual(target.composition, expectedAfter(before, result.damage, "melee"));
  const front = before.infantry - target.composition.infantry, rear = before.cavalry - target.composition.cavalry;
  assert.ok(front > rear && Math.abs(front - rear * 2) <= 2);
  assertPanel(target, battle);
});

test("real melee counterattacks allocate losses with the melee profile and refresh both panels", () => {
  const { battle, actor, target } = fixture({ rng: () => 0 });
  target.position = { x: 3, y: 3 };
  const beforeActor = structuredClone(actor.composition), beforeTarget = structuredClone(target.composition), beforeTroops = actor.troops;
  const result = battle.attack(target.id);
  const counterLoss = beforeTroops - actor.troops;
  assert.ok(counterLoss > 0);
  assert.deepEqual(actor.composition, expectedAfter(beforeActor, counterLoss, "melee"));
  assert.deepEqual(target.composition, expectedAfter(beforeTarget, result.damage, "melee"));
  assert.ok(beforeActor.heavyInfantry - actor.composition.heavyInfantry > beforeActor.crossbowman - actor.composition.crossbowman);
  assertPanel(actor, battle);
  assertPanel(target, battle);
});

test("ambush strikes use melee exposure without a counterattack or a second damage multiplier", () => {
  const { battle, actor, target } = fixture({ rng: () => 0 });
  target.ambushing = true;
  battle.map.terrain[target.position.y * battle.map.width + target.position.x] = "forest";
  const before = structuredClone(actor.composition), targetTroops = target.troops;
  battle.queue = [actor.id, target.id];
  const result = battle.moveStep(3, 3);
  assert.equal(result.ok, true);
  assert.equal(result.ambushes.length, 1);
  assert.deepEqual(actor.composition, expectedAfter(before, result.ambushes[0].damage, "melee"));
  assert.equal(target.troops, targetTroops);
  assert.equal(result.activationEnded, true);
  assertPanel(actor, battle);
});

test("actual shooting uses the weaker ranged front-line bias rather than melee bias", () => {
  const { battle, actor, target } = fixture({ divisions: [formation("leader", { archer: 4000 })] });
  const before = structuredClone(target.composition);
  const expectedDamage = Math.max(1, Math.round(actor.combatStats.rangedAttack / target.combatStats.rangedDefense
    * getCombatConfig(rules).rangedDamageRate * (0.88 + 0.99 * 0.24)));
  const result = battle.shoot(target.id);
  assert.equal(result.damage, expectedDamage);
  assert.deepEqual(target.composition, expectedAfter(before, result.damage, "ranged"));
  assert.notDeepEqual(target.composition, expectedAfter(before, result.damage, "melee"));
  const front = before.infantry - target.composition.infantry, rear = before.cavalry - target.composition.cavalry;
  assert.ok(front > rear && front < rear * 1.5);
  assertPanel(target, battle);
});

test("successful fire uses proportional fire exposure instead of melee or ranged exposure", () => {
  const { battle, actor, target } = fixture({ rng: () => 0 });
  target.position = { x: 3, y: 3 };
  const before = structuredClone(target.composition);
  const result = battle.fire(target.id);
  assert.equal(result.damage, Math.round(actor.combatStats.firePower));
  assert.deepEqual(target.composition, expectedAfter(before, result.damage, "fire"));
  assert.notDeepEqual(target.composition, expectedAfter(before, result.damage, "melee"));
  const losses = Object.keys(before).map((id) => before[id] - target.composition[id]);
  assert.ok(Math.max(...losses) - Math.min(...losses) <= 1);
  assertPanel(target, battle);
});

test("fire arrows independently apply ranged casualties and then fire casualties on the remaining composition", () => {
  const { battle, target } = fixture({ divisions: [formation("leader", { archer: 4000 })], rng: () => 0 });
  const before = structuredClone(target.composition);
  const result = battle.fireArrow(target.id);
  assert.equal(result.ok, true);
  assert.equal(result.fireTriggered, true);
  assert.ok(result.rangedDamage > 0 && result.fireDamage > 0);
  const afterArrows = expectedAfter(before, result.rangedDamage, "ranged");
  const afterFire = expectedAfter(afterArrows, result.fireDamage, "fire");
  assert.deepEqual(target.composition, afterFire);
  assert.notDeepEqual(target.composition, expectedAfter(before, result.damage, "ranged"));
  assert.notDeepEqual(target.composition, expectedAfter(before, result.damage, "melee"));
  assert.equal(target.troops, total(before) - result.rangedDamage - result.fireDamage);
  assertPanel(target, battle);
});

test("siege apportions losses across the whole army's exposed types and includes city reserves as infantry", () => {
  const { battle } = fixture({ mode: "siege", reserve: 4000,
    divisions: [formation("leader", { infantry: 4000 }), formation("aide", { cavalry: 4000 })],
    defenders: [formation("guard", { infantry: 4000 }), formation("guard-aide", { cavalry: 4000 })] });
  battle.chooseTransition("open");
  const attacker = armySnapshot(battle, "ally"), defender = armySnapshot(battle, "enemy");
  battle.siegeOrder("ally", "ram");
  const result = battle.siegeOrder("enemy", "rotate");
  assert.equal(result.ok, true);
  applyArmyLosses(attacker, result.attackerLoss, rules, "melee");
  applyArmyLosses(defender, result.defenderLoss, rules, "melee");
  assertArmy(battle, "ally", attacker);
  assertArmy(battle, "enemy", defender);
  const infantryLoss = 4000 - battle.units.find((unit) => unit.side === "enemy" && unit.officerIds.includes("guard")).troops;
  const cavalryLoss = 4000 - battle.units.find((unit) => unit.side === "enemy" && unit.officerIds.includes("guard-aide")).troops;
  const reserveLoss = 4000 - battle.defenderReserveTroops;
  assert.ok(infantryLoss > cavalryLoss && reserveLoss > cavalryLoss, "whole-army allocation is not equal losses per equal-size formation");
});

test("outside interception allocates melee losses only to returning formations and leaves city reserves untouched", () => {
  const { battle } = fixture({ reserve: 4000,
    divisions: [formation("leader", mixed()), formation("aide", mixed())],
    defenders: [formation("guard", { infantry: 4000 }), formation("guard-aide", { cavalry: 4000 })] });
  const attackers = armySnapshot(battle, "ally"), returning = structuredClone(battle.livingUnits("enemy"));
  const attackerTotal = attackers.reduce((sum, unit) => sum + unit.troops, 0), defenderTotal = returning.reduce((sum, unit) => sum + unit.troops, 0);
  battle.enterSiege(); battle.chooseTransition("return");
  assert.equal(battle.chooseTransition("intercept").ok, true);
  const attackerLoss = attackerTotal - battle.livingUnits("ally").reduce((sum, unit) => sum + unit.troops, 0);
  const defenderLoss = defenderTotal - battle.livingUnits("enemy").reduce((sum, unit) => sum + unit.troops, 0);
  applyArmyLosses(attackers, attackerLoss, rules, "melee");
  applyArmyLosses(returning, defenderLoss, rules, "melee");
  assertArmy(battle, "ally", attackers);
  assertArmy(battle, "enemy", returning);
  assert.equal(battle.defenderReserveTroops, 4000);
  assert.ok(defenderLoss > 0);
});

test("encircled breakout applies one whole-army melee allocation before survivors escape", () => {
  const { battle } = fixture({ mode: "siege", reserve: 4000,
    divisions: [formation("leader", { infantry: 4000 }), formation("aide", { cavalry: 4000 })],
    defenders: [formation("guard", { infantry: 4000 }), formation("guard-aide", { cavalry: 4000 })] });
  const expected = armySnapshot(battle, "enemy");
  battle.chooseTransition("encircle");
  const result = battle.retreatArmy("enemy");
  assert.equal(result.ok, true);
  assert.ok(result.losses > 0);
  applyArmyLosses(expected, result.losses, rules, "melee");
  for (const unit of expected) {
    const escaped = unit.id === "reserves" ? battle.escapedDefenderUnits.find((entry) => entry.name === "城内预备兵")
      : battle.escapedDefenderUnits.find((entry) => entry.id === unit.id);
    assert.equal(escaped.troops, unit.troops);
    assert.deepEqual(escaped.composition, unit.composition);
    if (unit.id !== "reserves") assertPanel(escaped, battle);
  }
  assert.equal(result.escapedTroops, expected.reduce((sum, unit) => sum + unit.troops, 0));
});

test("single-type and legacy formations keep exactly the requested total losses for all four profiles", () => {
  for (const type of ["melee", "ranged", "fire", "attrition"]) {
    for (const unitType of ["infantry", "archer", "cavalry"]) {
      const unit = { troops: 1000, unitType };
      assert.equal(applyFormationLosses(unit, 317, rules, type), 317);
      assert.equal(unit.troops, 683);
      assert.deepEqual(unit.composition, { [unitType]: 683 });
      assert.equal(applyFormationLosses(unit, 10000, rules, type), 683);
      assert.equal(unit.troops, 0);
      assert.deepEqual(unit.composition, {});
    }
  }
});
