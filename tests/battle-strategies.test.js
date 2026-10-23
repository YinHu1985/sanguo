import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { strategySuccessChance } from "../src/js/game/battle-strategies.js";

const originalRules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));

function fixture({ playerSide = "ally", rng = () => 0, allies = 2, defenders = 2, preparation, elapsedMonths = 0 } = {}) {
  const rules = structuredClone(originalRules);
  const officers = ["a", "b", "c", "d", "e", "f"].map((id, index) => ({ id, name: id, rank: "大将", status: "active",
    factionId: index < 3 ? "attacker" : "defender", locationCityId: index < 3 ? "origin" : "target",
    war: 80, intelligence: 80, leadership: 80, politics: 80, charm: 80 }));
  const city = (id, factionId, officerIds, count) => ({ id, name: id, factionId, officerIds,
    troops: count * 5000, food: 100000, gold: 1000, training: 80, morale: 80, wallLevel: 2, defense: 80 });
  const sourceCity = city("origin", "attacker", ["a", "b", "c"], allies);
  const targetCity = city("target", "defender", ["d", "e", "f"], defenders);
  targetCity.ambushPreparation = preparation;
  const form = (id) => ({ officerIds: [id], troops: 5000, composition: { infantry: 5000 } });
  const battle = new BattleEngine({ sourceCity, targetCity, rules, officers,
    divisions: ["a", "b", "c"].slice(0, allies).map(form), defenderDivisions: ["d", "e", "f"].slice(0, defenders).map(form),
    map: { width: 13, height: 9, terrain: Array(117).fill("plain"), stronghold: { x: 12, y: 4 },
      attackerStarts: [{ x: 2, y: 4 }, { x: 0, y: 8 }, { x: 0, y: 0 }],
      defenderStarts: [{ x: 3, y: 4 }, { x: 12, y: 8 }, { x: 12, y: 0 }] },
    supplies: { food: 100000, gold: 1000 }, playerSide, rng, state: { elapsedMonths } });
  const caster = battle.livingUnits("ally")[0], target = battle.livingUnits("enemy")[0];
  battle.queue = [caster.id, target.id, ...battle.units.filter((unit) => ![caster.id, target.id].includes(unit.id)).map((unit) => unit.id)];
  return { battle, caster, target, sourceCity, targetCity, rules };
}

function activate(battle, unit) {
  battle.queue = [unit.id, ...battle.queue.filter((id) => id !== unit.id)];
  unit.actionPoints = unit.maxActionPoints;
}

function pendingPursuit(caster, target) {
  target.provocation = { sourceId: caster.id, lastKnownPosition: { ...caster.position }, active: false };
}

test("all active stratagems require adjacent enemies while fire arrows keep their weapon range", () => {
  for (const action of ["fire", "doubt", "provoke"]) {
    const { battle, caster, target } = fixture();
    target.position = { x: 4, y: 4 };
    const before = structuredClone({ units: battle.units, supplies: battle.supplies, queue: battle.queue });
    assert.deepEqual(battle.strategyTargets(action), []);
    assert.equal(battle[action](target.id).ok, false);
    assert.deepEqual({ units: battle.units, supplies: battle.supplies, queue: battle.queue }, before);
    target.position = { x: 3, y: 4 };
    assert.ok(battle.strategyTargets(action).includes(target));
    assert.equal(battle[action](target.id).ok, true);
    assert.equal(caster.actionPoints, caster.maxActionPoints - battle.actionCost(action, caster));
  }
  const { battle, caster, target } = fixture();
  caster.composition = { archer: 5000 }; battle.refreshCombatStats(caster);
  target.position = { x: 4, y: 4 };
  assert.ok(battle.fireArrowTargets().includes(target));
  assert.equal(battle.fireArrow(target.id).ok, true);
});

