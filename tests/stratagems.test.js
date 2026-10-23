import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { STRATAGEM_ACTIONS, activeAmbushPreparation, executeStratagem, getStratagemConfig, previewStratagem } from "../src/js/game/stratagems.js";
import { employCandidates, executeEmploy, previewEmploy } from "../src/js/game/campaign.js";
import { queueTask, settleTasks } from "../src/js/game/tasks.js";
import { createInitialState, migrateState } from "../src/js/game/state.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const scenario = JSON.parse(await readFile(new URL("../src/data/scenario.json", import.meta.url), "utf8"));
const person = (id, factionId, locationCityId, extra = {}) => ({ id, name: id, factionId, locationCityId,
  status: "active", rank: "大将", war: 90, leadership: 90, intelligence: 90, politics: 90, charm: 90,
  loyalty: 55, merit: 0, acted: false, discovered: true, ...extra });
const city = (id, factionId, officerIds, adjacent, extra = {}) => ({ id, name: id, factionId, officerIds, adjacent,
  governorId: officerIds[0] ?? null, troops: 10000, gold: 5000, food: 20000, horses: 500, crossbows: 400, armor: 300,
  agriculture: 60, commerce: 60, popularSupport: 70, training: 80, morale: 80, ...extra });
const fixture = () => ({ year: 196, month: 6, elapsedMonths: 0, playerFactionId: "a", commandsMax: 8, commandsRemaining: 8, eventLog: [],
  factions: [{ id: "a", name: "甲", lord: "lord" }, { id: "b", name: "乙", lord: "enemyLord" }, { id: "c", name: "丙" }, { id: "neutral", name: "空城" }],
  cities: [city("a1", "a", ["lord", "aide", "third"], ["a2", "b1"]), city("a2", "a", [], ["a1", "b2"]),
    city("b1", "b", ["enemy", "enemyLord"], ["a1", "b2"], { troops: 3000 }), city("b2", "b", [], ["a2", "b1"], { troops: 1000 }),
    city("c1", "c", ["other"], ["b1"]), city("neutral", "neutral", [], ["a1"], { troops: 0 })],
  officers: [person("lord", "a", "a1", { rank: "君主" }), person("aide", "a", "a1"), person("third", "a", "a1"),
    person("enemy", "b", "b1"), person("enemyLord", "b", "b1", { rank: "君主" }), person("other", "c", "c1")] });
const c = (state, id = "a1") => state.cities.find((entry) => entry.id === id);
const o = (state, id = "lord") => state.officers.find((entry) => entry.id === id);
const order = (action, actor = "lord", targetId = action === "prepareAmbush" ? "a1" : "b1", extra = {}) => ({
  kind: "stratagem", cityId: "a1", officerIds: [actor], payload: { action, targetId, ...extra } });
const invoke = (state, action, options = {}, rng = () => 0) => executeStratagem(state, "a1", action === "prepareAmbush" ? "a1" : "b1", "lord", action, rules, options, rng);
const stores = (state) => Object.fromEntries(["troops", "food", "gold", "horses", "crossbows", "armor"].map((key) => [key,
  state.cities.reduce((sum, entry) => sum + (entry[key] ?? 0), 0) + (state.pendingInvasions ?? []).filter((entry) => !entry.resolved).reduce((sum, entry) =>
    sum + (key === "troops" ? entry.troops : ["food", "gold"].includes(key) ? entry.supplies?.[key] ?? 0 : entry.equipment?.[key] ?? 0), 0)]));

test("stratagem catalog exposes safe previews before the user selects a city or officer", () => {
  const state = fixture(), before = structuredClone(state);
  assert.deepEqual(STRATAGEM_ACTIONS, ["rumor", "discord", "surrender", "prepareAmbush"]);
  for (const action of STRATAGEM_ACTIONS) {
    assert.ok(getStratagemConfig(rules)[action].cost > 0);
    assert.equal(previewStratagem(state, undefined, undefined, undefined, action, rules).ok, false);
  }
  assert.equal(previewStratagem(state, "a1", "b1", "lord", "unknown", rules).ok, false);
  assert.deepEqual(state, before);
});

test("rumor spends money and one command, clamps support and morale, and failure still pays", () => {
  for (const success of [true, false]) {
    const state = fixture();
    Object.assign(c(state, "b1"), { popularSupport: 5, morale: 5 });
    const result = invoke(state, "rumor", {}, () => success ? 0 : 1);
    assert.equal(result.ok, true); assert.equal(result.success, success);
    assert.equal(c(state).gold, 4850); assert.equal(state.commandsRemaining, 7);
    assert.equal(o(state).acted, true); assert.equal(o(state).merit, 30);
    assert.equal(c(state, "b1").popularSupport, success ? 0 : 5);
    assert.equal(c(state, "b1").morale, success ? 0 : 5);
  }
});

