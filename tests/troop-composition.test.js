import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { settlePlayerBattle } from "../src/js/game/battle-result.js";
import { createInvasionBattle, settleDefensiveBattle } from "../src/js/game/invasion-battle.js";
import { createDefenderFormations } from "../src/js/game/army.js";
import { validateArmy, commitArmyDeparture } from "../src/js/game/rules.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";
import { autoResolveInvasion } from "../src/js/game/campaign.js";
import { calculateCombatStats } from "../src/js/game/combat-stats.js";
import { dailyFoodCost } from "../src/js/game/economy.js";
import { aggregateTroopStats, applyFormationLosses, autoComposition, compositionEquipment, EQUIPMENT_KEYS, formationComposition,
  resizeComposition, sumEquipment, unitTypeAvailability, validateComposition } from "../src/js/game/troops.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = { width: 4, height: 3, terrain: Array(12).fill("plain"), attackerStarts: [{ x: 0, y: 1 }], defenderStarts: [{ x: 3, y: 1 }] };
const composition = { infantry: 1000, archer: 500, heavyInfantry: 500, crossbowman: 500, cavalry: 500 };
const defenders = [{ officerIds: ["guard"], troops: 4000, composition: { infantry: 1000, heavyInfantry: 1000, crossbowman: 1000, cavalry: 1000 } }];
function fixture() {
  const city = (id, factionId, officerIds, extra = {}) => ({ id, name: id, factionId, officerIds, governorId: officerIds[0] ?? null,
    adjacent: ["source", "target", "home"].filter((other) => other !== id), troops: 20000, gold: 20000, food: 100000,
    horses: 5000, crossbows: 5000, armor: 5000, training: 80, morale: 80, popularSupport: 70, ...extra });
  const officer = (id, factionId, locationCityId) => ({ id, name: id, factionId, locationCityId, status: "active", rank: "君主",
    war: 80, intelligence: 80, leadership: 80, politics: 80, charm: 80, acted: false, merit: 0 });
  return { year: 196, month: 11, elapsedMonths: 3, playerFactionId: "a", commandsRemaining: 6, commandsMax: 6, tasks: [], eventLog: [],
    factions: [{ id: "a", name: "甲", unlockedTechnologies: [] }, { id: "b", name: "乙", unlockedTechnologies: [] }],
    cities: [city("source", "a", ["leader"]), city("target", "b", ["guard"], { troops: 4000, horses: 2000, crossbows: 2000, armor: 2000 }),
      city("home", "b", [], { troops: 1000, horses: 0, crossbows: 0, armor: 0 })],
    officers: [officer("leader", "a", "source"), officer("guard", "b", "target")] };
}
const stores = (city) => Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, city[key] ?? 0]));
function launch() {
  const state = fixture();
  const before = structuredClone(state);
  const army = validateArmy(state, "source", "target", [{ officerIds: ["leader"], troops: 3000, composition }], rules,
    { food: dailyFoodCost(3000, rules) * rules.army.maxSupplyDays, gold: 100 });
  assert.equal(army.ok, true, army.message);
  assert.equal(commitArmyDeparture(state, army).ok, true);
  const battle = new BattleEngine({ state, sourceCity: army.city, targetCity: army.target, officers: state.officers,
    divisions: army.divisions, defenderDivisions: defenders, supplies: army.supplies, rules, map });
  return { state, before, army, battle };
}

test("eleven data-driven types expose only the first five initially and preserve a future officer unlock hook", () => {
  const state = fixture();
  assert.equal(Object.keys(rules.troopTypes).length, 11);
  assert.deepEqual(Object.keys(rules.troopTypes).filter((id) => unitTypeAvailability(id, { state, factionId: "a", rules }).available),
    ["infantry", "archer", "heavyInfantry", "crossbowman", "cavalry"]);
  state.factions[0].unlockedTechnologies.push("heavyCavalry");
  assert.equal(unitTypeAvailability("heavyCavalry", { state, factionId: "a", rules }).available, true);
  assert.equal(unitTypeAvailability("heavyCavalry", { state, factionId: "b", rules }).available, false);
  assert.equal(unitTypeAvailability("elephant", { state, factionId: "a", rules, unlockByOfficer: (id) => id === "elephant" }).available, true);
});

