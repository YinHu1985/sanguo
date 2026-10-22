import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState, loadState, migrateState, saveState, storageKey } from "../src/js/game/state.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";
import { applyAtlasToScenario } from "../src/js/game/atlas.js";

const scenario = applyAtlasToScenario(
  JSON.parse(await readFile(new URL("../src/data/scenario.json", import.meta.url), "utf8")),
  JSON.parse(await readFile(new URL("../src/data/strategic-atlas.json", import.meta.url), "utf8"))
);
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));

function memoryStorage(context) {
  const values = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  } });
  context.after(() => original ? Object.defineProperty(globalThis, "localStorage", original) : delete globalThis.localStorage);
  return values;
}

const officer = (state, id) => state.officers.find((entry) => entry.id === id);
const home = (state) => state.cities.find((entry) => entry.id === "xiaopei");

function legacyTaskState() {
  const state = createInitialState(scenario, rules);
  for (const key of ["taskVersion", "tasks", "nextTaskId", "turnResolution", "lastTurnOpening"]) delete state[key];
  Object.assign(state, { started: true, year: 201, month: 8, elapsedMonths: 57, commandsRemaining: 2 });
  Object.assign(home(state), { gold: 127, food: 923, troops: 3456 });
  Object.assign(officer(state, "liu-bei"), { acted: true, merit: 234, loyalty: 87 });
  return state;
}

function queueDomestic(state) {
  const report = queueTask(state, { kind: "domestic", cityId: "xiaopei", officerIds: ["liu-bei"], payload: { action: "agriculture" } }, rules);
  assert.equal(report.ok, true, report.message);
  return report.task;
}

function queueMarch(state) {
  const report = queueTask(state, { kind: "march", cityId: "xiaopei", officerIds: ["guan-yu"],
    payload: { targetId: "puyang", divisions: [{ officerId: "guan-yu", troops: 2000, unitType: "infantry" }], supplies: { food: 300, gold: 100 } } }, rules);
  assert.equal(report.ok, true, report.message);
  return report.task;
}

test("fresh state contains an empty task ledger and no turn-opening or resolution marker", () => {
  const state = createInitialState(scenario, rules);
  assert.equal(state.taskVersion, 1);
  assert.deepEqual(state.tasks, []);
  assert.equal(state.nextTaskId, 1);
  assert.equal(state.turnResolution, null);
  assert.equal(state.lastTurnOpening, null);
});

test("task migration preserves legacy calendar, treasury, officer activity and commands without input mutation", () => {
  const saved = legacyTaskState();
  const before = structuredClone(saved);
  const restored = migrateState(saved, scenario, rules);
  assert.equal(restored.taskVersion, 1);
  assert.deepEqual(restored.tasks, []);
  assert.equal(restored.nextTaskId, 1);
  assert.equal(restored.turnResolution, null);
  assert.equal(restored.lastTurnOpening, null);
  assert.deepEqual(restored.cities, before.cities, "no income, resource refund or new reservation is applied during migration");
  assert.deepEqual(restored.officers, before.officers, "old acted flags and merit remain intact");
  for (const key of ["year", "month", "elapsedMonths", "commandsRemaining", "started", "relations", "eventLog"]) {
    assert.deepEqual(restored[key], before[key], key);
  }
  assert.deepEqual(saved, before);
  assert.deepEqual(migrateState(restored, scenario, rules), restored);
});

test("loading a pre-task save makes one recoverable snapshot and never resets or overwrites progress", (context) => {
  const values = memoryStorage(context);
  const saved = legacyTaskState();
  const raw = JSON.stringify(saved);
  const key = storageKey(scenario.id);
  values.set(key, raw);
  values.set(`${key}:previous`, "unrelated earlier campaign");
  values.set(`${key}:before-economy-v2`, "existing economy snapshot");
  const restored = loadState(scenario, rules);
  assert.equal(values.get(`${key}:before-tasks-v1`), raw);
  assert.equal(values.get(key), JSON.stringify(restored));
  assert.equal(values.get(`${key}:previous`), "unrelated earlier campaign");
  assert.equal(values.get(`${key}:before-economy-v2`), "existing economy snapshot");
  assert.equal(restored.started, true);
  assert.equal(restored.year, 201);
  assert.equal(restored.month, 8);
  assert.equal(restored.commandsRemaining, 2);
  assert.deepEqual(restored.cities, saved.cities);
  assert.deepEqual(restored.officers, saved.officers);
  restored.commandsRemaining = 1;
  home(restored).gold = 71;
  saveState(restored);
  assert.deepEqual(loadState(scenario, rules), restored);
  assert.equal(values.get(`${key}:before-tasks-v1`), raw, "later reloads must preserve the original pre-task snapshot");
});

