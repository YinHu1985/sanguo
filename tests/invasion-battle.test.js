import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInvasionBattle, settleDefensiveBattle } from "../src/js/game/invasion-battle.js";
import { dailyFoodCost } from "../src/js/game/economy.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = { width: 3, height: 3, terrain: Array(9).fill("plain"),
  attackerStarts: [{ x: 0, y: 1 }, { x: 0, y: 2 }], defenderStarts: [{ x: 2, y: 1 }, { x: 2, y: 2 }] };
const person = (id, factionId, locationCityId, extra = {}) => ({ id, name: id, factionId, locationCityId,
  status: "active", rank: "君主", war: 90, intelligence: 100, leadership: 80, politics: 80, charm: 80, merit: 0, acted: false, ...extra });
const city = (id, factionId, officerIds, extra = {}) => ({ id, name: id, factionId, officerIds,
  governorId: officerIds[0] ?? null, adjacent: ["origin", "target", "home"].filter((other) => other !== id),
  troops: 10000, gold: 5000, food: 20000, training: 80, morale: 80, popularSupport: 70, ...extra });
const lookup = (state, id) => state.cities.find((entry) => entry.id === id);

function fixture({ attackerTroops = 3000, defenderTroops = 6000, food = 10000, gold = 150,
  defenderFood = 20000, home = false, attackerHome = false } = {}) {
  const state = { year: 196, month: 11, elapsedMonths: 0, playerFactionId: "defender", commandsRemaining: 0, eventLog: [],
    factions: [{ id: "attacker", name: "攻方" }, { id: "defender", name: "守方" }],
    cities: [city("origin", "attacker", ["commander"]), city("target", "defender", ["guard"], { troops: defenderTroops, food: defenderFood })],
    officers: [person("commander", "attacker", "origin", { leadership: 60 }),
      person("guard", "defender", "target", { rank: "校尉", leadership: 100 })] };
  if (home) state.cities.push(city("home", "defender", [], { troops: 2000, training: 30, morale: 20 }));
  if (attackerHome) state.cities.push(city("backup", "attacker", [], { troops: 1000, training: 20, morale: 30 }));
  const before = structuredClone(state);
  const source = lookup(state, "origin");
  source.troops -= attackerTroops;
  source.food -= food;
  source.gold -= gold + rules.actions.march;
  state.officers[0].acted = true;
  const invasion = { id: "invasion-defense", sourceId: "origin", targetId: "target", attackerFactionId: "attacker", defenderFactionId: "defender",
    officerIds: ["commander"], divisions: [{ officerId: "commander", troops: attackerTroops, unitType: "infantry" }],
    troops: attackerTroops, training: 80, morale: 80, supplies: { food, gold }, resolved: false };
  state.pendingInvasions = [invasion];
  return { state, before, invasion };
}

function launch(options) {
  const data = fixture(options);
  const snapshot = structuredClone(data.state);
  const result = createInvasionBattle(data.state, data.invasion.id, rules, map);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(data.state, snapshot, "opening the battle never mutates the strategic state");
  result.battle.rng = () => 0;
  return { ...data, battle: result.battle };
}

const sum = (state, key) => state.cities.reduce((total, entry) => total + entry[key], 0);
const finishByWaiting = (battle) => { for (let turns = 0; battle.status === "active" && turns < 500; turns += 1) battle.wait(); };

test("opening defense uses reserved invasion troops and departure quality, all defending warehouses, and no command", () => {
  const data = fixture();
  lookup(data.state, "origin").training = 20;
  lookup(data.state, "origin").morale = 40;
  const snapshot = structuredClone(data.state);
  const { ok, battle } = createInvasionBattle(data.state, data.invasion.id, rules, map);
  assert.equal(ok, true);
  assert.equal(battle.playerSide, "enemy");
  assert.equal(battle.invasionId, data.invasion.id);
  assert.deepEqual(battle.armyOfficerIds, ["commander"]);
  assert.equal(battle.livingUnits("ally")[0].training, 80);
  assert.equal(battle.livingUnits("ally")[0].morale, 80);
  assert.equal(battle.supplies.ally.food, data.invasion.supplies.food - dailyFoodCost(3000, rules));
  assert.equal(battle.supplies.enemy.food, lookup(data.state, "target").food - dailyFoodCost(6000, rules));
  assert.equal(battle.defenderReserveTroops, 3000);
  assert.deepEqual(data.state, snapshot);
});

