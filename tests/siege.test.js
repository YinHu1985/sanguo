import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { createSiegeState, damageSiegeLayers, effectiveTroops, evaluateSiegeDay, interceptionLosses } from "../src/js/game/siege.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const baseRules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const baseMap = JSON.parse(await readFile(new URL("./fixtures/battle-map-small.json", import.meta.url), "utf8"));

function makeBattle(options = {}) {
  const sourceCity = structuredClone(scenario.cities.find((city) => city.id === "xiaopei"));
  const targetCity = { ...structuredClone(scenario.cities.find((city) => city.id === "puyang")),
    troops: 12000, food: 100000, gold: 1000, defense: 80, wallLevel: 2, ...options.targetCity };
  const rules = structuredClone(baseRules);
  rules.battle.siege = { ...rules.battle.siege, ...options.siege };
  return new BattleEngine({ sourceCity, targetCity,
    divisions: options.divisions ?? [{ officerIds: ["guan-yu", "zhang-fei"], troops: 8000, unitType: "infantry" }],
    defenderDivisions: options.defenderDivisions,
    officers: options.officers ?? structuredClone(scenario.officers), rules, map: options.map ?? structuredClone(baseMap),
    mode: options.mode ?? "field", playerSide: options.playerSide ?? "ally", canDefenderRetreat: options.canDefenderRetreat ?? true,
    supplies: options.supplies ?? { food: 100000, gold: 1000 }, rng: options.rng ?? (() => 0.99) });
}

function activate(battle, side) {
  const unit = battle.fieldUnits(side)[0];
  battle.queue = [unit.id, ...battle.queue.filter((id) => id !== unit.id)];
  return unit;
}

function siegeReady(options = {}) {
  const battle = makeBattle({ ...options, mode: "siege" });
  assert.equal(battle.phase, "siege_transition");
  assert.equal(battle.pendingDecision.kind, "encirclement");
  assert.equal(battle.chooseTransition(options.encirclement ?? "open").ok, true);
  return battle;
}

const army = (troops = 10000) => ({ troops, war: 80, intelligence: 80, leadership: 80, politics: 70, charm: 70, training: 80, morale: 80 });
const dayInput = (overrides = {}) => ({ attacker: army(), defender: army(), attackOrder: "ram", defenseOrder: "rotate",
  wallLevel: 2, cityDefense: 80, encirclement: "open", ...overrides });

test("multi-officer formations share one troop pool and take all five maximum abilities", () => {
  const battle = makeBattle();
  const unit = battle.livingUnits("ally")[0];
  const commanders = scenario.officers.filter((officer) => unit.officerIds.includes(officer.id));
  assert.equal(battle.livingUnits("ally").length, 1);
  assert.equal(unit.troops, 8000);
  assert.deepEqual(unit.officerIds, ["guan-yu", "zhang-fei"]);
  assert.equal(unit.officerId, "guan-yu");
  assert.equal(unit.commandLimit, baseRules.ranks["大将"]);
  for (const key of ["war", "intelligence", "leadership", "politics", "charm"]) {
    assert.equal(unit[key], Math.max(...commanders.map((officer) => officer[key])));
  }
});

test("grouped officers cannot be reused in another attacking formation", () => {
  assert.throws(() => makeBattle({ divisions: [
    { officerIds: ["guan-yu", "zhang-fei"], troops: 2000 }, { officerId: "zhang-fei", troops: 2000 }
  ] }), /重复编组/);
});

test("missing and overlapping deployment starts are repaired with distinct traversable positions", () => {
  const map = structuredClone(baseMap);
  map.attackerStarts = [{ x: 0, y: 2 }];
  map.defenderStarts = [{ x: 0, y: 2 }];
  const battle = makeBattle({ map, divisions: [
    { officerId: "liu-bei", troops: 1000 }, { officerId: "guan-yu", troops: 1000 },
    { officerId: "zhang-fei", troops: 1000 }, { officerId: "jian-yong", troops: 1000 }
  ] });
  const positions = battle.units.map((unit) => `${unit.position.x},${unit.position.y}`);
  assert.equal(new Set(positions).size, battle.units.length);
  assert.ok(battle.units.every((unit) => Number.isFinite(battle.movementCostAt(unit.position.x, unit.position.y))));
});

