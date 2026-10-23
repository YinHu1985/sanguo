import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BattleEngine } from "../src/js/game/battle.js";
import { evaluateSiegeDay } from "../src/js/game/siege.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));

function equalBattle({ training = 50, level = 3, mode = "field", random = 0.5 } = {}) {
  return new BattleEngine({
    sourceCity: { id: "a", name: "甲城", factionId: "a", officerIds: ["a"], troops: 10000, training, morale: 80 },
    targetCity: { id: "d", name: "乙城", factionId: "d", officerIds: ["d"], troops: 10000, training, morale: 80,
      food: 100000, gold: 1000, defense: 50, wallLevel: level },
    officers: ["a", "d"].map((id) => ({ id, name: id, factionId: id, status: "active", rank: "君主",
      war: 50, leadership: 50, intelligence: 50, politics: 50, charm: 50 })),
    divisions: [{ officerIds: ["a"], troops: 10000, composition: { infantry: 10000 } }],
    defenderDivisions: [{ officerIds: ["d"], troops: 10000, composition: { infantry: 10000 } }],
    map: { width: 9, height: 7, terrain: Array(63).fill("plain"), stronghold: { x: 8, y: 3 },
      attackerStarts: [{ x: 3, y: 3 }], defenderStarts: [{ x: 4, y: 3 }] },
    rules, supplies: { food: 100000, gold: 1000 }, rng: () => random, mode
  });
}

test("ordinary infantry all-AP active offense is 9–11%, and a complete mutual day costs both armies 18–22%", () => {
  for (const training of [50, 80]) {
    const battle = equalBattle({ training });
    battle.queue = ["ally-a", "enemy-d"];
    let activeLoss = 0;
    let counters = 0;
    let attacks = 0;
    while (battle.day === 1) {
      const unit = battle.activeUnit;
      const target = battle.getUnit(unit.side === "ally" ? "enemy-d" : "ally-a");
      if (unit.actionPoints >= battle.actionCost("attack", unit)) {
        const before = unit.troops;
        const result = battle.attack(target.id);
        assert.equal(result.ok, true);
        if (unit.side === "ally") activeLoss += result.damage;
        if (unit.troops < before) counters += 1;
        attacks += 1;
      } else assert.equal(battle.wait().ok, true);
    }
    assert.equal(counters, attacks, "every surviving adjacent ordinary formation counterattacks");
    assert.ok(activeLoss >= 900 && activeLoss <= 1100, `training ${training}: active damage ${activeLoss}`);
    for (const unit of battle.units) {
      const total = 10000 - unit.troops;
      assert.ok(total >= 1800 && total <= 2200, `training ${training}, ${unit.side}: daily loss ${total}`);
    }
  }
});

test("a morale-driven AP threshold change cannot increase the remaining activation's damage budget", () => {
  const battle = equalBattle({ training: 80 });
  const attacker = battle.getUnit("ally-a");
  const defender = battle.getUnit("enemy-d");
  attacker.morale = 42;
  battle.refreshCombatStats(attacker);
  attacker.actionPoints = attacker.maxActionPoints;
  attacker.activationActionPoints = attacker.maxActionPoints;
  battle.queue = [attacker.id, defender.id];
  const initialBudget = attacker.activationActionPoints;
  const first = battle.attack(defender.id);
  assert.equal(first.ok, true);
  assert.equal(attacker.morale, 39);
  assert.ok(attacker.maxActionPoints < initialBudget);
  assert.equal(attacker.activationActionPoints, initialBudget);
  const second = battle.attack(defender.id);
  assert.equal(second.ok, true);
  assert.ok(second.damage < first.damage, "morale and casualties reduce the next hit instead of halving its budget divisor");
});

test("equal ordinary armies can break each wall level at defense 50 within thirty days against passive rotation", () => {
  const days = [];
  for (const level of [1, 2, 3]) {
    const battle = equalBattle({ mode: "siege", level });
    battle.chooseTransition("open");
    while (battle.status === "active") {
      assert.equal(battle.siegeOrder("ally", "ram").ok, true);
      assert.equal(battle.siegeOrder("enemy", "rotate").ok, true);
    }
    assert.equal(battle.winner, "ally");
    assert.equal(battle.outcomeType, "siege");
    assert.equal(battle.siege.hp, 0);
    assert.ok(battle.day <= 30);
    assert.deepEqual(battle.siege.breachedMilestones, ["barbican", "outer", "inner"]);
    assert.ok(battle.units.every((unit) => unit.troops > 0), "the objective is breached before either army is wiped out");
    days.push(battle.day);
  }
  assert.ok(days[0] < days[1] && days[1] < days[2], `higher walls take longer: ${days.join(", ")}`);
});

test("siege commands retain distinct casualty, progress, repair and intelligence-risk tradeoffs", () => {
  const army = { troops: 10000, war: 50, intelligence: 50, leadership: 50, training: 50, morale: 80 };
  const evaluate = (attackOrder, defenseOrder, roll = 0.5, cityDefense = 50) => evaluateSiegeDay({
    attacker: army, defender: army, attackOrder, defenseOrder, cityDefense, wallLevel: 3
  }, rules, () => roll);
  const ram = evaluate("ram", "rotate");
  const assault = evaluate("assault", "rotate");
  const repair = evaluate("ram", "repair");
  const tunnelGood = evaluate("tunnel", "rotate", 0);
  const tunnelBad = evaluate("tunnel", "rotate", 0.99);
  const sortieGood = evaluate("ram", "sortie", 0);
  const sortieBad = evaluate("ram", "sortie", 0.99);
  assert.ok(assault.progress > ram.progress);
  assert.ok(assault.attackerLoss > ram.attackerLoss);
  assert.ok(repair.wallRepair > 0 && repair.repair > 0);
  assert.ok(repair.defenderLoss > ram.defenderLoss);
  assert.ok(tunnelGood.progress > tunnelBad.progress);
  assert.ok(tunnelGood.attackerLoss < tunnelBad.attackerLoss);
  assert.ok(sortieGood.attackerLoss > sortieBad.attackerLoss);
  assert.ok(sortieGood.defenderLoss < sortieBad.defenderLoss);
  assert.ok(evaluate("ram", "rotate", 0.5, 90).progress < ram.progress);
});

test("ordinary ram and assault make sustained visible progress against the real AI's repair-and-rotate defense", () => {
  const results = {};
  for (const command of ["ram", "assault"]) {
    const battle = equalBattle({ mode: "siege" });
    battle.chooseTransition("open");
    while (battle.status === "active") {
      battle.siegeOrder("ally", command);
      assert.equal(battle.runAISiegeDecision("enemy").ok, true);
      if (battle.day === 2) assert.ok(battle.siege.hp < battle.siege.maxHp, "the first day visibly reduces the wall HP");
    }
    assert.equal(battle.winner, "ally");
    assert.equal(battle.outcomeType, "siege");
    assert.ok(battle.siege.history.some((entry) => entry.defenseOrder === "repair"));
    assert.ok(battle.siege.history.some((entry) => entry.defenseOrder === "rotate"));
    results[command] = { day: battle.day, attackerLoss: 10000 - battle.getUnit("ally-a").troops };
  }
  assert.ok(results.assault.day < results.ram.day);
  // Assault has the larger daily casualty risk, not necessarily a larger final
  // campaign toll: a much earlier victory also avoids many days of losses.
  assert.ok(results.ram.attackerLoss > 0 && results.assault.attackerLoss > 0);
});
