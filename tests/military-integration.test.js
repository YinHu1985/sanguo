import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState, migrateState } from "../src/js/game/state.js";
import { validateArmy, commitArmyDeparture } from "../src/js/game/rules.js";
import { queueTask, settleTasks, finishBattleTask } from "../src/js/game/tasks.js";
import { BattleEngine } from "../src/js/game/battle.js";
import { settlePlayerBattle } from "../src/js/game/battle-result.js";
import { createInvasionBattle, settleDefensiveBattle } from "../src/js/game/invasion-battle.js";
import { createDefenderFormations } from "../src/js/game/army.js";
import { createArmyComposer } from "../src/js/ui/army-composer.js";
import { applyFormationLosses, EQUIPMENT_KEYS, sumEquipment, validateComposition } from "../src/js/game/troops.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const officer = (id, factionId, locationCityId) => ({ id, name: id, factionId, locationCityId,
  rank: "大将", status: "active", war: 80, intelligence: 80, leadership: 80, politics: 80, charm: 80, merit: 0 });
const city = (id, factionId, officerIds) => ({ id, name: id, factionId, officerIds, adjacent: ["source", "target", "home"].filter((other) => other !== id),
  troops: 10000, gold: 10000, food: 100000, horses: 10000, crossbows: 10000, armor: 10000,
  agriculture: 50, commerce: 50, popularSupport: 70, training: 80, morale: 80, governorId: null });
const scenario = { id: "military-integration", year: 196, month: 1, playerFactionId: "a",
  factions: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }],
  cities: [city("source", "a", ["leader", "aide"]), city("target", "b", ["guard", "guard-aide"]), city("home", "b", [])],
  officers: [officer("leader", "a", "source"), officer("aide", "a", "source"), officer("guard", "b", "target"), officer("guard-aide", "b", "target")] };
const map = { width: 7, height: 7, stronghold: { x: 6, y: 3 }, terrain: Array(49).fill("plain"),
  attackerStarts: [{ x: 0, y: 2 }, { x: 0, y: 4 }], defenderStarts: [{ x: 6, y: 2 }, { x: 6, y: 4 }] };
const fixture = () => createInitialState(scenario, rules);
const stores = (city) => Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, city[key] ?? 0]));
const cityById = (state, id) => state.cities.find((entry) => entry.id === id);
const totalStores = (state) => Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key,
  state.cities.reduce((sum, city) => sum + (city[key] ?? 0), 0)]));
const group = (id, composition = { infantry: 1000, heavyInfantry: 500, crossbowman: 500, cavalry: 1000 }) => ({
  officerIds: [id], troops: Object.values(composition).reduce((sum, count) => sum + count, 0), composition });
const marchOrder = (divisions = [group("leader"), group("aide")]) => ({ kind: "march", cityId: "source",
  officerIds: divisions.flatMap((entry) => entry.officerIds), payload: { targetId: "target", divisions, supplies: { food: 2000, gold: 200 } } });
const defenders = () => [group("guard"), group("guard-aide")];

function launchPlayer() {
  const state = fixture();
  const original = structuredClone(state);
  const army = validateArmy(state, "source", "target", [group("leader"), group("aide")], rules, { food: 2000, gold: 200 });
  assert.equal(army.ok, true, army.message);
  assert.equal(commitArmyDeparture(state, army).ok, true);
  const battle = new BattleEngine({ state, sourceCity: army.city, targetCity: army.target,
    divisions: army.divisions, defenderDivisions: defenders(), officers: state.officers, supplies: army.supplies,
    rules, map: structuredClone(map), canDefenderRetreat: true, rng: () => 0 });
  return { state, original, army, battle };
}

function launchDefense(mode = "field") {
  const { state, original, army } = launchPlayer();
  state.playerFactionId = "b";
  state.pendingInvasions = [{ id: "invasion", sourceId: "source", targetId: "target", attackerFactionId: "a", defenderFactionId: "b",
    officerIds: army.divisions.flatMap((unit) => unit.officerIds), divisions: army.divisions, troops: army.total,
    equipment: army.equipment, training: army.city.training, morale: army.city.morale, supplies: army.supplies, resolved: false }];
  const created = createInvasionBattle(state, "invasion", rules, structuredClone(map), { mode, defenderDivisions: defenders() });
  assert.equal(created.ok, true, created.message);
  return { state, original, battle: created.battle };
}

function assertGlobalEquipment(state, original, battle) {
  const survivors = sumEquipment([...battle.units.filter((unit) => unit.troops > 0), ...battle.escapedDefenderUnits], rules);
  const before = totalStores(original), after = totalStores(state);
  for (const key of EQUIPMENT_KEYS) {
    assert.equal(after[key], before[key] - battle.attackerEquipmentCommitted[key] - battle.defenderEquipmentCommitted[key] + survivors[key], key);
  }
}

