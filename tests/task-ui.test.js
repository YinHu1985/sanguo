import test from "node:test";
import assert from "node:assert/strict";
import { taskCounts, taskIsActive, taskTimingText } from "../src/js/ui/task-windows.js";

test("task counter includes both running orders and armies awaiting battle", () => {
  const state = { elapsedMonths: 3, tasks: [
    { status: "running", dueTurn: 5 },
    { status: "running", dueTurn: 3 },
    { status: "awaiting_battle", dueTurn: 3 },
    { status: "completed", completedTurn: 3 },
    { status: "failed", completedTurn: 3 },
    { status: "completed", completedTurn: 2 },
    { status: "failed", completedTurn: 2 }
  ] };
  assert.deepEqual(taskCounts(state), { active: 3, completed: 2 });
  assert.equal(taskIsActive({ status: "running" }), true);
  assert.equal(taskIsActive({ status: "awaiting_battle" }), true);
  assert.equal(taskIsActive({ status: "completed" }), false);
  assert.equal(taskIsActive({ status: "failed" }), false);
});

test("only this turn's completed or failed outcomes count as newly finished", () => {
  const state = { elapsedMonths: 8, tasks: [
    { status: "completed", completedTurn: 8 },
    { status: "failed", completedTurn: 8 },
    { status: "completed", completedTurn: 7 },
    { status: "failed", completedTurn: 0 },
    { status: "completed", completedTurn: 9 },
    { status: "running", completedTurn: 8 },
    { status: "awaiting_battle", completedTurn: 8 }
  ] };
  assert.deepEqual(taskCounts(state), { active: 2, completed: 2 });
  state.elapsedMonths = 9;
  assert.deepEqual(taskCounts(state), { active: 2, completed: 1 });
});

test("task counter supports empty and initial-turn ledgers without mutation", () => {
  assert.deepEqual(taskCounts({}), { active: 0, completed: 0 });
  assert.deepEqual(taskCounts({ tasks: [] }), { active: 0, completed: 0 });
  const state = { tasks: [{ status: "completed", completedTurn: 0 }, { status: "failed", completedTurn: 0 }] };
  const before = structuredClone(state);
  assert.deepEqual(taskCounts(state), { active: 0, completed: 2 });
  assert.deepEqual(state, before);
});

test("default and turn-end timing explain deferred effects without irrelevant combat copy", () => {
  assert.equal(taskTimingText({}, "domestic"), "结束本月后完成。");
  assert.equal(taskTimingText({ tasks: { defaultTiming: "turn_end" } }, "trade"), "结束本月后完成。");
  assert.match(taskTimingText({}, "march"), /结束本月后完成.*进入战场/);
  for (const kind of ["domestic", "recruit", "transfer", "governor", "search", "employ", "officerTransfer", "diplomacy", "trade"]) {
    assert.doesNotMatch(taskTimingText({}, kind), /战场/);
  }
});

test("per-action immediate and multi-turn text matches configured duration", () => {
  const rules = { tasks: { defaultTiming: "turn_end", actions: {
    trade: { timing: "immediate" }, domestic: { timing: "multi_turn", duration: 3 }, march: { timing: "multi_turn", duration: 2 }
  } } };
  assert.equal(taskTimingText(rules, "trade"), "签发后立即执行。");
  assert.match(taskTimingText(rules, "domestic"), /3 个回合后完成.*持续忙碌/);
  assert.doesNotMatch(taskTimingText(rules, "domestic"), /战场/);
  assert.match(taskTimingText(rules, "march"), /2 个回合后完成.*进入战场/);
  assert.match(taskTimingText({ tasks: { defaultTiming: "multi_turn" } }, "search"), /1 个回合后完成/);
});

test("object defaults and action overrides merge identically to the task engine", () => {
  const rules = { tasks: { defaultTiming: { timing: "multi_turn", duration: 4 }, actions: {
    search: { duration: 2 }, trade: { timing: "immediate" }, recruit: { timing: "turn_end" }
  } } };
  const before = structuredClone(rules);
  assert.match(taskTimingText(rules, "domestic"), /4 个回合后完成/);
  assert.match(taskTimingText(rules, "search"), /2 个回合后完成/);
  assert.equal(taskTimingText(rules, "trade"), "签发后立即执行。");
  assert.equal(taskTimingText(rules, "recruit"), "结束本月后完成。");
  assert.match(taskTimingText(rules, "march"), /4 个回合后完成.*进入战场/);
  assert.deepEqual(rules, before);
  assert.match(taskTimingText({ tasks: { defaultTiming: { timing: "immediate" } } }, "march"), /立即执行.*进入战场/);
});
