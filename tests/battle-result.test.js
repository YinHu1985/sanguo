import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { settlePlayerBattle } from "../src/js/game/battle-result.js";
import { validateArmy, commitArmyDeparture } from "../src/js/game/rules.js";
import { dailyFoodCost } from "../src/js/game/economy.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = { width: 3, height: 3, terrain: Array(9).fill("plain"),
  attackerStarts: [{ x: 0, y: 1 }, { x: 0, y: 2 }], defenderStarts: [{ x: 2, y: 1 }, { x: 2, y: 2 }] };
const person = (id, factionId, locationCityId, extra = {}) => ({ id, name: id, factionId, locationCityId, status: "active", rank: "君主",
  war: 90, intelligence: 100, leadership: 100, politics: 80, charm: 80, merit: 0, acted: false, ...extra });
const city = (id, factionId, officerIds, extra = {}) => ({ id, name: id, factionId, officerIds, governorId: officerIds[0],
  adjacent: [id === "origin" ? "target" : "origin"], troops: 10000, gold: 5000, food: 20000, training: 80, morale: 80, popularSupport: 70, ...extra });

function launch({ food = 1000, gold = 200, defenderTroops = 4000, defenderFood = 12000, divisions = [{ officerId: "lord", troops: 3000 }] } = {}) {
  const state = { year: 196, month: 11, playerFactionId: "a", commandsRemaining: 6, eventLog: [],
    factions: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }],
    cities: [city("origin", "a", ["lord", "aide"]), city("target", "b", ["guard"], { troops: defenderTroops, food: defenderFood })],
    officers: [person("lord", "a", "origin"), person("aide", "a", "origin"), person("guard", "b", "target", { leadership: 30, intelligence: 30, rank: "校尉" })] };
  const before = structuredClone(state);
  const army = validateArmy(state, "origin", "target", divisions, rules, { food, gold });
  assert.equal(army.ok, true);
  assert.equal(commitArmyDeparture(state, army).ok, true);
  const battle = new BattleEngine({ sourceCity: army.city, targetCity: army.target, divisions: army.divisions, supplies: army.supplies,
    officers: state.officers, rules, map, rng: () => 0 });
  battle.armyOfficerIds = army.divisions.map((division) => division.officerId);
  return { state, before, army, battle, source: army.city, target: army.target };
}

const sumResources = (state) => state.cities.reduce((sum, city) => ({ food: sum.food + city.food, gold: sum.gold + city.gold }), { food: 0, gold: 0 });

test("real departure, first-day rations, fire and retreat debit each cost exactly once and return the actual cargo", () => {
  const { state, before, battle, source, target } = launch();
  battle.livingUnits("enemy")[0].position = { x: 1, y: 1 };
  const original = sumResources(before);
  const attackFood = dailyFoodCost(3000, rules);
  const defenseFood = dailyFoodCost(4000, rules);
  assert.equal(battle.activeUnit.side, "ally");
  assert.equal(battle.fire(battle.livingUnits("enemy")[0].id).ok, true);
  const remainingDefenders = battle.livingUnits("enemy").reduce((sum, unit) => sum + unit.troops, 0) + battle.defenderReserveTroops;
  const result = settlePlayerBattle(state, battle, "enemy");
  assert.equal(result.ok, true);
  assert.equal(source.troops, 10000);
  assert.equal(source.gold, before.cities[0].gold - rules.actions.march - rules.battle.strategyGoldCosts.fire);
  assert.equal(source.food, before.cities[0].food - attackFood);
  assert.equal(target.food, before.cities[1].food - defenseFood);
  assert.equal(target.troops, remainingDefenders);
  assert.equal(sumResources(state).gold, original.gold - rules.actions.march - rules.battle.strategyGoldCosts.fire);
  assert.equal(sumResources(state).food, original.food - attackFood - defenseFood);
  assert.equal(result.supplies.gold, 200 - rules.battle.strategyGoldCosts.fire);
  assert.equal(result.supplies.food, 1000 - attackFood);
  const snapshot = structuredClone(state);
  assert.equal(settlePlayerBattle(state, battle, "enemy").ok, false);
  assert.deepEqual(state, snapshot);
});