test("illegal, hidden, friendly, in-city, dead, duplicate, unaffordable and exhausted targets never charge", () => {
  for (const action of ["doubt", "provoke"]) for (const invalid of ["missing", "friendly", "dead", "city", "hidden", "duplicate", "money", "ap"]) {
    const { battle, caster, target } = fixture();
    let targetId = target.id;
    if (invalid === "missing") targetId = "missing";
    if (invalid === "friendly") targetId = caster.id;
    if (invalid === "dead") target.troops = 0;
    if (invalid === "city") target.inCity = true;
    if (invalid === "hidden") { target.ambushing = true; battle.visibilityHooks = { detectAmbush: () => false }; }
    if (invalid === "duplicate") target[action === "doubt" ? "doubt" : "provocation"] = { sourceId: caster.id };
    if (invalid === "money") battle.supplies.ally.gold = battle.strategyGoldCost(action) - 1;
    if (invalid === "ap") caster.actionPoints = battle.actionCost(action) - 1;
    const before = structuredClone({ units: battle.units, supplies: battle.supplies, queue: battle.queue, log: battle.log });
    assert.equal(battle[action](targetId).ok, false, `${action}: ${invalid}`);
    assert.deepEqual({ units: battle.units, supplies: battle.supplies, queue: battle.queue, log: battle.log }, before);
  }
});

test("failed schemes charge exactly once, use intelligence difference and leave no status", () => {
  for (const action of ["doubt", "provoke"]) {
    const { battle, caster, target, rules } = fixture({ rng: () => 0.999 });
    const gold = battle.supplies.ally.gold, ap = caster.actionPoints;
    const result = battle[action](target.id);
    assert.equal(result.ok, true); assert.equal(result.success, false);
    assert.equal(battle.supplies.ally.gold, gold - battle.strategyGoldCost(action));
    assert.equal(caster.actionPoints, ap - battle.actionCost(action));
    assert.equal(target.doubt, null); assert.equal(target.provocation, null);
    assert.ok(strategySuccessChance(action, { intelligence: 100 }, { intelligence: 20 }, rules)
      > strategySuccessChance(action, { intelligence: 20 }, { intelligence: 100 }, rules));
  }
});

for (const playerSide of ["ally", "enemy"]) test(`doubt skips exactly the next activation for either controller (${playerSide})`, () => {
  const { battle, caster, target } = fixture({ playerSide });
  assert.equal(battle.doubt(target.id).success, true);
  assert.equal(battle.activeUnit, caster, "applying a status does not advance either formation");
  const before = structuredClone({ units: battle.units, queue: battle.queue });
  for (let i = 0; i < 4; i += 1) { assert.equal(battle.activeUnit, caster); assert.equal(battle.hasForcedAction(target), true); }
  assert.deepEqual({ units: battle.units, queue: battle.queue }, before, "state queries have no side effects");
  battle.wait();
  assert.equal(battle.activeUnit, target);
  const result = battle.runForcedTurn();
  assert.equal(result.action, "doubt-skip"); assert.equal(result.actorId, target.id);
  assert.equal(result.activationEnded, true); assert.equal(target.doubt, null);
  assert.equal(target.actionPoints, 0); assert.notEqual(battle.activeUnit, target);
  const day = battle.day;
  while (battle.day === day) assert.equal(battle.wait().ok, true);
  assert.equal(battle.hasForcedAction(target), false);
  assert.equal(target.actionPoints, target.maxActionPoints);
});

test("doubt applied after a target has acted waits until the following day and consumes a pending provocation", () => {
  const { battle, caster, target } = fixture();
  activate(battle, target); battle.wait();
  assert.equal(battle.activeUnit, caster);
  pendingPursuit(caster, target);
  battle.doubt(target.id); battle.wait();
  const day = battle.day;
  while (battle.day === day) battle.wait();
  while (battle.activeUnit !== target) battle.wait();
  assert.equal(battle.runForcedTurn().action, "doubt-skip");
  assert.equal(target.provocation, null);
  assert.equal(target.doubt, null);
});

test("controlled formations cannot bypass forced resolution through any manual command", () => {
  for (const effect of ["doubt", "provocation"]) {
    const { battle, caster, target } = fixture();
    target.composition = { archer: 5000 }; battle.refreshCombatStats(target);
    battle.map.terrain[target.position.y * battle.map.width + target.position.x] = "forest";
    target[effect] = { sourceId: caster.id, lastKnownPosition: { ...caster.position }, active: false };
    activate(battle, target);
    const before = structuredClone({ units: battle.units, supplies: battle.supplies, queue: battle.queue, log: battle.log });
    const commands = [() => battle.moveStep(4, 4), () => battle.attack(caster.id), () => battle.shoot(caster.id),
      () => battle.fireArrow(caster.id), () => battle.fire(caster.id), () => battle.doubt(caster.id), () => battle.provoke(caster.id),
      () => battle.wait(), () => battle.ambush(), () => battle.retreatToCity()];
    for (const command of commands) assert.equal(command().ok, false);
    assert.deepEqual({ units: battle.units, supplies: battle.supplies, queue: battle.queue, log: battle.log }, before);
  }
});