test("negative, fractional, nonfinite, malformed, unknown and locked compositions fail both validation and task submission atomically", () => {
  const invalid = [null, [], "infantry", { infantry: -1000 }, { infantry: 1000.5 }, { infantry: NaN }, { infantry: Infinity },
    { infantry: "1000" }, { infantry: 1000, cavalry: -1 }, { ghost: 1000 }, { infantry: 1000, ghost: 0 }, { heavyCavalry: 1000 }];
  for (const composition of invalid) {
    const state = fixture();
    const before = structuredClone(state);
    const unit = { officerIds: ["leader"], troops: 1000, composition };
    assert.equal(validateComposition(unit, { state, factionId: "a", rules }).ok, false);
    assert.equal(validateArmy(state, "source", "target", [unit], rules).ok, false);
    assert.equal(queueTask(state, marchOrder([unit]), rules).ok, false);
    assert.deepEqual(state, before);
  }
});

test("multiple individually affordable units cannot overbook one shared equipment warehouse", () => {
  const state = fixture();
  cityById(state, "source").horses = 1500;
  const divisions = [group("leader", { cavalry: 1000 }), group("aide", { cavalry: 1000 })];
  for (const formation of divisions) assert.equal(validateArmy(state, "source", "target", [formation], rules).ok, true);
  const before = structuredClone(state);
  assert.equal(validateArmy(state, "source", "target", divisions, rules).ok, false);
  assert.equal(queueTask(state, marchOrder(divisions), rules).ok, false);
  assert.deepEqual(state, before);
});

test("defense selection also rejects locked troops and aggregate equipment overbooking", () => {
  for (const divisions of [[group("guard", { dragoon: 1000 })],
    [group("guard", { cavalry: 1000 }), group("guard-aide", { cavalry: 1000 })]]) {
    const { state } = launchDefense();
    cityById(state, "target").horses = 1500;
    const before = structuredClone(state);
    assert.equal(createInvasionBattle(state, "invasion", rules, map, { defenderDivisions: divisions }).ok, false);
    assert.deepEqual(state, before);
  }
});

test("composer labels locked types, rejects total equipment overspending and accepts only the owning faction's unlock", (context) => {
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => {
    const nodes = new Map();
    return { innerHTML: "", querySelectorAll: () => [], querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", addEventListener() {} });
      return nodes.get(selector);
    } };
  } };
  context.after(() => { globalThis.document = oldDocument; });
  const state = fixture(), city = cityById(state, "source");
  const officers = state.officers.filter((officer) => officer.factionId === "a");
  const locked = createArmyComposer({ state, city, officers, rules, formations: [group("leader", { heavyCavalry: 1000 })] });
  assert.equal(locked.validate().ok, false);
  assert.match(locked.element.innerHTML, /data-troop-type="heavyCavalry"[^>]+disabled/);
  state.factions.find((faction) => faction.id === "b").unlockedTechnologies = ["heavyCavalry"];
  assert.equal(locked.validate().ok, false, "another faction's technology is not shared");
  state.factions.find((faction) => faction.id === "a").unlockedTechnologies = ["heavyCavalry"];
  assert.equal(locked.validate().ok, true);
  city.horses = 1500;
  const oversized = createArmyComposer({ state, city, officers, rules,
    formations: [group("leader", { cavalry: 1000 }), group("aide", { cavalry: 1000 })] });
  assert.equal(oversized.validate().ok, false);
});

test("auto-composition shares scarce equipment across several units and honors unlocked types without changing city stores", () => {
  const state = fixture(), city = cityById(state, "source");
  Object.assign(city, { troops: 20000, horses: 71, crossbows: 83, armor: 97 });
  const customRules = structuredClone(rules);
  customRules.army.maxOfficersPerUnit = 1;
  state.factions[0].unlockedTechnologies = ["dragoon"];
  const before = structuredClone(state);
  const units = createDefenderFormations(city, state.officers, customRules, { state });
  assert.equal(units.length, 2);
  const used = sumEquipment(units, rules);
  assert.deepEqual(used, { horses: 71, crossbows: 83, armor: 97 });
  assert.ok(units.some((unit) => unit.composition.dragoon > 0));
  for (const unit of units) assert.equal(Object.values(unit.composition).reduce((sum, count) => sum + count, 0), unit.troops);
  assert.deepEqual(state, before);
});

