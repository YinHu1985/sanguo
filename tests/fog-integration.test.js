import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { fieldTilesMarkup } from "../src/js/ui/field-view.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const officer = (id, name, factionId) => ({ id, name, factionId, rank: "君主", status: "active",
  war: 85, intelligence: 80, leadership: 90, politics: 70, charm: 70 });

function createBattle(options = {}) {
  const map = { width: 12, height: 7, terrain: Array(84).fill("plain"), stronghold: { x: 11, y: 3 },
    attackerStarts: [{ x: 0, y: 3 }], defenderStarts: [{ x: 9, y: 3 }, { x: 9, y: 5 }] };
  for (const [x, y] of [[2, 3], [3, 3], [9, 3], [9, 5]]) map.terrain[y * map.width + x] = "forest";
  return new BattleEngine({
    sourceCity: { id: "origin", name: "下邳", factionId: "shu", officerIds: ["guanyu"], troops: 5000, training: 80, morale: 80 },
    targetCity: { id: "target", name: "濮阳", factionId: "wei", officerIds: ["xiahou", "xuhuang"], troops: 3579,
      training: 70, morale: 70, food: 98765, gold: 4321, wallLevel: 2, defense: 100 },
    divisions: [{ officerIds: ["guanyu"], troops: 5000, unitType: "infantry" }],
    defenderDivisions: [{ officerIds: ["xiahou"], troops: 2468, unitType: "infantry" },
      { officerIds: ["xuhuang"], troops: 1111, unitType: "infantry" }],
    officers: [officer("guanyu", "关羽", "shu"), officer("xiahou", "夏侯惇", "wei"), officer("xuhuang", "徐晃", "wei")],
    rules, map, supplies: { food: 100000, gold: 2000 }, rng: () => 0, ...options
  });
}

function activate(battle, unit) {
  battle.queue = [unit.id, ...battle.queue.filter((id) => id !== unit.id)];
  unit.actionPoints = unit.maxActionPoints;
}

function putAt(battle, unit, x, y) {
  unit.position = { x, y };
  // Tests relocate formations outside normal movement; clear constructor sight
  // history so each fixture represents precisely the stated reconnaissance.
  battle.exploredTiles = { ally: new Set(), enemy: new Set() };
}

test("fog keeps all terrain public while omitting unseen unit names, identities and strengths from every DOM attribute", () => {
  const battle = createBattle();
  const attacker = battle.livingUnits("ally")[0];
  const hidden = battle.livingUnits("enemy")[0];
  const markup = fieldTilesMarkup(battle, { mode: "move", animatedUnitId: hidden.id });
  assert.ok(markup.includes(`data-unit-id="${attacker.id}"`));
  assert.ok(markup.includes("关羽"));
  assert.equal(markup.includes(hidden.id), false);
  assert.equal(markup.includes(hidden.name), false);
  assert.equal(markup.includes("2,468"), false);
  const hiddenTile = markup.match(/<button[^>]*data-x="9" data-y="3"[^>]*>/)?.[0];
  assert.ok(hiddenTile.includes("forest"));
  assert.ok(hiddenTile.includes(rules.terrain.forest.name));
  assert.ok(hiddenTile.includes("fog-unseen"));
  assert.ok(hiddenTile.includes("敌军动向不明"));
  assert.equal(hiddenTile.includes("unknown"), false);
  assert.equal(hiddenTile.includes("未侦察地区"), false);
  assert.equal(hiddenTile.includes("敌军控制区"), false);
  assert.equal(battle.visibleUnitAt(9, 3, "ally"), undefined);
});

test("adjacent concealed terrain reveals armed enemies without silently disarming them in the UI", () => {
  const battle = createBattle();
  const attacker = battle.livingUnits("ally")[0];
  const hidden = battle.livingUnits("enemy")[0];
  hidden.ambushing = true;
  putAt(battle, attacker, 8, 3);
  assert.equal(battle.isUnitVisibleTo(hidden, "ally"), true);
  const markup = fieldTilesMarkup(battle);
  assert.ok(markup.includes(`data-unit-id="${hidden.id}"`));
  assert.ok(markup.includes("夏侯惇"));
  assert.ok(markup.includes("2,468"));
  assert.ok(markup.includes("is-ambushing"));
  assert.equal(hidden.ambushing, true);
});