test("discord lowers only a resident non-lord's loyalty and refuses self, neutral and allied targets", () => {
  const state = fixture();
  o(state, "enemy").loyalty = 5;
  assert.equal(invoke(state, "discord", { targetOfficerId: "enemy" }).success, true);
  assert.equal(o(state, "enemy").loyalty, 0); assert.equal(o(state, "enemyLord").loyalty, 55);
  for (const alter of [s => { c(s, "b1").factionId = "a"; }, s => { c(s, "b1").factionId = "neutral"; },
    s => { s.relations = { "a|b": { allianceUntil: 99999 } }; }, s => { o(s, "enemy").rank = "君主"; },
    s => { o(s, "enemy").locationCityId = "b2"; }, s => { o(s, "enemy").status = "captured"; }]) {
    const invalid = fixture(); alter(invalid); const before = structuredClone(invalid);
    assert.equal(invoke(invalid, "discord", { targetOfficerId: "enemy" }).ok, false); assert.deepEqual(invalid, before);
  }
});

test("preparation replaces rather than stacks, and validity uses owner and a strict expiry clock", () => {
  const state = fixture();
  const first = invoke(state, "prepareAmbush", { effectiveTurn: 1 });
  assert.equal(first.success, true); assert.equal(c(state).ambushPreparation.expiresTurn, 4);
  assert.equal(activeAmbushPreparation(c(state), { elapsedMonths: 3 }).bonus, .25);
  assert.equal(activeAmbushPreparation(c(state), { elapsedMonths: 4 }), null);
  assert.ok(activeAmbushPreparation(c(state)), "without a clock the helper checks structure and ownership only");
  o(state).acted = false;
  const second = invoke(state, "prepareAmbush", { effectiveTurn: 3 });
  assert.notEqual(first.preparation.id, second.preparation.id); assert.equal(second.preparation.bonus, .25);
  assert.equal(second.preparation.expiresTurn, 6); assert.equal(c(state).gold, 4600);
  for (const corrupt of [{ factionId: "b" }, { expiresTurn: NaN }, { bonus: -1 }, { id: "" }]) {
    assert.equal(activeAmbushPreparation({ ...c(state), ambushPreparation: { ...second.preparation, ...corrupt } }, state), null);
  }
  assert.equal(previewStratagem(state, "a1", "a2", "aide", "prepareAmbush", rules).ok, false);
});

test("stratagem tasks reserve one fee now, apply once next month, and preserve the actor lock", () => {
  const state = fixture(), queued = queueTask(state, order("rumor"), rules);
  assert.equal(queued.ok, true); assert.equal(queued.task.targetFactionId, "b");
  assert.equal(c(state).gold, 4850); assert.equal(c(state, "b1").popularSupport, 70);
  assert.equal(o(state).taskId, queued.taskId);
  assert.equal(settleTasks(state, rules, { targetTurn: 0, rng: () => 0 }).completed.length, 0);
  assert.equal(settleTasks(state, rules, { targetTurn: 1, rng: () => 0 }).completed.length, 1);
  assert.equal(c(state).gold, 4850); assert.equal(c(state, "b1").popularSupport, 58);
  assert.equal(state.commandsRemaining, 7); assert.equal(o(state).taskId, undefined);
  assert.equal(state.tasks[0].reservation.status, "consumed");
  const before = structuredClone(state); settleTasks(state, rules, { targetTurn: 1, rng: () => 0 }); assert.deepEqual(state, before);
});

test("multi-turn preparation starts its lifetime at completion, not at submission", () => {
  const state = fixture(), config = structuredClone(rules);
  config.tasks = { defaultTiming: "turn_end", actions: { stratagem: { timing: "multi_turn", duration: 4 } } };
  assert.equal(queueTask(state, order("prepareAmbush"), config).ok, true);
  assert.equal(c(state).ambushPreparation, undefined);
  assert.equal(settleTasks(state, config, { targetTurn: 4 }).completed.length, 1);
  assert.equal(c(state).ambushPreparation.expiresTurn, 7); assert.equal(c(state).gold, 4800);
});

