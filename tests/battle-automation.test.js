import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { battleControlLabel, needsAutomaticBattleAction, runAutomaticBattleStep } from "../src/js/ui/battle-automation.js";
import { BattleEngine } from "../src/js/game/battle.js";
import { fieldTilesMarkup } from "../src/js/ui/field-view.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
function actualBattle(playerSide) {
  const officers = ["caster", "ambush-one", "ambush-two", "victim", "guard"].map((id, i) => ({ id, name: id,
    factionId: i < 3 ? "a" : "b", status: "active", rank: "大将", leadership: 80, intelligence: 80, war: 80 }));
  const city = (id, ids) => ({ id, name: id, factionId: id, officerIds: ids, troops: ids.length * 5000,
    training: 80, morale: 80, food: 100000, gold: 1000 });
  const form = (id) => ({ officerIds: [id], troops: 5000, composition: { infantry: 5000 } });
  return new BattleEngine({ sourceCity: city("a", officers.slice(0, 3).map(o => o.id)), targetCity: city("b", ["victim", "guard"]),
    officers, divisions: officers.slice(0, 3).map(o => form(o.id)), defenderDivisions: [form("victim"), form("guard")], rules,
    map: { width: 13, height: 9, terrain: Array(117).fill("plain"), stronghold: { x: 12, y: 4 },
      attackerStarts: [{ x: 0, y: 4 }, { x: 1, y: 4 }, { x: 2, y: 3 }], defenderStarts: [{ x: 3, y: 4 }, { x: 12, y: 8 }] },
    supplies: { food: 100000, gold: 1000 }, playerSide, rng: () => 0 });
}

function fixture(playerSide, activeSide, forced = false) {
  const calls = [];
  return { calls, status: "active", phase: "field", playerSide, aiSide: playerSide === "ally" ? "enemy" : "ally",
    activeUnit: { side: activeSide }, hasForcedAction: () => forced,
    runForcedTurn: () => { calls.push("forced"); return { ok: true, step: { x: 1, y: 1 }, forced: true }; },
    runEnemyTurn: () => { calls.push("ai"); return { ok: true, action: "wait" }; },
    runAISiegeDecision: () => { calls.push("siege"); return { ok: true }; }
  };
}

for (const playerSide of ["ally", "enemy"]) {
  for (const controlledSide of ["ally", "enemy"]) {
    test(`automatic controller dispatches exactly one forced step: player=${playerSide}, victim=${controlledSide}`, () => {
      const battle = fixture(playerSide, controlledSide, true);
      assert.equal(needsAutomaticBattleAction(battle), true);
      assert.equal(runAutomaticBattleStep(battle).forced, true);
      assert.deepEqual(battle.calls, ["forced"]);
    });
  }
  test(`normal player decisions are not automated: player=${playerSide}`, () => {
    const battle = fixture(playerSide, playerSide);
    assert.equal(needsAutomaticBattleAction(battle), false);
    assert.equal(runAutomaticBattleStep(battle).ok, false);
    assert.deepEqual(battle.calls, []);
    battle.activeUnit.side = battle.aiSide;
    assert.equal(runAutomaticBattleStep(battle).ok, true);
    assert.deepEqual(battle.calls, ["ai"]);
  });
}

test("the automatic controller stops for ended battles and preserves siege decision ownership", () => {
  const battle = fixture("enemy", "enemy", true);
  battle.status = "ended";
  assert.equal(needsAutomaticBattleAction(battle), false);
  battle.status = "active"; battle.phase = "siege";
  battle.pendingDecision = { side: "enemy" };
  assert.equal(needsAutomaticBattleAction(battle), false);
  battle.pendingDecision.side = "ally";
  assert.equal(runAutomaticBattleStep(battle).ok, true);
  assert.deepEqual(battle.calls, ["siege"]);
  battle.pendingDecision = null; battle.siege = { orders: { enemy: "rotate" } };
  assert.equal(needsAutomaticBattleAction(battle), true);
  battle.siege.orders.ally = "ram";
  assert.equal(needsAutomaticBattleAction(battle), false);
});

test("control labels distinguish pending and active pursuit and prioritize doubt", () => {
  assert.equal(battleControlLabel(null), "");
  assert.match(battleControlLabel({ provocation: { active: false } }), /下次强制追击/);
  assert.match(battleControlLabel({ provocation: { active: true } }), /强制行动中/);
  assert.match(battleControlLabel({ doubt: {}, provocation: {} }), /跳过下次行动/);
});

test("application pumps both sides' controlled activations with per-step animation and ambush replay", async () => {
  const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  const pump = app.slice(app.indexOf("async function processEnemyTurns()"), app.indexOf("function delay("));
  assert.match(pump, /while \(needsAutomaticBattleAction\(battle\)\)/);
  assert.match(pump, /runAutomaticBattleStep\(battle\)/);
  assert.match(pump, /await animateAmbushes\(result\)/);
  assert.match(pump, /await delay\(result\.step/);
  assert.doesNotMatch(pump, /activeUnit\?\.side !== battle\.aiSide/);
  assert.match(app, /battle\.doubt\(unit\.id\)/);
  assert.match(app, /battle\.provoke\(unit\.id\)/);
  assert.doesNotMatch(app, /plannedCommandDialog|劝降及战略计略尚未开放/);
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  for (const mode of ["doubt", "provoke"]) assert.ok(html.includes(`data-mode="${mode}"`));
});

for (const playerSide of ["ally", "enemy"]) {
  test(`real automatic pursuit triggers two ambushes then removes forced control: player=${playerSide}`, () => {
    const battle = actualBattle(playerSide);
    const [caster, first, second] = battle.livingUnits("ally"), victim = battle.livingUnits("enemy")[0];
    victim.provocation = { sourceId: caster.id, lastKnownPosition: { ...caster.position }, active: false };
    for (const unit of [first, second]) {
      unit.ambushing = true;
      battle.map.terrain[unit.position.y * battle.map.width + unit.position.x] = "forest";
    }
    battle.queue = [victim.id, caster.id, first.id, second.id, battle.livingUnits("enemy")[1].id];
    assert.equal(needsAutomaticBattleAction(battle), true);
    const result = runAutomaticBattleStep(battle);
    assert.equal(result.step, true);
    assert.equal(result.interrupted, true);
    assert.equal(result.ambushes.length, 2);
    assert.equal(result.activationEnded, true);
    assert.equal(victim.provocation, null);
    assert.equal(victim.actionPoints, 0);
    assert.equal(battle.activeUnit.id, caster.id);
    assert.equal(battle.hasForcedAction(), false);
    if (playerSide === "ally") assert.equal(needsAutomaticBattleAction(battle), false);
  });
}

test("battle status markup never exposes a controlled unit outside shared vision", () => {
  const battle = actualBattle("ally"), target = battle.livingUnits("enemy")[0];
  target.position = { x: 12, y: 0 };
  target.doubt = { sourceId: "ally-caster" };
  const hidden = fieldTilesMarkup(battle);
  assert.ok(!hidden.includes("疑兵 · 跳过下次行动"));
  assert.ok(!hidden.includes(`data-unit-id="${target.id}"`));
  target.position = { x: 0, y: 3 };
  const visible = fieldTilesMarkup(battle);
  assert.ok(visible.includes("疑兵 · 跳过下次行动"));
  assert.ok(visible.includes(`data-unit-id="${target.id}"`));
});