test("selected field troops stay selected while remaining soldiers and commanders support siege from the city", () => {
  const battle = makeBattle({ defenderDivisions: [{ officerIds: ["xiahou-dun"], troops: 2000 }] });
  assert.equal(battle.fieldUnits("enemy")[0].troops, 2000);
  assert.equal(battle.defenderReserveTroops, 10000);
  assert.equal(battle.getArmyStats("enemy").troops, 12000);
  assert.equal(battle.getArmyStats("enemy").intelligence, 92, "Cheng Yu's city intelligence supports siege despite not joining the field force");
  const day = battle.day;
  while (battle.day === day) battle.wait();
  assert.equal(battle.fieldUnits("enemy")[0].troops, 2000);
  assert.equal(battle.defenderReserveTroops, 10000);
});

test("only the unique main stronghold changes field combat into a siege", () => {
  const battle = makeBattle({ map: { ...structuredClone(baseMap), stronghold: { x: 8, y: 3 } } });
  const invader = activate(battle, "ally");
  battle.fieldUnits("enemy").forEach((unit) => { unit.position = { x: 8, y: 0 }; });
  invader.position = { x: 6, y: 3 };
  const troopsBefore = battle.getArmyStats("ally").troops;
  const storesBefore = structuredClone(battle.supplies);
  assert.equal(battle.moveStep(7, 3).ok, true);
  assert.equal(battle.phase, "field", "ordinary fort terrain is not a second main stronghold");
  const result = battle.moveStep(8, 3);
  assert.equal(result.phaseChanged, true);
  assert.equal(battle.phase, "siege_transition");
  assert.deepEqual(battle.pendingDecision, { side: "enemy", kind: "external", options: ["return", "retreat"] });
  assert.equal(battle.day, 1);
  assert.equal(battle.getArmyStats("ally").troops, troopsBefore);
  assert.deepEqual(battle.supplies, storesBefore);
  assert.equal(battle.moveStep(8, 4).ok, false);
});

test("field defenders can return to the city and the last return starts siege without a defeat", () => {
  const battle = makeBattle({ playerSide: "enemy", defenderDivisions: [{ officerIds: ["xiahou-dun"], troops: 2000 }] });
  const defender = activate(battle, "enemy");
  const suppliesBefore = structuredClone(battle.supplies);
  const result = battle.retreatToCity(defender.id);
  assert.equal(result.ok, true);
  assert.equal(result.phaseChanged, true);
  assert.equal(battle.status, "active");
  assert.equal(battle.fieldUnits("enemy").length, 0);
  assert.equal(battle.livingUnits("enemy")[0].troops, 2000);
  assert.equal(defender.inCity, true);
  assert.equal(battle.unitAt(defender.position.x, defender.position.y), undefined);
  assert.equal(battle.phase, "siege_transition");
  assert.equal(battle.pendingDecision.kind, "encirclement");
  assert.deepEqual(battle.supplies, suppliesBefore);
});

test("direct siege skips external-army decisions and retains city money, troops, and all commander abilities", () => {
  const battle = makeBattle({ mode: "siege", defenderDivisions: [{ officerIds: ["xiahou-dun"], troops: 2000 }] });
  assert.equal(battle.pendingDecision.kind, "encirclement");
  assert.equal(battle.getArmyStats("enemy").troops, 12000);
  assert.equal(battle.getArmyStats("enemy").intelligence, 92);
  assert.equal(battle.supplies.enemy.gold, 1000);
  assert.equal(battle.supplies.enemy.food, 100000 - battle.dailyFoodNeed("enemy"));
  assert.equal(battle.fieldUnits("enemy").length, 0);
});

test("outer army return allows a single deception response, then encirclement, without spending another day", () => {
  const battle = makeBattle({ rng: () => 0 });
  battle.enterSiege();
  const stores = structuredClone(battle.supplies);
  assert.equal(battle.chooseTransition("deceive").ok, false);
  assert.equal(battle.chooseTransition("return").ok, true);
  assert.equal(battle.pendingDecision.kind, "response");
  assert.equal(battle.chooseTransition("deceive").ok, true);
  assert.equal(battle.pendingDecision.kind, "encirclement");
  assert.equal(battle.cityDefense, 70);
  assert.equal(battle.siege.hp, battle.siege.maxHp - 25);
  assert.equal(battle.chooseTransition("deceive").ok, false);
  assert.equal(battle.chooseTransition("open").ok, true);
  assert.equal(battle.phase, "siege");
  assert.equal(battle.day, 1);
  assert.deepEqual(battle.supplies, stores);
});

