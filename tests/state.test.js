import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { archiveState, createInitialState, loadState, migrateState, saveState, storageKey } from "../src/js/game/state.js";

const scenario = JSON.parse(await readFile(new URL("../src/data/scenario.json", import.meta.url), "utf8"));
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

function oldEconomyState() {
  const saved = createInitialState(scenario, rules);
  delete saved.economyVersion;
  return saved;
}

function invasionFrom(city, overrides = {}) {
  return { id: "legacy-order", sourceId: city.id, attackerFactionId: city.factionId,
    targetId: "xiaopei", troops: 3000, officerIds: ["lv-qian"], resolved: false, ...overrides };
}

test("different scenarios keep separate save slots and preserve the legacy slot", (context) => {
  const values = memoryStorage(context);
  const legacy = { ...createInitialState(scenario, rules), scenarioId: "legacy-scenario", month: 4 };
  values.set("hanmo-zhoujun-save-v1", JSON.stringify(legacy));
  const fresh = loadState(scenario, rules);
  assert.equal(fresh.scenarioId, scenario.id);
  assert.equal(fresh.started, false);
  assert.equal(fresh.month, scenario.month);
  fresh.started = true;
  fresh.commandsRemaining = 2;
  saveState(fresh);
  assert.equal(loadState(scenario, rules).commandsRemaining, 2);
  assert.equal(values.get("hanmo-zhoujun-save-v1"), JSON.stringify(legacy));
});

test("starting over can retain a separate snapshot of the previous active campaign", (context) => {
  const values = memoryStorage(context);
  const current = createInitialState(scenario, rules);
  current.started = true;
  current.year = 201;
  archiveState(current);
  saveState(createInitialState(scenario, rules));
  assert.equal(JSON.parse(values.get(`${storageKey(scenario.id)}:previous`)).year, 201);
  assert.equal(loadState(scenario, rules).year, scenario.year);
});

test("the save round trip retains pending invasions and diplomatic agreements", (context) => {
  memoryStorage(context);
  const current = createInitialState(scenario, rules);
  current.pendingInvasions = [{ id: "test-invasion", resolved: false, troops: 3000, supplies: { food: 0, gold: 0 } }];
  current.relations = { "a|b": { friendliness: 70, allianceUntil: 2370 } };
  saveState(current);
  const restored = loadState(scenario, rules);
  assert.deepEqual(restored.pendingInvasions, current.pendingInvasions);
  assert.deepEqual(restored.relations, current.relations);
});

test("placeholder cleanup preserves progress, unstaffed cities, neutral cities and real officers", () => {
  const saved = createInitialState(scenario, rules);
  const city = saved.cities.find((entry) => entry.id === "jibei");
  const vacant = saved.cities.find((entry) => entry.id === "yunnan");
  const neutral = saved.cities.find((entry) => entry.id === "hepu");
  const officer = saved.officers.find((entry) => entry.id === "lv-qian");
  Object.assign(saved, { started: true, year: 201, month: 8, elapsedMonths: 57, commandsRemaining: 2, selectedCityId: city.id });
  Object.assign(city, { gold: 12345, food: 67890, troops: 9876, agriculture: 91, governorId: "bao-xin-you" });
  city.officerIds.push("bao-xin-you");
  Object.assign(vacant, { officerIds: ["old-local-clerk"], governorId: "old-local-clerk" });
  Object.assign(neutral, { factionId: "neutral", officerIds: [], governorId: null, troops: 0 });
  Object.assign(officer, { merit: 999, acted: true, loyalty: 73 });
  saved.officers.push(
    { id: "bao-xin-you", name: "济北郡丞", status: "active", factionId: city.factionId },
    { id: "old-local-clerk", name: "地方主簿", fictional: true, status: "captured", captorFactionId: saved.playerFactionId },
    { id: "custom-real-officer", name: "自定义人物数据", fictional: false, status: "free" }
  );
  const before = structuredClone(saved);
  const restored = migrateState(saved, scenario, rules);
  const expectedCity = { ...city, governorId: null, officerIds: city.officerIds.filter((id) => id !== "bao-xin-you") };
  assert.deepEqual(restored.cities.find((entry) => entry.id === city.id), expectedCity);
  assert.deepEqual(restored.cities.find((entry) => entry.id === vacant.id), { ...vacant, governorId: null, officerIds: [] });
  assert.deepEqual(restored.cities.find((entry) => entry.id === neutral.id), neutral);
  assert.deepEqual(restored.officers.find((entry) => entry.id === officer.id), officer);
  assert.ok(restored.officers.some((entry) => entry.id === "custom-real-officer"));
  assert.ok(!restored.officers.some((entry) => entry.fictional || entry.id === "bao-xin-you"));
  for (const key of ["year", "month", "elapsedMonths", "commandsRemaining", "selectedCityId", "started", "relations", "eventLog"]) {
    assert.deepEqual(restored[key], saved[key], key);
  }
  assert.deepEqual(saved, before, "migration must not mutate its input");
  assert.deepEqual(migrateState(restored, scenario, rules), restored, "cleanup must be idempotent");
});

