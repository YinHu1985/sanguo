import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calculateCombatStats, getCombatConfig } from "../src/js/game/combat-stats.js";
import { BattleEngine } from "../src/js/game/battle.js";
import { evaluateSiegeDay } from "../src/js/game/siege.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const abilities = { war: 80, intelligence: 80, leadership: 80, politics: 80, charm: 80, training: 80, morale: 80 };
const stats = (composition, extra = {}) => calculateCombatStats({ composition, ...abilities, ...extra }, rules);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function battleFor(composition = { archer: 1000 }, options = {}) {
  const customRules = structuredClone(rules);
  if (options.configure) options.configure(customRules);
  const total = Object.values(composition).reduce((sum, count) => sum + count, 0);
  const defending = options.defending ?? { infantry: 10000 };
  const targetTroops = options.targetTroops ?? Object.values(defending).reduce((sum, count) => sum + count, 0);
  const person = (id, factionId, locationCityId) => ({ id, name: id, factionId, locationCityId, status: "active", rank: "大将", ...abilities });
  const city = (id, factionId, officerIds, troops) => ({ id, name: id, factionId, officerIds, troops, food: 100000, gold: 10000,
    horses: 100000, crossbows: 100000, armor: 100000, training: 80, morale: 80 });
  const battle = new BattleEngine({ sourceCity: city("source", "a", ["leader"], total),
    targetCity: city("target", "b", ["guard"], targetTroops), officers: [person("leader", "a", "source"), person("guard", "b", "target")],
    rules: customRules, divisions: [{ officerIds: ["leader"], troops: total, composition }],
    ...(options.automaticDefenders ? {} : { defenderDivisions: [{ officerIds: ["guard"], troops: Object.values(defending).reduce((sum, count) => sum + count, 0), composition: defending }] }),
    supplies: { food: 100000, gold: 1000 }, rng: options.rng ?? (() => 0.99),
    map: { width: 10, height: 8, terrain: Array(80).fill("plain"), stronghold: { x: 9, y: 4 },
      attackerStarts: [{ x: 1, y: 3 }], defenderStarts: [{ x: 3, y: 3 }] } });
  const actor = battle.livingUnits("ally")[0], target = battle.livingUnits("enemy")[0];
  battle.queue = [actor.id, target.id];
  return { battle, actor, target };
}

test("one centralized panel applies commander, drill and morale once to final attack and protection", () => {
  const config = getCombatConfig(rules);
  const quality = (config.attackBase + 80 / config.warDivisor) * (config.commandAttackBase + 80 / config.commandAttackDivisor)
    * (config.trainingAttackBase + 80 / config.trainingAttackDivisor) * (config.moraleAttackBase + 80 / config.moraleAttackDivisor);
  const defense = (config.defenseBase + 80 / config.commandDefenseDivisor) * (config.trainingDefenseBase + 80 / config.trainingDefenseDivisor)
    * (config.moraleDefenseBase + 80 / config.moraleDefenseDivisor);
  const panel = stats({ infantry: 1000, archer: 1000 });
  near(panel.meleeAttack, (1000 + 1000 * rules.troopTypes.archer.attack) * quality);
  near(panel.rangedAttack, 1000 * rules.troopTypes.archer.rangedAttack * quality);
  near(panel.meleeDefense, (1 + rules.troopTypes.archer.defense) / 2 * defense);
  near(panel.rangedDefense, (rules.troopTypes.infantry.rangedDefense + rules.troopTypes.archer.rangedDefense) / 2 * defense);
  assert.equal(panel.actionPoints, panel.movement);
  assert.ok(panel.vision > panel.movement);
});

test("adding nine thousand infantry does not dilute one thousand archers' final firepower or fire-arrow power", () => {
  const archers = stats({ archer: 1000 }), mixed = stats({ archer: 1000, infantry: 9000 });
  assert.equal(mixed.rangedAttack, archers.rangedAttack);
  assert.equal(mixed.rangedFirePower, archers.rangedFirePower);
  assert.ok(mixed.meleeAttack > archers.meleeAttack);
  assert.equal(mixed.rangedTroops, archers.rangedTroops);
  assert.equal(mixed.range, archers.range);
});

