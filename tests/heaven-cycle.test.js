import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeHeavenCycle, heavenCycleStatus, recordHeavenOutcome, advanceHeavenCycle, transferCityOwnership } from "../src/js/game/heaven-cycle.js";
import { resolveOccupation } from "../src/js/game/campaign.js";
import { executeStratagem } from "../src/js/game/stratagems.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const person = (id, factionId, locationCityId, extra = {}) => ({ id, name: id, factionId, locationCityId,
  status: "active", rank: "大将", war: 80, leadership: 80, intelligence: 80, politics: 80, charm: 100, merit: 0, acted: false, ...extra });
const city = (id, factionId, officerIds, adjacent, extra = {}) => ({ id, name: id, factionId, officerIds, adjacent,
  governorId: officerIds[0] ?? null, troops: factionId === "a" ? 10000 : 1000, gold: 5000, food: 20000,
  agriculture: 60, commerce: 60, popularSupport: 70, training: 80, morale: 80, ...extra });
const fixture = () => ({ year: 196, month: 11, elapsedMonths: 0, playerFactionId: "a", commandsMax: 8, commandsRemaining: 8,
  eventLog: [], factions: [{ id: "a", name: "甲", lord: "a-lord" }, { id: "b", name: "乙", lord: "b-lord" }, { id: "c", name: "丙" }, { id: "neutral", name: "空城" }],
  cities: [city("a1", "a", ["a-lord", "a-aide"], ["a2", "b1"]), city("a2", "a", [], ["a1"]),
    city("b1", "b", ["b-lord"], ["a1", "b2"]), city("b2", "b", ["b-aide"], ["b1"])],
  officers: [person("a-lord", "a", "a1", { rank: "君主" }), person("a-aide", "a", "a1"),
    person("b-lord", "b", "b1", { rank: "君主" }), person("b-aide", "b", "b2")] });
const faction = (state, id = "a") => state.factions.find((entry) => entry.id === id);

test("legacy and damaged cycle records normalize without inventing historical wins", () => {
  for (const saved of [undefined, null, [], 10, { phase: "bad", strength: 5 }]) {
    const entry = { id: "a", researchPoints: 432, heavenCycle: saved };
    assert.deepEqual(normalizeHeavenCycle(entry), { phase: "neutral", strength: 0, lastReason: "" });
    assert.equal(entry.researchPoints, 432);
    assert.equal(heavenCycleStatus(entry, rules).multiplier, 1);
  }
  for (const strength of [NaN, Infinity, -5, "5", 1.5]) {
    const entry = { id: "a", heavenCycle: { phase: "victory", strength, lastReason: {} } };
    assert.deepEqual(normalizeHeavenCycle(entry), { phase: "victory", strength: 1, lastReason: "" });
  }
  const neutral = { id: "neutral", heavenCycle: { phase: "defeat", strength: 6 } };
  assert.equal(normalizeHeavenCycle(neutral).phase, "neutral");
});

test("heaven status is pure and neutral factions have no income modifier", () => {
  const entry = { id: "a" }, before = structuredClone(entry);
  const status = heavenCycleStatus(entry, rules);
  assert.deepEqual(entry, before);
  assert.equal(status.phase, "neutral"); assert.equal(status.progress, 0);
  assert.equal(status.multiplier, 1); assert.equal(status.label, "天意未动");
  assert.equal(heavenCycleStatus(undefined).multiplier, 1);
});

