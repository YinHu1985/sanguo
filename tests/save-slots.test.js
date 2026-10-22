import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState, storageKey } from "../src/js/game/state.js";
import { isPlayableSave, listCampaignSaves, loadCampaignSlot, persistCampaignSelection } from "../src/js/game/save-slots.js";
import { saveCardMarkup } from "../src/js/ui/main-menu.js";

const scenario = JSON.parse(await readFile(new URL("../src/data/scenario.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const campaign = (changes = {}) => ({ ...createInitialState(scenario, rules), started: true, ...changes });
const memory = (entries = []) => {
  const values = new Map(entries);
  return { values, getItem: (key) => values.get(key) ?? null,
    setItem: () => { throw new Error("Save browsing must be read-only"); } };
};
const writableMemory = (entries = [], beforeWrite = () => {}) => {
  const values = new Map(entries);
  const writes = [];
  return { values, writes, getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { beforeWrite("set", key, value); writes.push(["set", key]); values.set(key, value); },
    removeItem: (key) => { beforeWrite("remove", key); writes.push(["remove", key]); values.delete(key); } };
};
const activeKey = storageKey(scenario.id);
const previousKey = `${activeKey}:previous`;
const journalKey = `${activeKey}:menu-write-journal`;
const backupKey = `${activeKey}:before-menu-upgrade`;

test("title-screen save discovery has no write, migration, task or time side effects", () => {
  const saved = campaign({ year: 200, month: 7, commandsRemaining: 2, turnResolution: { stage: "tasks", targetTurn: 5 } });
  const raw = JSON.stringify(saved);
  const storage = memory([[storageKey(scenario.id), raw]]);
  const saves = listCampaignSaves(scenario.id, storage);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].year, 200);
  assert.equal(saves[0].month, 7);
  assert.equal(saves[0].commands, 2);
  assert.equal(saves[0].pending, true);
  assert.equal(storage.getItem(storageKey(scenario.id)), raw);
});

test("new campaigns, corrupt saves and other scenarios are not offered as playable slots", () => {
  for (const saved of [createInitialState(scenario, rules), campaign({ scenarioId: "other" }), campaign({ month: 13 }),
    campaign({ cities: [] }), campaign({ factions: [] }), campaign({ officers: null }),
    campaign({ tasks: {} }), campaign({ pendingInvasions: {} }), campaign({ tasks: [null] }),
    campaign({ pendingInvasions: [null] }), campaign({ factions: [null] }), campaign({ officers: [null] }), null]) {
    assert.equal(isPlayableSave(saved, scenario.id), false);
    assert.deepEqual(listCampaignSaves(scenario.id, memory([[storageKey(scenario.id), JSON.stringify(saved)]])), []);
  }
  assert.deepEqual(listCampaignSaves(scenario.id, memory([[storageKey(scenario.id), "{broken"]])), []);
  assert.deepEqual(listCampaignSaves(scenario.id, { getItem: () => { throw new Error("unavailable"); } }), []);
});

test("a damaged slot cannot prevent other slots or the title menu from being listed", () => {
  const storage = memory([[activeKey, JSON.stringify(campaign({ tasks: {} }))], [previousKey, JSON.stringify(campaign({ year: 199 }))]]);
  assert.deepEqual(listCampaignSaves(scenario.id, storage).map((save) => save.id), ["previous"]);
});

test("active, prior-campaign and matching legacy saves can be selected independently", () => {
  const storage = memory([
    [storageKey(scenario.id), JSON.stringify(campaign({ year: 199 }))],
    [`${storageKey(scenario.id)}:previous`, JSON.stringify(campaign({ year: 198 }))],
    ["hanmo-zhoujun-save-v1", JSON.stringify(campaign({ year: 197 }))]
  ]);
  assert.deepEqual(listCampaignSaves(scenario.id, storage).map((save) => save.id), ["active", "previous", "legacy"]);
  assert.equal(loadCampaignSlot("active", scenario, rules, storage).year, 199);
  assert.equal(loadCampaignSlot("previous", scenario, rules, storage).year, 198);
  assert.equal(loadCampaignSlot("legacy", scenario, rules, storage).year, 197);
  assert.equal(JSON.parse(storage.getItem(storageKey(scenario.id))).year, 199);
  assert.throws(() => loadCampaignSlot("arbitrary-key", scenario, rules, storage), /不可读取/);
});

test("choosing a saved checkpoint preserves tasks and balances without settling it", () => {
  const saved = campaign({ elapsedMonths: 3, tasks: [{ id: "order", kind: "march", status: "awaiting_battle", officerIds: [] }],
    turnResolution: { stage: "tasks", targetTurn: 4 }, monthlySettlementRead: { [scenario.playerFactionId]: 2 } });
  const storage = memory([[storageKey(scenario.id), JSON.stringify(saved)]]);
  const restored = loadCampaignSlot("active", scenario, rules, storage);
  assert.deepEqual(restored.tasks, saved.tasks);
  assert.deepEqual(restored.turnResolution, saved.turnResolution);
  assert.equal(restored.month, saved.month);
  assert.equal(restored.cities[0].gold, saved.cities[0].gold);
  assert.deepEqual(restored.monthlySettlementRead, saved.monthlySettlementRead);
});

test("a save removed after discovery cannot silently create a fresh campaign", () => {
  const storage = memory([[storageKey(scenario.id), JSON.stringify(campaign())]]);
  assert.equal(listCampaignSaves(scenario.id, storage).length, 1);
  storage.values.clear();
  assert.throws(() => loadCampaignSlot("active", scenario, rules, storage), /不可读取/);
});

test("save cards escape stored display names and distinguish suspended monthly work", () => {
  const html = saveCardMarkup({ id: "active", label: "自动存档", factionName: '<img src=x onerror="alert(1)">',
    year: 196, month: 11, cities: 6, commands: 3, pending: true }, true);
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
  assert.match(html, /checked/);
  assert.match(html, /月结尚未完成/);
});

test("startup presents a title scene and resumes work only after an explicit menu choice", async () => {
  const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  const init = app.slice(app.indexOf("async function init()"), app.indexOf("function showMainMenu()"));
  assert.match(init, /state = createInitialState\(scenario, rules\)/);
  assert.match(init, /showMainMenu\(\)/);
  assert.doesNotMatch(init, /await (?:continueMonthResolution|processReadyTaskBattles|announceTurnOpening)\(/);
  const opening = app.slice(app.indexOf("async function announceTurnOpening()"), app.indexOf("async function continueMonthResolution()"));
  assert.match(opening, /await taskUI\.showSettlement\(report\)/);
  assert.ok(opening.indexOf("await showStoryDialog") < opening.indexOf("pendingMonthlySettlement(state)"));
  assert.doesNotMatch(opening, /lastTurnOpening === stamp\) return/);
  const loading = app.slice(app.indexOf("async function loadFromMenu("), app.indexOf("function setMapReading("));
  assert.match(loading, /persistCampaignSelection\(loaded, \{ archiveCurrent: slotId !== "active" \}\)/);
  assert.ok(loading.indexOf("persistCampaignSelection(") < loading.indexOf("state = loaded"));
  assert.ok(loading.indexOf("state = loaded") < loading.indexOf("enterGame()"));
  const starting = app.slice(app.indexOf("async function startCampaign("), app.indexOf("async function showBattle("));
  assert.match(starting, /const nextState = createInitialState\(scenario, rules\)/);
  assert.match(starting, /persistCampaignSelection\(nextState, \{ archiveCurrent: true \}\)/);
  assert.ok(starting.indexOf("persistCampaignSelection(") < starting.indexOf("state = nextState"));
  assert.doesNotMatch(starting, /state = createInitialState|archiveState\(/);
});

test("ordinary identical reads create no writes or migration backup, including reordered object keys", () => {
  const saved = campaign();
  const raw = JSON.stringify(saved);
  const storage = writableMemory([[activeKey, raw]]);
  const next = loadCampaignSlot("active", scenario, rules, storage);
  const reordered = Object.fromEntries(Object.entries(next).reverse());
  assert.deepEqual(persistCampaignSelection(reordered, {}, storage), { ok: true, changed: false, archived: false, backupCreated: false });
  assert.equal(storage.getItem(activeKey), raw);
  assert.deepEqual(storage.writes, []);
});

test("menu migration preserves the exact original active record in a non-overwriting backup", () => {
  const saved = campaign();
  delete saved.taskVersion;
  delete saved.armyVersion;
  const raw = JSON.stringify(saved, null, 2);
  const storage = writableMemory([[activeKey, raw]]);
  const next = loadCampaignSlot("active", scenario, rules, storage);
  const result = persistCampaignSelection(next, {}, storage);
  assert.equal(result.backupCreated, true);
  assert.equal(storage.getItem(backupKey), raw);
  assert.equal(JSON.parse(storage.getItem(activeKey)).taskVersion, 1);
  assert.equal(JSON.parse(storage.getItem(activeKey)).armyVersion, 1);
  assert.equal(storage.getItem(journalKey), null);
  next.month = next.month % 12 + 1;
  persistCampaignSelection(next, {}, storage);
  assert.equal(storage.getItem(backupKey), raw, "the first raw upgrade snapshot must never be overwritten");
});

test("restoring previous swaps exact original active bytes while protecting an upgraded source", () => {
  const original = JSON.stringify(campaign({ year: 200 }), null, 2);
  const old = campaign({ year: 199 });
  delete old.armyVersion;
  const previous = JSON.stringify(old, null, 2);
  const storage = writableMemory([[activeKey, original], [previousKey, previous]]);
  const loaded = loadCampaignSlot("previous", scenario, rules, storage);
  const result = persistCampaignSelection(loaded, { archiveCurrent: true }, storage);
  assert.equal(result.archived, true);
  assert.equal(JSON.parse(storage.getItem(activeKey)).year, 199);
  assert.equal(storage.getItem(previousKey), original);
  assert.equal(storage.getItem(backupKey), previous);
  assert.equal(storage.getItem(journalKey), null);
});

test("failure while writing selected previous restores both original slots, not two copies of active", () => {
  const original = JSON.stringify(campaign({ year: 200 }));
  const previous = JSON.stringify(campaign({ year: 199 }));
  const storage = writableMemory([[activeKey, original], [previousKey, previous]], (operation, key) => {
    if (operation === "set" && key === activeKey) throw new Error("QuotaExceeded");
  });
  const loaded = loadCampaignSlot("previous", scenario, rules, storage);
  assert.throws(() => persistCampaignSelection(loaded, { archiveCurrent: true }, storage), /原有存档与快照已恢复/);
  assert.equal(storage.getItem(activeKey), original);
  assert.equal(storage.getItem(previousKey), previous);
  assert.equal(storage.getItem(journalKey), null);
});

test("failure to establish a recovery journal cannot overwrite any existing slot", () => {
  const original = JSON.stringify(campaign({ year: 200 }));
  const previous = JSON.stringify(campaign({ year: 199 }));
  const storage = writableMemory([[activeKey, original], [previousKey, previous]], (operation, key) => {
    if (operation === "set" && key === journalKey) throw new Error("QuotaExceeded");
  });
  assert.throws(() => persistCampaignSelection(campaign(), { archiveCurrent: true }, storage), /未改动现有存档/);
  assert.equal(storage.getItem(activeKey), original);
  assert.equal(storage.getItem(previousKey), previous);
  assert.deepEqual(storage.writes, []);
});

test("failure to preserve an upgrade backup aborts before replacing the old active save", () => {
  const saved = campaign();
  delete saved.taskVersion;
  const original = JSON.stringify(saved);
  const storage = writableMemory([[activeKey, original]], (operation, key) => {
    if (operation === "set" && key === backupKey) throw new Error("QuotaExceeded");
  });
  const loaded = loadCampaignSlot("active", scenario, rules, storage);
  assert.throws(() => persistCampaignSelection(loaded, {}, storage), /已恢复/);
  assert.equal(storage.getItem(activeKey), original);
  assert.equal(storage.getItem(backupKey), null);
  assert.equal(storage.getItem(journalKey), null);
});

test("a cleanup failure is not reported as success and leaves journal-backed original slots", () => {
  const original = JSON.stringify(campaign({ year: 200 }));
  const previous = JSON.stringify(campaign({ year: 199 }));
  const storage = writableMemory([[activeKey, original], [previousKey, previous]], (operation, key) => {
    if (operation === "remove" && key === journalKey) throw new Error("storage unavailable");
  });
  const loaded = loadCampaignSlot("previous", scenario, rules, storage);
  assert.throws(() => persistCampaignSelection(loaded, { archiveCurrent: true }, storage), /恢复记录已保留/);
  assert.equal(storage.getItem(activeKey), original);
  assert.equal(storage.getItem(previousKey), previous);
  assert.ok(storage.getItem(journalKey));
  assert.deepEqual(listCampaignSaves(scenario.id, storage).map((save) => save.year), [200, 199]);
});

test("failed rollback leaves a readable recovery journal and a later retry restores before writing", () => {
  const original = JSON.stringify(campaign({ year: 200 }));
  const previous = JSON.stringify(campaign({ year: 199 }));
  let failing = true;
  const storage = writableMemory([[activeKey, original], [previousKey, previous]], (operation, key, value) => {
    if (!failing || operation !== "set") return;
    if (key === activeKey || key === previousKey && value === previous) throw new Error("storage temporarily unavailable");
  });
  const loaded = loadCampaignSlot("previous", scenario, rules, storage);
  assert.throws(() => persistCampaignSelection(loaded, { archiveCurrent: true }, storage), /恢复记录已保留/);
  assert.equal(storage.getItem(previousKey), original, "the failed physical slot remains recoverable via the journal");
  const journal = JSON.parse(storage.getItem(journalKey));
  assert.equal(journal.activeRaw, original);
  assert.equal(journal.previousRaw, previous);
  const writesBeforeBrowsing = storage.writes.length;
  assert.deepEqual(listCampaignSaves(scenario.id, storage).map((save) => save.year), [200, 199]);
  assert.equal(loadCampaignSlot("previous", scenario, rules, storage).year, 199);
  assert.equal(storage.writes.length, writesBeforeBrowsing, "title and load inspection remain read-only during recovery");
  failing = false;
  assert.equal(persistCampaignSelection(loaded, { archiveCurrent: true }, storage).ok, true);
  assert.equal(JSON.parse(storage.getItem(activeKey)).year, 199);
  assert.equal(storage.getItem(previousKey), original);
  assert.equal(storage.getItem(journalKey), null);
});

test("a write interrupted before journal cleanup rolls back before a new selection", () => {
  const original = JSON.stringify(campaign({ year: 200 }));
  const previous = JSON.stringify(campaign({ year: 199 }));
  const halfWritten = JSON.stringify(campaign({ year: 198 }));
  const journal = JSON.stringify({ version: 1, scenarioId: scenario.id, activeRaw: original, previousRaw: previous });
  const storage = writableMemory([[activeKey, halfWritten], [previousKey, original], [journalKey, journal]]);
  const loaded = loadCampaignSlot("active", scenario, rules, storage);
  assert.equal(loaded.year, 200);
  persistCampaignSelection(loaded, {}, storage);
  assert.equal(storage.getItem(activeKey), original);
  assert.equal(storage.getItem(previousKey), previous);
  assert.equal(storage.getItem(journalKey), null);
});

test("failed initial active write removes the newly created archive and leaves legacy untouched", () => {
  const legacy = JSON.stringify(campaign({ year: 199 }));
  const storage = writableMemory([["hanmo-zhoujun-save-v1", legacy]], (operation, key) => {
    if (operation === "set" && key === activeKey) throw new Error("QuotaExceeded");
  });
  assert.throws(() => persistCampaignSelection(campaign(), { archiveCurrent: true }, storage), /已恢复/);
  assert.equal(storage.getItem(activeKey), null);
  assert.equal(storage.getItem(previousKey), null);
  assert.equal(storage.getItem("hanmo-zhoujun-save-v1"), legacy);
  assert.equal(storage.getItem(journalKey), null);
});

test("new campaigns can archive a matching legacy source without changing legacy storage", () => {
  const legacy = JSON.stringify(campaign({ year: 199 }));
  const storage = writableMemory([["hanmo-zhoujun-save-v1", legacy]]);
  const next = campaign();
  const before = structuredClone(next);
  persistCampaignSelection(next, { archiveCurrent: true }, storage);
  assert.equal(storage.getItem(previousKey), legacy);
  assert.equal(storage.getItem("hanmo-zhoujun-save-v1"), legacy);
  assert.deepEqual(next, before, "persistence must not change the caller's draft state");
  assert.equal(storage.getItem(backupKey), null);
});

test("invalid next states and damaged recovery metadata never overwrite recoverable data", () => {
  const original = JSON.stringify(campaign({ year: 200 }));
  const storage = writableMemory([[activeKey, original]]);
  assert.throws(() => persistCampaignSelection(campaign({ tasks: {} }), {}, storage), /数据无效/);
  assert.equal(storage.getItem(activeKey), original);
  storage.values.set(journalKey, "{damaged");
  assert.throws(() => persistCampaignSelection(campaign(), {}, storage), /恢复记录/);
  assert.equal(storage.getItem(journalKey), "{damaged");
  assert.equal(storage.getItem(activeKey), original);
  assert.deepEqual(storage.writes, []);
});
