import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const originalRules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));

function makeBattle(options = {}) {
  const rules = structuredClone(originalRules);
  rules.battle.field = { ...rules.battle.field, ...options.field };
  const map = { width: 9, height: 7, stronghold: { x: 8, y: 3 }, terrain: Array(63).fill("plain"),
    attackerStarts: [{ x: 0, y: 3 }, { x: 0, y: 5 }], defenderStarts: [{ x: 8, y: 2 }, { x: 8, y: 5 }], ...options.map };
  const sourceCity = { ...structuredClone(scenario.cities.find((city) => city.id === "xiaopei")), ...options.sourceCity };
  const targetCity = { ...structuredClone(scenario.cities.find((city) => city.id === "puyang")),
    troops: 6000, food: 100000, gold: 1000, ...options.targetCity };
  return new BattleEngine({ sourceCity, targetCity, rules, map, officers: structuredClone(scenario.officers),
    divisions: options.divisions ?? [{ officerId: "guan-yu", troops: 5000, unitType: options.unitType ?? "infantry" }],
    defenderDivisions: options.defenderDivisions ?? [{ officerId: "xiahou-dun", troops: 3000 }],
    supplies: { food: 100000, gold: 1000 }, playerSide: options.playerSide ?? "ally", rng: options.rng ?? (() => 0.5) });
}

function activate(battle, unit) {
  battle.queue = [unit.id, ...battle.queue.filter((id) => id !== unit.id)];
  unit.actionPoints = unit.maxActionPoints;
}

function terrain(battle, position, kind) {
  battle.map.terrain[position.y * battle.map.width + position.x] = kind;
}

function prepareAmbush(options = {}) {
  const battle = makeBattle(options);
  const mover = battle.livingUnits("ally")[0];
  mover.position = { x: 2, y: 3 };
  const defenders = battle.livingUnits("enemy");
  defenders.forEach((unit, index) => {
    unit.position = { x: 4, y: 3 + index };
    terrain(battle, unit.position, index ? "hill" : "forest");
    unit.ambushing = true;
  });
  activate(battle, mover);
  return { battle, mover, defenders };
}

test("field movement and attack costs are scaled down while move then attack still fits", () => {
  const infantry = makeBattle();
  const cavalry = makeBattle({ unitType: "cavalry" });
  const archer = makeBattle({ unitType: "archer" });
  assert.equal(infantry.livingUnits("ally")[0].maxActionPoints, 4);
  assert.equal(cavalry.livingUnits("ally")[0].maxActionPoints, 5);
  assert.equal(archer.livingUnits("ally")[0].maxActionPoints, 4);
  assert.equal(infantry.actionCost("attack"), 2);
  assert.equal(cavalry.actionCost("attack"), 2);
  assert.equal(infantry.actionCost("fire"), 2);
  const mover = infantry.livingUnits("ally")[0];
  const enemy = infantry.livingUnits("enemy")[0];
  mover.position = { x: 2, y: 3 };
  enemy.position = { x: 4, y: 3 };
  activate(infantry, mover);
  assert.equal(infantry.moveStep(3, 3).ok, true);
  assert.equal(infantry.attack(enemy.id).ok, true);
  assert.equal(mover.actionPoints, 1);
});

test("AP scaling clamps and terrain-aware cautious cost is triple but at most a full activation", () => {
  const minimum = makeBattle({ field: { movementScale: 0.01 } });
  const maximum = makeBattle({ field: { movementScale: 5 } });
  assert.equal(minimum.livingUnits("ally")[0].maxActionPoints, 2);
  assert.equal(maximum.livingUnits("ally")[0].maxActionPoints, 5);
  const battle = makeBattle();
  const unit = battle.livingUnits("ally")[0];
  unit.position = { x: 2, y: 3 };
  activate(battle, unit);
  assert.equal(battle.movementCostAt(3, 3, unit, { cautious: true }), 3);
  terrain(battle, { x: 3, y: 3 }, "hill");
  assert.equal(battle.movementCostAt(3, 3), 3);
  assert.equal(battle.movementCostAt(3, 3, unit, { cautious: true }), unit.maxActionPoints);
  unit.actionPoints = unit.maxActionPoints - 1;
  assert.equal(battle.moveStep(3, 3, { cautious: true }).ok, false);
  unit.actionPoints = unit.maxActionPoints;
  const move = battle.moveStep(3, 3, { cautious: true });
  assert.equal(move.ok, true);
  assert.equal(move.cost, unit.maxActionPoints);
  assert.equal(move.activationEnded, true);
});