test("same-side events strengthen the cycle and opposite events immediately replace it", () => {
  const state = fixture();
  for (let step = 1; step <= 6; step++) {
    recordHeavenOutcome(state, "a", "win", { reason: `取得城池${step}` });
    const status = heavenCycleStatus(faction(state), rules);
    assert.equal(status.strength, step); assert.equal(status.multiplier, Number((1 - 0.1 * step).toFixed(6)));
    assert.equal(status.angle, 180 + 30 * step);
  }
  assert.equal(heavenCycleStatus(faction(state), rules).label, "骄兵必败");
  recordHeavenOutcome(state, "a", "loss", { reason: "失去城池" });
  assert.deepEqual(faction(state).heavenCycle, { phase: "defeat", strength: 1, lastReason: "失去城池" });
  assert.equal(heavenCycleStatus(faction(state), rules).multiplier, 1.1);
  assert.equal(heavenCycleStatus(faction(state), rules).angle, 30);
  for (let i = 0; i < 5; i++) recordHeavenOutcome(state, "a", "defeat");
  assert.equal(heavenCycleStatus(faction(state), rules).multiplier, 1.6);
  assert.equal(heavenCycleStatus(faction(state), rules).label, "哀兵必胜");
  recordHeavenOutcome(state, "a", "victory");
  assert.equal(heavenCycleStatus(faction(state), rules).multiplier, 0.9);
});

test("monthly progression only strengthens an existing cycle and income limits remain bounded", () => {
  const state = fixture(), entry = faction(state);
  assert.equal(advanceHeavenCycle(entry, rules).phase, "neutral");
  for (const outcome of ["victory", "defeat"]) {
    recordHeavenOutcome(state, "a", outcome);
    assert.equal(advanceHeavenCycle(entry, rules).strength, 2);
    for (let i = 0; i < 40; i++) {
      recordHeavenOutcome(state, "a", outcome);
      advanceHeavenCycle(entry, rules);
    }
    const status = heavenCycleStatus(entry, rules);
    assert.equal(status.strength, 6); assert.equal(status.progress, 1);
    assert.equal(status.multiplier, outcome === "victory" ? 0.4 : 1.6);
  }
});

test("balance configuration controls monthly steps and modifiers independently of stored counters", () => {
  const state = fixture(), entry = faction(state);
  const config = { research: { heavenCycle: { maxStrength: 10, monthlyStrengthGain: 2, victoryPenaltyPerStrength: .05, defeatBonusPerStrength: .02 } } };
  recordHeavenOutcome(state, "a", "win");
  assert.equal(advanceHeavenCycle(entry, config).strength, 3);
  assert.equal(heavenCycleStatus(entry, config).multiplier, .85);
  for (let i = 0; i < 20; i++) recordHeavenOutcome(state, "a", "win");
  assert.equal(heavenCycleStatus(entry, config).multiplier, .5);
  assert.equal(heavenCycleStatus(entry, rules).multiplier, .4);
  recordHeavenOutcome(state, "a", "loss");
  assert.equal(advanceHeavenCycle(entry, config).multiplier, 1.06);
  const damaged = { research: { heavenCycle: { maxStrength: NaN, monthlyStrengthGain: -5, victoryPenaltyPerStrength: Infinity, defeatBonusPerStrength: -1 } } };
  assert.equal(advanceHeavenCycle(entry, damaged).strength, 4);
  assert.equal(heavenCycleStatus(entry, damaged).multiplier, 1.4);
});

test("invalid events and neutral ownership do not create cycle state", () => {
  const state = fixture(), before = structuredClone(state);
  for (const id of ["missing", "neutral", undefined]) assert.equal(recordHeavenOutcome(state, id, "win"), null);
  for (const event of [undefined, "unknown", "toString", "__proto__"]) assert.equal(recordHeavenOutcome(state, "a", event), null);
  assert.deepEqual(state, before);
});

test("ownership changes count exactly once for both factions, including AI opponents", () => {
  const state = fixture(), target = state.cities[2];
  assert.equal(transferCityOwnership(state, target, "c").changed, true);
  assert.equal(faction(state, "c").heavenCycle.phase, "victory");
  assert.equal(faction(state, "b").heavenCycle.phase, "defeat");
  assert.equal(faction(state).heavenCycle, undefined);
  const before = structuredClone(state);
  assert.equal(transferCityOwnership(state, target, "c").changed, false);
  assert.equal(transferCityOwnership(state, target, undefined).changed, false);
  assert.deepEqual(state, before);
});

