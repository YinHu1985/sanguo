import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pendingMonthlySettlement, markMonthlySettlementRead, taskLedgerRecords } from "../src/js/game/monthly-settlement.js";
import { createInitialState, migrateState } from "../src/js/game/state.js";
import { queueTask, finishBattleTask } from "../src/js/game/tasks.js";
import { beginTurnResolution, resumeTurnResolution } from "../src/js/game/turn-flow.js";
import { createTaskUI, taskCounts } from "../src/js/ui/task-windows.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const completed = (id, extra = {}) => ({ id, factionId: "liu-bei", status: "completed", submittedTurn: 2, completedTurn: 3, ...extra });
const snapshot = (tasks = [completed("one")]) => ({ started: true, elapsedMonths: 3, year: 196, month: 4, playerFactionId: "liu-bei", tasks });
const ids = (tasks) => tasks.map((task) => task.id);

function fixture() {
  const state = createInitialState(scenario, rules);
  state.started = true;
  state.cities.forEach((city) => { city.governorId = null; });
  state.relations = Object.fromEntries(["cao-cao|liu-bei", "liu-bei|yuan-shu", "cao-cao|yuan-shu"].map((key) => [key, { allianceUntil: 9999 }]));
  return state;
}

test("monthly report contains this period's completed and failed player orders only", () => {
  const state = snapshot([
    completed("finished"), completed("failed", { status: "failed" }),
    completed("enemy", { factionId: "cao-cao" }),
    completed("old", { completedTurn: 2 }), completed("future", { completedTurn: 4 }),
    completed("running", { status: "running" }),
    completed("invalid-status", { status: "cancelled" }),
    completed("immediate", { submittedTurn: 3, timing: "immediate" }),
    completed("long-job", { submittedTurn: 0, timing: "multi_turn" })
  ]);
  const before = structuredClone(state);
  assert.deepEqual(ids(pendingMonthlySettlement(state).tasks), ["finished", "failed", "long-job"]);
  assert.deepEqual(state, before, "reading a report never marks it read or changes its tasks");
  assert.deepEqual(taskCounts(state), { active: 1, completed: 4 });
  assert.deepEqual(ids(taskLedgerRecords(state).older), ["old"]);
});

test("empty, initial, unfinished or invalid months never create a settlement modal", async () => {
  for (const state of [{}, snapshot([]), { ...snapshot(), started: false },
    { ...snapshot(), elapsedMonths: 0 }, { ...snapshot(), elapsedMonths: -1 },
    { ...snapshot(), elapsedMonths: 1.5 }, { ...snapshot(), playerFactionId: null },
    snapshot([completed("same-turn", { submittedTurn: 3 })])]) {
    assert.equal(pendingMonthlySettlement(state), null);
  }
  const ui = createTaskUI({ getState: () => snapshot([]) });
  assert.equal(await ui.showSettlement(null), false);
  assert.equal(await ui.showSettlement({ tasks: [] }), false);
});

test("the read checkpoint persists through reload and applies per player faction and month", () => {
  let state = snapshot([completed("liu"), completed("cao", { factionId: "cao-cao" })]);
  const report = pendingMonthlySettlement(state);
  assert.equal(markMonthlySettlementRead(state, report), true);
  assert.equal(pendingMonthlySettlement(state), null);
  state = JSON.parse(JSON.stringify(state));
  assert.equal(pendingMonthlySettlement(state), null);
  state.playerFactionId = "cao-cao";
  assert.deepEqual(ids(pendingMonthlySettlement(state).tasks), ["cao"]);
  assert.equal(markMonthlySettlementRead(state, pendingMonthlySettlement(state)), true);
  state.playerFactionId = "liu-bei";
  assert.equal(pendingMonthlySettlement(state), null);
  state.elapsedMonths = 4;
  state.month = 5;
  state.tasks.push(completed("next-month", { submittedTurn: 3, completedTurn: 4 }));
  assert.deepEqual(ids(pendingMonthlySettlement(state).tasks), ["next-month"]);
});

test("invalid or stale reports cannot mark a different opening month read", () => {
  const state = snapshot();
  const report = pendingMonthlySettlement(state);
  for (const bad of [null, { ...report, turn: 2 }, { ...report, turn: 4 },
    { ...report, factionId: "cao-cao" }, { ...report, tasks: [] }]) {
    assert.equal(markMonthlySettlementRead(state, bad), false);
  }
  assert.equal(state.monthlySettlementRead, undefined);
  assert.ok(pendingMonthlySettlement(state));
});

