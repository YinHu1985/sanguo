import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState, migrateState } from "../src/js/game/state.js";
import { advanceMonth } from "../src/js/game/rules.js";
import { resumeTurnResolution } from "../src/js/game/turn-flow.js";
import { createInvasionBattle, settleDefensiveBattle } from "../src/js/game/invasion-battle.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const map = JSON.parse(await readFile(new URL("../src/data/battle-map.json", import.meta.url), "utf8"));
const city = (state, id) => state.cities.find((entry) => entry.id === id);

function addInvasion(state, { sourceId = "puyang", targetId = "xiaopei", officerId = "xiahou-dun" } = {}) {
  const source = city(state, sourceId);
  const target = city(state, targetId);
  const beforeDeparture = structuredClone(source);
  const invasion = {
    id: `test-invasion-${sourceId}-${targetId}`, sourceId, targetId,
    attackerFactionId: source.factionId, defenderFactionId: target.factionId,
    officerIds: [officerId], divisions: [{ officerId, troops: 3000, unitType: "infantry" }],
    troops: 3000, training: source.training, morale: source.morale,
    supplies: { food: 360, gold: 100 }, year: state.year, month: state.month,
    resolved: false, resolutionMode: "manual"
  };
  // Mirror prepareInvasion's reservation; opening a battle must not debit it again.
  source.troops -= invasion.troops;
  source.food -= invasion.supplies.food;
  source.gold -= invasion.supplies.gold + rules.actions.march;
  state.officers.find((officer) => officer.id === officerId).acted = true;
  state.pendingInvasions.push(invasion);
  return { invasionId: invasion.id, beforeDeparture, targetBeforeBattle: structuredClone(target) };
}

function fixture() {
  const state = createInitialState(scenario, rules);
  state.cities.forEach((entry) => { entry.governorId = null; });
  advanceMonth(state, rules);
  state.lastWorldTurnMonth = state.year * 12 + state.month;
  state.turnResolution = { stage: "invasions", targetTurn: state.elapsedMonths };
  return { state, ...addInvasion(state) };
}

function openBattle(state, invasionId) {
  const created = createInvasionBattle(state, invasionId, rules, map);
  assert.equal(created.ok, true, created.message);
  assert.equal(created.battle.playerSide, "enemy");
  return created.battle;
}

function defendUntilTimeout(state, battle) {
  while (battle.status === "active") battle.wait();
  assert.equal(battle.day, 30);
  assert.equal(battle.winner, "enemy");
  const result = settleDefensiveBattle(state, battle, battle.winner);
  assert.equal(result.ok, true, result.message);
  return result;
}

test("month opening waits for manual defense and concurrent resumes share one battle", async () => {
  const { state, invasionId, beforeDeparture, targetBeforeBattle } = fixture();
  const beforeCities = structuredClone(state.cities);
  let finishBattle;
  const battleGate = new Promise((resolve) => { finishBattle = resolve; });
  let startedBattle;
  const started = new Promise((resolve) => { startedBattle = resolve; });
  let invasionCalls = 0;
  let openingCalls = 0;
  let activeBattle;
  const stages = [];
  const callbacks = {
    save: () => { stages.push(state.turnResolution?.stage ?? null); },
    onInvasions: async () => {
      invasionCalls += 1;
      activeBattle = openBattle(state, invasionId);
      startedBattle();
      await battleGate;
      defendUntilTimeout(state, activeBattle);
    },
    onOpening: () => {
      openingCalls += 1;
      assert.equal(state.pendingInvasions.length, 0);
      assert.equal(state.turnResolution.stage, "opening");
    }
  };
  const first = resumeTurnResolution(state, rules, callbacks);
  await started;
  const second = resumeTurnResolution(state, rules, callbacks);
  assert.equal(invasionCalls, 1);
  assert.equal(openingCalls, 0);
  assert.equal(state.turnResolution.stage, "invasions");
  assert.equal(state.month, 2);
  assert.equal(state.elapsedMonths, 1);
  assert.deepEqual(state.cities, beforeCities, "live battle owns its supplies until settlement");
  finishBattle();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.completed));
  assert.equal(invasionCalls, 1);
  assert.equal(openingCalls, 1);
  assert.equal(state.month, 2);
  assert.equal(state.elapsedMonths, 1);
  assert.equal(state.turnResolution, null);
  assert.deepEqual(stages, ["invasions", "opening", null]);
  assert.equal(city(state, "puyang").troops, beforeDeparture.troops);
  assert.equal(city(state, "puyang").food, beforeDeparture.food - 360);
  assert.equal(city(state, "puyang").gold, beforeDeparture.gold - rules.actions.march);
  assert.equal(city(state, "xiaopei").food, targetBeforeBattle.food - activeBattle.dailyFoodNeed("enemy") * 30);
});