test("occupying a neutral city gives only the new owner a win", () => {
  const state = fixture();
  Object.assign(state.cities[2], { factionId: "neutral", officerIds: [], troops: 0 });
  const result = resolveOccupation(state, { sourceId: "a1", targetId: "b1", officerIds: ["a-aide"], troops: 1000 });
  assert.equal(result.ok, true); assert.equal(faction(state).heavenCycle.strength, 1);
  assert.equal(faction(state, "neutral").heavenCycle, undefined);
  assert.equal(faction(state, "b").heavenCycle, undefined);
});

test("actual occupations record a win and a loss, while failed repeats remain atomic", () => {
  for (const playerFactionId of ["a", "c"]) {
    const state = fixture(); state.playerFactionId = playerFactionId;
    const input = { sourceId: "a1", targetId: "b1", officerIds: ["a-aide"], troops: 1000 };
    assert.equal(resolveOccupation(state, input).ok, true);
    assert.equal(faction(state).heavenCycle.phase, "victory");
    assert.equal(faction(state, "b").heavenCycle.phase, "defeat");
    const before = structuredClone(state);
    assert.equal(resolveOccupation(state, input).ok, false); assert.deepEqual(state, before);
  }
  const invalid = fixture(), before = structuredClone(invalid);
  assert.equal(resolveOccupation(invalid, { sourceId: "a1", targetId: "b1", officerIds: ["missing"], troops: 1000 }).ok, false);
  assert.deepEqual(invalid, before);
});

test("multi-city surrender counts each city for winner and loser, including the last city", () => {
  const state = fixture();
  const result = executeStratagem(state, "a1", "b1", "a-lord", "surrender", rules, {}, () => 0);
  assert.equal(result.ok, true); assert.equal(result.success, true);
  assert.deepEqual(result.affectedCityIds, ["b1", "b2"]);
  assert.equal(faction(state).heavenCycle.strength, 2);
  assert.deepEqual(faction(state, "b").heavenCycle, { phase: "defeat", strength: 2, lastReason: "失去b2" });
  assert.equal(state.cities.some((entry) => entry.factionId === "b"), false);
});

test("failed surrender and discarded partial annexation drafts never change fate", () => {
  const state = fixture();
  assert.equal(executeStratagem(state, "a1", "b1", "a-lord", "surrender", rules, {}, () => 1).success, false);
  assert.equal(faction(state).heavenCycle, undefined); assert.equal(faction(state, "b").heavenCycle, undefined);
  const invalid = fixture();
  invalid.pendingInvasions = [{ id: "bad", sourceId: "b1", targetId: "a1", attackerFactionId: "b", defenderFactionId: "a",
    troops: 100, officerIds: ["b-lord"], supplies: { food: -1, gold: 0 }, training: 70, morale: 60 }];
  const before = structuredClone(invalid);
  assert.equal(executeStratagem(invalid, "a1", "b1", "a-lord", "surrender", rules, {}, () => 0).ok, false);
  assert.deepEqual(invalid, before);
});

test("task preview does not award phantom wins; committed surrender awards once", () => {
  const state = fixture();
  assert.equal(queueTask(state, { kind: "stratagem", cityId: "a1", officerIds: ["a-lord"], payload: { action: "surrender", targetId: "b1" } }, rules).ok, true);
  assert.equal(faction(state).heavenCycle, undefined); assert.equal(faction(state, "b").heavenCycle, undefined);
  assert.equal(settleTasks(state, rules, { targetTurn: 1, rng: () => 0 }).completed.length, 1);
  assert.equal(faction(state).heavenCycle.strength, 2); assert.equal(faction(state, "b").heavenCycle.strength, 2);
  const before = structuredClone(state);
  settleTasks(state, rules, { targetTurn: 1, rng: () => 0 }); assert.deepEqual(state, before);
});