test("creation rejects stale, allied, uncommanded or malformed invasions without any mutation", () => {
  for (const corrupt of [
    ({ invasion }) => { invasion.resolved = true; },
    ({ state }) => { lookup(state, "target").factionId = "third"; },
    ({ state }) => { lookup(state, "origin").factionId = "third"; },
    ({ state }) => { lookup(state, "target").officerIds = []; },
    ({ state }) => { state.relations = { "attacker|defender": { allianceUntil: 9999 } }; },
    ({ invasion }) => { invasion.divisions[0].troops = 9000; invasion.troops = 9000; },
    ({ invasion }) => { invasion.supplies.food = -1; },
    ({ invasion }) => { invasion.training = NaN; },
    ({ invasion }) => { invasion.divisions = [{ officerId: "missing", troops: 3000 }]; },
    ({ invasion }) => { invasion.divisions = []; },
    ({ invasion }) => { invasion.troops = 4000; }
  ]) {
    const data = fixture();
    corrupt(data);
    const snapshot = structuredClone(data.state);
    assert.equal(createInvasionBattle(data.state, data.invasion.id, rules, map).ok, false);
    assert.deepEqual(data.state, snapshot);
  }
});

test("a real defensive fire victory writes back city strategy spending and consumes reserved cargo only once", () => {
  const { state, before, battle } = launch({ attackerTroops: 500, defenderTroops: 3000 });
  assert.equal(battle.activeUnit.side, "enemy");
  const fire = battle.fire(battle.livingUnits("ally")[0].id);
  assert.equal(fire.ok, true);
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "enemy");
  const report = settleDefensiveBattle(state, battle, battle.winner);
  assert.equal(report.ok, true, report.message);
  assert.equal(report.playerWon, true);
  assert.equal(report.attackerSurvivors, 0);
  assert.equal(lookup(state, "target").troops, 3000);
  assert.equal(lookup(state, "target").factionId, "defender");
  assert.equal(lookup(state, "target").gold, 5000 - rules.battle.strategyGoldCosts.fire);
  assert.equal(lookup(state, "origin").troops, 9500);
  assert.equal(sum(state, "food"), sum(before, "food") - dailyFoodCost(500, rules) - dailyFoodCost(3000, rules));
  assert.equal(sum(state, "gold"), sum(before, "gold") - rules.actions.march - rules.battle.strategyGoldCosts.fire);
  assert.equal(state.commandsRemaining, 0);
  assert.equal(state.officers.find((entry) => entry.id === "guard").acted, true);
  assert.equal(state.pendingInvasions.length, 0);
  const settled = structuredClone(state);
  assert.equal(settleDefensiveBattle(state, battle, "enemy").ok, false);
  assert.equal(settleDefensiveBattle(state, { ...battle, settled: false }, "enemy").ok, false);
  assert.deepEqual(state, settled);
});

test("thirty real days of defense lead to a player victory and return remaining attack cargo", () => {
  const { state, before, battle } = launch();
  finishByWaiting(battle);
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.day, 30);
  const report = settleDefensiveBattle(state, battle, "enemy");
  assert.equal(report.ok, true, report.message);
  assert.equal(report.playerWon, true);
  assert.equal(lookup(state, "origin").troops, 10000);
  assert.equal(lookup(state, "target").troops, 6000);
  assert.equal(sum(state, "food"), sum(before, "food") - 30 * (dailyFoodCost(3000, rules) + dailyFoodCost(6000, rules)));
  assert.equal(state.commandsRemaining, 0);
});

test("attack supply exhaustion wins immediately without borrowing city stores or charging defender rations", () => {
  const { state, before, battle } = launch({ food: 0 });
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "enemy");
  const report = settleDefensiveBattle(state, battle, "enemy");
  assert.equal(report.ok, true);
  assert.equal(sum(state, "food"), sum(before, "food"));
  assert.equal(lookup(state, "origin").troops, 10000);
  assert.equal(lookup(state, "target").food, lookup(before, "target").food);
});

