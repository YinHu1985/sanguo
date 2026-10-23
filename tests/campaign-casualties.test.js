import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { autoResolveInvasion } from "../src/js/game/campaign.js";
import { calculateCombatStats } from "../src/js/game/combat-stats.js";
import { dailyFoodCost } from "../src/js/game/economy.js";
import { allocateTroopLosses, autoComposition, compositionEquipment, EQUIPMENT_KEYS, resizeComposition } from "../src/js/game/troops.js";

const baseRules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const total = (composition) => Object.values(composition).reduce((sum, count) => sum + count, 0);
const stores = (city) => Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, city[key] ?? 0]));
const person = (id, factionId, locationCityId) => ({ id, name: id, factionId, locationCityId, status: "active", rank: "君主",
  war: 80, leadership: 80, intelligence: 80, politics: 80, charm: 80, loyalty: 100, merit: 0, acted: false });

function fixture({ days = 4, defenderTroops = 8000, food = 2000, defenderFood = 20000, funded = true } = {}) {
  const rules = structuredClone(baseRules);
  rules.battleDayLimit = days;
  const composition = { infantry: 1500, archer: 1500, heavyInfantry: 1000, cavalry: 1000, crossbowman: 1000 };
  const source = { id: "source", name: "攻城出发地", factionId: "attacker", adjacent: ["target"], officerIds: ["attacker-lord"],
    troops: 2000, training: 80, morale: 80, gold: 5000, food: 18000, popularSupport: 70, horses: 700, crossbows: 500, armor: 600 };
  const target = { id: "target", name: "防守据点", factionId: "defender", adjacent: ["source"], officerIds: ["defender-lord"],
    troops: defenderTroops, training: 80, morale: 80, gold: 5000, food: defenderFood, popularSupport: 70,
    horses: 1600, crossbows: 1600, armor: 1600 };
  const invasion = { id: "mixed-war", sourceId: "source", targetId: "target", attackerFactionId: "attacker", defenderFactionId: "defender",
    officerIds: ["attacker-lord"], troops: total(composition), training: 80, morale: 80, resolved: false, supplies: { food, gold: 100 },
    divisions: [{ officerIds: ["attacker-lord"], troops: total(composition), composition: { ...composition } }],
    ...(funded ? { equipment: compositionEquipment(composition, rules) } : {}) };
  const state = { year: 196, month: 6, elapsedMonths: 0, eventLog: [], playerFactionId: "defender", commandsRemaining: 6,
    factions: [{ id: "attacker", name: "攻方", unlockedTechnologies: [] }, { id: "defender", name: "守方", unlockedTechnologies: [] }],
    officers: [person("attacker-lord", "attacker", "source"), person("defender-lord", "defender", "target")], cities: [source, target], pendingInvasions: [invasion] };
  const defenderComposition = autoComposition(target.troops, stores(target), { state, factionId: target.factionId, officers: [state.officers[1]], rules });
  return { state, source, target, invasion, rules, composition, defenderComposition };
}

function panel(composition, officer, rules) {
  return calculateCombatStats({ troops: total(composition), composition, officers: [officer], training: 80, morale: 80 }, rules);
}

function expectedDamage(attacking, defending, attackerOfficer, defenderOfficer, rules, random = 0.25, stance = "defend") {
  const attackPanel = panel(attacking, attackerOfficer, rules);
  const defensePanel = panel(defending, defenderOfficer, rules);
  const attack = { melee: attackPanel.meleeAttack / defensePanel.meleeDefense,
    ranged: attackPanel.rangedAttack * 0.5 / defensePanel.rangedDefense };
  const defense = { melee: defensePanel.meleeAttack / attackPanel.meleeDefense,
    ranged: defensePanel.rangedAttack * 0.5 / attackPanel.rangedDefense };
  const factor = 0.88 + random * 0.24;
  const attackerLoss = Math.min(total(attacking), Math.max(1, Math.floor((defense.melee + defense.ranged) * (stance === "sally" ? 1 : 1.18) * factor * 0.065)));
  const defenderLoss = Math.min(total(defending), Math.max(1, Math.floor((attack.melee + attack.ranged) * factor * (stance === "sally" ? 0.075 : 0.065))));
  const split = (loss, power) => {
    const ranged = Math.round(loss * power.ranged / (power.melee + power.ranged));
    return { melee: loss - ranged, ranged };
  };
  return { attackerLoss, defenderLoss, attackerDamage: split(attackerLoss, defense), defenderDamage: split(defenderLoss, attack) };
}