test("public terrain stays visible when explored sight moves away but enemy formations do not persist as live map intelligence", () => {
  const battle = createBattle();
  const attacker = battle.livingUnits("ally")[0];
  const enemy = battle.livingUnits("enemy")[0];
  putAt(battle, attacker, 8, 3);
  assert.equal(battle.getVisibility("ally").unitIds.has(enemy.id), true);
  attacker.position = { x: 0, y: 3 };
  const sight = battle.getVisibility("ally");
  assert.equal(sight.visible.has("9,3"), false);
  assert.equal(sight.explored.has("9,3"), true);
  const markup = fieldTilesMarkup(battle);
  const rememberedTile = markup.match(/<button[^>]*data-x="9" data-y="3"[^>]*>/)?.[0];
  assert.ok(rememberedTile.includes("forest"));
  assert.ok(rememberedTile.includes(rules.terrain.forest.name));
  assert.ok(rememberedTile.includes("fog-explored"));
  assert.equal(markup.includes(enemy.id), false);
  assert.equal(markup.includes(enemy.name), false);
});

test("hidden enemy occupancy and control zones cannot change planning results", () => {
  const hiddenNear = createBattle();
  const hiddenFar = createBattle();
  const nearAttacker = hiddenNear.livingUnits("ally")[0];
  const farAttacker = hiddenFar.livingUnits("ally")[0];
  putAt(hiddenNear, hiddenNear.livingUnits("enemy")[0], 2, 3);
  assert.equal(hiddenNear.visibleUnits("ally").some((unit) => unit.side === "enemy"), false);
  assert.equal(hiddenFar.visibleUnits("ally").some((unit) => unit.side === "enemy"), false);
  assert.deepEqual(hiddenNear.reachableTiles(nearAttacker), hiddenFar.reachableTiles(farAttacker));
  assert.deepEqual(hiddenNear.findPath({ x: 2, y: 3 }, nearAttacker), hiddenFar.findPath({ x: 2, y: 3 }, farAttacker));
  assert.ok(hiddenNear.findPath({ x: 2, y: 3 }, nearAttacker).length > 0, "concealed occupancy must not silently remove a destination");

  activate(hiddenNear, nearAttacker);
  assert.equal(hiddenNear.moveStep(1, 3).ok, true);
  assert.equal(hiddenNear.visibleUnits("ally").some((unit) => unit.side === "enemy"), true);
  const before = { ...nearAttacker.position };
  assert.equal(hiddenNear.moveStep(2, 3).ok, false, "actual stepping must revalidate newly discovered occupancy");
  assert.deepEqual(nearAttacker.position, before);
});

test("newly revealed control zones invalidate the next step of an already planned route", () => {
  const battle = createBattle();
  const attacker = battle.livingUnits("ally")[0];
  const enemy = battle.livingUnits("enemy")[0];
  putAt(battle, enemy, 2, 3);
  activate(battle, attacker);
  assert.ok(battle.findPath({ x: 2, y: 2 }, attacker).length > 0);
  assert.equal(battle.moveStep(1, 3).ok, true);
  assert.equal(battle.isInEnemyZoc(attacker.position, "ally"), true);
  assert.equal(battle.isInEnemyZoc({ x: 2, y: 2 }, "ally"), true);
  assert.equal(battle.moveStep(2, 2).ok, false);
  assert.deepEqual(attacker.position, { x: 1, y: 3 });
  assert.equal(battle.moveStep(0, 3).ok, true, "leaving the control zone remains legal");
});

test("AI orders do not follow enemies hidden in different unobserved locations", () => {
  const first = createBattle();
  const second = createBattle();
  const firstDefender = first.livingUnits("enemy")[0];
  const secondDefender = second.livingUnits("enemy")[0];
  // Open ground prevents the defender's independent "set an ambush" choice
  // from masking an accidental use of hidden targets in its pursuit logic.
  putAt(first, firstDefender, 9, 2);
  putAt(second, secondDefender, 9, 2);
  putAt(first, first.livingUnits("ally")[0], 0, 1);
  putAt(second, second.livingUnits("ally")[0], 0, 6);
  activate(first, firstDefender);
  activate(second, secondDefender);
  assert.equal(first.visibleUnits("enemy").some((unit) => unit.side === "ally"), false);
  assert.equal(second.visibleUnits("enemy").some((unit) => unit.side === "ally"), false);
  const actionA = first.runEnemyTurn();
  const actionB = second.runEnemyTurn();
  assert.equal(actionA.ok, true);
  assert.equal(actionB.ok, true);
  assert.equal(actionA.action, "move", "defenders may advance on the public attacker camp without knowing enemy positions");
  assert.equal(actionB.action, "move");
  assert.equal(actionA.targetId, undefined);
  assert.equal(actionB.targetId, undefined);
  assert.deepEqual(firstDefender.position, secondDefender.position);
  assert.deepEqual(actionA.step, actionB.step, "hidden enemy positions must not influence the chosen step");
});