test("defender starvation loses the city; surviving garrison never teleports to an escape city", () => {
  const { state, battle } = launch({ defenderFood: 0, home: true });
  assert.equal(battle.winner, "ally");
  const attackStores = { ...battle.supplies.ally };
  const report = settleDefensiveBattle(state, battle, "ally");
  assert.equal(report.ok, true, report.message);
  assert.equal(report.playerWon, false);
  assert.equal(report.escapedTroops, 0);
  assert.equal(lookup(state, "home").troops, 2000);
  assert.equal(lookup(state, "target").factionId, "attacker");
  assert.equal(lookup(state, "target").troops, 3000);
  assert.equal(lookup(state, "target").food, attackStores.food);
  assert.equal(lookup(state, "target").gold, 5000 + attackStores.gold);
  assert.equal(state.officers.find((entry) => entry.id === "guard").locationCityId, "home");
  assert.equal(state.officers.find((entry) => entry.id === "commander").locationCityId, "target");
});

test("a real attacking fire victory captures actual remaining warehouses and surviving attack troops", () => {
  const { state, before, battle } = launch({ defenderTroops: 500 });
  battle.wait();
  assert.equal(battle.activeUnit.side, "ally");
  assert.equal(battle.fire(battle.livingUnits("enemy")[0].id).ok, true);
  assert.equal(battle.winner, "ally");
  const report = settleDefensiveBattle(state, battle, "ally");
  assert.equal(report.ok, true, report.message);
  assert.equal(lookup(state, "target").troops, 3000);
  assert.equal(lookup(state, "origin").troops, 7000);
  assert.equal(state.officers.find((entry) => entry.id === "guard").status, "captured");
  assert.equal(sum(state, "food"), sum(before, "food") - dailyFoodCost(3000, rules) - dailyFoodCost(500, rules));
  assert.equal(sum(state, "gold"), sum(before, "gold") - rules.actions.march - rules.battle.strategyGoldCosts.fire);
});

test("abandoning a city moves surviving garrison and reserves with escaped officers and blends quality", () => {
  const { state, battle } = launch({ home: true });
  Object.assign(battle.livingUnits("enemy")[0], { troops: 2000, training: 60, morale: 40 });
  battle.defenderReserveTraining = 90;
  battle.defenderReserveMorale = 80;
  const cargo = structuredClone(battle.supplies);
  const report = settleDefensiveBattle(state, battle, "ally", { retreated: true });
  assert.equal(report.ok, true, report.message);
  assert.equal(report.escapedTroops, 5000);
  assert.equal(report.retreatCityId, "home");
  assert.equal(lookup(state, "home").troops, 7000);
  assert.equal(lookup(state, "home").training, Math.round((2000 * 30 + 5000 * 78) / 7000));
  assert.equal(lookup(state, "home").morale, Math.round((2000 * 20 + 5000 * 64) / 7000));
  assert.equal(lookup(state, "target").troops, 3000);
  assert.equal(lookup(state, "target").gold, cargo.ally.gold + cargo.enemy.gold);
  assert.equal(lookup(state, "target").food, cargo.ally.food + cargo.enemy.food);
  assert.equal(lookup(state, "home").food, 20000, "abandoned city stores are captured, not carried with the troops");
  assert.equal(state.officers.find((entry) => entry.id === "guard").locationCityId, report.retreatCityId);
});

test("abandonment without any remaining seat loses surviving troops and captures real commanders", () => {
  const { state, battle } = launch();
  const report = settleDefensiveBattle(state, battle, "ally", { retreated: true });
  assert.equal(report.ok, true, report.message);
  assert.equal(report.escapedTroops, 0);
  assert.equal(report.retreatCityId, null);
  assert.equal(lookup(state, "target").troops, 3000);
  assert.equal(state.officers.find((entry) => entry.id === "guard").status, "captured");
});