function applyExpectedLosses(composition, split, rules) {
  const next = { ...composition };
  for (const type of ["melee", "ranged"]) {
    for (const [id, loss] of Object.entries(allocateTroopLosses(next, split[type], rules, type))) {
      next[id] -= loss;
      if (!next[id]) delete next[id];
    }
  }
  return next;
}

test("automatic casualties retain each pre-round total, split damage sources and update compositions before the next day", () => {
  for (const stance of ["defend", "sally"]) {
    const setup = fixture();
    const { state, invasion, rules } = setup;
    let randomCalls = 0;
    const report = autoResolveInvasion(state, invasion, rules, stance, () => { randomCalls += 1; return 0.25; });
    assert.equal(report.ok, true);
    assert.equal(report.attackerWon, false);
    assert.equal(report.days, 4);
    assert.equal(randomCalls, report.days * 2, "casualty distribution must never add random draws");
    let attacker = setup.composition;
    let defender = setup.defenderComposition;
    for (const day of report.dailyLog) {
      const expected = expectedDamage(attacker, defender, state.officers[0], state.officers[1], rules, 0.25, stance);
      assert.equal(day.attackerLoss, expected.attackerLoss);
      assert.equal(day.defenderLoss, expected.defenderLoss, "defending damage uses its pre-round strength, not the already wounded side");
      assert.deepEqual(day.attackerLossByDamageType, expected.attackerDamage);
      assert.deepEqual(day.defenderLossByDamageType, expected.defenderDamage);
      assert.equal(total(day.attackerLossByDamageType), day.attackerLoss);
      assert.equal(total(day.defenderLossByDamageType), day.defenderLoss);
      assert.equal(total(day.attackerLossByTroopType), day.attackerLoss);
      assert.equal(total(day.defenderLossByTroopType), day.defenderLoss);
      assert.equal(day.attackerFood, dailyFoodCost(total(attacker), rules));
      assert.equal(day.defenderFood, dailyFoodCost(total(defender), rules));
      const nextAttacker = applyExpectedLosses(attacker, expected.attackerDamage, rules);
      const nextDefender = applyExpectedLosses(defender, expected.defenderDamage, rules);
      assert.deepEqual(day.attackerComposition, nextAttacker);
      assert.deepEqual(day.defenderComposition, nextDefender);
      for (const [id, count] of Object.entries(attacker)) assert.equal(day.attackerLossByTroopType[id] ?? 0, count - (nextAttacker[id] ?? 0));
      for (const [id, count] of Object.entries(defender)) assert.equal(day.defenderLossByTroopType[id] ?? 0, count - (nextDefender[id] ?? 0));
      attacker = nextAttacker;
      defender = nextDefender;
      assert.equal(total(attacker), day.attackerSurvivors);
      assert.equal(total(defender), day.defenderSurvivors);
    }
    assert.notDeepEqual(attacker, resizeComposition(setup.composition, report.attackerSurvivors), "the remaining army is not repeatedly restored to its initial ratios");
    assert.deepEqual(report.combatSurvivors, { attacker: { troops: total(attacker), composition: attacker }, defender: { troops: total(defender), composition: defender } });
  }
});

test("retreat and defended warehouses return equipment from actual surviving types rather than initial ratios", () => {
  const { state, invasion, rules, source, target, composition, defenderComposition } = fixture({ days: 8 });
  const sourceBefore = stores(source), targetBefore = stores(target);
  const defenderCommitted = compositionEquipment(defenderComposition, rules);
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0.25);
  assert.equal(report.attackerWon, false);
  const attackerEquipment = compositionEquipment(report.combatSurvivors.attacker.composition, rules);
  const defenderEquipment = compositionEquipment(report.combatSurvivors.defender.composition, rules);
  assert.notDeepEqual(attackerEquipment, compositionEquipment(resizeComposition(composition, report.attackerSurvivors), rules));
  for (const key of EQUIPMENT_KEYS) {
    assert.equal(source[key], sourceBefore[key] + attackerEquipment[key]);
    assert.equal(target[key], targetBefore[key] - defenderCommitted[key] + defenderEquipment[key]);
  }
  const snapshot = structuredClone(state);
  assert.equal(autoResolveInvasion(state, invasion, rules).ok, false);
  assert.deepEqual(state, snapshot, "settlement cannot pay surviving equipment twice");
});