test("running task loads restore actor locks without reserving costs a second time", (context) => {
  memoryStorage(context);
  const current = createInitialState(scenario, rules);
  current.started = true;
  const task = queueDomestic(current);
  const reservedCities = structuredClone(current.cities);
  const reservedCommands = current.commandsRemaining;
  const savedTasks = structuredClone(current.tasks);
  delete officer(current, "liu-bei").taskId;
  officer(current, "liu-bei").acted = false;
  saveState(current);
  const restored = loadState(scenario, rules);
  assert.equal(officer(restored, "liu-bei").taskId, task.id);
  assert.equal(officer(restored, "liu-bei").acted, true);
  assert.equal(restored.commandsRemaining, reservedCommands);
  assert.deepEqual(restored.cities, reservedCities);
  assert.deepEqual(restored.tasks, savedTasks);
  assert.equal(restored.tasks[0].reservation.status, "reserved");
  saveState(restored);
  assert.deepEqual(loadState(scenario, rules), restored);
});

test("awaiting-battle and queued tasks resume with their resources, locks and turn markers intact", (context) => {
  memoryStorage(context);
  const current = createInitialState(scenario, rules);
  current.started = true;
  const march = queueMarch(current);
  const domestic = queueDomestic(current);
  const report = settleTasks(current, rules, { targetTurn: 1, rng: () => 0.5 });
  assert.equal(report.battleTask.id, march.id);
  assert.equal(current.tasks.find((entry) => entry.id === domestic.id).status, "running");
  current.turnResolution = { phase: "tasks", targetTurn: 1, year: current.year, month: current.month, worldApplied: false };
  current.lastTurnOpening = "196-11:liu-bei";
  current.pendingInvasions = [{ id: "persisted-invasion", sourceId: "jibei", targetId: "xiaopei", attackerFactionId: "cao-cao",
    officerIds: ["lv-qian"], troops: 1700, supplies: { food: 204, gold: 67 }, resolved: false }];
  const expected = structuredClone(current);
  for (const id of ["guan-yu", "liu-bei"]) { delete officer(current, id).taskId; officer(current, id).acted = false; }
  saveState(current);
  let restored = loadState(scenario, rules);
  assert.deepEqual(restored, expected, "load only repairs locks; pending battles and all reserved assets are preserved");
  assert.equal(officer(restored, "guan-yu").taskId, march.id);
  assert.equal(officer(restored, "liu-bei").taskId, domestic.id);
  for (let reload = 0; reload < 3; reload += 1) {
    saveState(restored);
    restored = loadState(scenario, rules);
    assert.deepEqual(restored, expected, `reload ${reload + 1} must not refund or withdraw anything again`);
  }
});

test("completed task loads clear stale task ids but keep each officer's existing monthly acted flag", (context) => {
  memoryStorage(context);
  const current = createInitialState(scenario, rules);
  const task = queueDomestic(current);
  settleTasks(current, rules, { targetTurn: 1, rng: () => 0.5 });
  assert.equal(current.tasks[0].status, "completed");
  Object.assign(officer(current, "liu-bei"), { taskId: task.id, acted: true });
  Object.assign(officer(current, "guan-yu"), { taskId: "missing-task", acted: false });
  const cities = structuredClone(current.cities);
  const ledger = structuredClone(current.tasks);
  saveState(current);
  const restored = loadState(scenario, rules);
  assert.equal(officer(restored, "liu-bei").taskId, undefined);
  assert.equal(officer(restored, "liu-bei").acted, true);
  assert.equal(officer(restored, "guan-yu").taskId, undefined);
  assert.equal(officer(restored, "guan-yu").acted, false);
  assert.deepEqual(restored.tasks, ledger);
  assert.deepEqual(restored.cities, cities);
  assert.equal(restored.commandsRemaining, current.commandsRemaining);
});

test("task backup and active-slot write failures preserve the original save while returning migrated progress", async (context) => {
  for (const failureAt of ["backup", "active"]) {
    await context.test(failureAt, (child) => {
      const values = memoryStorage(child);
      const saved = legacyTaskState();
      const raw = JSON.stringify(saved);
      const key = storageKey(scenario.id);
      values.set(key, raw);
      localStorage.setItem = (name, value) => {
        if (failureAt === "backup" || name === key) throw new Error("storage full");
        values.set(name, value);
      };
      const restored = loadState(scenario, rules);
      assert.equal(restored.taskVersion, 1);
      assert.deepEqual(restored.tasks, []);
      assert.equal(restored.started, true);
      assert.equal(restored.year, saved.year);
      assert.equal(restored.month, saved.month);
      assert.equal(restored.commandsRemaining, saved.commandsRemaining);
      assert.deepEqual(restored.cities, saved.cities);
      assert.deepEqual(restored.officers, saved.officers);
      assert.equal(values.get(key), raw);
      assert.equal(values.get(`${key}:before-tasks-v1`), failureAt === "active" ? raw : undefined);
    });
  }
});