test("loading old placeholders keeps a recoverable snapshot and writes the cleaned active slot", (context) => {
  const values = memoryStorage(context);
  const saved = createInitialState(scenario, rules);
  saved.started = true;
  saved.year = 202;
  saved.officers.push({ id: "bao-xin-you", name: "济北郡丞" });
  const raw = JSON.stringify(saved);
  const key = storageKey(scenario.id);
  values.set(key, raw);
  values.set(`${key}:previous`, "unrelated previous campaign");
  const restored = loadState(scenario, rules);
  assert.equal(restored.year, 202);
  assert.equal(values.get(`${key}:before-placeholder-cleanup`), raw);
  assert.equal(values.get(key), JSON.stringify(restored));
  assert.equal(values.get(`${key}:previous`), "unrelated previous campaign");
  assert.ok(!restored.officers.some((officer) => officer.id === "bao-xin-you"));
  loadState(scenario, rules);
  assert.equal(values.get(`${key}:before-placeholder-cleanup`), raw, "later loads must not overwrite the backup");
});

test("removed commander orders withdraw their troops once without disturbing other invasions", () => {
  const saved = createInitialState(scenario, rules);
  const source = saved.cities.find((city) => city.id === "jibei");
  Object.assign(source, { troops: 2000, training: 40, morale: 50, governorId: "bao-xin-you" });
  source.officerIds.push("bao-xin-you");
  const realOrder = { id: "real-order", officerIds: ["lv-qian"], divisions: [{ officerId: "lv-qian", troops: 1000 }], troops: 1000, resolved: false,
    supplies: { food: 0, gold: 0 } };
  const withdrawn = { id: "withdrawn-order", sourceId: source.id, attackerFactionId: source.factionId,
    officerIds: ["bao-xin-you", "bi-chen"], divisions: [{ officerId: "bao-xin-you", troops: 500 }, { officerId: "bi-chen", troops: 1500 }],
    troops: 2000, training: 80, morale: 90, resolved: false };
  saved.pendingInvasions = [withdrawn, realOrder, { ...withdrawn, id: "already-resolved", resolved: true }];
  const restored = migrateState(saved, scenario, rules);
  const home = restored.cities.find((city) => city.id === source.id);
  assert.deepEqual(restored.pendingInvasions, [{ ...realOrder,
    divisions: [{ officerId: "lv-qian", officerIds: ["lv-qian"], troops: 1000, unitType: "infantry" }] }]);
  assert.equal(home.troops, 4000);
  assert.equal(home.training, 60);
  assert.equal(home.morale, 70);
  assert.equal(home.governorId, null);
  assert.deepEqual(migrateState(restored, scenario, rules), restored);
});

test("a failed cleanup backup does not reset a loaded campaign", (context) => {
  memoryStorage(context);
  const saved = createInitialState(scenario, rules);
  Object.assign(saved, { started: true, year: 203, commandsRemaining: 1 });
  saved.officers.push({ id: "bao-xin-you", name: "济北郡丞" });
  localStorage.setItem(storageKey(scenario.id), JSON.stringify(saved));
  localStorage.setItem = () => { throw new Error("storage full"); };
  const restored = loadState(scenario, rules);
  assert.equal(restored.year, 203);
  assert.equal(restored.commandsRemaining, 1);
  assert.equal(restored.started, true);
  assert.ok(!restored.officers.some((officer) => officer.id === "bao-xin-you"));
});