test("composite troop equipment follows all seven equipment combinations exactly", () => {
  assert.deepEqual(compositionEquipment({ infantry: 50, archer: 50, heavyInfantry: 10, crossbowman: 20, cavalry: 30,
    raiderCavalry: 40, heavyCavalry: 50, guard: 60, dragoon: 70, elephant: 100, rattan: 100 }, rules),
  { horses: 190, crossbows: 190, armor: 190 });
});

test("mixed types expose weighted coefficients and additive total firepower from the actual shooters", () => {
  const stats = aggregateTroopStats({ infantry: 900, archer: 100 }, rules);
  assert.equal(stats.attack, 0.975);
  assert.equal(stats.defense, 0.98);
  assert.equal(stats.rangedTroops, 100);
  assert.equal(stats.range, 2);
  assert.equal(stats.rangedAttack, 0.095);
  assert.equal(stats.meleeAttackTotal, 975);
  assert.equal(stats.rangedAttackTotal, 95);
  assert.equal(stats.rangedDefense, 0.975);
  assert.equal(stats.vision, 4);
  assert.equal(aggregateTroopStats({ infantry: 1000 }, rules).range, 0);
  assert.equal(aggregateTroopStats({ infantry: 500, cavalry: 500 }, rules).actionPoints, 7);
  assert.equal(aggregateTroopStats({ infantry: 500, cavalry: 500 }, rules).vision, 4.5);
});

test("adding non-shooters cannot dilute ranged firepower, and a single shooter still contributes", () => {
  const archers = aggregateTroopStats({ archer: 1000 }, rules);
  const mixed = aggregateTroopStats({ archer: 1000, infantry: 9000 }, rules);
  assert.equal(archers.rangedAttackTotal, 950);
  assert.equal(mixed.rangedAttackTotal, archers.rangedAttackTotal);
  assert.equal(mixed.rangedTroops, archers.rangedTroops);
  assert.ok(mixed.meleeAttackTotal > archers.meleeAttackTotal);
  const single = aggregateTroopStats({ archer: 1, infantry: 9999 }, rules);
  assert.equal(single.rangedTroops, 1);
  assert.equal(single.rangedAttackTotal, 0.95);
  assert.equal(single.range, 2);
});

test("every troop has separate ranged protection and vision values in the data file", () => {
  for (const type of Object.values(rules.troopTypes)) {
    assert.ok(Number.isFinite(type.rangedDefense) && type.rangedDefense > 0);
    assert.ok(Number.isFinite(type.vision) && type.vision > 0);
  }
  assert.ok(rules.troopTypes.heavyInfantry.rangedDefense > rules.troopTypes.infantry.rangedDefense);
  assert.ok(rules.troopTypes.cavalry.vision > rules.troopTypes.infantry.vision);
});

test("old formations read as a composition, but malformed or locked compositions never validate", () => {
  assert.deepEqual(formationComposition({ troops: 700, unitType: "cavalry" }, rules), { cavalry: 700 });
  const state = fixture();
  for (const entry of [{ troops: 10, composition: { infantry: 9 } }, { troops: 10, composition: { infantry: -10 } },
    { troops: 10, composition: { infantry: 10.5 } }, { troops: 10, composition: { ghost: 10 } }, { troops: 10, composition: { heavyCavalry: 10 } }]) {
    assert.equal(validateComposition(entry, { state, factionId: "a", rules }).ok, false);
  }
});