test("interception hurts only the returning field soldiers, never city reserves", () => {
  const battle = makeBattle({ defenderDivisions: [{ officerIds: ["xiahou-dun"], troops: 2000 }] });
  battle.enterSiege();
  battle.chooseTransition("return");
  const reserve = battle.defenderReserveTroops;
  battle.chooseTransition("intercept");
  assert.equal(battle.defenderReserveTroops, reserve);
  assert.ok(battle.livingUnits("enemy")[0].troops < 2000);
  assert.ok(battle.getArmyStats("ally").troops < 8000);
  assert.equal(battle.pendingDecision.kind, "encirclement");
});

test("outer retreat preserves escaped soldiers and excludes their commanders and rations from the siege", () => {
  const battle = makeBattle({ defenderDivisions: [{ officerIds: ["cheng-yu"], troops: 2000 }] });
  battle.enterSiege();
  assert.equal(battle.getArmyStats("enemy").intelligence, 92);
  const result = battle.chooseTransition("retreat");
  assert.equal(result.ok, true);
  assert.equal(battle.escapedDefenderUnits.length, 1);
  assert.equal(battle.escapedDefenderUnits[0].troops, 2000);
  assert.equal(battle.units.some((unit) => unit.officerIds.includes("cheng-yu")), false);
  assert.equal(battle.getArmyStats("enemy").troops, 10000);
  assert.equal(battle.getArmyStats("enemy").intelligence, 61);
  assert.equal(battle.dailyFoodNeed("enemy"), 40);
  assert.equal(battle.pendingDecision.kind, "encirclement");
});

test("no remaining friendly city forbids both outside withdrawal and full defending retreat", () => {
  const battle = makeBattle({ canDefenderRetreat: false, playerSide: "enemy" });
  battle.enterSiege();
  assert.deepEqual(battle.pendingDecision.options, ["return"]);
  assert.equal(battle.chooseTransition("retreat").ok, false);
  assert.equal(battle.retreatArmy().ok, false);
  assert.equal(battle.escapedDefenderUnits.length, 0);
});

test("wall level changes only the single HP length; milestones never create extra segments", () => {
  assert.equal(createSiegeState(1).maxHp, 100);
  assert.equal(createSiegeState(2).maxHp, 160);
  assert.equal(createSiegeState(3).maxHp, 220);
  assert.equal(effectiveTroops(100000, 1), 30000);
  assert.equal(effectiveTroops(100000, 2), 30000);
  assert.equal(effectiveTroops(100000, 3), 30000);
  const state = createSiegeState(3);
  assert.deepEqual(damageSiegeLayers(state, 100).breached, ["瓮城"]);
  assert.equal(state.hp, 120);
  assert.equal(state.layers, undefined);
  assert.equal(damageSiegeLayers(state, 150).conquered, true);
});

test("encirclement adds wall length without also increasing attack progress or resetting earned progress", () => {
  const battle = makeBattle({ rng: () => 0 });
  battle.enterSiege();
  battle.chooseTransition("return");
  battle.chooseTransition("deceive");
  battle.chooseTransition("encircle");
  assert.equal(battle.siege.maxHp, 200);
  assert.equal(battle.siege.hp, 175);
  const open = evaluateSiegeDay(dayInput(), baseRules);
  const closed = evaluateSiegeDay(dayInput({ encirclement: "encircle" }), baseRules);
  assert.equal(closed.progress, open.progress);
});

test("siege losses depend on opposing effective strength while progress depends on own attacking strength", () => {
  const normal = evaluateSiegeDay(dayInput(), baseRules);
  const moreAttackers = evaluateSiegeDay(dayInput({ attacker: army(20000) }), baseRules);
  const moreDefenders = evaluateSiegeDay(dayInput({ defender: army(20000) }), baseRules);
  assert.equal(moreAttackers.attackerLoss, normal.attackerLoss);
  assert.ok(moreAttackers.defenderLoss > normal.defenderLoss);
  assert.ok(moreAttackers.progress > normal.progress);
  assert.equal(moreDefenders.defenderLoss, normal.defenderLoss);
  assert.ok(moreDefenders.attackerLoss > normal.attackerLoss);
  assert.equal(moreDefenders.progress, normal.progress);
  const capped = evaluateSiegeDay(dayInput({ attacker: army(100000), defender: army(100000), wallLevel: 1 }), baseRules);
  const atCap = evaluateSiegeDay(dayInput({ attacker: army(30000), defender: army(30000), wallLevel: 1 }), baseRules);
  assert.deepEqual(capped, atCap);
});