for (const playerSide of ["ally", "enemy"]) test(`provoke permits repeated forced melee but no manual control (${playerSide})`, () => {
  const { battle, caster, target } = fixture({ playerSide, rng: () => 0.99 });
  pendingPursuit(caster, target); activate(battle, target);
  const first = battle.runForcedTurn();
  assert.equal(first.action, "attack"); assert.equal(first.actorId, target.id); assert.equal(first.targetId, caster.id);
  assert.equal(first.forced, true); assert.equal(first.actionContinues, true);
  assert.equal(battle.wait().ok, false);
  const second = battle.runForcedTurn();
  assert.equal(second.action, "attack"); assert.equal(second.activationEnded, true);
  assert.equal(target.provocation, null); assert.equal(battle.hasForcedAction(target), false);
  assert.equal(battle.runForcedTurn().ok, false);
});

test("a successful provoking caster can withdraw, then the victim pursues one ordinary grid step per call and attacks", () => {
  const { battle, caster, target } = fixture();
  assert.equal(battle.provoke(target.id).success, true);
  assert.equal(battle.moveStep(1, 4).ok, true);
  assert.equal(battle.moveStep(0, 4).ok, true);
  assert.equal(battle.activeUnit, target);
  for (let i = 0; i < 2; i += 1) {
    const before = { ...target.position }, ap = target.actionPoints;
    const result = battle.runForcedTurn();
    assert.equal(result.action, "move"); assert.equal(result.step, true); assert.equal(result.cautious, false);
    assert.equal(battle.distance(before, target.position), 1); assert.equal(target.actionPoints, ap - result.cost);
  }
  const hit = battle.runForcedTurn();
  assert.equal(hit.action, "attack"); assert.equal(hit.targetId, caster.id);
  assert.equal(hit.activationEnded, true); assert.equal(target.provocation, null);
});

test("a defending caster can bait the attacking player using the same city wallet and forced runner", () => {
  const { battle, caster: attacker, target: defender } = fixture();
  activate(battle, defender);
  const ap = defender.actionPoints, gold = battle.supplies.enemy.gold;
  assert.equal(battle.provoke(attacker.id).success, true);
  assert.equal(defender.actionPoints, ap - battle.actionCost("provoke", defender));
  assert.equal(battle.supplies.enemy.gold, gold - battle.strategyGoldCost("provoke"));
  assert.equal(battle.supplies.ally.gold, 1000);
  assert.equal(battle.moveStep(4, 4).ok, true);
  assert.equal(battle.moveStep(5, 4).ok, true);
  assert.equal(battle.activeUnit, attacker);
  assert.equal(battle.runForcedTurn().action, "move");
  assert.equal(battle.runForcedTurn().action, "move");
  const hit = battle.runForcedTurn();
  assert.equal(hit.action, "attack"); assert.equal(hit.actorId, attacker.id); assert.equal(hit.targetId, defender.id);
  assert.equal(hit.activationEnded, true); assert.equal(attacker.provocation, null);
});

test("provocation is consumed at the day boundary even when that unit immediately acts first next day", () => {
  const { battle, caster, target } = fixture({ rng: () => 0.99 });
  target.leadership = 100;
  battle.refreshCombatStats(target);
  pendingPursuit(caster, target);
  battle.queue = [target.id];
  target.actionPoints = battle.actionCost("attack", target);
  const result = battle.runForcedTurn();
  assert.equal(result.action, "attack"); assert.equal(result.activationEnded, true);
  assert.equal(battle.day, 2); assert.equal(battle.activeUnit, target);
  assert.equal(target.provocation, null); assert.equal(battle.hasForcedAction(), false);
  assert.equal(battle.runForcedTurn().ok, false);
  assert.equal(battle.wait().ok, true);
});