test("a real fire victory combines only the captured remainder and attacker remainder, preserving global resource accounting", () => {
  const { state, before, battle, source, target } = launch({ defenderTroops: 500 });
  battle.livingUnits("enemy")[0].position = { x: 1, y: 1 };
  const original = sumResources(before);
  const fire = battle.fire(battle.livingUnits("enemy")[0].id);
  assert.equal(fire.ok, true);
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "ally");
  const cargo = { ...battle.supplies.ally };
  const captured = { ...battle.supplies.enemy };
  const result = settlePlayerBattle(state, battle, battle.winner);
  assert.equal(result.ok, true);
  assert.equal(result.occupation.ok, true);
  assert.equal(target.factionId, "a");
  assert.equal(target.troops, 3000);
  assert.equal(target.food, captured.food + cargo.food);
  assert.equal(target.gold, captured.gold + cargo.gold);
  assert.equal(source.troops, 7000);
  assert.equal(source.gold, before.cities[0].gold - 200 - rules.actions.march);
  assert.equal(sumResources(state).gold, original.gold - rules.actions.march - rules.battle.strategyGoldCosts.fire);
  assert.equal(sumResources(state).food, original.food - dailyFoodCost(3000, rules) - dailyFoodCost(500, rules));
  const snapshot = structuredClone(state);
  assert.equal(settlePlayerBattle(state, battle, "ally").ok, false);
  assert.deepEqual(state, snapshot);
});

test("zero carried grain causes immediate first-day defeat and does not borrow the origin warehouse", () => {
  const { state, before, battle, source, target } = launch({ food: 0 });
  assert.equal(battle.status, "ended");
  assert.equal(battle.winner, "enemy");
  const enemyFoodAfterBattle = battle.supplies.enemy.food;
  assert.equal(enemyFoodAfterBattle, before.cities[1].food, "the immediate retreat occurs before defenders spend their daily ration");
  const result = settlePlayerBattle(state, battle, battle.winner);
  assert.equal(result.ok, true);
  assert.equal(source.troops, before.cities[0].troops);
  assert.equal(source.food, before.cities[0].food);
  assert.equal(source.gold, before.cities[0].gold - rules.actions.march);
  assert.equal(target.food, enemyFoodAfterBattle);
  assert.equal(sumResources(state).food, sumResources(before).food);
  assert.equal(result.supplies.food, 0);
});

test("defender strategy spending is written back from the battlefield wallet on retreat", () => {
  const { state, before, battle, target } = launch();
  battle.livingUnits("enemy")[0].position = { x: 1, y: 1 };
  assert.equal(battle.wait().ok, true);
  assert.equal(battle.activeUnit.side, "enemy");
  assert.equal(battle.fire(battle.livingUnits("ally")[0].id).ok, true);
  const result = settlePlayerBattle(state, battle, "enemy");
  assert.equal(result.ok, true);
  assert.equal(target.gold, before.cities[1].gold - rules.battle.strategyGoldCosts.fire);
  assert.equal(sumResources(state).gold, sumResources(before).gold - rules.actions.march - rules.battle.strategyGoldCosts.fire);
});

test("retreat blends surviving divisions with the origin garrison and defending formations with reserves by headcount", () => {
  const { state, battle, source, target } = launch({ defenderTroops: 6000, divisions: [{ officerId: "lord", troops: 3000 }, { officerId: "aide", troops: 2000 }] });
  const [first, second] = battle.livingUnits("ally");
  Object.assign(first, { troops: 2000, training: 90, morale: 70 });
  Object.assign(second, { troops: 1000, training: 30, morale: 40 });
  const [defender] = battle.livingUnits("enemy");
  Object.assign(defender, { troops: 2000, training: 60, morale: 50 });
  assert.equal(battle.defenderReserveTroops, 3000);
  const result = settlePlayerBattle(state, battle, "enemy");
  assert.equal(result.ok, true);
  assert.equal(source.troops, 8000);
  assert.equal(source.training, Math.round((5000 * 80 + 3000 * 70) / 8000));
  assert.equal(source.morale, Math.round((5000 * 80 + 3000 * 60) / 8000));
  assert.equal(target.troops, 5000);
  assert.equal(target.training, Math.round((2000 * 60 + 3000 * 80) / 5000));
  assert.equal(target.morale, Math.round((2000 * 50 + 3000 * 80) / 5000));
});