test("unresolved manual defense survives reload without charging departure or first-day supplies twice", async () => {
  const prepared = fixture();
  let state = prepared.state;
  const reservedCities = structuredClone(state.cities);
  const reservation = structuredClone(state.pendingInvasions[0]);
  let firstBattle;
  const waiting = await resumeTurnResolution(state, rules, {
    onInvasions: () => { firstBattle = openBattle(state, prepared.invasionId); }
  });
  assert.equal(waiting.waiting, "invasions");
  firstBattle.wait();
  assert.deepEqual(state.cities, reservedCities);
  assert.deepEqual(state.pendingInvasions[0], reservation);

  state = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  assert.equal(state.pendingInvasions[0].resolutionMode, "manual");
  let restoredBattle;
  let openings = 0;
  const result = await resumeTurnResolution(state, rules, {
    onInvasions: () => {
      restoredBattle = openBattle(state, prepared.invasionId);
      assert.equal(restoredBattle.day, 1);
      assert.equal(restoredBattle.supplies.ally.food, 348);
      assert.equal(state.pendingInvasions[0].supplies.food, 360);
      assert.equal(city(state, "puyang").food, city({ cities: reservedCities }, "puyang").food);
      defendUntilTimeout(state, restoredBattle);
    },
    onOpening: () => { openings += 1; }
  });
  assert.equal(result.completed, true);
  assert.equal(openings, 1);
  assert.equal(state.elapsedMonths, 1);
  assert.equal(state.month, 2);
  assert.equal(city(state, "puyang").food, prepared.beforeDeparture.food - 360);
  assert.equal(city(state, "puyang").gold, prepared.beforeDeparture.gold - rules.actions.march);
  assert.equal(city(state, "puyang").troops, prepared.beforeDeparture.troops);
  const after = structuredClone(state);
  assert.equal(settleDefensiveBattle(state, restoredBattle, "enemy").ok, false);
  assert.equal(createInvasionBattle(state, prepared.invasionId, rules, map).ok, false);
  assert.equal((await resumeTurnResolution(state, rules)).idle, true);
  assert.deepEqual(state, after);
});

test("reload after defense settlement resumes only the opening report without replaying combat or economy", async () => {
  let { state, invasionId } = fixture();
  const result = await resumeTurnResolution(state, rules, {
    onInvasions: () => { defendUntilTimeout(state, openBattle(state, invasionId)); }
  });
  assert.equal(result.waiting, "opening");
  assert.equal(state.turnResolution.stage, "opening");
  assert.equal(state.pendingInvasions.length, 0);
  state = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  const settledCities = structuredClone(state.cities);
  const settledEvents = structuredClone(state.eventLog);
  let openings = 0;
  const resumed = await resumeTurnResolution(state, rules, {
    onInvasions: () => { assert.fail("settled invasion must not reopen"); },
    onOpening: () => { openings += 1; }
  });
  assert.equal(resumed.completed, true);
  assert.equal(openings, 1);
  assert.equal(state.elapsedMonths, 1);
  assert.equal(state.month, 2);
  assert.deepEqual(state.cities, settledCities);
  assert.deepEqual(state.eventLog, settledEvents);
});

test("a second pending defense prevents month opening until both battles have settled", async () => {
  const { state, invasionId } = fixture();
  const second = addInvasion(state, { sourceId: "xuchang", targetId: "xuzhou", officerId: "cao-cao" });
  let openings = 0;
  const first = await resumeTurnResolution(state, rules, {
    onInvasions: () => { defendUntilTimeout(state, openBattle(state, invasionId)); },
    onOpening: () => { openings += 1; }
  });
  assert.equal(first.waiting, "invasions");
  assert.equal(openings, 0);
  assert.equal(state.pendingInvasions.length, 1);
  assert.equal(state.pendingInvasions[0].id, second.invasionId);
  const firstBattleCities = structuredClone(state.cities);
  const completed = await resumeTurnResolution(state, rules, {
    onInvasions: () => { defendUntilTimeout(state, openBattle(state, second.invasionId)); },
    onOpening: () => { openings += 1; }
  });
  assert.equal(completed.completed, true);
  assert.equal(openings, 1);
  assert.equal(state.pendingInvasions.length, 0);
  assert.equal(state.elapsedMonths, 1);
  assert.deepEqual(city(state, "puyang"), city({ cities: firstBattleCities }, "puyang"));
  assert.deepEqual(city(state, "xiaopei"), city({ cities: firstBattleCities }, "xiaopei"));
});

test("an interrupted defense callback retains the invasion checkpoint for a safe retry", async () => {
  const { state, invasionId } = fixture();
  const beforeCities = structuredClone(state.cities);
  await assert.rejects(resumeTurnResolution(state, rules, {
    onInvasions: () => {
      openBattle(state, invasionId);
      throw new Error("battle view interrupted");
    }
  }), /battle view interrupted/);
  assert.equal(state.turnResolution.stage, "invasions");
  assert.equal(state.pendingInvasions.length, 1);
  assert.deepEqual(state.cities, beforeCities);
  const result = await resumeTurnResolution(state, rules, {
    onInvasions: () => { defendUntilTimeout(state, openBattle(state, invasionId)); },
    onOpening: () => {}
  });
  assert.equal(result.completed, true);
  assert.equal(state.month, 2);
  assert.equal(state.elapsedMonths, 1);
});