test("defense victory merges remaining field formations and reserve quality, and attackers with their home", () => {
  const { state, battle } = launch({ food: 0 });
  Object.assign(battle.livingUnits("ally")[0], { troops: 1000, training: 30, morale: 40 });
  Object.assign(battle.livingUnits("enemy")[0], { troops: 2000, training: 60, morale: 50 });
  const report = settleDefensiveBattle(state, battle, "enemy");
  assert.equal(report.ok, true, report.message);
  assert.equal(lookup(state, "origin").troops, 8000);
  assert.equal(lookup(state, "origin").training, Math.round((7000 * 80 + 1000 * 30) / 8000));
  assert.equal(lookup(state, "origin").morale, Math.round((7000 * 80 + 1000 * 40) / 8000));
  assert.equal(lookup(state, "target").troops, 5000);
  assert.equal(lookup(state, "target").training, Math.round((2000 * 60 + 3000 * 80) / 5000));
  assert.equal(lookup(state, "target").morale, Math.round((2000 * 50 + 3000 * 80) / 5000));
});

test("a defeated attack returns to a remaining attacker seat when its original source has fallen", () => {
  const { state, battle } = launch({ food: 0, attackerHome: true });
  lookup(state, "origin").factionId = "third";
  const sourceBefore = structuredClone(lookup(state, "origin"));
  const report = settleDefensiveBattle(state, battle, "enemy");
  assert.equal(report.ok, true, report.message);
  assert.equal(report.returnCityId, "backup");
  assert.equal(lookup(state, "backup").troops, 4000);
  assert.equal(lookup(state, "backup").training, Math.round((1000 * 20 + 3000 * 80) / 4000));
  assert.deepEqual(lookup(state, "origin"), sourceBefore);
});

test("an attack with no remaining seat cannot give its remaining cargo to the new owner of its origin", () => {
  const { state, battle } = launch({ food: 0 });
  lookup(state, "origin").factionId = "third";
  const sourceBefore = structuredClone(lookup(state, "origin"));
  const report = settleDefensiveBattle(state, battle, "enemy");
  assert.equal(report.ok, true, report.message);
  assert.equal(report.returnCityId, null);
  assert.deepEqual(lookup(state, "origin"), sourceBefore);
  assert.equal(state.pendingInvasions.length, 0);
});

test("invalid outcomes, stale ownership and corrupt stores are rejected atomically", () => {
  for (const corrupt of [
    ({ battle }) => { battle.supplies.ally.food = -1; },
    ({ battle }) => { battle.supplies.enemy.gold += 1; },
    ({ battle }) => { battle.units[0].troops = 99999; },
    ({ battle }) => { battle.defenderReserveTroops = NaN; },
    ({ battle }) => { battle.units[0].training = NaN; },
    ({ battle }) => { battle.armyOfficerIds = ["missing"]; },
    ({ state }) => { lookup(state, "target").factionId = "third"; },
    ({ state }) => { lookup(state, "origin").factionId = "third"; }
  ]) {
    const data = launch();
    corrupt(data);
    const snapshot = structuredClone(data.state);
    assert.equal(settleDefensiveBattle(data.state, data.battle, "ally", { retreated: true }).ok, false);
    assert.deepEqual(data.state, snapshot);
    assert.notEqual(data.battle.settled, true);
  }
  const { state, battle } = launch();
  const snapshot = structuredClone(state);
  assert.equal(settleDefensiveBattle(state, battle, "enemy").ok, false);
  assert.equal(settleDefensiveBattle(state, battle, "ally").ok, false);
  assert.equal(settleDefensiveBattle(state, battle, "enemy", { retreated: true }).ok, false);
  assert.deepEqual(state, snapshot);
  const terminal = launch({ food: 0 });
  assert.equal(settleDefensiveBattle(terminal.state, terminal.battle, "ally", { retreated: true }).ok, false);
});

test("grouped invasion and chosen defending formations preserve every real commander without multiplying troops", () => {
  const { state, invasion } = fixture({ attackerTroops: 6000 });
  state.officers.push(person("attacker-aide", "attacker", "origin", { rank: "校尉" }),
    person("defender-aide", "defender", "target", { rank: "校尉" }));
  lookup(state, "origin").officerIds.push("attacker-aide");
  lookup(state, "target").officerIds.push("defender-aide");
  invasion.officerIds.push("attacker-aide");
  invasion.divisions = [{ id: "joint-attack", officerIds: ["commander", "attacker-aide"], troops: 6000, unitType: "infantry" }];
  const before = structuredClone(state);
  const result = createInvasionBattle(state, invasion.id, rules, map, { mode: "field",
    defenderDivisions: [{ id: "joint-defense", officerIds: ["guard", "defender-aide"], troops: 4000, unitType: "archer" }] });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.battle.armyOfficerIds, invasion.officerIds);
  assert.equal(result.battle.livingUnits("ally").length, 1);
  assert.equal(result.battle.livingUnits("ally")[0].troops, 6000);
  assert.deepEqual(result.battle.livingUnits("ally")[0].officerIds, ["commander", "attacker-aide"]);
  assert.equal(result.battle.livingUnits("enemy")[0].troops, 4000);
  assert.deepEqual(result.battle.livingUnits("enemy")[0].officerIds, ["guard", "defender-aide"]);
  assert.equal(result.battle.defenderReserveTroops, 2000);
  assert.deepEqual(state, before);
});