test("fortification slows progress and different attack and defense commands create distinct effects", () => {
  const protectedWall = evaluateSiegeDay(dayInput({ cityDefense: 100 }), baseRules);
  const ruinedWall = evaluateSiegeDay(dayInput({ cityDefense: 0 }), baseRules);
  assert.ok(ruinedWall.progress > protectedWall.progress);
  const ram = evaluateSiegeDay(dayInput(), baseRules);
  const assault = evaluateSiegeDay(dayInput({ attackOrder: "assault" }), baseRules);
  const tunnel = evaluateSiegeDay(dayInput({ attackOrder: "tunnel" }), baseRules);
  const repair = evaluateSiegeDay(dayInput({ defenseOrder: "repair" }), baseRules);
  const sortie = evaluateSiegeDay(dayInput({ defenseOrder: "sortie" }), baseRules, () => 0);
  assert.ok(assault.progress > ram.progress);
  assert.ok(assault.attackerLoss > ram.attackerLoss);
  assert.ok(tunnel.defenseDamage > ram.defenseDamage);
  assert.ok(repair.defenderLoss > ram.defenderLoss);
  assert.ok(repair.repair > ram.repair);
  assert.ok(sortie.attackerLoss > ram.attackerLoss);
  assert.ok(sortie.defenderLoss > ram.defenderLoss);
});

test("both sides must submit exactly one command before a siege day resolves", () => {
  const battle = siegeReady();
  const stores = structuredClone(battle.supplies);
  const troops = battle.getArmyStats("ally").troops;
  assert.equal(battle.siegeOrder("ally", "ram").waiting, true);
  assert.equal(battle.day, 1);
  assert.deepEqual(battle.supplies, stores);
  assert.equal(battle.getArmyStats("ally").troops, troops);
  assert.equal(battle.siegeOrder("ally", "assault").ok, false);
  assert.equal(battle.siegeOrder("enemy", "ram").ok, false);
  const result = battle.siegeOrder("enemy", "rotate");
  assert.equal(result.dayCompleted, true);
  assert.equal(battle.day, 2);
  assert.deepEqual(battle.siege.orders, { ally: null, enemy: null });
  assert.equal(battle.supplies.ally.food, stores.ally.food - battle.dailyFoodNeed("ally"));
  assert.equal(battle.supplies.enemy.food, stores.enemy.food - battle.dailyFoodNeed("enemy"));
  assert.equal(battle.cityDefense, 78);
  assert.ok(battle.getArmyStats("ally").troops < troops);
});

test("field and siege share thirty days and never charge a thirty-first day", () => {
  const battle = makeBattle({ siege: { layerHp: 100000, attackerLossRate: 0, defenderLossRate: 0 } });
  while (battle.day < 29) battle.wait();
  const storesAtDay29 = structuredClone(battle.supplies);
  battle.enterSiege();
  battle.chooseTransition("return");
  battle.chooseTransition("deceive");
  battle.chooseTransition("open");
  assert.deepEqual(battle.supplies, storesAtDay29);
  for (let index = 0; index < 2; index += 1) {
    battle.siegeOrder("ally", "ram");
    battle.siegeOrder("enemy", "rotate");
  }
  assert.equal(battle.status, "ended");
  assert.equal(battle.day, 30);
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.outcomeType, "time");
  assert.equal(battle.supplies.ally.food, storesAtDay29.ally.food - battle.dailyFoodNeed("ally"));
  assert.equal(battle.supplies.enemy.food, storesAtDay29.enemy.food - battle.dailyFoodNeed("enemy"));
});