test("frontline exposure leaves a different mix than proportional losses and never resurrects a lost type", () => {
  const setup = fixture({ days: 10 });
  const { state, invasion, rules } = setup;
  // A deliberately exaggerated data-only profile makes the integration easy to audit.
  rules.battle.casualties = { profiles: { melee: { default: 0.01, infantry: 1000 }, ranged: { default: 0.01, infantry: 1000 } } };
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0.25);
  assert.equal(report.attackerWon, false);
  const missingAt = report.dailyLog.findIndex((day) => !day.attackerComposition.infantry);
  assert.ok(missingAt >= 0, "the exposed frontline must eventually be exhausted");
  for (const day of report.dailyLog.slice(missingAt)) assert.equal(day.attackerComposition.infantry, undefined);
  assert.ok(report.combatSurvivors.attacker.composition.archer > 0);
  assert.ok(report.combatSurvivors.attacker.composition.cavalry > 0);
});

test("a melee-only exchange allocates no phantom ranged casualties", () => {
  const { state, invasion, rules } = fixture();
  for (const type of Object.values(rules.troopTypes)) type.rangedAttack = 0;
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0.25);
  for (const day of report.dailyLog) {
    assert.deepEqual(day.attackerLossByDamageType, { melee: day.attackerLoss, ranged: 0 });
    assert.deepEqual(day.defenderLossByDamageType, { melee: day.defenderLoss, ranged: 0 });
  }
});

test("victory deposits only the truly surviving mixed army's equipment", () => {
  const { state, invasion, rules, source, target, defenderComposition } = fixture({ defenderTroops: 300, days: 30 });
  const sourceBefore = stores(source), targetBefore = stores(target);
  const defenderCommitted = compositionEquipment(defenderComposition, rules);
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0.25);
  assert.equal(report.attackerWon, true);
  assert.equal(target.factionId, "attacker");
  const incoming = compositionEquipment(report.combatSurvivors.attacker.composition, rules);
  const survivingDefender = compositionEquipment(report.combatSurvivors.defender.composition, rules);
  for (const key of EQUIPMENT_KEYS) {
    assert.equal(source[key], sourceBefore[key]);
    assert.equal(target[key], targetBefore[key] - defenderCommitted[key] + survivingDefender[key] + incoming[key]);
  }
  assert.equal(target.troops, total(report.combatSurvivors.attacker.composition));
});

test("missing old equipment ledgers cannot manufacture gear after combat or cancellation", () => {
  for (const cancelled of [false, true]) {
    const { state, invasion, rules, source } = fixture({ funded: false });
    if (cancelled) state.relations = { "attacker|defender": { allianceUntil: 99999 } };
    const before = stores(source);
    let draws = 0;
    const report = autoResolveInvasion(state, invasion, rules, "defend", () => { draws += 1; return 0.25; });
    assert.equal(report.ok, true);
    assert.deepEqual(stores(source), before);
    if (cancelled) {
      assert.equal(report.cancelled, true);
      assert.equal(draws, 0);
    }
  }
});

test("cancelled and unfed funded armies return untouched equipment without casualty rolls", () => {
  for (const reason of ["alliance", "stale", "unfed"]) {
    const { state, invasion, rules, source, target, composition } = fixture({ food: reason === "unfed" ? 0 : 2000 });
    if (reason === "alliance") state.relations = { "attacker|defender": { allianceUntil: 99999 } };
    if (reason === "stale") target.factionId = "third";
    const sourceBefore = stores(source), targetBefore = stores(target);
    const loaded = compositionEquipment(composition, rules);
    let draws = 0;
    const report = autoResolveInvasion(state, invasion, rules, "defend", () => { draws += 1; return 0.25; });
    assert.equal(report.ok, true);
    assert.equal(draws, 0);
    assert.deepEqual(stores(target), targetBefore);
    for (const key of EQUIPMENT_KEYS) assert.equal(source[key], sourceBefore[key] + loaded[key]);
    if (reason === "unfed") {
      assert.equal(report.endReason, "attacker-food");
      assert.equal(report.days, 0);
      assert.deepEqual(report.combatSurvivors.attacker.composition, composition);
    } else assert.equal(report.cancelled, true);
  }
});

test("running out of defender grain preserves the combat composition before its separate surrender", () => {
  const { state, invasion, rules, target, composition, defenderComposition } = fixture({ defenderFood: 0 });
  const before = stores(target);
  const incoming = compositionEquipment(composition, rules);
  const report = autoResolveInvasion(state, invasion, rules, "defend", () => 0.25);
  assert.equal(report.endReason, "defender-food");
  assert.equal(report.days, 0);
  assert.equal(report.defenderSurvivors, 0, "occupation disbands the defeated garrison");
  assert.deepEqual(report.combatSurvivors.defender.composition, defenderComposition, "surrender is not retroactively presented as combat casualties");
  for (const key of EQUIPMENT_KEYS) assert.equal(target[key], before[key] + incoming[key]);
});
