import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { aggregateAbilities } from "../src/js/game/army.js";
import { evaluateSiegeDay } from "../src/js/game/siege.js";
import { dailyFoodCost } from "../src/js/game/economy.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = { width: 7, height: 5, terrain: Array(35).fill("plain"), stronghold: { x: 6, y: 2 },
  attackerStarts: [{ x: 0, y: 1 }, { x: 0, y: 3 }], defenderStarts: [{ x: 6, y: 1 }, { x: 6, y: 3 }] };
const officer = (id, factionId, stats = {}) => ({ id, name: id, factionId, status: "active", rank: "君主",
  war: 70, intelligence: 70, leadership: 70, politics: 70, charm: 70, ...stats });

function createBattle(options = {}) {
  const officers = [officer("a", "attack", { war: 99, intelligence: 20 }), officer("b", "attack", { intelligence: 98, leadership: 90 }),
    officer("c", "defend", { intelligence: 99 }), officer("d", "defend", { intelligence: 20 })];
  return new BattleEngine({
    sourceCity: { id: "origin", name: "出发城", factionId: "attack", officerIds: ["a", "b"], troops: 10000, training: 80, morale: 80 },
    targetCity: { id: "target", name: "目标城", factionId: "defend", officerIds: ["c", "d"], troops: 8000,
      training: 80, morale: 80, food: 100000, gold: 2000, wallLevel: 2, defense: 100 },
    divisions: [{ officerIds: ["a", "b"], troops: 5000, unitType: "infantry" }],
    defenderDivisions: [{ officerIds: ["c"], troops: 2500, unitType: "infantry" },
      { officerIds: ["d"], troops: 2500, unitType: "infantry" }],
    officers, rules, map, supplies: { food: 100000, gold: 2000 }, rng: () => 1, canDefenderRetreat: true,
    ...options
  });
}

function activate(battle, unit) {
  battle.queue = [unit.id, ...battle.queue.filter((id) => id !== unit.id)];
}

test("capturing the sole field stronghold carries time and stores forward instead of resetting the siege", () => {
  const battle = createBattle();
  while (battle.day < 4) battle.wait();
  const stores = structuredClone(battle.supplies);
  const troops = battle.livingUnits().reduce((total, unit) => total + unit.troops, battle.defenderReserveTroops);
  const attacker = battle.livingUnits("ally")[0];
  attacker.position = { x: 5, y: 2 };
  // The phase-transition test uses an unguarded entrance; crossing a defended
  // control zone is covered separately and must not be bypassed here.
  battle.livingUnits("enemy").forEach((unit, index) => { unit.position = { x: 0, y: index * 4 }; });
  activate(battle, attacker);
  assert.equal(battle.moveStep(6, 2).phaseChanged, true);
  assert.equal(battle.phase, "siege_transition");
  assert.equal(battle.pendingDecision.kind, "external");
  assert.equal(battle.day, 4);
  assert.deepEqual(battle.supplies, stores);
  assert.equal(battle.livingUnits().reduce((total, unit) => total + unit.troops, battle.defenderReserveTroops), troops);
  assert.equal(battle.chooseTransition("return").ok, true);
  assert.equal(battle.pendingDecision.kind, "response");
  assert.equal(battle.chooseTransition("deceive").ok, true, "deterministic failed deception must still advance the decision");
  assert.equal(battle.chooseTransition("open").ok, true);
  assert.equal(battle.phase, "siege");
  assert.equal(battle.day, 4);
  assert.deepEqual(battle.supplies, stores);
});

test("returning field defenders leave the map and cannot be attacked or burned through the wall", () => {
  const battle = createBattle();
  const defender = battle.livingUnits("enemy")[0];
  const attacker = battle.livingUnits("ally")[0];
  defender.position = { x: 2, y: 2 };
  attacker.position = { x: 1, y: 2 };
  activate(battle, defender);
  const before = { troops: defender.troops, morale: defender.morale };
  assert.equal(battle.retreatToCity().ok, true);
  assert.deepEqual({ troops: defender.troops, morale: defender.morale }, before);
  assert.equal(battle.unitAt(2, 2), undefined);
  activate(battle, attacker);
  assert.equal(battle.attackTargets().includes(defender), false);
  assert.equal(battle.fireTargets().includes(defender), false);
  assert.equal(battle.attack(defender.id).ok, false);
  assert.equal(battle.fire(defender.id).ok, false);
  assert.equal(battle.getArmyStats("enemy").troops, 8000);
});