test("integer casualty allocation conserves soldiers at arbitrary ratios and repeated one-soldier losses", () => {
  for (let total = 0; total < 41; total += 1) {
    const resized = resizeComposition({ infantry: 17, archer: 11, cavalry: 13 }, total);
    assert.equal(Object.values(resized).reduce((sum, count) => sum + count, 0), total);
    assert.ok(Object.values(resized).every((count) => Number.isSafeInteger(count) && count >= 0));
  }
  const unit = { troops: 41, composition: { infantry: 17, archer: 11, cavalry: 13 } };
  for (let before = 41; before > 0; before -= 1) {
    assert.equal(applyFormationLosses(unit, 1, rules), 1);
    assert.equal(Object.values(unit.composition).reduce((sum, count) => sum + count, 0), before - 1);
  }
  assert.equal(applyFormationLosses(unit, 100, rules), 0);
});

test("departure consumes equipment exactly once and rejects overbooked or locked groups atomically", () => {
  const { state, army } = launch();
  assert.deepEqual(stores(state.cities[0]), { horses: 4500, crossbows: 4500, armor: 4500 });
  assert.equal(commitArmyDeparture(state, army).ok, false);
  for (const mutate of [(s) => { s.cities[0].horses = 499; }, (s) => { s.cities[0].armor = 0; }]) {
    const fresh = fixture(); mutate(fresh);
    const before = structuredClone(fresh);
    const checked = validateArmy(fresh, "source", "target", [{ officerIds: ["leader"], troops: 3000, composition }], rules);
    assert.equal(checked.ok, false); assert.deepEqual(fresh, before);
  }
  const fresh = fixture();
  assert.equal(validateArmy(fresh, "source", "target", [{ officerIds: ["leader"], troops: 1000, composition: { heavyCavalry: 1000 } }], rules).ok, false);
});

test("auto-composition shares one equipment budget across groups and never uses a general's free cavalry preference", () => {
  const state = fixture();
  state.officers[0].unitType = "cavalry";
  Object.assign(state.cities[0], { horses: 17, crossbows: 23, armor: 31 });
  const before = structuredClone(state);
  const formed = createDefenderFormations(state.cities[0], state.officers, rules, { state });
  assert.deepEqual(sumEquipment(formed, rules), { horses: 17, crossbows: 23, armor: 31 });
  assert.ok(formed.every((unit) => unit.composition.infantry > 0 && unit.composition.archer > 0));
  assert.deepEqual(state, before);
});

test("a rejected queued march refunds every reserved equipment piece exactly once", () => {
  const state = fixture();
  const initial = stores(state.cities[0]);
  const result = queueTask(state, { kind: "march", cityId: "source", officerIds: ["leader"],
    payload: { targetId: "target", divisions: [{ officerIds: ["leader"], troops: 3000, composition }],
      supplies: { food: dailyFoodCost(3000, rules) * rules.army.maxSupplyDays, gold: 50 } } }, rules);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(stores(state.cities[0]), { horses: 4500, crossbows: 4500, armor: 4500 });
  state.cities[1].factionId = "a";
  settleTasks(state, rules);
  assert.deepEqual(stores(state.cities[0]), initial);
  settleTasks(state, rules);
  assert.deepEqual(stores(state.cities[0]), initial);
});

test("retreat returns only surviving attacker gear and reconciles the defender warehouse without copying gear", () => {
  const { state, battle } = launch();
  applyFormationLosses(battle.livingUnits("ally")[0], 600, rules);
  applyFormationLosses(battle.livingUnits("enemy")[0], 1000, rules);
  const result = settlePlayerBattle(state, battle, "enemy");
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(stores(state.cities[0]), { horses: 4900, crossbows: 4900, armor: 4900 });
  assert.deepEqual(stores(state.cities[1]), { horses: 1750, crossbows: 1750, armor: 1750 });
  const snapshot = structuredClone(state);
  assert.equal(settlePlayerBattle(state, battle, "enemy").ok, false);
  assert.deepEqual(state, snapshot);
});

test("victory deposits surviving attacking equipment at the occupied city, not back in its origin", () => {
  const { state, battle } = launch();
  applyFormationLosses(battle.livingUnits("ally")[0], 600, rules);
  applyFormationLosses(battle.livingUnits("enemy")[0], 1000, rules);
  Object.assign(battle, { status: "ended", winner: "ally" });
  const result = settlePlayerBattle(state, battle, "ally");
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(stores(state.cities[0]), { horses: 4500, crossbows: 4500, armor: 4500 });
  assert.deepEqual(stores(state.cities[1]), { horses: 2150, crossbows: 2150, armor: 2150 });
});