test("invalid winners, stale commanders and malformed cargo fail without mutating either city or settling the battle", () => {
  for (const corrupt of [
    ({ battle }) => { battle.supplies.ally.food = -1; },
    ({ battle }) => { battle.armyOfficerIds = ["missing"]; },
    ({ target }) => { target.factionId = "a"; },
    ({ battle }) => { battle.defenderReserveTroops = NaN; },
    ({ battle }) => { battle.units[0].training = NaN; }
  ]) {
    const fixture = launch();
    corrupt(fixture);
    const before = structuredClone(fixture.state);
    assert.equal(settlePlayerBattle(fixture.state, fixture.battle, "enemy").ok, false);
    assert.deepEqual(fixture.state, before);
    assert.notEqual(fixture.battle.settled, true);
  }
  const { state, battle } = launch();
  const before = structuredClone(state);
  assert.equal(settlePlayerBattle(state, battle, "ally").ok, false, "an active battle cannot claim an unearned victory");
  assert.equal(settlePlayerBattle(state, battle, "invalid").ok, false);
  assert.deepEqual(state, before);
});

test("a winning grouped army moves all member officers but its shared soldiers are counted only once", () => {
  const { state, battle, source, target } = launch({ defenderTroops: 500 });
  const attacker = battle.livingUnits("ally")[0];
  attacker.officerIds = ["lord", "aide"];
  battle.armyOfficerIds = ["lord", "aide"];
  battle.status = "ended";
  battle.winner = "ally";
  for (const defender of battle.units.filter((unit) => unit.side === "enemy")) defender.troops = 0;
  Object.assign(target, { wallLevel: 2, defense: 100, wallProgress: 19 });
  battle.cityDefense = 23;
  battle.wallLevel = 1;
  const result = settlePlayerBattle(state, battle, "ally");
  assert.equal(result.ok, true, result.message);
  assert.equal(source.troops, 7000);
  assert.equal(target.troops, 3000);
  assert.deepEqual(target.officerIds.sort(), ["aide", "lord"]);
  assert.equal(target.defense, 23);
  assert.equal(target.wallLevel, 2);
  assert.equal(target.wallProgress, 19);
  for (const id of ["lord", "aide"]) assert.equal(state.officers.find((officer) => officer.id === id).locationCityId, target.id);
});

test("escaped enemy field armies are transferred before occupation and are not captured or counted in the target garrison", () => {
  const { state, battle, target } = launch({ defenderTroops: 4000 });
  state.cities.push(city("enemy-home", "b", [], { troops: 1000, training: 20, morale: 30 }));
  target.adjacent.push("enemy-home");
  const defender = battle.units.find((unit) => unit.side === "enemy");
  defender.officerIds = ["guard"];
  battle.escapedDefenderUnits = [structuredClone(defender)];
  battle.units = battle.units.filter((unit) => unit !== defender);
  battle.defenderReserveTroops = 0;
  battle.status = "ended";
  battle.winner = "ally";
  const result = settlePlayerBattle(state, battle, "ally");
  assert.equal(result.ok, true, result.message);
  assert.equal(result.escapedDefenderTroops, 3000);
  assert.equal(result.defenderRetreatCityId, "enemy-home");
  assert.equal(state.cities.find((entry) => entry.id === "enemy-home").troops, 4000);
  const officer = state.officers.find((entry) => entry.id === "guard");
  assert.equal(officer.status, "active");
  assert.equal(officer.factionId, "b");
  assert.equal(officer.locationCityId, "enemy-home");
  assert.equal(target.factionId, "a");
  assert.deepEqual(target.officerIds, ["lord"]);
});

test("duplicate grouped commanders and escaped officers still on the battlefield cannot be settled", () => {
  for (const corrupt of [
    ({ battle }) => { battle.units[0].officerIds = ["lord", "lord"]; },
    ({ battle }) => { battle.cityDefense = 101; },
    ({ state, battle }) => {
      state.cities.push(city("enemy-home", "b", []));
      battle.escapedDefenderUnits = [structuredClone(battle.units.find((unit) => unit.side === "enemy"))];
    }
  ]) {
    const data = launch();
    corrupt(data);
    const before = structuredClone(data.state);
    assert.equal(settlePlayerBattle(data.state, data.battle, "enemy").ok, false);
    assert.deepEqual(data.state, before);
  }
});