test("fresh campaigns use economy v2, and old campaigns retain resources and settlement markers", () => {
  assert.equal(createInitialState(scenario, rules).economyVersion, 2);
  const saved = oldEconomyState();
  Object.assign(saved, { started: true, year: 203, month: 7, elapsedMonths: 80, commandsRemaining: 1,
    lastWorldTurnMonth: 2443, lastEconomyMonth: 2443, lastHarvestYear: 203 });
  const city = saved.cities.find((entry) => entry.id === "jibei");
  Object.assign(city, { gold: 17, food: 23, troops: 1234, lastIncomeMonth: 2443, lastHarvestYear: 203 });
  const before = structuredClone(saved);
  const restored = migrateState(saved, scenario, rules);
  assert.equal(restored.economyVersion, 2);
  assert.deepEqual(restored.cities, saved.cities, "migration must not replenish city stores or retroactively pay income");
  assert.deepEqual(restored.officers, saved.officers);
  for (const key of ["started", "year", "month", "elapsedMonths", "commandsRemaining", "lastWorldTurnMonth", "lastEconomyMonth", "lastHarvestYear", "eventLog"]) {
    assert.deepEqual(restored[key], saved[key], key);
  }
  assert.deepEqual(saved, before);
  assert.deepEqual(migrateState(restored, scenario, rules), restored);
});

test("legacy pending armies draw at most thirty days of food and 150 gold from their own source exactly once", () => {
  const saved = oldEconomyState();
  const source = saved.cities.find((entry) => entry.id === "jibei");
  Object.assign(source, { food: 1000, gold: 1000 });
  saved.pendingInvasions = [invasionFrom(source)];
  const restored = migrateState(saved, scenario, rules);
  const home = restored.cities.find((entry) => entry.id === source.id);
  assert.deepEqual(restored.pendingInvasions[0].supplies, { food: 360, gold: 150 });
  assert.equal(home.food, 640);
  assert.equal(home.gold, 850, "no dispatch fee is charged retroactively");
  assert.equal(home.troops, source.troops, "already deployed troops must not be subtracted twice");
  assert.equal(restored.commandsRemaining, saved.commandsRemaining);
  assert.deepEqual(migrateState(restored, scenario, rules), restored);
  assert.equal(source.food, 1000, "input save remains untouched");
});

test("legacy armies cannot invent supplies or overdraw a source shared by several orders", () => {
  const saved = oldEconomyState();
  const source = saved.cities.find((entry) => entry.id === "jibei");
  Object.assign(source, { food: 400, gold: 170 });
  saved.pendingInvasions = [invasionFrom(source), invasionFrom(source, { id: "second-order" })];
  const restored = migrateState(saved, scenario, rules);
  assert.deepEqual(restored.pendingInvasions.map((order) => order.supplies), [{ food: 360, gold: 150 }, { food: 40, gold: 20 }]);
  const home = restored.cities.find((entry) => entry.id === source.id);
  assert.equal(home.food, 0);
  assert.equal(home.gold, 0);
});

test("already supplied and already resolved orders retain their cargo without another withdrawal", () => {
  const saved = oldEconomyState();
  const source = saved.cities.find((entry) => entry.id === "jibei");
  saved.pendingInvasions = [
    invasionFrom(source, { supplies: { food: 123, gold: 45 } }),
    invasionFrom(source, { id: "empty-cargo", supplies: { food: 0, gold: 0 } }),
    invasionFrom(source, { id: "resolved-order", resolved: true })
  ];
  const restored = migrateState(saved, scenario, rules);
  assert.deepEqual(restored.pendingInvasions, saved.pendingInvasions);
  assert.deepEqual(restored.cities, saved.cities);
});

test("invalid-source and incomplete legacy invasion stubs get zero cargo without taking another city's stores", () => {
  const saved = oldEconomyState();
  const source = saved.cities.find((entry) => entry.id === "jibei");
  saved.pendingInvasions = [
    invasionFrom(source, { sourceId: "missing-city" }),
    invasionFrom(source, { id: "occupied-source", attackerFactionId: "liu-bei" }),
    { id: "stub", resolved: false, troops: 3000 }
  ];
  const restored = migrateState(saved, scenario, rules);
  assert.deepEqual(restored.pendingInvasions.map((order) => order.supplies), Array.from({ length: 3 }, () => ({ food: 0, gold: 0 })));
  assert.deepEqual(restored.cities, saved.cities);
});

