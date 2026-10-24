import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { archiveState, createInitialState, loadState, migrateState, saveState, storageKey } from "../src/js/game/state.js";
import { loadCampaignSlot, persistCampaignSelection, saveManualSlot } from "../src/js/game/save-slots.js";
import { heavenCycleStatus, recordHeavenOutcome } from "../src/js/game/heaven-cycle.js";
import { advanceMonth } from "../src/js/game/rules.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const sourceScenario = JSON.parse(await readFile(new URL("../src/data/scenario.json", import.meta.url), "utf8"));
const scenario = { ...sourceScenario, factions: [...sourceScenario.factions.filter((entry) => entry.id !== "neutral"), { id: "neutral", name: "无主" }] };
const campaign = () => ({ ...createInitialState(scenario, rules), started: true });
const cycles = (state) => state.factions.map((entry) => ({ id: entry.id, heavenCycle: structuredClone(entry.heavenCycle) }));
const memory = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};
function installStorage(context) {
  const storage = memory(), original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  context.after(() => original ? Object.defineProperty(globalThis, "localStorage", original) : delete globalThis.localStorage);
  return storage;
}
function variedCampaign() {
  const state = campaign();
  const entries = [
    { phase: "victory", strength: 4, lastReason: "研习「军制整饬」" },
    { phase: "defeat", strength: 3, lastReason: "失去许昌" },
    { phase: "neutral", strength: 0, lastReason: "旧存档的显式中立状态" },
    { phase: "victory", strength: 12, lastReason: "连续胜利的完整事件计数" }
  ];
  state.factions.filter((entry) => entry.id !== "neutral").slice(0, entries.length)
    .forEach((entry, index) => { entry.heavenCycle = entries[index]; });
  return state;
}

test("new campaigns start every actual faction at victory strength one, without a synthetic event", () => {
  const untouchedScenario = structuredClone(scenario), state = campaign();
  for (const faction of state.factions) {
    const neutral = faction.id === "neutral";
    assert.deepEqual(faction.heavenCycle, { phase: neutral ? "neutral" : "victory", strength: neutral ? 0 : 1, lastReason: "" });
    const status = heavenCycleStatus(faction, rules);
    assert.equal(status.multiplier, neutral ? 1 : 0.9);
    assert.equal(status.label, neutral ? "天意未动" : "胜兵必骄");
  }
  assert.equal(state.eventLog.length, 1, "only the scenario introduction is logged");
  assert.deepEqual(scenario, untouchedScenario);
  assert.notStrictEqual(state.factions[0].heavenCycle, state.factions[1].heavenCycle, "factions never share mutable momentum");
});

test("old saves without heaven data receive the opening default once, including extra saved factions", () => {
  const old = campaign();
  delete old.policyVersion;
  old.factions.forEach((entry) => { delete entry.heavenCycle; });
  old.factions.push({ id: "saved-only", name: "存档新增势力", researchPoints: 987, unlockedTechnologies: [] });
  const untouched = structuredClone(old), restored = migrateState(old, scenario, rules);
  for (const faction of restored.factions) {
    assert.deepEqual(faction.heavenCycle, { phase: faction.id === "neutral" ? "neutral" : "victory",
      strength: faction.id === "neutral" ? 0 : 1, lastReason: "" });
  }
  assert.equal(restored.factions.at(-1).researchPoints, 987);
  assert.deepEqual(restored.eventLog, untouched.eventLog);
  assert.deepEqual(migrateState(JSON.parse(JSON.stringify(restored)), scenario, rules), restored);
  assert.deepEqual(old, untouched, "migration never edits the original save");
});

test("repeated autosaves and loads preserve explicit phases, progress and reasons exactly", (context) => {
  const storage = installStorage(context);
  let state = variedCampaign();
  const expected = cycles(state), points = state.factions.map((entry) => entry.researchPoints), events = structuredClone(state.eventLog);
  for (let pass = 0; pass < 5; pass++) {
    saveState(state);
    assert.deepEqual(cycles(JSON.parse(storage.getItem(storageKey(scenario.id)))), expected);
    state = loadState(scenario, rules);
    assert.deepEqual(cycles(state), expected);
    assert.deepEqual(state.factions.map((entry) => entry.researchPoints), points);
    assert.deepEqual(state.eventLog, events);
  }
  archiveState(state);
  assert.deepEqual(cycles(loadCampaignSlot("previous", scenario, rules, storage)), expected);
});

test("all manual slots preserve heaven momentum through load and selection without resetting or advancing it", () => {
  const storage = memory();
  const state = variedCampaign(), expected = cycles(state);
  for (let number = 1; number <= 3; number++) {
    const slot = `manual-${number}`;
    saveManualSlot(slot, state, storage);
    const raw = storage.getItem(`${storageKey(scenario.id)}:${slot}`);
    for (let pass = 0; pass < 3; pass++) {
      const loaded = loadCampaignSlot(slot, scenario, rules, storage);
      assert.deepEqual(cycles(loaded), expected);
      persistCampaignSelection(loaded, { archiveCurrent: true }, storage);
      assert.deepEqual(cycles(loadCampaignSlot("active", scenario, rules, storage)), expected);
      assert.equal(storage.getItem(`${storageKey(scenario.id)}:${slot}`), raw, "loading must not rewrite the manual snapshot");
    }
  }
  assert.deepEqual(cycles(state), expected);
});

test("monthly income uses saved momentum once and resumes the next step after reload", (context) => {
  installStorage(context);
  let state = campaign();
  const factionId = state.playerFactionId;
  const faction = () => state.factions.find((entry) => entry.id === factionId);
  const earned = [];
  for (let month = 0; month < 3; month++) {
    const before = faction().researchPoints;
    const report = advanceMonth(state, rules).research.find((entry) => entry.factionId === factionId);
    earned.push(report.gain);
    assert.equal(faction().researchPoints, before + report.gain);
    assert.equal(faction().heavenCycle.strength, month + 2);
    const checkpoint = cycles(state);
    saveState(state);
    state = loadState(scenario, rules);
    assert.deepEqual(cycles(state), checkpoint, "loading never advances the monthly clock");
  }
  assert.deepEqual(earned, [90, 80, 70]);
  recordHeavenOutcome(state, factionId, "defeat", { reason: "失去城池" });
  saveState(state);
  state = loadState(scenario, rules);
  assert.deepEqual(faction().heavenCycle, { phase: "defeat", strength: 1, lastReason: "失去城池" });
  assert.equal(advanceMonth(state, rules).research.find((entry) => entry.factionId === factionId).gain, 110);
  assert.deepEqual(faction().heavenCycle, { phase: "defeat", strength: 2, lastReason: "失去城池" });
  saveState(state);
  state = loadState(scenario, rules);
  assert.equal(advanceMonth(state, rules).research.find((entry) => entry.factionId === factionId).gain, 120);
});