test("cautious path cost and reachable tiles use the same terrain budget as individual steps", () => {
  const battle = makeBattle();
  const unit = battle.activeUnit;
  const normal = battle.reachableTiles(unit);
  const cautious = battle.reachableTiles(unit, { cautious: true });
  assert.ok(normal.length > cautious.length);
  assert.ok(cautious.every((tile) => battle.distance(unit.position, tile) === 1));
  const destination = cautious[0];
  const path = battle.findPath(destination, unit, { cautious: true });
  assert.equal(path.length, 1);
  assert.equal(path[0].cost, destination.cost);
  assert.equal(battle.move(destination.x, destination.y, { cautious: true }).cost, path[0].cost);
});

test("ambush can only be prepared in woods or hills and persists through waits and day reset", () => {
  const battle = makeBattle();
  const defender = battle.livingUnits("enemy")[0];
  activate(battle, defender);
  assert.equal(battle.canAmbush(defender), false);
  assert.equal(battle.ambush().ok, false);
  terrain(battle, defender.position, "hill");
  assert.equal(battle.canAmbush(defender), true);
  const result = battle.ambush();
  assert.equal(result.activationEnded, true);
  assert.equal(defender.ambushing, true);
  assert.equal(defender.actionPoints, 0);
  while (battle.day === 1) battle.wait();
  assert.equal(defender.ambushing, true);
  assert.equal(defender.actionPoints, defender.maxActionPoints);
  activate(battle, defender);
  battle.wait();
  assert.equal(defender.ambushing, true);
});

test("normal movement triggers every adjacent ambusher in initiative order without counters or charging their AP", () => {
  let rolls = 0;
  const { battle, mover, defenders } = prepareAmbush({ rng: () => { rolls += 1; return 0; },
    defenderDivisions: [{ officerId: "xiahou-dun", troops: 3000 }, { officerId: "cheng-yu", troops: 3000 }] });
  const beforeTroops = mover.troops;
  const beforeMorale = mover.morale;
  const beforeDefenders = defenders.map((unit) => ({ troops: unit.troops, actionPoints: unit.actionPoints }));
  const result = battle.moveStep(3, 3);
  assert.equal(result.ok, true);
  assert.equal(result.interrupted, true);
  assert.equal(result.activationEnded, true);
  assert.deepEqual(result.ambushes.map((event) => event.actorId), [...defenders].sort((a, b) => battle.initiative(b) - battle.initiative(a)).map((unit) => unit.id));
  assert.equal(rolls, 2, "each surprise hit uses one damage roll and no counterattack roll");
  assert.equal(mover.troops, beforeTroops - result.ambushes.reduce((sum, hit) => sum + hit.damage, 0));
  assert.equal(mover.morale, beforeMorale - 10);
  assert.equal(mover.actionPoints, 0);
  defenders.forEach((unit, index) => {
    assert.equal(unit.ambushing, false);
    assert.equal(unit.troops, beforeDefenders[index].troops);
    assert.equal(unit.actionPoints, beforeDefenders[index].actionPoints);
  });
  mover.position = { x: 2, y: 3 };
  activate(battle, mover);
  assert.equal(battle.moveStep(3, 3).ambushes, undefined, "a discharged ambush does not fire twice");
});

test("equal-initiative surprise attacks use stable unit-ID ordering", () => {
  const { battle, defenders } = prepareAmbush({
    defenderDivisions: [{ officerId: "xiahou-dun", troops: 3000 }, { officerId: "cheng-yu", troops: 3000 }] });
  defenders.forEach((unit) => { unit.leadership = 80; unit.training = 70; unit.morale = 70; unit.unitType = "infantry"; });
  const result = battle.moveStep(3, 3);
  assert.deepEqual(result.ambushes.map((hit) => hit.actorId), defenders.map((unit) => unit.id).sort());
});