test("concealed orders and opposing daily consumption stay out of player logs, even after later discovery", () => {
  const battle = createBattle();
  const attacker = battle.livingUnits("ally")[0];
  const enemy = battle.livingUnits("enemy")[0];
  activate(battle, enemy);
  assert.equal(battle.ambush().ok, true);
  const visibleBefore = battle.getVisibleLog("ally").map((entry) => entry.message).join("\n");
  assert.equal(visibleBefore.includes(enemy.name), false);
  assert.equal(visibleBefore.includes("守方消耗"), false);
  assert.equal(battle.getVisibleLog("ally").filter((entry) => entry.message.includes("今日我军军粮消耗")).length, 1);
  putAt(battle, attacker, 8, 3);
  assert.equal(battle.isUnitVisibleTo(enemy, "ally"), true);
  const visibleAfter = battle.getVisibleLog("ally").map((entry) => entry.message).join("\n");
  assert.equal(visibleAfter.includes(enemy.name), false, "learning a current location cannot reveal earlier concealed orders");
  assert.ok(battle.getVisibleLog("enemy").some((entry) => entry.message.includes(enemy.name)));
});

test("cautious movement reveals nearby ambushers but neither triggers nor disarms their reaction", () => {
  const battle = createBattle();
  const attacker = battle.livingUnits("ally")[0];
  const enemy = battle.livingUnits("enemy")[0];
  putAt(battle, enemy, 2, 3);
  activate(battle, enemy);
  assert.equal(battle.ambush().ok, true);
  activate(battle, attacker);
  const troops = attacker.troops;
  const result = battle.moveStep(1, 3, { cautious: true });
  assert.equal(result.ok, true);
  assert.equal(result.cost, 3);
  assert.equal(result.ambushes?.length ?? 0, 0);
  assert.equal(attacker.troops, troops);
  assert.equal(enemy.ambushing, true);
  assert.equal(battle.isUnitVisibleTo(enemy, "ally"), true);
});

test("ambush terminates the final activation and automatic route even when a fresh day restores the same mover's AP", () => {
  const battle = createBattle();
  const attacker = battle.livingUnits("ally")[0];
  const enemy = battle.livingUnits("enemy")[0];
  putAt(battle, enemy, 2, 3);
  activate(battle, enemy);
  assert.equal(battle.ambush().ok, true);
  battle.queue = [attacker.id];
  attacker.actionPoints = attacker.maxActionPoints;
  const originalDay = battle.day;
  const enemyTroops = enemy.troops;
  const result = battle.moveStep(1, 3);
  assert.equal(result.ok, true);
  assert.equal(result.interrupted, true);
  assert.equal(result.activationEnded, true);
  assert.equal(result.ambushes.length, 1);
  assert.equal(result.ambushes[0].actorId, enemy.id);
  assert.equal(result.ambushes[0].targetId, attacker.id);
  assert.equal(enemy.troops, enemyTroops, "ambush strikes do not provoke a counterattack");
  assert.equal(enemy.ambushing, false);
  assert.equal(battle.day, originalDay + 1);
  assert.equal(battle.activeUnit.id, attacker.id, "the restored activation deliberately uses the same ID");
  assert.equal(attacker.actionPoints, attacker.maxActionPoints);
  assert.deepEqual(attacker.position, { x: 1, y: 3 });
});

test("automatic movement UI stops on explicit interruption or a day rollover, not only a changed active unit ID", async () => {
  const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  const moveLoop = app.slice(app.indexOf("async function animateMoveTo("), app.indexOf("async function animateAmbushes("));
  assert.match(moveLoop, /finalResult\.interrupted/);
  assert.match(moveLoop, /battle\.day\s*!==\s*startingDay/);
  assert.match(moveLoop, /await animateAmbushes\(finalResult\)/);
  assert.match(moveLoop, /moveStep\(step\.x, step\.y, movementOptions\)/);
});

test("changing battle phases never renders the raw audience-restricted field log", async () => {
  const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  assert.equal(/battle\.log\.map\(/.test(app), false, "siege may reveal current armies, not previously hidden field orders");
  const battle = createBattle();
  const enemy = battle.livingUnits("enemy")[0];
  activate(battle, enemy);
  battle.ambush();
  battle.enterSiege();
  assert.equal(battle.getVisibleLog("ally").some((entry) => entry.message.includes(enemy.name)), false);
  assert.ok(battle.getVisibleLog("enemy").some((entry) => entry.message.includes(enemy.name)));
});
