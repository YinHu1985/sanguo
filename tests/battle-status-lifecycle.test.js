import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { getStrategyConfig } from "../src/js/game/battle-strategies.js";
import { initializeBattleStatuses, getBattleStatus, applyBattleStatus, getControllingStatus } from "../src/js/game/battle-statuses.js";

const originalRules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));

function fixture({ targetSide = "enemy", duration = 3, rng = () => 0.99, allies = 2 } = {}) {
  const rules = structuredClone(originalRules);
  for (const action of ["doubt", "provoke"]) rules.battle.strategies[action].durationActivations = duration;
  const officers = ["a", "b", "c", "d", "e"].map((id, index) => ({ id, name: id, status: "active", rank: "大将",
    factionId: index < 3 ? "A" : "B", locationCityId: index < 3 ? "origin" : "target",
    war: 80, intelligence: 80, leadership: 80, politics: 80, charm: 80 }));
  const city = (id, factionId, officerIds, troops) => ({ id, name: id, factionId, officerIds, troops,
    food: 100000, gold: 1000, training: 80, morale: 80, wallLevel: 1, defense: 80 });
  const formation = (id) => ({ officerIds: [id], troops: 10000, composition: { infantry: 10000 } });
  const battle = new BattleEngine({ sourceCity: city("origin", "A", ["a", "b", "c"], allies * 10000),
    targetCity: city("target", "B", ["d", "e"], 20000), officers, rules,
    divisions: ["a", "b", "c"].slice(0, allies).map(formation), defenderDivisions: ["d", "e"].map(formation),
    map: { width: 13, height: 9, terrain: Array(117).fill("plain"), stronghold: { x: 12, y: 4 },
      attackerStarts: [{ x: 2, y: 4 }, { x: 0, y: 8 }, { x: 0, y: 0 }],
      defenderStarts: [{ x: 3, y: 4 }, { x: 12, y: 8 }] },
    supplies: { food: 100000, gold: 1000 }, playerSide: targetSide, rng });
  const target = battle.livingUnits(targetSide)[0], source = battle.livingUnits(targetSide === "ally" ? "enemy" : "ally")[0];
  battle.queue = [source.id, target.id, ...battle.units.filter((unit) => ![source.id, target.id].includes(unit.id)).map((unit) => unit.id)];
  return { battle, source, target, rules };
}

function activate(battle, unit) {
  battle.queue = [unit.id, ...battle.queue.filter((id) => id !== unit.id)];
  unit.actionPoints = unit.maxActionPoints;
}

function advanceTo(battle, unit) {
  for (let steps = 0; steps < 30 && battle.activeUnit?.id !== unit.id; steps += 1) {
    const result = battle.hasForcedAction() ? battle.runForcedTurn() : battle.wait();
    assert.equal(result.ok, true, result.message);
  }
  assert.equal(battle.activeUnit?.id, unit.id);
}

function addControl(target, source, type, remainingActivations) {
  const applied = applyBattleStatus(target, type, { sourceId: source.id, remainingActivations,
    ...(type === "provocation" ? { lastKnownPosition: { ...source.position }, active: false } : {}) });
  assert.equal(applied.ok, true, applied.message);
}

for (const targetSide of ["ally", "enemy"]) test(`configured three-activation doubt skips three complete turns on ${targetSide}`, () => {
  const { battle, source, target } = fixture({ targetSide, rng: () => 0 });
  assert.equal(battle.doubt(target.id).success, true);
  assert.equal(getBattleStatus(target, "doubt").remainingActivations, 3);
  battle.wait();
  for (let remaining = 3; remaining > 0; remaining -= 1) {
    advanceTo(battle, target);
    const before = JSON.stringify(target.statuses), queue = [...battle.queue], day = battle.day;
    for (let read = 0; read < 3; read += 1) {
      assert.equal(battle.hasForcedAction(), true); assert.equal(battle.activeUnit, target);
      assert.equal(getControllingStatus(target).type, "doubt");
    }
    assert.equal(JSON.stringify(target.statuses), before); assert.deepEqual(battle.queue, queue); assert.equal(battle.day, day);
    const result = battle.runForcedTurn();
    assert.equal(result.action, "doubt-skip"); assert.equal(result.activationEnded, true);
    assert.equal(getBattleStatus(target, "doubt")?.remainingActivations ?? 0, remaining - 1);
    assert.notEqual(battle.activeUnit, target);
  }
  advanceTo(battle, target);
  assert.equal(battle.hasForcedAction(), false); assert.equal(battle.wait().ok, true);
  assert.equal(source.statuses.doubt, undefined);
});