test("a destroyed moving formation stops further ambushes and remains available for casualty animation", () => {
  const { battle, mover, defenders } = prepareAmbush({
    defenderDivisions: [{ officerId: "xiahou-dun", troops: 3000 }, { officerId: "cheng-yu", troops: 3000 }] });
  mover.troops = 1;
  const result = battle.moveStep(3, 3);
  assert.equal(result.ambushes.length, 1);
  assert.equal(result.interrupted, true);
  assert.equal(result.battleEnded, true);
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.getUnit(mover.id).troops, 0);
  assert.deepEqual(battle.getUnit(mover.id).position, { x: 3, y: 3 });
  assert.equal(defenders.find((unit) => unit.id !== result.ambushes[0].actorId).ambushing, true);
});

test("cautious movement discovers adjacent ambushers without triggering or disarming them", () => {
  const { battle, mover, defenders } = prepareAmbush();
  assert.equal(battle.isUnitVisibleTo(defenders[0], "ally"), false);
  const troops = mover.troops;
  const result = battle.moveStep(3, 3, { cautious: true });
  assert.equal(result.ok, true);
  assert.equal(result.cautious, true);
  assert.equal(result.ambushes, undefined);
  assert.equal(mover.troops, troops);
  assert.equal(defenders[0].ambushing, true);
  assert.equal(battle.isUnitVisibleTo(defenders[0], "ally"), true);
  assert.equal(battle.visibleUnitAt(4, 3, "ally").id, defenders[0].id);
});

test("same-zone movement is forbidden, but a path can leave enemy control and then reenter", () => {
  const { battle, mover, defenders } = prepareAmbush();
  defenders[0].ambushing = false;
  mover.position = { x: 3, y: 3 };
  activate(battle, mover);
  assert.equal(battle.isInEnemyZoc(mover.position, "ally"), true);
  assert.equal(battle.isInEnemyZoc({ x: 3, y: 2 }, "ally"), true);
  assert.equal(battle.moveStep(3, 2).ok, false);
  assert.equal(battle.moveStep(3, 2, { cautious: true }).ok, false, "caution is not permission to cross a control zone");
  const path = battle.findPath({ x: 3, y: 2 }, mover);
  assert.ok(path.length >= 2);
  let from = mover.position;
  for (const to of path) {
    assert.equal(battle.isInEnemyZoc(from, "ally", { knownOnly: true }) && battle.isInEnemyZoc(to, "ally", { knownOnly: true }), false);
    from = to;
  }
  assert.equal(battle.moveStep(2, 3).ok, true);
  assert.equal(battle.isInEnemyZoc(mover.position, "ally"), false);
});

test("control zones are the union of all live outside enemies, not per-unit zones", () => {
  const { battle, mover, defenders } = prepareAmbush({
    defenderDivisions: [{ officerId: "xiahou-dun", troops: 3000 }, { officerId: "cheng-yu", troops: 3000 }] });
  mover.position = { x: 3, y: 3 };
  defenders[0].position = { x: 4, y: 3 };
  defenders[1].position = { x: 1, y: 3 };
  defenders.forEach((unit) => { unit.ambushing = false; });
  assert.equal(battle.moveStep(2, 3).ok, false);
  defenders[1].inCity = true;
  assert.equal(battle.isInEnemyZoc({ x: 2, y: 3 }, "ally"), false);
  defenders[0].troops = 0;
  assert.equal(battle.isInEnemyZoc({ x: 3, y: 3 }, "ally"), false);
});