test("ongoing siege starvation uses mutable live stores and surviving troop consumption", () => {
  const battle = siegeReady({ supplies: { food: 32, gold: 1000 }, siege: { attackerLossRate: 0, defenderLossRate: 0 } });
  assert.equal(battle.supplies.ally.food, 0);
  battle.supplies.ally.food += 32;
  battle.siegeOrder("ally", "ram");
  battle.siegeOrder("enemy", "rotate");
  assert.equal(battle.day, 2);
  assert.equal(battle.status, "active");
  battle.siegeOrder("ally", "ram");
  battle.siegeOrder("enemy", "rotate");
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.outcomeType, "supply");
});

test("breaking the last wall ends the siege and does not consume tomorrow's food", () => {
  const battle = siegeReady({ targetCity: { wallLevel: 1 }, siege: { hitPointsByLevel: { 1: 0.1 } } });
  const stores = structuredClone(battle.supplies);
  battle.siegeOrder("ally", "assault");
  const result = battle.siegeOrder("enemy", "rotate");
  assert.equal(result.battleEnded, true);
  assert.equal(battle.winner, "ally");
  assert.equal(battle.outcomeType, "siege");
  assert.equal(battle.siege.hp, 0);
  assert.equal(battle.day, 1);
  assert.deepEqual(battle.supplies, stores);
});

test("open encirclement permits a lossless retreat of deployed and reserve defenders", () => {
  const battle = siegeReady({ playerSide: "enemy", defenderDivisions: [{ officerIds: ["xiahou-dun"], troops: 2000 }] });
  const result = battle.retreatArmy();
  assert.equal(result.ok, true);
  assert.equal(result.safeRetreat, true);
  assert.equal(result.losses, 0);
  assert.equal(result.escapedTroops, 12000);
  assert.equal(battle.escapedDefenderUnits.reduce((sum, unit) => sum + unit.troops, 0), 12000);
  assert.equal(battle.getArmyStats("enemy").troops, 0);
  assert.equal(battle.defenderReserveTroops, 0);
  assert.equal(battle.livingUnits("enemy").length, 0);
  assert.equal(battle.defenderRetreated, true);
  assert.equal(battle.winner, "ally");
});

test("encircled defenders suffer pursuit while attacking retreat still returns a defender win", () => {
  const battle = siegeReady({ playerSide: "enemy", encirclement: "encircle" });
  const result = battle.retreatArmy();
  assert.ok(result.losses > 0);
  assert.equal(result.escapedTroops + result.losses, 12000);
  assert.equal(result.safeRetreat, false);
  const attacker = siegeReady();
  assert.equal(attacker.retreatArmy().winner, "enemy");
});

test("AI handles only its own transitions and daily orders, and cannot decide for the player", () => {
  const attackerPlayer = makeBattle();
  attackerPlayer.enterSiege();
  assert.equal(attackerPlayer.runAISiegeDecision().ok, true);
  assert.equal(attackerPlayer.pendingDecision.kind, "response");
  assert.equal(attackerPlayer.runAISiegeDecision().ok, false);
  attackerPlayer.chooseTransition("deceive");
  assert.equal(attackerPlayer.runAISiegeDecision().ok, false);
  attackerPlayer.chooseTransition("open");
  assert.equal(attackerPlayer.runAISiegeDecision().ok, true);
  assert.ok(attackerPlayer.siege.orders.enemy);
  assert.equal(attackerPlayer.siege.orders.ally, null);
  assert.equal(attackerPlayer.runAISiegeDecision().ok, false);

  const defenderPlayer = makeBattle({ playerSide: "enemy", mode: "siege" });
  assert.equal(defenderPlayer.runAISiegeDecision().ok, true);
  assert.equal(defenderPlayer.phase, "siege");
  assert.equal(defenderPlayer.runAISiegeDecision().ok, true);
  assert.ok(defenderPlayer.siege.orders.ally);
  assert.equal(defenderPlayer.siege.orders.enemy, null);
});

test("morale changes clamp both deployed troops and city reserves", () => {
  const battle = makeBattle({ defenderDivisions: [{ officerIds: ["xiahou-dun"], troops: 2000 }] });
  battle.changeMorale("enemy", -1000);
  assert.equal(battle.getArmyStats("enemy").morale, 0);
  assert.equal(battle.defenderReserveMorale, 0);
  battle.changeMorale("enemy", 1000);
  assert.equal(battle.getArmyStats("enemy").morale, 100);
  assert.equal(battle.defenderReserveMorale, 100);
  assert.equal(battle.changeMorale("unknown", 10).ok, false);
});