test("withdrawing removed commanders also returns their remaining cargo exactly once, including a zero-troop convoy", () => {
  const saved = oldEconomyState();
  const source = saved.cities.find((entry) => entry.id === "jibei");
  Object.assign(source, { food: 500, gold: 200, troops: 2000 });
  const withdrawn = invasionFrom(source, { officerIds: ["bao-xin-you"], troops: 1000, supplies: { food: 123, gold: 45 } });
  saved.pendingInvasions = [withdrawn,
    { ...withdrawn, id: "zero-troops", troops: 0, supplies: { food: 20, gold: 10 } },
    { ...withdrawn, id: "already-resolved", resolved: true }];
  const restored = migrateState(saved, scenario, rules);
  const home = restored.cities.find((entry) => entry.id === source.id);
  assert.deepEqual(restored.pendingInvasions, []);
  assert.equal(home.food, 643);
  assert.equal(home.gold, 255);
  assert.equal(home.troops, 3000);
  assert.deepEqual(migrateState(restored, scenario, rules), restored);
});

test("old economy loads create a recoverable snapshot and repeated reloads never draw supplies twice", (context) => {
  const values = memoryStorage(context);
  const saved = oldEconomyState();
  const source = saved.cities.find((entry) => entry.id === "jibei");
  saved.started = true;
  saved.pendingInvasions = [invasionFrom(source)];
  const key = storageKey(scenario.id);
  const raw = JSON.stringify(saved);
  values.set(key, raw);
  values.set(`${key}:previous`, "previous campaign");
  values.set(`${key}:before-placeholder-cleanup`, "earlier placeholder snapshot");
  const restored = loadState(scenario, rules);
  assert.equal(values.get(`${key}:before-economy-v2`), raw);
  assert.equal(values.get(`${key}:before-placeholder-cleanup`), "earlier placeholder snapshot");
  assert.equal(values.get(`${key}:previous`), "previous campaign");
  assert.equal(values.get(key), JSON.stringify(restored));
  assert.deepEqual(loadState(scenario, rules), restored);
  assert.equal(values.get(`${key}:before-economy-v2`), raw);
});

test("a save needing both upgrades retains both pre-migration snapshots before replacing the active slot", (context) => {
  const values = memoryStorage(context);
  const saved = oldEconomyState();
  saved.officers.push({ id: "bao-xin-you", name: "济北郡丞" });
  const key = storageKey(scenario.id);
  const raw = JSON.stringify(saved);
  values.set(key, raw);
  const restored = loadState(scenario, rules);
  assert.equal(values.get(`${key}:before-placeholder-cleanup`), raw);
  assert.equal(values.get(`${key}:before-economy-v2`), raw);
  assert.equal(values.get(key), JSON.stringify(restored));
});

test("failed economy backup or active-slot writes preserve the original save and return the campaign progress", async (context) => {
  for (const failureAt of ["backup", "active"]) {
    await context.test(failureAt, (child) => {
      const values = memoryStorage(child);
      const saved = oldEconomyState();
      Object.assign(saved, { started: true, year: 204, month: 8, commandsRemaining: 1, lastHarvestYear: 204 });
      const source = saved.cities.find((entry) => entry.id === "jibei");
      saved.pendingInvasions = [invasionFrom(source)];
      const raw = JSON.stringify(saved);
      const key = storageKey(scenario.id);
      values.set(key, raw);
      localStorage.setItem = (name, value) => {
        if (failureAt === "backup" || name === key) throw new Error("storage full");
        values.set(name, value);
      };
      const restored = loadState(scenario, rules);
      assert.equal(restored.started, true);
      assert.equal(restored.year, 204);
      assert.equal(restored.month, 8);
      assert.equal(restored.commandsRemaining, 1);
      assert.equal(restored.lastHarvestYear, 204);
      assert.equal(restored.economyVersion, 2);
      assert.equal(values.get(key), raw, "failed writes must not replace or erase the old slot");
      assert.deepEqual(loadState(scenario, rules), restored, "a repeated load starts from the same original save, not an already deducted city");
      if (failureAt === "active") assert.equal(values.get(`${key}:before-economy-v2`), raw);
    });
  }
});