test("hidden occupancy and hidden control zones do not change route previews but stop illegal actual steps", () => {
  const { battle, mover, defenders } = prepareAmbush();
  battle.visibilityHooks = { detectAmbush: () => false };
  mover.position = { x: 3, y: 3 };
  const enemy = defenders[0];
  const beforePreview = battle.reachableTiles(mover);
  assert.ok(beforePreview.some((tile) => tile.x === 4 && tile.y === 3));
  assert.equal(battle.isInEnemyZoc(mover.position, "ally"), true);
  assert.equal(battle.isInEnemyZoc(mover.position, "ally", { knownOnly: true }), false);
  const blocked = battle.moveStep(4, 3);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.interrupted, true);
  assert.equal(blocked.message, "前方受阻，部队停止推进");
  assert.equal(blocked.message.includes(enemy.name), false);
  assert.deepEqual(mover.position, { x: 3, y: 3 });
  const zoc = battle.moveStep(3, 2);
  assert.equal(zoc.ok, false);
  assert.equal(zoc.interrupted, true);
  assert.equal(zoc.message, blocked.message);
});

test("hidden units cannot be attacked or targeted by fire even when their ID and coordinates are known", () => {
  const { battle, mover, defenders } = prepareAmbush();
  const enemy = defenders[0];
  assert.equal(battle.distance(mover.position, enemy.position), 2);
  mover.attackRange = 2;
  assert.equal(battle.attackTargets(mover).length, 0);
  assert.equal(battle.fireTargets(mover).length, 0);
  const before = { troops: enemy.troops, ap: mover.actionPoints, gold: battle.supplies.ally.gold };
  assert.equal(battle.attack(enemy.id).ok, false);
  assert.equal(battle.fire(enemy.id).ok, false);
  assert.deepEqual({ troops: enemy.troops, ap: mover.actionPoints, gold: battle.supplies.ally.gold }, before);
});

test("moving, attacking, firing, and returning to the city clear only the acting unit's ambush", () => {
  for (const action of ["move", "attack", "fire", "return"]) {
    const { battle, mover, defenders } = prepareAmbush();
    const defender = defenders[0];
    mover.position = { x: 3, y: 3 };
    activate(battle, defender);
    const result = action === "move" ? battle.moveStep(4, 2) : action === "attack" ? battle.attack(mover.id)
      : action === "fire" ? battle.fire(mover.id) : battle.retreatToCity();
    assert.equal(result.ok, true, action);
    assert.equal(defender.ambushing, false, action);
  }
});

test("ambush at the main stronghold resolves before occupation and only surviving attackers begin siege", () => {
  for (const survives of [true, false]) {
    const { battle, mover } = prepareAmbush({ map: { stronghold: { x: 3, y: 3 } } });
    if (!survives) mover.troops = 1;
    const result = battle.moveStep(3, 3);
    assert.equal(result.interrupted, true);
    assert.equal(result.ambushes.length, 1);
    assert.equal(battle.phase, survives ? "siege_transition" : "field");
    assert.equal(battle.status, survives ? "active" : "ended");
    assert.equal(mover.actionPoints, 0);
  }
});

test("a last-activation ambush remains interrupted even when next-day AP has already refreshed", () => {
  const { battle, mover } = prepareAmbush();
  battle.queue = [mover.id];
  const result = battle.moveStep(3, 3);
  assert.equal(result.interrupted, true);
  assert.equal(result.activationEnded, true);
  assert.equal(battle.day, 2);
  assert.equal(mover.actionPoints, mover.maxActionPoints);
  assert.equal(result.ambushes.length, 1);
});

test("field logs retain their original audience and hidden actions never become retroactively visible", () => {
  const battle = makeBattle();
  const enemy = battle.livingUnits("enemy")[0];
  terrain(battle, enemy.position, "forest");
  activate(battle, enemy);
  assert.equal(battle.ambush().ok, true);
  assert.equal(battle.getVisibleLog("ally").some((entry) => entry.message.includes(enemy.name)), false);
  assert.equal(battle.getVisibleLog("enemy").some((entry) => entry.message.includes(enemy.name)), true);
  const player = battle.livingUnits("ally")[0];
  player.position = { x: 7, y: 2 };
  assert.equal(battle.isUnitVisibleTo(enemy, "ally"), true);
  assert.equal(battle.getVisibleLog("ally").some((entry) => entry.message.includes(enemy.name)), false);
  const rationLogs = battle.getVisibleLog("ally").filter((entry) => /军粮消耗/.test(entry.message));
  assert.equal(rationLogs.length, 1);
  assert.deepEqual(rationLogs[0].audience, ["ally"]);
  assert.equal(battle.getVisibleLog("ally").some((entry) => /守方消耗/.test(entry.message)), false);
});

