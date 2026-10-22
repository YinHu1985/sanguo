import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState, storageKey } from "../src/js/game/state.js";
import { listCampaignSaves, listManualSaveSlots, loadCampaignSlot, persistCampaignSelection, saveManualSlot } from "../src/js/game/save-slots.js";

const scenario = JSON.parse(await readFile(new URL("../src/data/scenario.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const campaign = (changes = {}) => ({ ...createInitialState(scenario, rules), started: true, ...changes });
const activeKey = storageKey(scenario.id);
const manualKey = (number) => `${activeKey}:manual-${number}`;
const memory = (entries = [], beforeWrite = () => {}) => {
  const values = new Map(entries);
  const writes = [];
  return { values, writes, getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { beforeWrite(key, value); values.set(key, value); writes.push([key, value]); },
    removeItem: (key) => { values.delete(key); writes.push([key, null]); } };
};

test("manual slot discovery always offers three independent slots without writes", () => {
  const storage = memory();
  assert.deepEqual(listManualSaveSlots(scenario.id, storage), [1, 2, 3].map((number) => ({
    id: `manual-${number}`, label: `手动存档 ${number}`, empty: true, invalid: false
  })));
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(listCampaignSaves(scenario.id, storage), []);
});

test("saving a manual snapshot changes only its slot and never mutates the campaign", () => {
  const entries = [[activeKey, JSON.stringify(campaign({ year: 199 }))],
    [`${activeKey}:previous`, JSON.stringify(campaign({ year: 198 }))],
    [manualKey(1), JSON.stringify(campaign({ year: 197 }))],
    [manualKey(3), JSON.stringify(campaign({ year: 200 }))]];
  const storage = memory(entries);
  const state = campaign({ year: 201, month: 7, commandsRemaining: 3 });
  const before = structuredClone(state);
  assert.deepEqual(saveManualSlot("manual-2", state, storage), { ok: true, slotId: "manual-2" });
  assert.deepEqual(state, before);
  assert.equal(storage.getItem(manualKey(2)), JSON.stringify(before));
  assert.deepEqual(storage.writes.map(([key]) => key), [manualKey(2)]);
  for (const [key, value] of entries) assert.equal(storage.getItem(key), value);
  state.month = 8;
  assert.equal(JSON.parse(storage.getItem(manualKey(2))).month, 7, "snapshot is not a live state reference");
});

test("manual summaries and campaign selection include all valid manual saves", () => {
  const saved = campaign({ year: 202, month: 3, commandsRemaining: 4 });
  const storage = memory([[manualKey(1), JSON.stringify(saved)]]);
  const [summary, empty] = listManualSaveSlots(scenario.id, storage);
  assert.equal(summary.id, "manual-1");
  assert.equal(summary.empty, false);
  assert.equal(summary.invalid, false);
  assert.equal(summary.factionName, saved.factions.find((item) => item.id === saved.playerFactionId).name);
  assert.equal(summary.year, 202);
  assert.equal(summary.month, 3);
  assert.equal(summary.commands, 4);
  assert.equal(summary.cities, saved.cities.filter((item) => item.factionId === saved.playerFactionId).length);
  assert.equal(summary.pending, false);
  assert.equal(empty.empty, true);
  const { empty: ignoredEmpty, invalid: ignoredInvalid, ...campaignSummary } = summary;
  assert.deepEqual(listCampaignSaves(scenario.id, storage), [campaignSummary]);
  assert.deepEqual(storage.writes, []);
});

test("damaged and wrong-scenario manual records are disclosed but never offered for loading", () => {
  const unrelatedRaw = JSON.stringify(campaign({ scenarioId: "other" }));
  const storage = memory([[manualKey(1), "{broken"], [manualKey(2), unrelatedRaw]]);
  const slots = listManualSaveSlots(scenario.id, storage);
  assert.deepEqual(slots.map(({ empty, invalid }) => ({ empty, invalid })), [
    { empty: true, invalid: true }, { empty: true, invalid: true }, { empty: true, invalid: false }
  ]);
  assert.deepEqual(listCampaignSaves(scenario.id, storage), []);
  assert.throws(() => loadCampaignSlot("manual-1", scenario, rules, storage), /不可读取/);
  saveManualSlot("manual-1", campaign(), storage);
  assert.equal(listManualSaveSlots(scenario.id, storage)[0].invalid, false);
  assert.equal(storage.getItem(manualKey(2)), unrelatedRaw);
});

test("manual slots are readable even when the unrelated automatic-save journal is damaged", () => {
  const raw = JSON.stringify(campaign({ year: 203 }));
  const storage = memory([[manualKey(3), raw], [`${activeKey}:menu-write-journal`, "{damaged"]]);
  assert.equal(listManualSaveSlots(scenario.id, storage)[2].year, 203);
  assert.deepEqual(listCampaignSaves(scenario.id, storage).map((save) => save.id), ["manual-3"]);
  assert.equal(loadCampaignSlot("manual-3", scenario, rules, storage).year, 203);
  saveManualSlot("manual-2", campaign(), storage);
  assert.equal(storage.getItem(`${activeKey}:menu-write-journal`), "{damaged");
  assert.equal(storage.getItem(manualKey(3)), raw);
  assert.deepEqual(storage.writes.map(([key]) => key), [manualKey(2)]);
});

test("manual loading migrates a copy and preserves exact source bytes for the upgrade backup", () => {
  const old = campaign({ year: 199 });
  delete old.armyVersion;
  delete old.taskVersion;
  const raw = JSON.stringify(old, null, 2);
  const activeRaw = JSON.stringify(campaign({ year: 205 }));
  const storage = memory([[manualKey(2), raw], [activeKey, activeRaw]]);
  const loaded = loadCampaignSlot("manual-2", scenario, rules, storage);
  assert.equal(loaded.year, 199);
  assert.equal(loaded.armyVersion, 1);
  assert.equal(loaded.taskVersion, 1);
  assert.equal(storage.getItem(manualKey(2)), raw);
  assert.deepEqual(storage.writes, [], "inspection does not commit the migration");
  const result = persistCampaignSelection(loaded, { archiveCurrent: true }, storage);
  assert.equal(result.backupCreated, true);
  assert.equal(storage.getItem(`${activeKey}:before-menu-upgrade`), raw);
  assert.equal(storage.getItem(`${activeKey}:previous`), activeRaw);
  assert.equal(storage.getItem(manualKey(2)), raw);
  assert.equal(JSON.parse(storage.getItem(activeKey)).year, 199);
});

test("a confirmed overwrite replaces only the selected manual record in one atomic write", () => {
  const storage = memory([[manualKey(1), JSON.stringify(campaign({ year: 197 }))]]);
  saveManualSlot("manual-1", campaign({ year: 200 }), storage);
  assert.equal(JSON.parse(storage.getItem(manualKey(1))).year, 200);
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.values.size, 1, "no journal or separate metadata is needed");
});

test("quota or unavailable-storage failures preserve the old manual record without touching other slots", () => {
  for (const cause of [new Error("QuotaExceededError"), new Error("SecurityError")]) {
    const old = JSON.stringify(campaign({ year: 199 }));
    const active = JSON.stringify(campaign({ year: 200 }));
    const storage = memory([[manualKey(1), old], [activeKey, active]], () => { throw cause; });
    assert.throws(() => saveManualSlot("manual-1", campaign(), storage), /手动存档写入失败.*原有存档未改动/);
    assert.equal(storage.getItem(manualKey(1)), old);
    assert.equal(storage.getItem(activeKey), active);
    assert.deepEqual(storage.writes, []);
  }
});

test("invalid slot IDs cannot target automatic saves, snapshots or arbitrary browser data", () => {
  const storage = memory();
  for (const id of ["active", "previous", "legacy", "manual-0", "manual-4", manualKey(1), null, undefined]) {
    assert.throws(() => saveManualSlot(id, campaign(), storage), /无效的手动存档位置/);
  }
  assert.deepEqual(storage.writes, []);
});

test("invalid or unstarted campaigns cannot replace a manual snapshot", () => {
  const raw = JSON.stringify(campaign());
  const storage = memory([[manualKey(1), raw]]);
  for (const state of [null, createInitialState(scenario, rules), campaign({ scenarioId: "" }),
    campaign({ month: 13 }), campaign({ cities: [] }), campaign({ tasks: {} }), campaign({ pendingInvasions: [null] })]) {
    assert.throws(() => saveManualSlot("manual-1", state, storage), /数据无效/);
  }
  assert.equal(storage.getItem(manualKey(1)), raw);
  assert.deepEqual(storage.writes, []);
});

test("manual saves reject unfinished month resolution, ready battles and unresolved invasions", () => {
  const storage = memory();
  for (const changes of [{ turnResolution: { stage: "tasks" } }, { turnResolution: { stage: "opening" } },
    { tasks: [{ id: "march", status: "awaiting_battle" }] },
    { pendingInvasions: [{ id: "invasion", resolved: false }] },
    { pendingInvasions: [{ id: "invasion" }] }]) {
    assert.throws(() => saveManualSlot("manual-1", campaign(changes), storage), /回合结算或待处理战斗/);
  }
  assert.deepEqual(storage.writes, []);
});

test("ordinary running tasks and already-resolved invasions remain safe manual checkpoints", () => {
  const state = campaign({ tasks: [{ id: "build", status: "running", remainingTurns: 2 }],
    pendingInvasions: [{ id: "old-invasion", resolved: true }] });
  const storage = memory();
  saveManualSlot("manual-3", state, storage);
  const restored = loadCampaignSlot("manual-3", scenario, rules, storage);
  assert.deepEqual(restored.tasks, state.tasks);
  assert.deepEqual(restored.pendingInvasions, state.pendingInvasions);
  assert.equal(restored.month, state.month);
  assert.equal(listManualSaveSlots(scenario.id, storage)[2].pending, false);
});

test("serialization failures never alter the prior snapshot", () => {
  const raw = JSON.stringify(campaign({ year: 198 }));
  const storage = memory([[manualKey(1), raw]]);
  const circular = campaign();
  circular.self = circular;
  assert.throws(() => saveManualSlot("manual-1", circular, storage), /无法序列化/);
  assert.throws(() => saveManualSlot("manual-1", campaign({ extra: 1n }), storage), /无法序列化/);
  assert.throws(() => saveManualSlot("manual-1", campaign({ toJSON: () => null }), storage), /无法安全保存/);
  assert.equal(storage.getItem(manualKey(1)), raw);
  assert.deepEqual(storage.writes, []);
});

test("unavailable manual storage produces damaged-slot hints without throwing from the menu", () => {
  const storage = { getItem: () => { throw new Error("SecurityError"); } };
  const slots = listManualSaveSlots(scenario.id, storage);
  assert.equal(slots.length, 3);
  assert.ok(slots.every((slot) => slot.empty && slot.invalid));
  assert.deepEqual(listCampaignSaves(scenario.id, storage), []);
});