test("a changed target owner cancels a deferred stratagem and returns its reserved fee", () => {
  const state = fixture(); assert.equal(queueTask(state, order("rumor"), rules).ok, true);
  c(state, "b1").factionId = "c";
  const result = settleTasks(state, rules, { rng: () => 0 });
  assert.equal(result.failed.length, 1); assert.match(result.failed[0].result.message, /换主/);
  assert.equal(c(state).gold, 5000); assert.equal(c(state, "b1").popularSupport, 70);
  assert.equal(state.commandsRemaining, 7); assert.equal(o(state).taskId, undefined);
});

test("surrender rejects strong factions and allies, but accepts an unstaffed faction with no army", () => {
  const state = fixture(); c(state, "b1").troops = 20000;
  assert.equal(invoke(state, "surrender").ok, false);
  c(state, "b1").troops = 0; c(state, "b2").troops = 0;
  state.officers = state.officers.filter((entry) => entry.factionId !== "b");
  for (const entry of state.cities.filter((entry) => entry.factionId === "b")) { entry.officerIds = []; entry.governorId = null; }
  const before = stores(state), count = state.officers.length;
  assert.equal(invoke(state, "surrender").success, true);
  assert.equal(state.officers.length, count); assert.equal(c(state, "b1").factionId, "a");
  assert.deepEqual(stores(state), { ...before, gold: before.gold - 500 });
  const allied = fixture(); allied.relations = { "a|b": { allianceUntil: 99999 } };
  assert.equal(invoke(allied, "surrender").ok, false);
});

test("successful surrender joins every city and active officer, transfers prisoners, and never duplicates stores", () => {
  const state = fixture();
  state.officers.push(person("prisoner", null, "b2", { status: "captured", captorFactionId: "b" }));
  c(state, "b1").ambushPreparation = { id: "old", factionId: "b", expiresTurn: 3, bonus: .25 };
  const before = stores(state), count = state.officers.length;
  const result = invoke(state, "surrender");
  assert.equal(result.success, true); assert.deepEqual(result.affectedCityIds, ["b1", "b2"]);
  assert.equal(c(state, "b1").governorId, "enemy"); assert.equal(c(state, "b1").ambushPreparation, undefined);
  assert.equal(o(state, "enemyLord").rank, "大将"); assert.equal(o(state, "enemyLord").factionId, "a");
  assert.equal(o(state, "prisoner").status, "captured"); assert.equal(o(state, "prisoner").captorFactionId, "a");
  assert.equal(state.officers.length, count); assert.deepEqual(stores(state), { ...before, gold: before.gold - 500 });
  for (const id of ["enemy", "enemyLord"]) assert.equal(state.cities.reduce((n, entry) => n + entry.officerIds.filter((other) => other === id).length, 0), 1);
  assert.equal(invoke(state, "surrender").ok, false);
});

test("unsuccessful surrender charges its full fee without transferring any city or officer", () => {
  const state = fixture(), before = stores(state);
  assert.equal(invoke(state, "surrender", {}, () => 1).success, false);
  assert.equal(c(state, "b1").factionId, "b"); assert.equal(o(state, "enemyLord").rank, "君主");
  assert.deepEqual(stores(state), { ...before, gold: before.gold - 500 });
});

function reserveInvasion(state, id, sourceId, targetId, troops = 1000, equipment = { horses: 100, crossbows: 50, armor: 25 }) {
  const source = c(state, sourceId), target = c(state, targetId);
  const invasion = { id, sourceId, targetId, attackerFactionId: source.factionId, defenderFactionId: target.factionId,
    officerIds: [...source.officerIds].slice(0, 1), troops, training: 70, morale: 60, supplies: { food: 200, gold: 100 }, resolved: false };
  source.troops -= troops; source.food -= 200; source.gold -= 100;
  if (equipment) { invasion.equipment = { ...equipment }; for (const [key, value] of Object.entries(equipment)) source[key] -= value; }
  state.pendingInvasions ??= []; state.pendingInvasions.push(invasion);
  return invasion;
}

test("surrender safely recalls armies from either side plus third parties and returns only reserved equipment", () => {
  const state = fixture(), original = stores(state);
  reserveInvasion(state, "own", "a2", "b1"); reserveInvasion(state, "enemy", "b1", "a1");
  reserveInvasion(state, "third", "c1", "b2"); reserveInvasion(state, "legacy", "b2", "c1", 1000, null);
  assert.deepEqual(stores(state), original);
  const result = invoke(state, "surrender");
  assert.equal(result.success, true); assert.equal(result.cancelledInvasionIds.length, 4);
  assert.equal(state.pendingInvasions.length, 0); assert.deepEqual(stores(state), { ...original, gold: original.gold - 500 });
  assert.equal(c(state, "a2").troops, 10000); assert.equal(c(state, "c1").troops, 10000);
  assert.equal(c(state, "b2").horses, 500, "legacy unreserved cavalry never invents horses on return");
});