for (const targetSide of ["ally", "enemy"]) test(`configured three-activation provocation lasts whole turns rather than attack steps on ${targetSide}`, () => {
  const { battle, source, target } = fixture({ targetSide });
  battle.rng = () => 0;
  assert.equal(battle.provoke(target.id).success, true);
  battle.rng = () => 0.99;
  battle.wait();
  for (let remaining = 3; remaining > 0; remaining -= 1) {
    advanceTo(battle, target);
    assert.equal(getBattleStatus(target, "provocation").remainingActivations, remaining);
    assert.equal(getBattleStatus(target, "provocation").active, false);
    const first = battle.runForcedTurn();
    assert.equal(first.action, "attack"); assert.equal(first.actionContinues, true);
    assert.equal(getBattleStatus(target, "provocation").remainingActivations, remaining, "partial actions do not consume duration");
    assert.equal(getBattleStatus(target, "provocation").active, true);
    assert.equal(battle.wait().ok, false);
    const second = battle.runForcedTurn();
    assert.equal(second.action, "attack"); assert.equal(second.activationEnded, true);
    assert.equal(getBattleStatus(target, "provocation")?.remainingActivations ?? 0, remaining - 1);
    if (remaining > 1) assert.equal(getBattleStatus(target, "provocation").active, false);
  }
  advanceTo(battle, target);
  assert.equal(battle.hasForcedAction(), false); assert.equal(battle.attack(source.id).ok, true);
});

test("different-duration controls both consume one activation while doubt takes priority", () => {
  for (const [doubtDuration, provokeDuration] of [[2, 3], [3, 1]]) {
    const { battle, source, target } = fixture();
    addControl(target, source, "doubt", doubtDuration);
    addControl(target, source, "provocation", provokeDuration);
    activate(battle, target);
    for (let round = 0; round < Math.max(doubtDuration, provokeDuration); round += 1) {
      advanceTo(battle, target);
      if (round < doubtDuration) assert.equal(battle.runForcedTurn().action, "doubt-skip");
      else {
        assert.equal(battle.runForcedTurn().action, "attack");
        assert.equal(battle.runForcedTurn().activationEnded, true);
      }
      assert.equal(getBattleStatus(target, "doubt")?.remainingActivations ?? 0, Math.max(0, doubtDuration - round - 1));
      assert.equal(getBattleStatus(target, "provocation")?.remainingActivations ?? 0, Math.max(0, provokeDuration - round - 1));
    }
    assert.deepEqual(target.statuses, {});
  }
});

test("multi-step pursuit preserves duration until the complete activation ends", () => {
  const { battle, source, target } = fixture();
  source.position = { x: 0, y: 4 };
  addControl(target, source, "provocation", 3); activate(battle, target);
  for (let step = 0; step < 2; step += 1) {
    assert.equal(battle.runForcedTurn().action, "move");
    assert.equal(getBattleStatus(target, "provocation").remainingActivations, 3);
  }
  assert.equal(battle.runForcedTurn().action, "attack");
  assert.equal(getBattleStatus(target, "provocation").remainingActivations, 2);
});

test("an exhausted activation consumes one duration even when there was no legal action", () => {
  for (const type of ["doubt", "provocation"]) {
    const { battle, source, target } = fixture();
    addControl(target, source, type, 3); activate(battle, target); target.actionPoints = 0;
    const result = battle.runForcedTurn();
    assert.equal(result.activationEnded, true);
    assert.equal(getBattleStatus(target, type).remainingActivations, 2);
    assert.notEqual(battle.activeUnit, target);
  }
});

test("multi-ambush interruption consumes one activation but leaves future provocation activations", () => {
  const { battle, source, target } = fixture({ allies: 3 });
  source.position = { x: 0, y: 4 };
  battle.livingUnits("ally").slice(1).forEach((unit, index) => {
    unit.position = index ? { x: 2, y: 3 } : { x: 1, y: 4 };
    unit.ambushing = true;
    battle.map.terrain[unit.position.y * battle.map.width + unit.position.x] = "forest";
  });
  addControl(target, source, "provocation", 3); activate(battle, target);
  const result = battle.runForcedTurn();
  assert.equal(result.action, "move"); assert.equal(result.ambushes.length, 2);
  assert.equal(result.interrupted, true); assert.equal(result.activationEnded, true);
  assert.equal(getBattleStatus(target, "provocation").remainingActivations, 2);
  assert.equal(getBattleStatus(target, "provocation").active, false);
  advanceTo(battle, target);
  assert.equal(getBattleStatus(target, "provocation").remainingActivations, 2, "other units and a new day do not consume extra duration");
  assert.equal(battle.hasForcedAction(), true);
  const next = battle.runForcedTurn();
  assert.equal(next.ok, true); assert.equal(next.forced, true);
});

test("last unit at a day boundary ticks once even if it immediately acts first again", () => {
  const { battle, source, target } = fixture();
  target.leadership = 100; battle.refreshCombatStats(target);
  addControl(target, source, "provocation", 3);
  battle.queue = [target.id]; target.actionPoints = battle.actionCost("attack", target);
  assert.equal(battle.runForcedTurn().activationEnded, true);
  assert.equal(battle.day, 2); assert.equal(battle.activeUnit, target);
  assert.equal(getBattleStatus(target, "provocation").remainingActivations, 2);
  assert.equal(getBattleStatus(target, "provocation").active, false);
  assert.equal(battle.runForcedTurn().actionContinues, true);
  assert.equal(getBattleStatus(target, "provocation").remainingActivations, 2);
  assert.equal(battle.runForcedTurn().activationEnded, true);
  assert.equal(getBattleStatus(target, "provocation").remainingActivations, 1);
});