test("older saves without read metadata get one report and preserve it through migration", () => {
  const state = fixture();
  Object.assign(state, { elapsedMonths: 3, month: 4, tasks: [completed("legacy", { factionId: undefined, submittedTurn: undefined })] });
  delete state.monthlySettlementRead;
  let restored = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  assert.deepEqual(ids(pendingMonthlySettlement(restored).tasks), ["legacy"]);
  markMonthlySettlementRead(restored, pendingMonthlySettlement(restored));
  restored = migrateState(JSON.parse(JSON.stringify(restored)), scenario, rules);
  assert.equal(pendingMonthlySettlement(restored), null);
});

test("only the opening checkpoint may expose results after all armies and invasions finish", () => {
  const state = snapshot();
  for (const stage of ["tasks", "invasions"]) {
    state.turnResolution = { stage, targetTurn: 3 };
    assert.equal(pendingMonthlySettlement(state), null);
  }
  state.turnResolution = { stage: "opening", targetTurn: 3 };
  assert.ok(pendingMonthlySettlement(state));
  state.pendingInvasions = [{ resolved: false }];
  assert.equal(pendingMonthlySettlement(state), null);
  state.pendingInvasions[0].resolved = true;
  state.tasks.push(completed("battle", { status: "awaiting_battle" }));
  assert.equal(pendingMonthlySettlement(state), null);
  state.tasks[1].status = "completed";
  assert.deepEqual(ids(pendingMonthlySettlement(state).tasks), ["one", "battle"]);
});

test("a real multi-turn order produces no premature report and appears once at its due opening", async () => {
  const state = fixture();
  const customRules = structuredClone(rules);
  customRules.tasks = { defaultTiming: "turn_end", actions: { domestic: { timing: "multi_turn", duration: 3 } } };
  const order = queueTask(state, { kind: "domestic", cityId: "xiaopei", officerIds: ["liu-bei"], payload: { action: "agriculture" } }, customRules);
  assert.equal(order.ok, true);
  for (let turn = 1; turn <= 3; turn += 1) {
    beginTurnResolution(state);
    const result = await resumeTurnResolution(state, customRules, { onOpening: () => {
      const report = pendingMonthlySettlement(state);
      if (turn < 3) assert.equal(report, null);
      else {
        assert.deepEqual(ids(report.tasks), [order.taskId]);
        assert.equal(markMonthlySettlementRead(state, report), true);
      }
    } });
    assert.equal(result.completed, true);
  }
  assert.equal(pendingMonthlySettlement(JSON.parse(JSON.stringify(state))), null);
});

test("a battle-blocked month reports its outcome and later orders together after resumed settlement", async () => {
  let state = fixture();
  state.relations = {};
  const march = queueTask(state, { kind: "march", cityId: "xiaopei", officerIds: ["guan-yu"], payload: {
    targetId: "puyang", divisions: [{ officerId: "guan-yu", troops: 2000, unitType: "infantry" }], supplies: { gold: 100, food: 500 }
  } }, rules);
  const development = queueTask(state, { kind: "domestic", cityId: "xiaopei", officerIds: ["liu-bei"], payload: { action: "agriculture" } }, rules);
  assert.equal(march.ok, true);
  assert.equal(development.ok, true);
  beginTurnResolution(state);
  assert.equal((await resumeTurnResolution(state, rules)).waiting, "battle");
  assert.equal(pendingMonthlySettlement(state), null);
  state = JSON.parse(JSON.stringify(state));
  let shown = 0;
  const result = await resumeTurnResolution(state, rules, {
    onBattle: (task) => finishBattleTask(state, task.id, { success: false, message: "进攻失利，部队撤回。" }, state.turnResolution.targetTurn),
    onInvasions: () => { state.pendingInvasions.forEach((invasion) => { invasion.resolved = true; }); },
    onOpening: () => {
      const report = pendingMonthlySettlement(state);
      assert.deepEqual(ids(report.tasks), [march.taskId, development.taskId]);
      assert.equal(report.tasks[0].result.success, false);
      assert.equal(markMonthlySettlementRead(state, report), true);
      shown += 1;
    }
  });
  assert.equal(result.completed, true);
  assert.equal(shown, 1);
  assert.equal(pendingMonthlySettlement(state), null);
});

test("a lost city does not change ownership of a player's failed order report", () => {
  const state = snapshot([completed("lost-city", { status: "failed", cityId: "xiaopei" }), completed("enemy", { factionId: "cao-cao", cityId: "xiaopei" })]);
  state.cities = [{ id: "xiaopei", factionId: "cao-cao" }];
  assert.deepEqual(ids(pendingMonthlySettlement(state).tasks), ["lost-city"]);
});