test("tunnel intelligence success and failure change progress and both casualty counts", () => {
  const input = dayInput({ attackOrder: "tunnel" });
  const success = evaluateSiegeDay(input, baseRules, () => 0);
  const failure = evaluateSiegeDay(input, baseRules, () => 0.99);
  assert.equal(success.strategyResults[0].success, true);
  assert.equal(failure.strategyResults[0].success, false);
  assert.ok(success.progress > failure.progress);
  assert.ok(success.attackerLoss < failure.attackerLoss);
  assert.ok(success.defenderLoss > failure.defenderLoss);
  const clever = evaluateSiegeDay({ ...input, attacker: { ...army(), intelligence: 100 }, defender: { ...army(), intelligence: 20 } }, baseRules, () => 0.6);
  const outwitted = evaluateSiegeDay({ ...input, attacker: { ...army(), intelligence: 20 }, defender: { ...army(), intelligence: 100 } }, baseRules, () => 0.6);
  assert.equal(clever.strategyResults[0].success, true);
  assert.equal(outwitted.strategyResults[0].success, false);
});

test("sortie uses defending intelligence and success suppresses advance with fewer defender casualties", () => {
  const input = dayInput({ defenseOrder: "sortie" });
  const success = evaluateSiegeDay(input, baseRules, () => 0);
  const failure = evaluateSiegeDay(input, baseRules, () => 0.99);
  assert.equal(success.strategyResults[0].side, "enemy");
  assert.ok(success.progress < failure.progress);
  assert.ok(success.attackerLoss > failure.attackerLoss);
  assert.ok(success.defenderLoss < failure.defenderLoss);
  const battle = siegeReady({ rng: () => 0 });
  battle.siegeOrder("ally", "tunnel");
  battle.siegeOrder("enemy", "sortie");
  assert.ok(battle.log.some((entry) => /地道成功/.test(entry.message)));
  assert.ok(battle.log.some((entry) => /袭扰成功/.test(entry.message)));
});

test("repair restores the single HP pool without repeating milestone announcements or exceeding maximum", () => {
  const battle = siegeReady();
  damageSiegeLayers(battle.siege, battle.siege.maxHp - 40);
  const milestones = [...battle.siege.breachedMilestones];
  battle.siegeOrder("ally", "ram");
  const result = battle.siegeOrder("enemy", "repair");
  assert.deepEqual(battle.siege.breachedMilestones, milestones);
  assert.ok(Math.abs(battle.siege.hp - (45 - result.progress)) < 0.00001);
  battle.siege.hp = battle.siege.maxHp - 1;
  battle.siegeOrder("ally", "ram");
  const next = battle.siegeOrder("enemy", "repair");
  assert.ok(Math.abs(battle.siege.hp - (battle.siege.maxHp - next.progress)) < 0.00001);
});

test("interception compares war and leadership as well as opposing capped troop numbers", () => {
  const strong = { ...army(), war: 100, leadership: 100 };
  const weak = { ...army(), war: 20, leadership: 20 };
  const advantage = interceptionLosses(strong, weak, 1, baseRules);
  const disadvantage = interceptionLosses(weak, strong, 1, baseRules);
  assert.ok(advantage.defenderLoss > disadvantage.defenderLoss);
  assert.ok(advantage.attackerLoss < disadvantage.attackerLoss);
  assert.deepEqual(interceptionLosses({ ...strong, troops: 100000 }, { ...weak, troops: 100000 }, 1, baseRules),
    interceptionLosses({ ...strong, troops: 30000 }, { ...weak, troops: 30000 }, 1, baseRules));
});

test("all real attacking commanders remain available to siege even when their former troop pool is empty", () => {
  const battle = makeBattle({ divisions: [
    { officerIds: ["guan-yu"], troops: 3000 }, { officerIds: ["zhang-fei"], troops: 3000 }
  ] });
  const clever = battle.units.find((unit) => unit.officerIds.includes("guan-yu"));
  clever.troops = 0;
  assert.equal(battle.getArmyStats("ally").troops, 3000);
  assert.equal(battle.getArmyStats("ally").intelligence, 75);
  assert.equal(battle.getArmyStats("ally").leadership, 94);
});