test("forced pursuit triggers every eligible ambush in order, stops immediately and does not resume", () => {
  const { battle, caster, target } = fixture({ allies: 3 });
  caster.position = { x: 0, y: 4 };
  target.position = { x: 3, y: 4 };
  const ambushers = battle.livingUnits("ally").slice(1);
  ambushers.forEach((unit, index) => {
    unit.position = index ? { x: 2, y: 3 } : { x: 1, y: 4 };
    unit.ambushing = true;
    battle.map.terrain[unit.position.y * battle.map.width + unit.position.x] = "forest";
  });
  pendingPursuit(caster, target); activate(battle, target);
  const result = battle.runForcedTurn();
  assert.equal(result.action, "move"); assert.equal(result.ambushes.length, 2);
  assert.equal(result.interrupted, true); assert.equal(result.activationEnded, true);
  assert.equal(result.cautious, false); assert.equal(target.provocation, null);
  assert.equal(target.actionPoints, 0); assert.notEqual(battle.activeUnit, target);
  assert.ok(ambushers.every((unit) => !unit.ambushing));
  assert.equal(battle.runForcedTurn().ok, false);
});

test("pursuit respects terrain cost and cannot pass directly between enemy ZOC tiles", () => {
  const { battle, caster, target } = fixture({ allies: 3 });
  caster.position = { x: 0, y: 4 }; target.position = { x: 4, y: 4 };
  const guard = battle.livingUnits("ally")[1]; guard.position = { x: 3, y: 4 };
  pendingPursuit(caster, target); activate(battle, target);
  const before = { ...target.position };
  const result = battle.runForcedTurn();
  if (result.action === "move") {
    assert.equal(battle.isInEnemyZoc(before, target.side) && battle.isInEnemyZoc(target.position, target.side), false);
  } else assert.equal(result.action, "provoke-end");

  const data = fixture();
  data.caster.position = { x: 0, y: 4 }; data.target.position = { x: 3, y: 4 };
  pendingPursuit(data.caster, data.target); activate(data.battle, data.target);
  for (const neighbor of data.battle.neighbors(data.target.position)) data.battle.map.terrain[neighbor.y * data.battle.map.width + neighbor.x] = "hill";
  const ap = data.target.actionPoints;
  const step = data.battle.runForcedTurn();
  assert.equal(step.action, "move"); assert.equal(step.cost, originalRules.terrain.hill.move);
  assert.equal(data.target.actionPoints, ap - step.cost);
});

test("hidden caster movement is not tracked beyond the last observed tile", () => {
  const { battle, caster, target } = fixture();
  caster.position = { x: 0, y: 0 }; target.position = { x: 4, y: 4 };
  target.provocation = { sourceId: caster.id, lastKnownPosition: { x: 2, y: 4 }, active: false };
  battle.map.terrain[0] = "forest";
  activate(battle, target);
  assert.equal(battle.isUnitVisibleTo(caster, target.side), false);
  const result = battle.runForcedTurn();
  assert.equal(result.action, "move");
  assert.deepEqual(target.provocation.lastKnownPosition, { x: 2, y: 4 });
  assert.equal(battle.distance(target.position, { x: 2, y: 4 }), 1);
  caster.position = { x: 12, y: 0 };
  assert.equal(battle.runForcedTurn().action, "move");
  assert.deepEqual(target.position, { x: 2, y: 4 });
  assert.deepEqual(target.provocation.lastKnownPosition, { x: 2, y: 4 });
  const end = battle.runForcedTurn();
  assert.equal(end.action, "provoke-end"); assert.equal(end.activationEnded, true);
});

test("pursuit memory follows visible caster steps but stops updating upon entering concealed woodland", () => {
  const { battle, caster, target } = fixture();
  caster.composition = { cavalry: 5000 };
  battle.refreshCombatStats(caster);
  caster.actionPoints = caster.maxActionPoints;
  assert.equal(battle.provoke(target.id).success, true);
  assert.equal(battle.moveStep(1, 4).ok, true);
  assert.deepEqual(target.provocation.lastKnownPosition, { x: 1, y: 4 });
  battle.map.terrain[4 * battle.map.width] = "forest";
  assert.equal(battle.moveStep(0, 4).ok, true);
  assert.equal(battle.isUnitVisibleTo(caster, target.side), false);
  assert.deepEqual(target.provocation.lastKnownPosition, { x: 1, y: 4 });
});