test("legacy reserved invasions without divisions can open an unstaffed direct siege without inventing officers", () => {
  const { state, invasion } = fixture();
  delete invasion.divisions;
  invasion.resolutionMode = "siege";
  lookup(state, "target").officerIds = [];
  const before = structuredClone(state);
  const result = createInvasionBattle(state, invasion.id, rules, map);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.battle.phase, "siege_transition");
  assert.equal(result.battle.pendingDecision.kind, "encirclement");
  assert.equal(result.battle.chooseTransition("encircle").ok, true);
  assert.equal(result.battle.phase, "siege");
  assert.deepEqual(result.battle.armyOfficerIds, ["commander"]);
  assert.equal(result.battle.livingUnits("ally").reduce((total, unit) => total + unit.troops, 0), invasion.troops);
  assert.deepEqual(state, before);
});

test("invalid defending group selections are rejected before any strategic mutations", () => {
  for (const defenderDivisions of [
    [{ officerIds: ["guard", "guard"], troops: 1000 }],
    [{ officerIds: ["commander"], troops: 1000 }],
    [{ officerIds: ["guard"], troops: 7000 }],
    [{ officerIds: ["guard"], troops: -1 }],
    [{ officerIds: ["guard"], troops: 1000 }, { officerIds: ["guard"], troops: 1000 }]
  ]) {
    const { state, invasion } = fixture();
    const before = structuredClone(state);
    assert.equal(createInvasionBattle(state, invasion.id, rules, map, { defenderDivisions }).ok, false);
    assert.deepEqual(state, before);
  }
});

test("an escaped outer formation returns to another own city even when the defended city survives", () => {
  const { state, battle } = launch({ food: 0, home: true });
  const unit = battle.units.find((entry) => entry.side === "enemy");
  unit.officerIds = ["guard"];
  battle.escapedDefenderUnits = [structuredClone(unit)];
  battle.units = battle.units.filter((entry) => entry !== unit);
  Object.assign(lookup(state, "target"), { wallLevel: 2, defense: 100, wallProgress: 28 });
  battle.cityDefense = 41;
  battle.wallLevel = 1;
  const before = sum(state, "troops");
  const report = settleDefensiveBattle(state, battle, "enemy");
  assert.equal(report.ok, true, report.message);
  assert.equal(report.escapedTroops, 3000);
  assert.equal(report.defenderLosses, 0);
  assert.equal(lookup(state, "target").troops, 3000);
  assert.equal(lookup(state, "home").troops, 5000);
  assert.equal(lookup(state, "target").governorId, null);
  assert.equal(state.officers.find((officer) => officer.id === "guard").locationCityId, "home");
  assert.equal(lookup(state, "target").defense, 41);
  assert.equal(lookup(state, "target").wallLevel, 2, "battle damage must not demote architectural level");
  assert.equal(lookup(state, "target").wallProgress, 28);
  assert.equal(sum(state, "troops"), before + 3000, "only the originally reserved attackers are returned");
});