test("defender withdrawal carries survivor equipment to the retreat city instead of duplicating captured gear", () => {
  const { state, army } = launch();
  state.playerFactionId = "b";
  const invasion = { id: "inv", sourceId: "source", targetId: "target", attackerFactionId: "a", defenderFactionId: "b",
    officerIds: ["leader"], divisions: army.divisions, troops: 3000, equipment: army.equipment, training: 80, morale: 80, supplies: army.supplies, resolved: false };
  state.pendingInvasions = [invasion];
  const result = createInvasionBattle(state, "inv", rules, map, { defenderDivisions: defenders });
  assert.equal(result.ok, true, result.message);
  const battle = result.battle;
  applyFormationLosses(battle.livingUnits("ally")[0], 600, rules);
  applyFormationLosses(battle.livingUnits("enemy")[0], 1000, rules);
  const settled = settleDefensiveBattle(state, battle, "ally", { retreated: true });
  assert.equal(settled.ok, true, settled.message);
  assert.deepEqual(stores(state.cities[1]), { horses: 1400, crossbows: 1400, armor: 1400 });
  assert.deepEqual(stores(state.cities[2]), { horses: 750, crossbows: 750, armor: 750 });
});

test("cancelled invasions return their reserved mixed equipment, while old cavalry orders mint no horses", () => {
  for (const legacy of [false, true]) {
    const { state, army } = launch();
    const invasion = { id: "inv", sourceId: "source", targetId: "target", attackerFactionId: "a", defenderFactionId: "b",
      officerIds: ["leader"], divisions: legacy ? [{ officerId: "leader", troops: 3000, unitType: "cavalry" }] : army.divisions,
      troops: 3000, training: 80, morale: 80, supplies: army.supplies, resolved: false, ...(legacy ? {} : { equipment: army.equipment }) };
    state.pendingInvasions = [invasion]; state.cities[1].factionId = "a";
    const result = autoResolveInvasion(state, invasion, rules);
    assert.equal(result.ok, true);
    assert.deepEqual(stores(state.cities[0]), legacy ? { horses: 4500, crossbows: 4500, armor: 4500 } : { horses: 5000, crossbows: 5000, armor: 5000 });
  }
});

test("automatic campaign combat applies the shared final panel once, including independent ranged protection", () => {
  const { state, army } = launch();
  const custom = structuredClone(rules);
  custom.battle.combatStats = { ...(custom.battle.combatStats ?? {}), warDivisor: 120, trainingAttackDivisor: 250 };
  const target = state.cities[1];
  const targetComposition = autoComposition(target.troops, stores(target), { state, factionId: "b", officers: [state.officers[1]], rules: custom });
  const attack = calculateCombatStats({ troops: 3000, composition, officers: [state.officers[0]], training: 80, morale: 80 }, custom);
  const defense = calculateCombatStats({ troops: target.troops, composition: targetComposition, officers: [state.officers[1]], training: target.training, morale: target.morale }, custom);
  const invasion = { id: "panel-invasion", sourceId: "source", targetId: "target", attackerFactionId: "a", defenderFactionId: "b",
    officerIds: ["leader"], divisions: army.divisions, troops: 3000, equipment: army.equipment, training: 80, morale: 80, supplies: army.supplies, resolved: false };
  state.pendingInvasions = [invasion];
  const result = autoResolveInvasion(state, invasion, custom, "defend", () => 0.5);
  assert.equal(result.ok, true);
  assert.equal(result.dailyLog[0].attackerLoss, Math.floor((defense.meleeAttack / attack.meleeDefense + defense.rangedAttack * 0.5 / attack.rangedDefense) * 1.18 * 0.065));
  assert.equal(result.dailyLog[0].defenderLoss, Math.floor((attack.meleeAttack / defense.meleeDefense + attack.rangedAttack * 0.5 / defense.rangedDefense) * 0.065));
});