test("surrender task cost remains reserved even if later peace returns cargo to the same source", () => {
  const state = fixture(), original = stores(state);
  reserveInvasion(state, "own", "a1", "b1");
  assert.equal(queueTask(state, order("surrender", "aide"), rules).ok, true);
  assert.equal(c(state).gold, 4400);
  assert.equal(settleTasks(state, rules, { rng: () => 0 }).completed.length, 1);
  assert.equal(c(state).gold, 4500); assert.deepEqual(stores(state), { ...original, gold: original.gold - 500 });
  assert.equal(state.tasks[0].reservation.status, "consumed"); assert.equal(state.tasks[0].status, "completed");
});

test("malformed returning cargo or detached active officers cannot partially annex a faction", () => {
  for (const corrupt of [s => { reserveInvasion(s, "invalid", "b1", "a1").supplies.food = -1; },
    s => { reserveInvasion(s, "invalid", "b1", "a1").training = NaN; },
    s => { reserveInvasion(s, "invalid", "b1", "a1").morale = 101; },
    s => { reserveInvasion(s, "invalid", "b1", "a1"); c(s, "b1").training = -1; },
    s => { o(s, "enemy").locationCityId = "missing"; }]) {
    const state = fixture(); corrupt(state); const before = structuredClone(state);
    assert.equal(invoke(state, "surrender").ok, false); assert.deepEqual(state, before);
  }
});

test("overflowing preparation completion dates fail atomically and return the task reservation", () => {
  const state = fixture(), before = structuredClone(state);
  assert.equal(invoke(state, "prepareAmbush", { effectiveTurn: Number.MAX_SAFE_INTEGER }).ok, false);
  assert.deepEqual(state, before);
  assert.equal(queueTask(state, order("prepareAmbush"), rules).ok, true);
  assert.equal(settleTasks(state, rules, { targetTurn: Number.MAX_SAFE_INTEGER }).failed.length, 1);
  assert.equal(c(state).gold, 5000); assert.equal(c(state).ambushPreparation, undefined);
  assert.equal(o(state).taskId, undefined); assert.equal(state.tasks[0].reservation.status, "returned");
});

test("later hostile tasks revalidate after surrender and refund without hitting the newly joined cities", () => {
  const state = fixture();
  assert.equal(queueTask(state, order("surrender"), rules).ok, true);
  assert.equal(queueTask(state, order("rumor", "aide"), rules).ok, true);
  assert.equal(queueTask(state, { kind: "march", cityId: "a1", officerIds: ["third"], payload: { targetId: "b1",
    divisions: [{ officerId: "third", troops: 1000, unitType: "infantry" }], supplies: { food: 200, gold: 100 } } }, rules).ok, true);
  const result = settleTasks(state, rules, { rng: () => 0 });
  assert.equal(result.completed.length, 1); assert.equal(result.failed.length, 2); assert.equal(result.battleTask, null);
  assert.equal(c(state).gold, 4500); assert.equal(c(state).troops, 10000); assert.equal(c(state).food, 20000);
  assert.equal(c(state, "b1").popularSupport, 70);
});

test("enemy recruitment moves an acted but idle low-loyalty officer without moving soldiers or stores", () => {
  const state = fixture(), before = stores(state); o(state, "enemy").acted = true;
  assert.deepEqual(employCandidates(state, "a1", rules).map((entry) => entry.id), ["enemy"]);
  assert.equal(previewEmploy(state, "a1", "lord", "enemy", rules).enemyRecruit, true);
  assert.equal(executeEmploy(state, "a1", "lord", "enemy", rules, () => 0).success, true);
  assert.equal(o(state, "enemy").factionId, "a"); assert.equal(o(state, "enemy").locationCityId, "a1");
  assert.equal(o(state, "enemy").loyalty, 75); assert.equal(c(state, "b1").governorId, null);
  assert.equal(c(state, "b1").officerIds.includes("enemy"), false);
  assert.equal(c(state).officerIds.filter((id) => id === "enemy").length, 1);
  assert.deepEqual(stores(state), { ...before, gold: before.gold - rules.personnel.employCost });
});