test("doubling a fixed composition doubles total attacks but never doubles individual protection", () => {
  const normal = stats({ infantry: 2000, crossbowman: 1000 }), doubled = stats({ infantry: 4000, crossbowman: 2000 });
  near(doubled.meleeAttack, normal.meleeAttack * 2);
  near(doubled.rangedAttack, normal.rangedAttack * 2);
  assert.equal(doubled.meleeDefense, normal.meleeDefense);
  assert.equal(doubled.rangedDefense, normal.rangedDefense);
  assert.equal(doubled.movement, normal.movement);
});

test("officer arrays and pre-aggregated five-dimensional abilities produce the same battle panel", () => {
  const officers = [{ ...abilities, war: 100, intelligence: 30, leadership: 50 }, { ...abilities, war: 30, intelligence: 100, leadership: 100 }];
  const fromOfficers = stats({ archer: 1000, cavalry: 1000 }, { officers });
  const aggregate = stats({ archer: 1000, cavalry: 1000 }, { war: 100, intelligence: 100, leadership: 100 });
  assert.deepEqual(fromOfficers, aggregate);
});

test("the derived panel responds to commander quality, training, morale and distinct ranged protection", () => {
  const strong = stats({ infantry: 1000 }, { war: 100, leadership: 100, training: 100, morale: 100 });
  const weak = stats({ infantry: 1000 }, { war: 10, leadership: 10, training: 10, morale: 10 });
  assert.ok(strong.meleeAttack > weak.meleeAttack && strong.meleeDefense > weak.meleeDefense);
  assert.ok(strong.movement > weak.movement && strong.vision > weak.vision);
  const armored = stats({ heavyInfantry: 1000 });
  assert.notEqual(armored.meleeDefense, armored.rangedDefense);
  assert.ok(armored.rangedDefense > stats({ archer: 1000 }).rangedDefense);
});

test("battle construction and the independent composition preview agree on every final field", () => {
  const { battle, actor } = battleFor({ infantry: 2000, crossbowman: 1000, heavyInfantry: 1000 });
  assert.deepEqual(actor.combatStats, calculateCombatStats(actor, battle.rules));
  assert.equal(actor.maxActionPoints, actor.combatStats.movement);
  assert.equal(actor.vision, actor.combatStats.vision);
  assert.equal(actor.rangedRange, actor.combatStats.range);
});

test("actual shooting and ignition depend on the same absolute archers, not the formation's infantry proportion", () => {
  const shoot = (composition, action) => {
    const { battle, target } = battleFor(composition, { rng: () => 0 });
    return battle[action](target.id);
  };
  for (const action of ["shoot", "fireArrow"]) {
    const pure = shoot({ archer: 1000 }, action), mixed = shoot({ archer: 1000, infantry: 9000 }, action);
    assert.equal(pure.ok, true);
    assert.equal(mixed.ok, true);
    assert.equal(mixed.rangedDamage, pure.rangedDamage);
    assert.equal(mixed.fireDamage, pure.fireDamage);
    assert.equal(mixed.damage, pure.damage);
  }
});

test("even one archer among 9999 infantry enables a legal one-casualty shot with no proportion threshold", () => {
  const { battle, actor, target } = battleFor({ infantry: 9999, archer: 1 });
  assert.equal(actor.combatStats.rangedTroops, 1);
  assert.equal(battle.shootTargets(actor)[0], target);
  assert.equal(battle.shoot(target.id).damage, 1);
});

test("ranged resolution consumes cached final power and ranged protection once plus terrain and randomness", () => {
  const { battle, actor, target } = battleFor({ archer: 1000 }, { defending: { heavyInfantry: 10000 } });
  const attack = actor.combatStats.rangedAttack, defense = target.combatStats.rangedDefense;
  const expected = Math.max(1, Math.round(attack / defense * getCombatConfig(battle.rules).rangedDamageRate * (0.88 + 0.99 * 0.24)));
  assert.equal(battle.shoot(target.id).damage, expected);
  assert.deepEqual(target.combatStats, calculateCombatStats(target, battle.rules), "casualty and morale effects refresh the final panel");
});

