import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { settlePlayerBattle } from "../src/js/game/battle-result.js";
import { createInvasionBattle, settleDefensiveBattle } from "../src/js/game/invasion-battle.js";
import { commitArmyDeparture, validateArmy } from "../src/js/game/rules.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = { width: 3, height: 3, terrain: Array(9).fill("plain"), attackerStarts: [{ x: 0, y: 1 }], defenderStarts: [{ x: 2, y: 1 }] };
function launch({ defensive = false, targetFood = 10000 } = {}) {
  const city = (id, factionId, officerId, food = 10000) => ({ id, name: id, factionId, officerIds: [officerId], governorId: officerId,
    adjacent: [id === "source" ? "target" : "source"], troops: 5000, food, gold: 5000, horses: 0, crossbows: 0, armor: 0,
    training: 80, morale: 80, popularSupport: 70 });
  const officer = (id, factionId, locationCityId) => ({ id, name: id, factionId, locationCityId, status: "active", rank: "君主",
    war: 90, leadership: 90, intelligence: 90, politics: 90, charm: 90, acted: false });
  const state = { year: 196, month: 6, elapsedMonths: 0, playerFactionId: "a", commandsRemaining: 6, eventLog: [],
    factions: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }],
    cities: [city("source", "a", "attacker"), city("target", "b", "defender", targetFood)],
    officers: [officer("attacker", "a", "source"), officer("defender", "b", "target")] };
  const target = state.cities[1];
  target.ambushPreparation = { id: "prepared", factionId: "b", expiresTurn: 3, bonus: .25 };
  const army = validateArmy(state, "source", "target", [{ officerId: "attacker", troops: 2000, unitType: "infantry" }], rules, { food: 500, gold: 100 });
  assert.equal(army.ok, true); assert.equal(commitArmyDeparture(state, army).ok, true);
  let battle;
  if (defensive) {
    state.playerFactionId = "b";
    state.pendingInvasions = [{ id: "incoming", sourceId: "source", targetId: "target", attackerFactionId: "a", defenderFactionId: "b",
      officerIds: ["attacker"], divisions: army.divisions, troops: 2000, training: 80, morale: 80,
      supplies: army.supplies, equipment: army.equipment, resolved: false }];
    const result = createInvasionBattle(state, "incoming", rules, map);
    assert.equal(result.ok, true, result.message); battle = result.battle;
  } else {
    battle = new BattleEngine({ sourceCity: army.city, targetCity: army.target, divisions: army.divisions, supplies: army.supplies,
      officers: state.officers, rules, map, state, rng: () => 0 });
    battle.armyOfficerIds = ["attacker"];
  }
  return { state, battle, target, settle: (winner) => defensive ? settleDefensiveBattle(state, battle, winner) : settlePlayerBattle(state, battle, winner) };
}

for (const defensive of [false, true]) {
  const mode = defensive ? "defensive" : "player attack";
  test(`${mode} settlement consumes only the exact preparation used and preserves public city references`, () => {
    const data = launch({ defensive });
    data.battle.ambushPreparationUsedId = "prepared";
    Object.assign(data.battle, { status: "ended", winner: "enemy" });
    assert.equal(data.settle("enemy").ok, true);
    assert.equal(data.target.ambushPreparation, undefined);
    assert.equal(data.state.cities[1], data.target);
    const before = structuredClone(data.state); assert.equal(data.settle("enemy").ok, false); assert.deepEqual(data.state, before);
  });

  test(`${mode} settlement leaves unused and subsequently replaced preparations intact`, () => {
    for (const replacement of [false, true]) {
      const data = launch({ defensive });
      if (replacement) { data.battle.ambushPreparationUsedId = "prepared"; data.target.ambushPreparation.id = "replacement"; }
      Object.assign(data.battle, { status: "ended", winner: "enemy" });
      assert.equal(data.settle("enemy").ok, true);
      assert.equal(data.target.ambushPreparation.id, replacement ? "replacement" : "prepared");
    }
  });

  test(`${mode} an invalid settlement cannot consume preparation before the transaction succeeds`, () => {
    const data = launch({ defensive });
    data.battle.ambushPreparationUsedId = "prepared";
    Object.assign(data.battle, { status: "ended", winner: "enemy" });
    data.battle.supplies.ally.food = -1;
    const before = structuredClone(data.state);
    assert.equal(data.settle("enemy").ok, false); assert.deepEqual(data.state, before);
    assert.equal(data.target.ambushPreparation.id, "prepared"); assert.notEqual(data.battle.settled, true);
  });

  test(`${mode} city loss clears even an unused preparation instead of transferring it to the conqueror`, () => {
    const data = launch({ defensive, targetFood: 0 });
    assert.equal(data.battle.status, "ended"); assert.equal(data.battle.winner, "ally");
    assert.equal(data.battle.ambushPreparationUsedId, null);
    const result = data.settle("ally"); assert.equal(result.ok, true, result.message);
    assert.equal(data.target.factionId, "a"); assert.equal(data.target.ambushPreparation, undefined);
  });
}