test("legacy status fields migrate once into a single serializable canonical record", () => {
  const { battle, source, target } = fixture();
  const legacy = JSON.parse(JSON.stringify(target));
  delete legacy.statuses;
  legacy.doubt = { sourceId: source.id };
  legacy.provocation = { sourceId: source.id, lastKnownPosition: { ...source.position }, active: false };
  initializeBattleStatuses(legacy);
  battle.units[battle.units.indexOf(target)] = legacy; activate(battle, legacy);
  assert.equal(legacy.doubt.remainingActivations, 1); assert.equal(legacy.provocation.remainingActivations, 1);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(legacy)), "doubt"), false);
  assert.equal(Object.hasOwn(structuredClone(legacy), "provocation"), false);
  assert.equal(battle.runForcedTurn().action, "doubt-skip");
  assert.deepEqual(legacy.statuses, {}); assert.equal(legacy.doubt, null); assert.equal(legacy.provocation, null);
});

test("JSON and structured snapshots preserve remaining duration across restoration", () => {
  for (const copy of [structuredClone, (value) => JSON.parse(JSON.stringify(value))]) {
    const { battle, source, target } = fixture();
    addControl(target, source, "doubt", 3); activate(battle, target);
    battle.runForcedTurn();
    const restored = copy(target);
    assert.equal(restored.statuses.doubt.remainingActivations, 2);
    assert.equal(Object.hasOwn(restored, "doubt"), false);
    initializeBattleStatuses(restored);
    battle.units[battle.units.indexOf(target)] = restored; activate(battle, restored);
    assert.equal(battle.runForcedTurn().action, "doubt-skip");
    assert.equal(restored.statuses.doubt.remainingActivations, 1);
  }
});

test("duplicate casts cannot refresh or stack the remaining duration", () => {
  const { battle, source, target } = fixture({ rng: () => 0 });
  battle.doubt(target.id); battle.wait(); battle.runForcedTurn();
  activate(battle, source);
  const remaining = getBattleStatus(target, "doubt").remainingActivations;
  const ap = source.actionPoints, gold = battle.supplies.ally.gold;
  battle.rules.battle.strategies.doubt.durationActivations = 10;
  assert.equal(battle.doubt(target.id).ok, false);
  assert.equal(applyBattleStatus(target, "doubt", { sourceId: source.id, remainingActivations: 10 }).ok, false);
  assert.equal(getBattleStatus(target, "doubt").remainingActivations, remaining);
  assert.equal(source.actionPoints, ap); assert.equal(battle.supplies.ally.gold, gold);
});

test("duration configuration accepts only positive safe integers and defaults to one", () => {
  for (const invalid of [undefined, null, 0, -1, 1.5, "3", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const { battle, target, rules } = fixture({ rng: () => 0 });
    rules.battle.strategies.doubt.durationActivations = invalid;
    assert.equal(getStrategyConfig("doubt", rules).durationActivations, 1);
    assert.equal(battle.doubt(target.id).success, true);
    assert.equal(getBattleStatus(target, "doubt").remainingActivations, 1);
  }
  assert.equal(getStrategyConfig("provoke", { battle: { strategies: { provoke: { durationActivations: 4 } } } }).durationActivations, 4);
});

test("source loss, source return, siege entry and battle end clear multi-activation control immediately", () => {
  for (const transition of ["sourceDead", "sourceReturn", "siege", "battleEnd"]) {
    const { battle, source, target } = fixture({ targetSide: "ally" });
    addControl(target, source, "provocation", 3);
    if (transition === "sourceDead") { source.troops = 0; activate(battle, target); assert.equal(battle.runForcedTurn().action, "provoke-cancel"); }
    if (transition === "sourceReturn") { activate(battle, source); assert.equal(battle.retreatToCity().ok, true); }
    if (transition === "siege") { addControl(target, source, "doubt", 3); battle.enterSiege(); }
    if (transition === "battleEnd") { addControl(target, source, "doubt", 3); battle.retreatArmy("ally"); }
    assert.equal(getBattleStatus(target, "provocation"), null);
    if (["siege", "battleEnd"].includes(transition)) assert.deepEqual(target.statuses, {});
  }
});

test("a routed and refilled same-ID formation cannot retain its previous control duration", () => {
  const { battle, source, target } = fixture({ rng: () => 0 });
  addControl(target, source, "doubt", 3);
  for (const unit of battle.livingUnits("enemy")) {
    unit.troops = unit === target ? 1 : 0;
    unit.composition = unit === target ? { infantry: 1 } : {};
    battle.refreshCombatStats(unit);
  }
  battle.defenderReserveTroops = 5000; battle.automaticDefenderReinforcements = true;
  assert.equal(battle.fire(target.id).ok, true);
  assert.ok(target.troops > 0);
  assert.deepEqual(target.statuses, {});
});