test("melee damage and counters use finalized power while losses and morale immediately refresh both panels", () => {
  const { battle, actor, target } = battleFor({ infantry: 4000 }, { rng: () => 0 });
  target.position = { x: 2, y: 3 };
  const before = actor.combatStats.meleeAttack;
  const expected = Math.max(1, Math.round(before / target.combatStats.meleeDefense * getCombatConfig(battle.rules).meleeDamageRate
    / Math.max(1, Math.floor(actor.activationActionPoints / actor.combatStats.attackCost)) * 0.88));
  const result = battle.attack(target.id);
  assert.equal(result.damage, expected);
  assert.ok(actor.combatStats.meleeAttack < before, "a real counterattack reduced the attacking panel");
  assert.deepEqual(actor.combatStats, calculateCombatStats(actor, battle.rules));
  assert.deepEqual(target.combatStats, calculateCombatStats(target, battle.rules));
});

test("morale effects and infantry-only reinforcement refresh the same final combat model", () => {
  const { battle, actor, target } = battleFor({ archer: 5000 }, { automaticDefenders: true, targetTroops: 20000 });
  const old = target.combatStats.meleeAttack;
  battle.changeMorale("enemy", -30);
  assert.ok(target.combatStats.meleeAttack < old);
  assert.deepEqual(target.combatStats, calculateCombatStats(target, battle.rules));
  battle.shoot(target.id);
  const infantry = target.composition.infantry ?? 0, soldiers = target.troops;
  const day = battle.day;
  while (battle.day === day && battle.status === "active") battle.wait();
  assert.ok(target.troops > soldiers);
  assert.equal(target.composition.infantry - infantry, target.troops - soldiers);
  assert.deepEqual(target.combatStats, calculateCombatStats(target, battle.rules));
  assert.equal(actor.actionPoints, actor.combatStats.movement);
});

test("field visibility consumes configured final sight while woods and mountains still conceal distant enemies", () => {
  const { battle, actor, target } = battleFor({ infantry: 1000 }, { configure(custom) { custom.troopTypes.infantry.vision = 7; } });
  target.position = { x: 7, y: 3 };
  assert.equal(actor.combatStats.vision, 7);
  assert.ok(actor.combatStats.vision > actor.maxActionPoints + 1);
  assert.equal(battle.isUnitVisibleTo(target, "ally"), true);
  battle.map.terrain[target.position.y * battle.map.width + target.position.x] = "forest";
  assert.equal(battle.isUnitVisibleTo(target, "ally"), false);
});

test("siege reads the finalized army panel once and obeys the wall cap without double troop scaling", () => {
  const attacker = { ...abilities, troops: 10000, composition: { infantry: 5000, heavyInfantry: 5000 } };
  const defender = { ...abilities, troops: 10000, composition: { infantry: 10000 } };
  attacker.combatStats = calculateCombatStats(attacker, rules);
  defender.combatStats = calculateCombatStats(defender, rules);
  const input = { attacker, defender, attackOrder: "ram", defenseOrder: "rotate", wallLevel: 1, cityDefense: 50 };
  const expected = evaluateSiegeDay(input, rules);
  const alteredRawInputs = evaluateSiegeDay({ ...input,
    attacker: { ...attacker, leadership: 1, war: 1, training: 1, morale: 1 },
    defender: { ...defender, leadership: 1, war: 1, training: 1, morale: 1 } }, rules);
  assert.deepEqual(alteredRawInputs, expected, "already-finalized panel must not reapply raw commander or quality stats");
  const capped = (troops) => evaluateSiegeDay({ ...input,
    attacker: { ...abilities, troops, composition: { infantry: troops } },
    defender: { ...abilities, troops, composition: { infantry: troops } } }, rules);
  assert.deepEqual(capped(200000), capped(30000));
});

test("an empty or minimal legacy formation receives finite safe panel defaults", () => {
  for (const unit of [{}, { troops: 1000 }, { composition: {}, training: NaN, morale: Infinity }]) {
    const panel = calculateCombatStats(unit, rules);
    assert.ok(Object.values(panel).every(Number.isFinite));
    assert.ok(panel.meleeDefense > 0 && panel.rangedDefense > 0);
    assert.equal(panel.rangedAttack, 0);
  }
});
