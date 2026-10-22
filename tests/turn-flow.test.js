import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState } from "../src/js/game/state.js";
import { queueTask, finishBattleTask } from "../src/js/game/tasks.js";
import { beginTurnResolution, resumeTurnResolution } from "../src/js/game/turn-flow.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const city = (state, id = "xiaopei") => state.cities.find((entry) => entry.id === id);
const officer = (state, id = "liu-bei") => state.officers.find((entry) => entry.id === id);
const task = (state, id) => state.tasks.find((entry) => entry.id === id);
function fixture(peaceful = true) {
  const state = createInitialState(scenario, rules);
  state.cities.forEach((entry) => { entry.governorId = null; });
  if (peaceful) {
    state.relations = Object.fromEntries(["cao-cao|liu-bei", "liu-bei|yuan-shu", "cao-cao|yuan-shu"].map((key) => [key, { allianceUntil: 9999 }]));
  }
  return state;
}
const domestic = (state, customRules = rules, officerId = "liu-bei") => queueTask(state, {
  kind: "domestic", cityId: "xiaopei", officerIds: [officerId], payload: { action: "agriculture" }
}, customRules);
const march = (state) => queueTask(state, { kind: "march", cityId: "xiaopei", officerIds: ["guan-yu"], payload: {
  targetId: "puyang", divisions: [{ officerId: "guan-yu", troops: 2000, unitType: "infantry" }], supplies: { gold: 100, food: 500 }
} }, rules);

test("beginning a turn only creates a checkpoint and resuming it never resets its target", () => {
  const state = fixture();
  const before = structuredClone(state);
  const first = beginTurnResolution(state);
  assert.equal(first.ok, true);
  assert.equal(first.resumed, false);
  assert.deepEqual(state.turnResolution, { stage: "tasks", targetTurn: 1 });
  const { turnResolution, ...rest } = state;
  delete before.turnResolution;
  assert.deepEqual(rest, before);
  assert.equal(beginTurnResolution(state).resumed, true);
  assert.deepEqual(state.turnResolution, turnResolution);
});

test("a normal monthly resolution completes due work, advances once, saves stages and opens the new turn", async () => {
  const state = fixture();
  const beforeAgriculture = city(state).agriculture;
  const order = domestic(state);
  assert.equal(order.ok, true);
  assert.equal(city(state).agriculture, beforeAgriculture);
  const snapshots = [];
  let openingCalls = 0;
  beginTurnResolution(state);
  const result = await resumeTurnResolution(state, rules, {
    save: (current) => snapshots.push(structuredClone(current)),
    onOpening: () => { openingCalls += 1; }
  });
  assert.equal(result.completed, true);
  assert.equal(task(state, order.taskId).status, "completed");
  assert.equal(task(state, order.taskId).completedTurn, 1);
  assert.ok(city(state).agriculture > beforeAgriculture);
  assert.equal(state.month, 2);
  assert.equal(state.elapsedMonths, 1);
  assert.equal(state.lastWorldTurnMonth, 196 * 12 + 2);
  assert.equal(state.commandsRemaining, rules.commandsPerMonth);
  assert.equal(openingCalls, 1);
  assert.deepEqual(snapshots.map((saved) => saved.turnResolution?.stage ?? null), ["tasks", "invasions", "opening", null]);
  assert.equal(snapshots[0].month, 1);
  const after = structuredClone(state);
  const repeated = await resumeTurnResolution(state, rules, { onOpening: () => { openingCalls += 1; } });
  assert.equal(repeated.idle, true);
  assert.deepEqual(state, after);
  assert.equal(openingCalls, 1);
});

test("resume without a checkpoint cannot begin or charge a new month", async () => {
  const state = fixture();
  const before = structuredClone(state);
  assert.equal((await resumeTurnResolution(state, rules)).idle, true);
  assert.deepEqual(state, before);
});

