import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { validateArmy, commitArmyDeparture } from "../src/js/game/rules.js";
import { settlePlayerBattle } from "../src/js/game/battle-result.js";
import { createInvasionBattle, settleDefensiveBattle } from "../src/js/game/invasion-battle.js";
import { EQUIPMENT_KEYS, compositionEquipment, sumEquipment } from "../src/js/game/troops.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const composition = () => ({ infantry: 1000, heavyInfantry: 1000, crossbowman: 1000, cavalry: 1000 });
const map = { width: 7, height: 7, stronghold: { x: 6, y: 3 }, terrain: Array(49).fill("plain"),
  attackerStarts: [{ x: 2, y: 3 }], defenderStarts: [{ x: 3, y: 3 }] };
const stores = (city) => Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, city[key]]));
const totalStores = (state) => Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, state.cities.reduce((sum, city) => sum + city[key], 0)]));
const find = (state, id) => state.cities.find((city) => city.id === id);

function launch() {
  const city = (id, factionId, officerIds) => ({ id, name: id, factionId, officerIds, adjacent: ["source", "target", "home"].filter((other) => id !== other),
    troops: 10000, gold: 10000, food: 100000, horses: 10000, crossbows: 10000, armor: 10000, training: 80, morale: 80, popularSupport: 70 });
  const officer = (id, factionId, locationCityId) => ({ id, name: id, factionId, locationCityId, status: "active", rank: "大将",
    war: 80, intelligence: 80, leadership: 80, politics: 80, charm: 80, merit: 0, acted: false });
  const state = { year: 196, month: 1, playerFactionId: "a", commandsMax: 6, commandsRemaining: 6, eventLog: [],
    factions: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }],
    cities: [city("source", "a", ["leader"]), city("target", "b", ["guard"]), city("home", "b", [])],
    officers: [officer("leader", "a", "source"), officer("guard", "b", "target")] };
  const initial = structuredClone(state);
  const army = validateArmy(state, "source", "target", [{ officerIds: ["leader"], troops: 4000, composition: composition() }], rules,
    { food: 5000, gold: 500 });
  assert.equal(army.ok, true, army.message);
  assert.equal(commitArmyDeparture(state, army).ok, true);
  const battle = new BattleEngine({ state, sourceCity: army.city, targetCity: army.target, divisions: army.divisions,
    defenderDivisions: [{ officerIds: ["guard"], troops: 4000, composition: composition() }],
    officers: state.officers, rules, supplies: army.supplies, map: structuredClone(map), canDefenderRetreat: true, rng: () => 0 });
  battle.queue = [battle.livingUnits("ally")[0].id, battle.livingUnits("enemy")[0].id];
  return { state, initial, army, battle };
}

function assertTotalBalance(state, initial, battle) {
  const survivors = sumEquipment([...battle.units.filter((unit) => unit.troops > 0), ...battle.escapedDefenderUnits], rules);
  const before = totalStores(initial), after = totalStores(state);
  for (const key of EQUIPMENT_KEYS) assert.equal(after[key], before[key]
    - battle.attackerEquipmentCommitted[key] - battle.defenderEquipmentCommitted[key] + survivors[key], key);
}

test("melee-biased casualties destroy the actual troop equipment and retreat returns only surviving loadouts", () => {
  const { state, initial, battle } = launch();
  const actor = battle.livingUnits("ally")[0], target = battle.livingUnits("enemy")[0];
  const result = battle.attack(target.id);
  assert.equal(result.ok, true);
  const attackerGear = compositionEquipment(actor.composition, rules), defenderGear = compositionEquipment(target.composition, rules);
  assert.ok(1000 - defenderGear.armor > 1000 - defenderGear.horses, "front-line armored infantry must lose more gear than equal-size cavalry");
  assert.ok(1000 - attackerGear.armor > 1000 - attackerGear.horses, "counterattack uses the same exposure rule");
  battle.retreatArmy("ally");
  const settled = settlePlayerBattle(state, battle, battle.winner);
  assert.equal(settled.ok, true, settled.message);
  for (const key of EQUIPMENT_KEYS) {
    assert.equal(find(state, "source")[key], find(initial, "source")[key] - battle.attackerEquipmentCommitted[key] + attackerGear[key]);
    assert.equal(find(state, "target")[key], find(initial, "target")[key] - battle.defenderEquipmentCommitted[key] + defenderGear[key]);
  }
  assertTotalBalance(state, initial, battle);
  const after = structuredClone(state);
  assert.equal(settlePlayerBattle(state, battle, battle.winner).ok, false);
  assert.deepEqual(state, after);
});