test("escaping outer soldiers neither take the in-city formations nor continue contributing abilities or eating city grain", () => {
  const battle = createBattle();
  const inside = battle.livingUnits("enemy")[1];
  activate(battle, inside);
  battle.retreatToCity();
  assert.equal(battle.getArmyStats("enemy").intelligence, 99);
  battle.enterSiege();
  assert.equal(battle.chooseTransition("retreat").ok, true);
  assert.equal(battle.escapedDefenderUnits.length, 1);
  assert.deepEqual(battle.escapedDefenderUnits[0].officerIds, ["c"]);
  assert.equal(battle.getArmyStats("enemy").troops, 5500);
  assert.equal(battle.getArmyStats("enemy").intelligence, 20);
  assert.equal(battle.defenderReserveTroops, 3000);
  assert.equal(battle.dailyFoodNeed("enemy"), dailyFoodCost(5500, rules));
  assert.equal(battle.livingUnits("enemy")[0].id, inside.id);
});

test("a defender without another own city cannot escape the field or abandon an open siege", () => {
  const battle = createBattle({ canDefenderRetreat: false });
  battle.enterSiege();
  assert.equal(battle.pendingDecision.options.includes("retreat"), false);
  const before = battle.getArmyStats("enemy").troops;
  assert.equal(battle.chooseTransition("retreat").ok, false);
  battle.chooseTransition("return");
  battle.chooseTransition("deceive");
  battle.chooseTransition("open");
  assert.equal(battle.retreatArmy("enemy").ok, false);
  assert.equal(battle.getArmyStats("enemy").troops, before);
  assert.equal(battle.escapedDefenderUnits.length, 0);
});

test("field and siege together allow exactly thirty funded days, with no extra ration at transition or day thirty-one", () => {
  const stableRules = structuredClone(rules);
  Object.assign(stableRules.battle.siege, { baseProgressPerThousand: 0, attackerLossRate: 0, defenderLossRate: 0 });
  const battle = createBattle({ rules: stableRules });
  while (battle.day < 10) battle.wait();
  battle.enterSiege();
  battle.chooseTransition("return");
  battle.chooseTransition("deceive");
  battle.chooseTransition("open");
  let siegeDays = 0;
  while (battle.status === "active") {
    assert.equal(battle.siegeOrder("ally", "ram").ok, true);
    assert.equal(battle.siegeOrder("enemy", "rotate").ok, true);
    siegeDays += 1;
    assert.ok(siegeDays <= 21);
  }
  assert.equal(siegeDays, 21);
  assert.equal(battle.day, 30);
  assert.equal(battle.winner, "enemy");
  assert.equal(battle.outcomeType, "time");
  assert.equal(battle.supplies.ally.food, 100000 - 30 * dailyFoodCost(5000, rules));
  assert.equal(battle.supplies.enemy.food, 100000 - 30 * dailyFoodCost(8000, rules));
  const stores = structuredClone(battle.supplies);
  assert.equal(battle.siegeOrder("ally", "ram").ok, false);
  assert.deepEqual(battle.supplies, stores);
});

test("siege army power caps both sides independently while reserve numbers still consume full grain", () => {
  const army = { troops: 1000000, leadership: 80, training: 80, morale: 80, intelligence: 80, war: 80 };
  for (const [level, cap] of [[1, 20000], [2, 35000], [3, 50000]]) {
    const oversized = evaluateSiegeDay({ attacker: army, defender: army, wallLevel: level, cityDefense: 80, attackOrder: "ram", defenseOrder: "rotate" }, rules);
    const limited = evaluateSiegeDay({ attacker: { ...army, troops: cap }, defender: { ...army, troops: cap },
      wallLevel: level, cityDefense: 80, attackOrder: "ram", defenseOrder: "rotate" }, rules);
    assert.equal(oversized.attackerEffective, cap);
    assert.equal(oversized.defenderEffective, cap);
    assert.equal(oversized.attackerLoss, limited.attackerLoss);
    assert.equal(oversized.defenderLoss, limited.defenderLoss);
    assert.equal(oversized.progress, limited.progress);
  }
  const battle = createBattle({ mode: "siege" });
  assert.equal(battle.dailyFoodNeed("enemy"), dailyFoodCost(8000, rules));
  assert.equal(battle.getArmyStats("enemy").troops, 8000);
});

test("five-dimensional group and army abilities use per-dimension maxima instead of sums or only the lead officer", () => {
  const abilities = aggregateAbilities([{ war: 90, intelligence: 20, leadership: 40, politics: 95, charm: 10 },
    { war: 30, intelligence: 99, leadership: 92, politics: 40, charm: 88 }]);
  assert.deepEqual(abilities, { war: 90, intelligence: 99, leadership: 92, politics: 95, charm: 88 });
  const battle = createBattle();
  const group = battle.livingUnits("ally")[0];
  assert.equal(group.troops, 5000);
  assert.equal(group.commandLimit, 12000);
  assert.equal(group.war, 99);
  assert.equal(group.intelligence, 98);
  assert.equal(group.leadership, 90);
  assert.equal(battle.getArmyStats("ally").intelligence, 98);
});
