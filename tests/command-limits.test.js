import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canIssueCommand, commandLimitEnabled, consumeCommand } from "../src/js/game/commands.js";
import { createInitialState, migrateState } from "../src/js/game/state.js";
import { advanceMonth } from "../src/js/game/rules.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";

const scenario = JSON.parse(await readFile(new URL("./fixtures/legacy-scenario.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const city = (state, id = "xiaopei") => state.cities.find((entry) => entry.id === id);
const fresh = (limited = false) => createInitialState(scenario, { ...rules, commandLimitEnabled: limited });
const domestic = (cityId = "xiaopei", officerIds = ["liu-bei"]) => ({ kind: "domestic", cityId, officerIds, payload: { action: "agriculture" } });

test("test-play defaults to unlimited ruler commands without altering monthly or tactical budgets", () => {
  assert.equal(rules.commandLimitEnabled, false);
  const state = createInitialState(scenario, rules);
  assert.equal(commandLimitEnabled(state), false);
  state.commandsRemaining = 0;
  assert.equal(canIssueCommand(state), true);
  for (let i = 0; i < 20; i++) consumeCommand(state);
  assert.equal(state.commandsRemaining, 0);
  assert.equal(state.commandsMax, rules.commandsPerMonth);
  assert.equal(commandLimitEnabled({}), true, "legacy rule callers retain the original limited mode");
  assert.equal(canIssueCommand({ commandsRemaining: 0 }), false);
});

test("current rules override saved switches both ways without refilling an exhausted old save", () => {
  const old = fresh(true);
  old.commandsRemaining = 0;
  old.year = 200;
  city(old).gold = 12345;
  const unlimited = migrateState(old, scenario, rules);
  assert.equal(unlimited.commandLimitEnabled, false);
  assert.equal(unlimited.commandsRemaining, 0);
  assert.equal(canIssueCommand(unlimited), true);
  assert.equal(unlimited.year, 200);
  assert.equal(city(unlimited).gold, 12345);
  const restored = migrateState(unlimited, scenario, { ...rules, commandLimitEnabled: true });
  assert.equal(restored.commandLimitEnabled, true);
  assert.equal(restored.commandsRemaining, 0);
  assert.equal(canIssueCommand(restored), false);
  delete old.commandLimitEnabled;
  assert.equal(migrateState(old, scenario, rules).commandLimitEnabled, false);
});

test("eight different officers can queue and settle more than six orders without free resources or repeat actions", () => {
  const state = fresh();
  const initialGold = state.cities.reduce((sum, entry) => sum + entry.gold, 0);
  const orders = state.cities.filter((entry) => entry.factionId === state.playerFactionId)
    .flatMap((entry) => entry.officerIds.map((id) => domestic(entry.id, [id])));
  assert.equal(orders.length, 8);
  for (const order of orders) assert.equal(queueTask(state, order, rules).ok, true);
  assert.equal(state.tasks.length, 8);
  assert.equal(state.commandsRemaining, 0);
  assert.ok(state.cities.reduce((sum, entry) => sum + entry.gold, 0) < initialGold);
  const reserved = structuredClone(state);
  assert.equal(queueTask(state, orders[0], rules).ok, false, "officers still cannot act twice");
  assert.deepEqual(state, reserved);
  const afterReservation = state.cities.map((entry) => entry.gold);
  const report = settleTasks(state, rules, { rng: () => 0.99 });
  assert.equal(report.completed.length, 8);
  assert.equal(report.failed.length, 0);
  assert.deepEqual(state.cities.map((entry) => entry.gold), afterReservation, "settlement does not charge twice");
  assert.equal(state.commandsRemaining, 0);
  advanceMonth(state, rules);
  assert.equal(state.commandLimitEnabled, false);
  assert.equal(state.commandsRemaining, rules.commandsPerMonth);
  assert.equal(queueTask(state, orders[0], rules).ok, true);
});

test("re-enabling the original rule stops the seventh order with no partial mutation", () => {
  const state = fresh(true);
  const orders = state.cities.filter((entry) => entry.factionId === state.playerFactionId)
    .flatMap((entry) => entry.officerIds.map((id) => domestic(entry.id, [id])));
  for (const order of orders.slice(0, 6)) assert.equal(queueTask(state, order, rules).ok, true);
  const before = structuredClone(state);
  const result = queueTask(state, orders[6], rules);
  assert.equal(result.ok, false);
  assert.match(result.message, /指令已用尽/);
  assert.deepEqual(state, before);
});

const cases = [
  ["domestic", { action: "agriculture" }],
  ["recruit", { amount: 500 }],
  ["transfer", { targetId: "xuzhou", troops: 500, gold: 100, food: 100 }],
  ["governor", {}],
  ["search", {}],
  ["employ", { targetId: "cheng-yu" }],
  ["officerTransfer", { targetId: "xuzhou" }],
  ["diplomacy", { targetFactionId: "cao-cao", action: "goodwill" }],
  ["trade", { direction: "buy", goldAmount: 10 }],
  ["stratagem", { targetId: "puyang", action: "rumor" }],
  ["march", { targetId: "puyang", divisions: [{ officerId: "liu-bei", troops: 2000, unitType: "infantry" }], supplies: { gold: 100, food: 300 } }]
];
for (const [kind, payload] of cases) {
  test(`zero remaining tokens permits ${kind}, including primitive validation and completion`, () => {
    const state = fresh();
    state.commandsRemaining = 0;
    if (kind === "employ") {
      state.cities.forEach((entry) => { entry.officerIds = entry.officerIds.filter((id) => id !== "cheng-yu"); });
      Object.assign(state.officers.find((entry) => entry.id === "cheng-yu"),
        { factionId: null, status: "free", discovered: true, locationCityId: "xiaopei" });
    }
    const initialGold = city(state).gold;
    const result = queueTask(state, { kind, cityId: "xiaopei", officerIds: ["liu-bei"], payload }, rules);
    assert.equal(result.ok, true, result.message);
    assert.ok(city(state).gold < initialGold, "money costs are still reserved");
    assert.equal(state.commandsRemaining, 0);
    const report = settleTasks(state, rules, { rng: () => 0.99 });
    assert.equal(report.failed.length, 0);
    assert.equal(state.tasks[0].status, kind === "march" ? "awaiting_battle" : "completed");
    assert.equal(state.commandsRemaining, 0);
    assert.equal(state.officers.find((entry) => entry.id === "liu-bei").acted, true);
  });
}

test("unlimited commands do not bypass insufficient funds, task locks or turn-resolution guards", () => {
  for (const mutate of [
    (state) => { city(state).gold = 0; },
    (state) => { state.officers.find((entry) => entry.id === "liu-bei").acted = true; },
    (state) => { state.turnResolution = { stage: "tasks", targetTurn: 1 }; }
  ]) {
    const state = fresh(); state.commandsRemaining = 0; mutate(state);
    const before = structuredClone(state);
    assert.equal(queueTask(state, domestic(), rules).ok, false);
    assert.deepEqual(state, before);
  }
});