test("queued mixed armies survive real save migration, settle after battle once and conserve gear globally", () => {
  let state = fixture();
  const original = structuredClone(state);
  const queued = queueTask(state, marchOrder(), rules);
  assert.equal(queued.ok, true, queued.message);
  const reserved = stores(cityById(state, "source"));
  state = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  assert.deepEqual(stores(cityById(state, "source")), reserved);
  let task = settleTasks(state, rules).battleTask;
  assert.ok(task);
  assert.deepEqual(stores(cityById(state, "source")), reserved);
  state = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  task = state.tasks.find((entry) => entry.id === task.id);
  const battle = new BattleEngine({ state, sourceCity: cityById(state, task.cityId), targetCity: cityById(state, task.targetId),
    divisions: task.battle.divisions, defenderDivisions: defenders(), officers: state.officers,
    supplies: task.battle.supplies, rules, map, rng: () => 0 });
  for (const unit of battle.units) applyFormationLosses(unit, 403, rules);
  battle.retreatArmy("ally");
  const result = settlePlayerBattle(state, battle, battle.winner);
  assert.equal(result.ok, true, result.message);
  assert.equal(finishBattleTask(state, task.id, result).ok, true);
  assertGlobalEquipment(state, original, battle);
  const finished = structuredClone(state);
  assert.equal(settlePlayerBattle(state, battle, battle.winner).ok, false);
  settleTasks(state, rules);
  assert.deepEqual(state, finished);
});

test("a partially escaped defender army returns its gear even when its city ultimately wins", () => {
  const { state, original, battle } = launchDefense();
  const [inside, outside] = battle.livingUnits("enemy");
  applyFormationLosses(outside, 307, rules);
  battle.queue = [inside.id, outside.id];
  assert.equal(battle.retreatToCity(inside.id).ok, true);
  battle.enterSiege();
  assert.equal(battle.chooseTransition("retreat").ok, true);
  assert.equal(battle.chooseTransition("open").ok, true);
  assert.equal(battle.retreatArmy("ally").ok, true);
  const escapedEquipment = sumEquipment(battle.escapedDefenderUnits, rules);
  const result = settleDefensiveBattle(state, battle, battle.winner);
  assert.equal(result.ok, true, result.message);
  for (const key of EQUIPMENT_KEYS) assert.equal(cityById(state, "home")[key], cityById(original, "home")[key] + escapedEquipment[key]);
  assert.equal(cityById(state, "target").factionId, "b");
  assertGlobalEquipment(state, original, battle);
});

test("full defending breakout carries only surviving equipped soldiers and leaves unused warehouse gear to the captor", () => {
  for (const encirclement of ["open", "encircle"]) {
    const { state, original, battle } = launchDefense("siege");
    assert.equal(battle.chooseTransition(encirclement).ok, true);
    const retreat = battle.retreatArmy("enemy");
    assert.equal(retreat.ok, true, retreat.message);
    assert.equal(retreat.losses === 0, encirclement === "open");
    const survivorEquipment = sumEquipment(battle.escapedDefenderUnits, rules);
    const attackingEquipment = sumEquipment(battle.livingUnits("ally"), rules);
    const result = settleDefensiveBattle(state, battle, battle.winner);
    assert.equal(result.ok, true, result.message);
    for (const key of EQUIPMENT_KEYS) {
      assert.equal(cityById(state, "home")[key], cityById(original, "home")[key] + survivorEquipment[key]);
      assert.equal(cityById(state, "target")[key], cityById(original, "target")[key] - battle.defenderEquipmentCommitted[key] + attackingEquipment[key]);
    }
    assertGlobalEquipment(state, original, battle);
    const finished = structuredClone(state);
    assert.equal(settleDefensiveBattle(state, battle, battle.winner).ok, false);
    assert.deepEqual(state, finished);
  }
});

test("departure revalidation refreshes the equipment ledger if a still-valid composition changed", () => {
  const state = fixture();
  const initial = stores(cityById(state, "source"));
  const army = validateArmy(state, "source", "target", [group("leader", { cavalry: 1000 })], rules);
  assert.equal(army.ok, true);
  army.divisions[0].composition = { heavyInfantry: 1000 };
  assert.equal(commitArmyDeparture(state, army).ok, true);
  assert.deepEqual(army.equipment, { horses: 0, crossbows: 0, armor: 1000 });
  assert.deepEqual(stores(cityById(state, "source")), { ...initial, armor: initial.armor - 1000 });
  assert.deepEqual(sumEquipment(army.divisions, rules), army.equipment);
});

test("equipment overflow at returning and escaping destinations rejects settlement without partial mutation", () => {
  const player = launchPlayer();
  cityById(player.state, "source").horses = Number.MAX_SAFE_INTEGER;
  player.battle.retreatArmy("ally");
  const before = structuredClone(player.state);
  assert.equal(settlePlayerBattle(player.state, player.battle, player.battle.winner).ok, false);
  assert.deepEqual(player.state, before);
  assert.notEqual(player.battle.settled, true);

  const defense = launchDefense("siege");
  cityById(defense.state, "home").horses = Number.MAX_SAFE_INTEGER;
  defense.battle.chooseTransition("open");
  defense.battle.retreatArmy("enemy");
  const defenseBefore = structuredClone(defense.state);
  assert.equal(settleDefensiveBattle(defense.state, defense.battle, defense.battle.winner).ok, false);
  assert.deepEqual(defense.state, defenseBefore);
  assert.notEqual(defense.battle.settled, true);
});