test("fire-arrow two-stage casualty allocation settles equipment from its final real composition, not a total survivor ratio", () => {
  const { state, initial, battle } = launch();
  const target = battle.livingUnits("enemy")[0];
  const result = battle.fireArrow(target.id);
  assert.equal(result.ok, true);
  assert.equal(result.fireTriggered, true);
  const finalGear = compositionEquipment(target.composition, rules);
  assert.ok(finalGear.armor < finalGear.horses, "ranged front-line exposure remains reflected after proportional fire losses");
  battle.retreatArmy("ally");
  const settled = settlePlayerBattle(state, battle, battle.winner);
  assert.equal(settled.ok, true, settled.message);
  for (const key of EQUIPMENT_KEYS) assert.equal(find(state, "target")[key], find(initial, "target")[key] - battle.defenderEquipmentCommitted[key] + finalGear[key]);
  assertTotalBalance(state, initial, battle);
});

test("a real encircled defending retreat routes surviving biased loadouts to the retreat city exactly once", () => {
  const { state, initial, army } = launch();
  state.playerFactionId = "b";
  state.pendingInvasions = [{ id: "invasion", sourceId: "source", targetId: "target", attackerFactionId: "a", defenderFactionId: "b",
    officerIds: ["leader"], divisions: army.divisions, troops: army.total, equipment: army.equipment,
    training: 80, morale: 80, supplies: army.supplies, resolved: false }];
  const created = createInvasionBattle(state, "invasion", rules, map, { mode: "siege",
    defenderDivisions: [{ officerIds: ["guard"], troops: 4000, composition: composition() }] });
  assert.equal(created.ok, true, created.message);
  const battle = created.battle;
  battle.chooseTransition("encircle");
  const retreat = battle.retreatArmy("enemy");
  assert.ok(retreat.losses > 0);
  const survivorGear = sumEquipment(battle.escapedDefenderUnits, rules);
  assert.ok(survivorGear.armor < survivorGear.horses);
  const settled = settleDefensiveBattle(state, battle, battle.winner);
  assert.equal(settled.ok, true, settled.message);
  for (const key of EQUIPMENT_KEYS) {
    assert.equal(find(state, "home")[key], find(initial, "home")[key] + survivorGear[key]);
    assert.equal(find(state, "target")[key], find(initial, "target")[key] - battle.defenderEquipmentCommitted[key] + battle.attackerEquipmentCommitted[key]);
  }
  assertTotalBalance(state, initial, battle);
  const after = structuredClone(state);
  assert.equal(settleDefensiveBattle(state, battle, battle.winner).ok, false);
  assert.deepEqual(state, after);
});

test("a legacy uncommitted cavalry invasion can fight and withdraw without manufacturing equipment", () => {
  const { state, army } = launch();
  state.playerFactionId = "b";
  state.pendingInvasions = [{ id: "old", sourceId: "source", targetId: "target", attackerFactionId: "a", defenderFactionId: "b",
    officerIds: ["leader"], divisions: [{ officerId: "leader", unitType: "cavalry", troops: 4000 }], troops: 4000,
    training: 80, morale: 80, supplies: army.supplies, resolved: false }];
  const starting = stores(find(state, "source"));
  const created = createInvasionBattle(state, "old", rules, map, {
    defenderDivisions: [{ officerIds: ["guard"], troops: 4000, composition: composition() }] });
  assert.equal(created.ok, true, created.message);
  const battle = created.battle, target = battle.livingUnits("enemy")[0], actor = battle.livingUnits("ally")[0];
  assert.equal(battle.attackerEquipmentCommitted, undefined);
  battle.queue = [target.id, actor.id];
  assert.equal(battle.attack(actor.id).ok, true);
  assert.ok(actor.troops < 4000);
  assert.deepEqual(actor.composition, { cavalry: actor.troops });
  battle.retreatArmy("ally");
  const settled = settleDefensiveBattle(state, battle, battle.winner);
  assert.equal(settled.ok, true, settled.message);
  assert.deepEqual(stores(find(state, "source")), starting);
});