test("whole-army siege retreat settles escaped troops and reserves exactly once with no extra losses", () => {
  const { state, battle } = launch({ home: true });
  const defender = battle.units.find((entry) => entry.side === "enemy");
  defender.officerIds = ["guard"];
  battle.escapedDefenderUnits = [structuredClone(defender), { id: "reserve", side: "enemy", officerIds: [],
    troops: battle.defenderReserveTroops, training: 80, morale: 80 }];
  battle.units = battle.units.filter((unit) => unit.side !== "enemy");
  battle.defenderReserveTroops = 0;
  battle.defenderRetreated = true;
  battle.status = "ended";
  battle.winner = "ally";
  battle.cityDefense = 67;
  const report = settleDefensiveBattle(state, battle, "ally");
  assert.equal(report.ok, true, report.message);
  assert.equal(report.escapedTroops, 6000);
  assert.equal(report.defenderLosses, 0);
  assert.equal(lookup(state, "home").troops, 8000);
  assert.equal(lookup(state, "target").troops, 3000);
  assert.equal(lookup(state, "target").factionId, "attacker");
  assert.equal(lookup(state, "target").defense, 67);
  assert.equal(state.officers.find((officer) => officer.id === "guard").locationCityId, "home");
  assert.equal(lookup(state, "home").officerIds.filter((id) => id === "guard").length, 1);
  const after = structuredClone(state);
  assert.equal(settleDefensiveBattle(state, battle, "ally").ok, false);
  assert.deepEqual(state, after);
});

test("escaped armies without another own city and malformed wall values fail atomically", () => {
  for (const corrupt of [
    ({ battle }) => { battle.cityDefense = -1; },
    ({ battle }) => { battle.cityDefense = NaN; },
    ({ battle }) => {
      const defender = battle.units.find((unit) => unit.side === "enemy");
      battle.escapedDefenderUnits = [structuredClone(defender)];
      battle.units = battle.units.filter((unit) => unit !== defender);
    }
  ]) {
    const data = launch({ food: 0 });
    corrupt(data);
    const before = structuredClone(data.state);
    assert.equal(settleDefensiveBattle(data.state, data.battle, "enemy").ok, false);
    assert.deepEqual(data.state, before);
    assert.notEqual(data.battle.settled, true);
  }
});

test("real siege withdrawal preserves every soldier for an open perimeter and charges breakout loss only once", () => {
  for (const encirclement of ["open", "encircle"]) {
    const { state, invasion } = fixture({ home: true });
    const created = createInvasionBattle(state, invasion.id, rules, map, { mode: "siege" });
    assert.equal(created.ok, true, created.message);
    const { battle } = created;
    assert.equal(battle.chooseTransition(encirclement).ok, true);
    const withdrawal = battle.retreatArmy("enemy");
    assert.equal(withdrawal.ok, true, withdrawal.message);
    if (encirclement === "open") assert.equal(withdrawal.losses, 0);
    else assert.ok(withdrawal.losses > 0);
    const report = settleDefensiveBattle(state, battle, battle.winner);
    assert.equal(report.ok, true, report.message);
    assert.equal(report.escapedTroops, 6000 - withdrawal.losses);
    assert.equal(report.defenderLosses, withdrawal.losses);
    assert.equal(lookup(state, "home").troops, 8000 - withdrawal.losses);
    assert.equal(lookup(state, "target").factionId, "attacker");
    assert.equal(lookup(state, "target").troops, 3000);
    assert.equal(state.officers.find((officer) => officer.id === "guard").locationCityId, "home");
  }
});

test("real outer-army escape survives settlement when the invading side subsequently retreats", () => {
  const { state, invasion } = fixture({ home: true });
  const { battle } = createInvasionBattle(state, invasion.id, rules, map, { mode: "field",
    defenderDivisions: [{ officerIds: ["guard"], troops: 2000, unitType: "infantry" }] });
  assert.equal(battle.enterSiege().ok, true);
  assert.equal(battle.pendingDecision.kind, "external");
  assert.equal(battle.chooseTransition("retreat").ok, true);
  assert.equal(battle.escapedDefenderUnits.reduce((total, unit) => total + unit.troops, 0), 2000);
  assert.equal(battle.defenderReserveTroops, 4000);
  assert.equal(battle.chooseTransition("open").ok, true);
  assert.equal(battle.retreatArmy("ally").ok, true);
  const report = settleDefensiveBattle(state, battle, battle.winner);
  assert.equal(report.ok, true, report.message);
  assert.equal(report.playerWon, true);
  assert.equal(report.defenderLosses, 0);
  assert.equal(lookup(state, "target").troops, 4000);
  assert.equal(lookup(state, "home").troops, 4000);
  assert.equal(state.officers.find((officer) => officer.id === "guard").locationCityId, "home");
});