test("a campaign already won advances its economy but does not take an AI world turn", async () => {
  const state = fixture();
  for (const entry of state.cities) entry.factionId = state.playerFactionId;
  beginTurnResolution(state);
  assert.equal((await resumeTurnResolution(state, rules, { onOpening: () => {} })).completed, true);
  assert.equal(state.elapsedMonths, 1);
  assert.equal(state.lastWorldTurnMonth, undefined);
});

test("manual battle waits without advancing and reload resumes later queued work after the result", async () => {
  let state = fixture(false);
  const attack = march(state);
  assert.equal(attack.ok, true);
  const development = domestic(state);
  assert.equal(development.ok, true);
  const sourceAfterReservation = structuredClone(city(state));
  beginTurnResolution(state);
  const waiting = await resumeTurnResolution(state, rules);
  assert.equal(waiting.waiting, "battle");
  assert.equal(waiting.taskId, attack.taskId);
  assert.equal(state.month, 1);
  assert.equal(state.elapsedMonths, 0);
  assert.equal(task(state, attack.taskId).status, "awaiting_battle");
  assert.equal(task(state, development.taskId).status, "running");
  assert.deepEqual(city(state), sourceAfterReservation, "departure must not debit reserved cargo again");
  state = JSON.parse(JSON.stringify(state));
  let battleCalls = 0;
  const completed = await resumeTurnResolution(state, rules, {
    onBattle: (pending) => {
      battleCalls += 1;
      assert.equal(pending.id, attack.taskId);
      assert.equal(finishBattleTask(state, pending.id, { success: false, message: "战斗已由回调结算" }, state.turnResolution.targetTurn).ok, true);
    },
    onOpening: () => {}
  });
  assert.equal(completed.completed, true);
  assert.equal(battleCalls, 1);
  assert.equal(state.elapsedMonths, 1);
  assert.equal(state.month, 2);
  assert.equal(task(state, development.taskId).status, "completed");
  assert.equal(task(state, attack.taskId).completedTurn, 1);
});

test("an unfinished battle callback returns once instead of repeatedly reopening the same battle", async () => {
  const state = fixture(false);
  march(state);
  beginTurnResolution(state);
  let calls = 0;
  const result = await resumeTurnResolution(state, rules, { onBattle: () => { calls += 1; } });
  assert.equal(result.waiting, "battle");
  assert.equal(calls, 1);
  assert.equal(state.turnResolution.stage, "tasks");
  assert.equal(state.elapsedMonths, 0);
});

test("an invasion checkpoint waits for every unresolved battle and never repeats monthly economy", async () => {
  const state = fixture();
  state.elapsedMonths = 1;
  state.month = 2;
  state.turnResolution = { stage: "invasions", targetTurn: 1 };
  state.pendingInvasions = [{ id: "pending", resolved: false }, { id: "old", resolved: true }];
  const beforeCities = structuredClone(state.cities);
  assert.equal((await resumeTurnResolution(state, rules)).waiting, "invasions");
  let decisions = 0;
  assert.equal((await resumeTurnResolution(state, rules, { onInvasions: () => { decisions += 1; } })).waiting, "invasions");
  assert.equal(decisions, 1);
  const result = await resumeTurnResolution(state, rules, {
    onInvasions: () => { decisions += 1; state.pendingInvasions[0].resolved = true; }, onOpening: () => {}
  });
  assert.equal(result.completed, true);
  assert.equal(decisions, 2);
  assert.equal(state.month, 2);
  assert.deepEqual(state.cities, beforeCities);
});