test("enemy recruitment excludes rulers, allies, high loyalty, non-neighbors, task locks and armies in flight", () => {
  for (const alter of [s => { o(s, "enemy").loyalty = 61; }, s => { o(s, "enemy").rank = "君主"; },
    s => { s.factions[1].lord = "enemy"; }, s => { s.relations = { "a|b": { allianceUntil: 99999 } }; },
    s => { c(s).adjacent = ["a2"]; }, s => { o(s, "enemy").taskId = "busy"; },
    s => { s.tasks = [{ id: "busy", status: "running", officerIds: ["enemy"] }]; },
    s => { reserveInvasion(s, "busy", "b1", "a1"); }]) {
    const state = fixture(); alter(state); const before = structuredClone(state);
    assert.equal(previewEmploy(state, "a1", "lord", "enemy", rules).ok, false);
    assert.equal(employCandidates(state, "a1", rules).some((entry) => entry.id === "enemy"), false);
    assert.equal(executeEmploy(state, "a1", "lord", "enemy", rules, () => 0).ok, false); assert.deepEqual(state, before);
  }
});

test("recruitment probability responds to loyalty and charm; refusal still consumes gift and actor", () => {
  const state = fixture(), base = previewEmploy(state, "a1", "lord", "enemy", rules).chance;
  o(state, "enemy").loyalty = 20;
  assert.ok(previewEmploy(state, "a1", "lord", "enemy", rules).chance > base);
  o(state, "enemy").loyalty = 55; o(state).charm = 30;
  assert.ok(previewEmploy(state, "a1", "lord", "enemy", rules).chance < base);
  assert.equal(executeEmploy(state, "a1", "lord", "enemy", rules, () => 1).success, false);
  assert.equal(o(state, "enemy").factionId, "b"); assert.equal(c(state).gold, 5000 - rules.personnel.employCost);
  assert.equal(o(state).acted, true); assert.equal(state.commandsRemaining, 7);
});

test("deferred enemy recruitment rechecks original allegiance and task locks without charging a stale target", () => {
  for (const change of [s => { o(s, "enemy").factionId = "c"; c(s, "b1").factionId = "c"; },
    s => { o(s, "enemy").taskId = "busy"; }, s => { o(s, "enemy").status = "free"; }]) {
    const state = fixture();
    assert.equal(queueTask(state, { kind: "employ", cityId: "a1", officerIds: ["lord"], payload: { targetId: "enemy" } }, rules).ok, true);
    assert.equal(state.tasks[0].targetOfficerSnapshot.factionId, "b");
    change(state); assert.equal(settleTasks(state, rules, { rng: () => 0 }).failed.length, 1);
    assert.equal(c(state).gold, 5000); assert.equal(c(state).officerIds.includes("enemy"), false);
  }
});

test("an absorbed former ruler is an ordinary general under the new faction, not permanently protected by old lord metadata", () => {
  const state = fixture(); assert.equal(invoke(state, "surrender").success, true);
  state.playerFactionId = "c"; c(state, "c1").adjacent = ["b1"];
  o(state, "enemyLord").loyalty = 20;
  assert.equal(previewEmploy(state, "c1", "other", "enemyLord", rules).ok, true);
});

test("a recruited captured ruler joins as a general without replacing or duplicating the actual lord", () => {
  const state = fixture();
  state.officers.push(person("captiveLord", null, "a1", { status: "captured", rank: "君主", captorFactionId: "a" }));
  state.factions.push({ id: "fallen", lord: "captiveLord" });
  assert.equal(executeEmploy(state, "a1", "lord", "captiveLord", rules, () => 0).success, true);
  assert.equal(o(state, "captiveLord").rank, "大将"); assert.equal(o(state, "captiveLord").factionId, "a");
  assert.equal(state.factions[0].lord, "lord"); assert.equal(o(state).rank, "君主");
});

test("save migration preserves valid preparation and task target snapshots, removing expired or foreign preparations", () => {
  const state = createInitialState(scenario, rules), city = state.cities.find((entry) => entry.factionId === state.playerFactionId);
  state.elapsedMonths = 5;
  city.ambushPreparation = { id: "prepared", factionId: city.factionId, expiresTurn: 8, bonus: .25 };
  state.tasks = [{ id: "saved", kind: "stratagem", status: "completed", officerIds: [], targetFactionId: "b",
    payload: { action: "rumor", targetId: "b1" }, targetOfficerSnapshot: { factionId: "b", status: "active" } }];
  const migrated = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  assert.deepEqual(migrated.cities.find((entry) => entry.id === city.id).ambushPreparation, city.ambushPreparation);
  assert.deepEqual(migrated.tasks, state.tasks);
  for (const update of [{ expiresTurn: 5 }, { factionId: "other" }]) {
    const stale = structuredClone(state); Object.assign(stale.cities.find((entry) => entry.id === city.id).ambushPreparation, update);
    assert.equal(migrateState(stale, scenario, rules).cities.find((entry) => entry.id === city.id).ambushPreparation, undefined);
  }
});