test("dead, returned, removed and no-longer-hostile casters cancel provocation without consuming normal AP", () => {
  for (const invalid of ["dead", "city", "removed", "friendly", "offboard"]) {
    const { battle, caster, target } = fixture();
    pendingPursuit(caster, target); activate(battle, target);
    if (invalid === "dead") caster.troops = 0;
    if (invalid === "city") caster.inCity = true;
    if (invalid === "removed") battle.units = battle.units.filter((unit) => unit !== caster);
    if (invalid === "friendly") caster.side = target.side;
    if (invalid === "offboard") caster.position.x = -1;
    const ap = target.actionPoints;
    const result = battle.runForcedTurn();
    assert.equal(result.action, "provoke-cancel"); assert.equal(target.provocation, null);
    assert.equal(target.actionPoints, ap); assert.equal(battle.activeUnit, target);
    assert.equal(battle.wait().ok, true);
  }
});

test("a destroyed caster's provocation cannot transfer to a same-ID reserve replacement", () => {
  const { battle, caster: attacker, target: defender } = fixture({ rng: () => 0.99 });
  for (const unit of battle.livingUnits("enemy")) {
    unit.troops = unit === defender ? 1 : 0;
    unit.composition = unit === defender ? { infantry: 1 } : {};
    battle.refreshCombatStats(unit);
  }
  battle.defenderReserveTroops = 5000;
  battle.automaticDefenderReinforcements = true;
  pendingPursuit(defender, attacker);
  activate(battle, attacker);
  const result = battle.runForcedTurn();
  assert.equal(result.action, "attack"); assert.equal(result.damage, 1);
  assert.ok(defender.troops > 0, "the reserve line has re-formed using the same formation ID");
  assert.equal(attacker.provocation, null);
  assert.equal(battle.hasForcedAction(attacker), false);
  assert.equal(battle.wait().ok, true, "losing the real caster restores normal command of remaining AP");
});

test("siege entry clears field-only control and ambush states on every formation", () => {
  const { battle, caster, target } = fixture();
  pendingPursuit(caster, target); caster.doubt = { sourceId: target.id }; target.ambushing = true;
  battle.enterSiege();
  assert.equal(battle.hasForcedAction(target), false);
  assert.ok(battle.units.every((unit) => unit.doubt === null && unit.provocation === null && !unit.ambushing));
});

test("AI may try a legal control scheme once per activation, and forced actions also work on its side", () => {
  const rolls = [0, 0.4, 0, 0.99];
  const { battle, caster, target } = fixture({ playerSide: "enemy", rng: () => rolls.shift() ?? 0.99 });
  const result = battle.runEnemyTurn();
  assert.equal(result.action, "doubt"); assert.equal(result.targetId, target.id); assert.equal(result.success, true);
  assert.equal(caster.strategyAttempted, true);
  const next = battle.runEnemyTurn();
  assert.equal(next.action, "attack", "AI does not spend its remaining AP on an endless series of control attempts");
  assert.equal(battle.activeUnit, target);
  assert.equal(battle.runEnemyTurn().ok, false, "AI entry point cannot take over the player's unit");
  assert.equal(battle.runForcedTurn().action, "doubt-skip");
});

test("defender ambush preparation buffs only the first real ambush hit, never mutates the strategic city", () => {
  const preparation = { id: "prepared-1", factionId: "defender", expiresTurn: 3, bonus: 0.25 };
  const setup = (prep, elapsedMonths = 0) => {
    const data = fixture({ preparation: prep, elapsedMonths });
    data.caster.position = { x: 2, y: 4 };
    data.battle.livingUnits("enemy").forEach((unit, index) => {
      unit.position = { x: 4, y: 4 + index }; unit.ambushing = true;
      data.battle.map.terrain[unit.position.y * data.battle.map.width + unit.position.x] = "forest";
    });
    return data;
  };
  const ordinary = setup(undefined), prepared = setup(preparation);
  const before = structuredClone(prepared.targetCity);
  const plain = ordinary.battle.moveStep(3, 4), bonus = prepared.battle.moveStep(3, 4);
  assert.equal(bonus.ambushes.length, 2);
  assert.equal(bonus.ambushes[0].damage, Math.round(plain.ambushes[0].damage * 1.25));
  assert.equal(bonus.ambushes[0].preparationBonus, 0.25);
  assert.equal(bonus.ambushes[1].preparationBonus, 0);
  assert.equal(prepared.battle.ambushPreparationUsedId, preparation.id);
  assert.deepEqual(prepared.targetCity, before);
  const expired = setup(preparation, 3);
  assert.equal(expired.battle.moveStep(3, 4).ambushes[0].preparationBonus, 0);
  assert.equal(expired.battle.ambushPreparationUsedId, null);
});