test("opening checkpoints survive reload and show the report without rerunning economy or AI", async () => {
  let state = fixture();
  beginTurnResolution(state);
  const waiting = await resumeTurnResolution(state, rules);
  assert.equal(waiting.waiting, "opening");
  assert.equal(state.turnResolution.stage, "opening");
  const before = structuredClone(state);
  state = JSON.parse(JSON.stringify(state));
  let openings = 0;
  assert.equal((await resumeTurnResolution(state, rules, { onOpening: () => { openings += 1; } })).completed, true);
  assert.equal(openings, 1);
  assert.equal(state.turnResolution, null);
  assert.deepEqual(state.cities, before.cities);
  assert.deepEqual(state.eventLog, before.eventLog);
  assert.equal(state.lastWorldTurnMonth, before.lastWorldTurnMonth);
  assert.equal(state.elapsedMonths, before.elapsedMonths);
});

test("targetTurn guards a replay whose month was already advanced before its phase was saved", async () => {
  const state = fixture();
  beginTurnResolution(state);
  await resumeTurnResolution(state, rules);
  state.turnResolution.stage = "tasks";
  const before = structuredClone(state);
  assert.equal((await resumeTurnResolution(state, rules, { onOpening: () => {} })).completed, true);
  assert.equal(state.month, before.month);
  assert.equal(state.elapsedMonths, before.elapsedMonths);
  assert.deepEqual(state.cities, before.cities);
  assert.deepEqual(state.officers, before.officers);
  assert.deepEqual(state.eventLog, before.eventLog);
});

test("multi-turn work remains locked across months and completes only at its due turn", async () => {
  const state = fixture();
  const customRules = structuredClone(rules);
  customRules.tasks = { defaultTiming: "turn_end", actions: { domestic: { timing: "multi_turn", duration: 3 } } };
  const initialAgriculture = city(state).agriculture;
  const order = domestic(state, customRules);
  assert.equal(order.ok, true);
  for (let turn = 1; turn <= 3; turn += 1) {
    beginTurnResolution(state);
    assert.equal((await resumeTurnResolution(state, customRules, { onOpening: () => {} })).completed, true);
    assert.equal(state.elapsedMonths, turn);
    if (turn < 3) {
      assert.equal(task(state, order.taskId).status, "running");
      assert.equal(officer(state).taskId, order.taskId);
      assert.equal(officer(state).acted, true);
      assert.equal(city(state).agriculture, initialAgriculture);
      assert.equal(domestic(state, customRules).ok, false);
    }
  }
  assert.equal(task(state, order.taskId).status, "completed");
  assert.equal(task(state, order.taskId).completedTurn, 3);
  assert.equal(officer(state).taskId, undefined);
  assert.equal(officer(state).acted, false);
  assert.ok(city(state).agriculture > initialAgriculture);
});

test("concurrent resumes share one resolution and one opening callback", async () => {
  const state = fixture();
  beginTurnResolution(state);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let openings = 0;
  const callbacks = { onOpening: async () => { openings += 1; await gate; } };
  const first = resumeTurnResolution(state, rules, callbacks);
  const second = resumeTurnResolution(state, rules, callbacks);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.every((result) => result.completed), true);
  assert.equal(state.elapsedMonths, 1);
  assert.equal(openings, 1);
});

test("failed callbacks keep their checkpoint and may be retried without repeating the month", async () => {
  const state = fixture();
  beginTurnResolution(state);
  await assert.rejects(resumeTurnResolution(state, rules, { onOpening: () => { throw new Error("dialog interrupted"); } }), /dialog interrupted/);
  assert.equal(state.turnResolution.stage, "opening");
  const before = structuredClone(state.cities);
  assert.equal((await resumeTurnResolution(state, rules, { onOpening: () => {} })).completed, true);
  assert.equal(state.elapsedMonths, 1);
  assert.deepEqual(state.cities, before);
});

test("invalid checkpoints fail without changing resources or date", async () => {
  for (const checkpoint of [{ stage: "unknown", targetTurn: 1 }, { stage: "tasks", targetTurn: 3 }, { stage: "tasks", targetTurn: NaN }]) {
    const state = fixture();
    state.turnResolution = checkpoint;
    const before = structuredClone(state);
    assert.equal((await resumeTurnResolution(state, rules)).ok, false);
    assert.deepEqual(state, before);
  }
});