test("defending AI does not pursue an unseen enemy and may wait in a prepared woodland ambush", () => {
  const battle = makeBattle();
  const enemy = battle.livingUnits("enemy")[0];
  activate(battle, enemy);
  const position = { ...enemy.position };
  assert.equal(battle.runEnemyTurn().action, "wait");
  assert.deepEqual(enemy.position, position);
  terrain(battle, enemy.position, "forest");
  activate(battle, enemy);
  assert.equal(battle.runEnemyTurn().action, "ambush");
  assert.equal(enemy.ambushing, true);
  assert.deepEqual(enemy.position, position);
});

test("attacking AI can use allied scouts to see an armed ambush and choose cautious movement", () => {
  const battle = makeBattle({ playerSide: "enemy", divisions: [
    { officerId: "guan-yu", troops: 5000 }, { officerId: "zhang-fei", troops: 2000 }
  ] });
  const invader = battle.livingUnits("ally")[0];
  const scout = battle.livingUnits("ally")[1];
  const ambusher = battle.livingUnits("enemy")[0];
  invader.position = { x: 0, y: 3 };
  scout.position = { x: 3, y: 2 };
  ambusher.position = { x: 4, y: 3 };
  ambusher.ambushing = true;
  terrain(battle, ambusher.position, "forest");
  activate(battle, invader);
  assert.equal(battle.isUnitVisibleTo(ambusher, "ally"), true);
  const result = battle.runEnemyTurn();
  assert.equal(result.action, "move");
  assert.equal(result.cautious, true);
  assert.equal(result.cost, 3);
});

test("a routed ambush formation cannot transfer its old trap to a replacement reserve line", () => {
  const { battle, mover, defenders } = prepareAmbush();
  battle.automaticDefenderReinforcements = true;
  mover.position = { x: 3, y: 3 };
  const defender = defenders[0];
  defender.troops = 1;
  assert.equal(battle.attack(defender.id).ok, true);
  assert.equal(battle.status, "active");
  assert.equal(defender.troops, 3000);
  assert.equal(defender.ambushing, false);
  assert.equal(battle.terrainAt(defender.position.x, defender.position.y), "plain");
});

test("losing sight of a moving enemy reports no destination terrain, AP, or subsequent hidden movement", () => {
  const battle = makeBattle();
  const observer = battle.livingUnits("ally")[0];
  const enemy = battle.livingUnits("enemy")[0];
  observer.position = { x: 2, y: 3 };
  enemy.position = { x: 4, y: 3 };
  terrain(battle, { x: 5, y: 3 }, "forest");
  terrain(battle, { x: 6, y: 3 }, "forest");
  activate(battle, enemy);
  assert.equal(battle.isUnitVisibleTo(enemy, "ally"), true);
  assert.equal(battle.moveStep(5, 3).ok, true);
  assert.equal(battle.isUnitVisibleTo(enemy, "ally"), false);
  const visibleAfterLoss = battle.getVisibleLog("ally");
  const enemyMessages = visibleAfterLoss.filter((entry) => entry.message.includes(enemy.name));
  assert.equal(enemyMessages.length, 1);
  assert.match(enemyMessages[0].message, /离开我军视野/);
  assert.doesNotMatch(enemyMessages[0].message, /树林|进入|行动力|5,3/);
  assert.equal(battle.getVisibleLog("enemy").some((entry) => entry.message.includes(`${enemy.name}进入树林`)), true);
  assert.equal(battle.moveStep(6, 3).ok, true);
  assert.equal(battle.isUnitVisibleTo(enemy, "ally"), false);
  assert.deepEqual(battle.getVisibleLog("ally"), visibleAfterLoss);
});
