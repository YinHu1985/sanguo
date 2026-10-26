import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState, migrateState } from "../src/js/game/state.js";
import { enableOfficerPlay, playerOfficer, officerCity, syncPlayerIdentity } from "../src/js/game/character-state.js";
import { capability, playerRole, canControlUnit, canControlArmy, participatesInBattle, isAIManagedCity, checkRequirements } from "../src/js/game/capabilities.js";
import { calculateModified, resolveValue } from "../src/js/game/modifiers.js";
import { performPersonalAction, previewPersonalWork, buildPersonalExpedition, expeditionOptions, DUTIES } from "../src/js/game/personal.js";
import { currentAssignment, refreshPersonalAssignments } from "../src/js/game/personal-assignments.js";
import { createPersonalUI } from "../src/js/ui/personal-view.js";
import { taskCounts, personalTaskRecords } from "../src/js/ui/task-windows.js";
import { emitDomainEvent } from "../src/js/game/domain-events.js";
import { queueTask, settleTasks, DUTY_MANDATE } from "../src/js/game/tasks.js";
import { advanceMonth, previewDomestic } from "../src/js/game/rules.js";
import { runWorldTurn, getCampaignStatus } from "../src/js/game/campaign.js";
import { unlockTechnology } from "../src/js/game/technology.js";
import { enableWarCampaigns, ensureTaskBattle, getBattleEngine, checkpointBattle, advanceBattleMonths } from "../src/js/game/war-campaigns.js";
import { simulateBattleMonth } from "../src/js/game/battle-simulation.js";
import { needsAutomaticBattleAction, runAutomaticBattleStep } from "../src/js/ui/battle-automation.js";
import { aggregateAbilities } from "../src/js/game/army.js";
import { applyAtlasToScenario } from "../src/js/game/atlas.js";

const read = name => readFile(new URL(`../src/data/${name}.json`, import.meta.url), "utf8").then(JSON.parse);
const rules = await read("rules"); rules.character = await read("character-system");
const scenario = applyAtlasToScenario(await read("scenario"), await read("strategic-atlas"));
const map = { width: 12, height: 8, terrain: Array(96).fill("plain"), attackerStarts: [{ x: 0, y: 2 }, { x: 0, y: 4 }], defenderStarts: [{ x: 11, y: 2 }], stronghold: { x: 11, y: 4 } };
function setup(id = "guan-yu") {
  const state = createInitialState(scenario, rules); state.started = true;
  enableWarCampaigns(state, map); enableOfficerPlay(state, rules, id);
  const city = officerCity(state); city.gold = 10000; city.food = 100000; city.troops = 15000;
  return state;
}
const perform = (state, action, payload = {}) => performPersonalAction(state, action, payload, rules);

test("modifier pipeline has stable stacking, scopes, same-kind maximum, trace and no input mutation", () => {
  const effects = [
    { id: "flat", source: "a", operation: "flat", value: 10 },
    { id: "percent", source: "b", operation: "percent", value: .2 },
    { id: "book", source: "c", operation: "flat", value: 3, exclusiveGroup: "books" },
    { id: "book", source: "d", operation: "flat", value: 5, exclusiveGroup: "books" },
    { id: "weather", source: "e", operation: "multiply", value: .5, when: { weather: "rain" } }
  ];
  const before = structuredClone(effects);
  const result = calculateModified(100, effects, { weather: "rain" });
  assert.equal(result.value, 69); assert.equal(result.trace.length, 4);
  assert.equal(calculateModified(100, effects.toReversed(), { weather: "rain" }).value, 69);
  assert.deepEqual(effects, before);
});

test("shared faction effects are not repeated per actor; inactive skill slots have no effects", () => {
  const state = setup(), officer = playerOfficer(state), city = officerCity(state);
  state.factions.find(f => f.id === state.playerFactionId).modifiers = [{ id: "farm", target: "domestic.gain", operation: "percent", value: .5 }];
  officer.skills = ["domestic.1"];
  assert.equal(resolveValue(state, "domestic.gain", 10, { factionId: state.playerFactionId, officerIds: [officer.id, officer.id] }).value, 15);
  const before = JSON.stringify(state);
  const noFaction = previewDomestic("agriculture", [officer], city, rules);
  assert.ok(previewDomestic("agriculture", [officer], city, rules, state).gain > noFaction.gain);
  assert.equal(JSON.stringify(state), before);
});

test("treasures automatically modify effective abilities and same category chooses highest", () => {
  const state = setup(), officer = playerOfficer(state); officer.war = 60;
  officer.treasures = [2, 5].map(value => ({ id: `sword${value}`, modifiers: [{ id: "war", target: "ability.war", operation: "flat", value, exclusiveGroup: "weapon" }] }));
  assert.equal(aggregateAbilities([officer]).war, 65); assert.equal(officer.war, 60);
});

test("requirement query supports future grants and fails closed for unknown conditions", () => {
  assert.equal(checkRequirements([{ type: "grant", id: "elephant" }], { grants: ["elephant"] }).ok, true);
  assert.equal(checkRequirements([{ type: "new-rule", id: "x" }]).ok, false);
});

test("ordinary officers cannot issue government or policy mutations; governors stay local; ruler commands cost no AP", () => {
  const state = setup(), city = officerCity(state);
  const order = { kind: "domestic", cityId: city.id, officerIds: ["liu-bei"], payload: { action: "agriculture" } };
  assert.equal(playerRole(state), "officer"); assert.equal(queueTask(state, order, rules).ok, false);
  assert.equal(unlockTechnology(state, state.playerFactionId, Object.keys(rules.technologies)[0], rules).ok, false);
  city.governorId = state.playerOfficerId;
  assert.equal(playerRole(state), "governor"); assert.equal(capability(state, "government", { cityId: city.id }).ok, true);
  assert.equal(capability(state, "government", { cityId: "xu-chang" }).ok, false);
  assert.equal(capability(state, "government", { cityId: city.id, kind: "governor" }).ok, false);
  enableOfficerPlay(state, rules, "liu-bei");
  const ap = state.personal.ap; assert.equal(queueTask(state, order, rules).ok, true); assert.equal(state.personal.ap, ap);
});

test("personal training is immediate, accumulates growth, exhausts AP but not public-duty opportunity", () => {
  const state = setup(), before = playerOfficer(state).politics;
  for (let i = 0; i < 4; i++) assert.equal(perform(state, "train", { ability: "politics" }).ok, true);
  assert.equal(state.personal.ap, 0); assert.equal(playerOfficer(state).politics, before + 1);
  assert.equal(playerOfficer(state).growth.politics, 20); assert.equal(playerOfficer(state).acted, false);
  const snapshot = structuredClone(state);
  assert.equal(perform(state, "work").ok, false); assert.deepEqual(state, snapshot);
});

test("invalid or unfunded requests are atomic and consume neither AP nor private/city resources", () => {
  const state = setup(); officerCity(state).gold = 0;
  const snapshot = structuredClone(state);
  assert.equal(perform(state, "request", { duty: "agriculture" }).ok, false);
  assert.deepEqual(state, snapshot);
  assert.equal(perform(state, "train", { ability: "bogus" }).ok, false); assert.deepEqual(state, snapshot);
});

test("request → personal work over months → report → save/reload has exactly-once rewards", () => {
  let state = setup(); const before = playerOfficer(state).merit, ap = state.personal.ap, cityGold = officerCity(state).gold;
  const result = perform(state, "request", { duty: "agriculture" });
  assert.equal(result.ok, true, result.message); assert.equal(state.personal.ap, ap - 10);
  assert.equal(taskCounts(state).active, 1);
  assert.equal(playerOfficer(state).taskId, undefined);
  assert.equal(officerCity(state).gold, cityGold - result.task.reward);
  assert.equal(playerOfficer(state).growth.politics, 0);
  assert.equal(perform(state, "cityWork", { project: "agriculture" }).ok, true);
  assert.equal(currentAssignment(state).status, "active");
  const progress = currentAssignment(state).progress;
  state = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  assert.equal(currentAssignment(state).progress, progress);
  advanceMonth(state, rules); assert.equal(state.personal.ap, 100);
  assert.equal(perform(state, "cityWork", { project: "agriculture" }).ok, true);
  assert.equal(currentAssignment(state).status, "ready");
  state.personal.ap = 0;
  const gold = state.personal.gold, reward = currentAssignment(state).reward;
  assert.equal(perform(state, "report").ok, true);
  assert.equal(taskCounts(state).active, 0); assert.equal(taskCounts(state).completed, 1);
  assert.equal(personalTaskRecords(state).completed[0].status, "completed");
  assert.equal(state.personal.gold, gold + reward); assert.equal(playerOfficer(state).merit, before + 60);
  assert.equal(playerOfficer(state).growth.politics, 75);
  state = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  const completed = structuredClone(state);
  assert.equal(perform(state, "report").ok, false); assert.deepEqual(state, completed);
  const savedAP = state.personal.ap = 17;
  state = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules); assert.equal(state.personal.ap, savedAP);
});

for (const project of Object.keys(DUTIES)) test(`personal ${project} uses only private gold/AP, immediate shared effects, and is repeatable`, () => {
  const state = setup(), city = officerCity(state);
  city.gold = 0; city.food = 0; city.defense = 40;
  state.personal.gold = 3000;
  state.commandLimitEnabled = true; state.commandsRemaining = 0;
  const before = structuredClone(state), preview = previewPersonalWork(state, project, rules);
  assert.equal(preview.ok, true, preview.message);
  const result = perform(state, "cityWork", { project }); assert.equal(result.ok, true, result.message);
  assert.equal(state.personal.gold, 3000 - preview.expense); assert.equal(state.personal.ap, 75);
  assert.equal(officerCity(state).gold, 0); assert.equal(officerCity(state).food, 0);
  assert.equal(state.commandsRemaining, 0); assert.equal(playerOfficer(state).acted, false);
  assert.equal(state.tasks.length, before.tasks.length);
  assert.equal(playerOfficer(state).growth[preview.ability], 20);
  const key = project === "recruit" ? "troops" : preview.targetKey;
  assert.ok(officerCity(state)[key] > before.cities.find(c => c.id === city.id)[key]);
  assert.equal(perform(state, "cityWork", { project }).ok, true);
});

test("unaffordable, invalid, maxed, battle-locked and foreign personal work is atomic", () => {
  const cases = [
    state => { state.personal.gold = 0; },
    state => { state.personal.ap = 0; },
    state => { officerCity(state).agriculture = 100; },
    state => { playerOfficer(state).battleId = "active-war"; },
    state => { playerOfficer(state).taskId = "public-task"; },
    state => { officerCity(state).factionId = "neutral"; },
    state => { playerOfficer(state).status = "free"; }
  ];
  for (const change of cases) {
    const state = setup(); change(state); const before = structuredClone(state);
    assert.equal(perform(state, "cityWork", { project: "agriculture" }).ok, false);
    assert.deepEqual(state, before);
  }
  const state = setup(), before = structuredClone(state);
  assert.equal(perform(state, "cityWork", { project: "march" }).ok, false); assert.deepEqual(state, before);
});

test("assignment counts only matching personal contributions and never auto-completes at month end", () => {
  const state = setup();
  assert.equal(perform(state, "request", { duty: "agriculture" }).ok, true);
  const before = structuredClone(state);
  assert.equal(perform(state, "request", { duty: "commerce" }).ok, false); assert.deepEqual(state, before);
  assert.equal(perform(state, "cityWork", { project: "commerce" }).ok, true);
  assert.equal(currentAssignment(state).progress, 0);
  settleTasks(state, rules); advanceMonth(state, rules);
  assert.equal(currentAssignment(state).status, "active"); assert.equal(currentAssignment(state).progress, 0);
});

test("expired and employer-invalidated assignments refund reserved reward exactly once", () => {
  for (const reason of ["expiry", "captured", "city-lost"]) {
    let state = setup();
    assert.equal(perform(state, "request", { duty: "agriculture" }).ok, true);
    const task = currentAssignment(state), reward = task.reward, gold = state.personal.gold;
    if (reason === "expiry") state.elapsedMonths = task.deadlineTurn;
    if (reason === "captured") playerOfficer(state).status = "captured";
    if (reason === "city-lost") officerCity(state).factionId = "cao";
    const employerGold = state.cities.filter(c => c.factionId === task.factionId).reduce((n,c) => n + c.gold, 0);
    const hasTreasury = state.cities.some(c => c.factionId === task.factionId);
    refreshPersonalAssignments(state);
    assert.equal(currentAssignment(state), undefined); assert.equal(state.personal.gold, gold);
    assert.equal(state.personal.assignments[0].reservedGold, 0);
    assert.equal(state.cities.filter(c => c.factionId === task.factionId).reduce((n,c) => n + c.gold, 0), employerGold + (hasTreasury ? reward : 0));
    const snapshot = structuredClone(state); refreshPersonalAssignments(state); assert.deepEqual(state, snapshot);
    state = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
    refreshPersonalAssignments(state); assert.equal(state.personal.gold, gold);
  }
});

test("private money migration preserves zero and supplies defaults for old saves", () => {
  const state = setup(); state.personal.gold = 0; enableOfficerPlay(state, rules); assert.equal(state.personal.gold, 0);
  delete state.personal.gold; delete state.personal.assignments; enableOfficerPlay(state, rules);
  assert.equal(state.personal.gold, rules.character.startingGold); assert.deepEqual(state.personal.assignments, []);
});

test("wall assignments credit real remaining work and do not overstate the final upgrade", () => {
  const state = setup(), city = officerCity(state);
  city.wallLevel = 2; city.wallProgress = 99; city.defense = 100;
  const preview = previewPersonalWork(state, "buildWall", rules);
  assert.equal(preview.progress, 1); assert.equal(preview.remaining, 1);
  assert.equal(perform(state, "request", { duty: "buildWall" }).ok, true);
  assert.equal(currentAssignment(state).target, 1);
  assert.equal(perform(state, "cityWork", { project: "buildWall" }).ok, true);
  assert.equal(officerCity(state).wallLevel, 3); assert.equal(currentAssignment(state).status, "ready");
  const before = structuredClone(state);
  assert.equal(perform(state, "cityWork", { project: "buildWall" }).ok, false); assert.deepEqual(state, before);
});

test("personal profile passes the actual officer record; camp has work, not expedition", async () => {
  const state = setup(); let profile, click;
  const root = { style: { setProperty() {} }, querySelectorAll: () => [{ dataset: { place: "profile" }, addEventListener: (name, cb) => { click = cb; } }] };
  const previous = globalThis.document;
  try {
    globalThis.document = { baseURI: "http://127.0.0.1/", querySelector: () => root };
    const ui = createPersonalUI({ getState: () => state, rules, themes: { themes: { central: { image: "scene.svg" } }, regionThemes: {} }, onProfile: value => { profile = value; } });
    ui.render(); await click();
    assert.equal(profile, playerOfficer(state)); assert.ok(profile.name); assert.ok(Number.isFinite(profile.leadership));
    assert.deepEqual(rules.character.locations.find(p => p.id === "camp").projects, ["recruit", "train"]);
    assert.ok(root.innerHTML.includes('data-place="workshop"'));
    assert.ok(root.innerHTML.includes('personal-civic'));
    assert.ok(root.innerHTML.includes('personal-life'));
    assert.ok(!root.innerHTML.includes('data-place="journal"'));
    const life = root.innerHTML.match(/<nav class="personal-locations personal-life"[^]*?<\/nav>/)[0];
    assert.match(life, /data-place="home"/); assert.match(life, /data-place="visit"/); assert.match(life, /data-place="tavern"/);
    assert.doesNotMatch(life, /data-place="travel"/);
    assert.ok(root.innerHTML.includes('data-place="month"'));
    assert.ok(!root.innerHTML.includes('personal-stats'));
    assert.ok(!root.innerHTML.includes('<progress'));
    assert.equal(ui.requestExpedition, undefined);
    assert.equal(typeof ui.showJournal, "function");
  } finally { globalThis.document = previous; }
});

test("visits make symmetric relationships and tavern work earns only private money", () => {
  const state = setup(), cityGold = officerCity(state).gold;
  assert.equal(perform(state, "visit", { officerId: "liu-bei" }).ok, true);
  assert.equal(playerOfficer(state).relationships["liu-bei"], 10);
  assert.equal(state.officers.find(o => o.id === "liu-bei").relationships["guan-yu"], 10);
  assert.equal(perform(state, "work").ok, true); assert.equal(state.personal.gold, 240); assert.equal(officerCity(state).gold, cityGold);
});

test("accepted public work remains with its employer after the protagonist is captured", () => {
  const state = setup("liu-bei"), city = officerCity(state);
  const queued = queueTask(state, { kind: "domestic", cityId: city.id, officerIds: ["guan-yu"], payload: { action: "agriculture" } }, rules);
  assert.equal(queued.ok, true);
  const agriculture = city.agriculture, gold = city.gold;
  playerOfficer(state).status = "captured"; syncPlayerIdentity(state);
  assert.equal(state.playerFactionId, "neutral");
  assert.equal(settleTasks(state, rules).completed.length, 1);
  assert.equal(state.playerFactionId, "neutral");
  assert.ok(state.cities.find(c => c.id === city.id).agriculture > agriculture);
  assert.equal(state.cities.find(c => c.id === city.id).gold, gold);
});

test("old campaign converts to its real lord without resetting the world", () => {
  const state = createInitialState(scenario, rules); state.month = 8; state.cities[0].gold = 123;
  enableOfficerPlay(state, rules); assert.equal(state.playerOfficerId, "liu-bei");
  assert.equal(state.month, 8); assert.equal(state.cities[0].gold, 123);
});

test("AI administers the ordinary protagonist's faction but never spends their duty opportunity", () => {
  const state = setup(); const city = officerCity(state); city.agriculture = 10;
  assert.equal(isAIManagedCity(state, city), true);
  runWorldTurn(state, rules, () => 1);
  assert.equal(playerOfficer(state).acted, false); assert.equal(playerOfficer(state).locationCityId, city.id);
  assert.ok(city.agriculture > 10 || city.troops > 15000);
});

function launchPersonal(state) {
  const city = officerCity(state), targetId = expeditionOptions(state, rules)[0]?.id;
  const expedition = buildPersonalExpedition(state, targetId, rules); assert.equal(expedition.ok, true, expedition.message);
  const target = state.cities.find(c => c.id === targetId); target.troops = 2000; target.food = 60000;
  // Fixture: an already approved military order, not a personal "join" action.
  const result = queueTask(state, expedition.order, rules, DUTY_MANDATE); assert.equal(result.ok, true, result.message);
  assert.equal(state.personal.ap, 100);
  assert.ok(officerCity(state).troops < 15000); assert.equal(playerOfficer(state).taskId, result.task.id);
  settleTasks(state, rules);
  const created = ensureTaskBattle(state, result.task.id, rules, map, { targetTurn: 1 });
  assert.equal(created.ok, true, created.message); return created.record;
}

test("a military order reserves city forces; player controls only own unit and friendly AI uses same engine", () => {
  const state = setup(), record = launchPersonal(state);
  const { battle } = getBattleEngine(state, record.id, rules, { targetTurn: 1 });
  assert.equal(participatesInBattle(state, record), true); assert.equal(canControlArmy(battle), false);
  const friendly = battle.units.filter(u => u.side === battle.playerSide);
  assert.equal(friendly.filter(u => canControlUnit(battle, u)).length, 1);
  for (let i = 0; i < 80 && battle.status === "active" && battle.phase === "field"; i++) {
    if (canControlUnit(battle)) {
      assert.equal(needsAutomaticBattleAction(battle), battle.hasForcedAction());
      battle.wait();
    } else {
      assert.equal(needsAutomaticBattleAction(battle), true);
      assert.equal(runAutomaticBattleStep(battle).ok, true);
    }
  }
  const commander = record.commanders.ally;
  checkpointBattle(state, record.id, battle, { targetTurn: 1 });
  const restored = migrateState(JSON.parse(JSON.stringify(state)), scenario, rules);
  if (record.status !== "ended") {
    const reopened = getBattleEngine(restored, record.id, rules, { targetTurn: 1 });
    assert.equal(canControlArmy(reopened.battle), false); assert.equal(restored.battles[0].commanders.ally, commander);
  }
});

test("removed enlistment action cannot issue an expedition or spend personal resources", () => {
  const state = setup(), before = structuredClone(state);
  assert.equal(perform(state, "join", { targetId: expeditionOptions(state, rules)[0]?.id }).ok, false);
  assert.deepEqual(state, before);
});

test("commander identity does not change when first unit is defeated; battle event rewards only once", () => {
  const state = setup(), record = launchPersonal(state);
  const { battle } = getBattleEngine(state, record.id, rules, { targetTurn: 1 });
  const general = battle.units.find(u => u.officerIds.includes(record.commanders.ally)); general.troops = 0; general.composition = {};
  assert.equal(canControlArmy(battle), false);
  const before = playerOfficer(state).merit;
  battle.retreatArmy(); const saved = checkpointBattle(state, record.id, battle, { targetTurn: 1 }); assert.equal(saved.ok, true, saved.message);
  assert.equal(playerOfficer(state).merit, before + 80);
  assert.equal(emitDomainEvent(state, { id: `battle:${record.id}:completed`, type: "battle.completed", officerIds: [state.playerOfficerId] }), false);
  assert.equal(playerOfficer(state).merit, before + 80);
});

test("nonparticipating friendly wars run headlessly, participating war stays available to player", () => {
  const state = setup(), record = launchPersonal(state);
  assert.equal(advanceBattleMonths(state, rules, { targetTurn: 1 }).ok, true);
  assert.equal(record.lastProcessedTurn, 0);
  state.playerOfficerId = "mi-zhu";
  assert.equal(participatesInBattle(state, record), false);
  assert.equal(advanceBattleMonths(state, rules, { targetTurn: 1 }).ok, true);
  assert.ok(record.lastProcessedTurn >= 1 || record.status === "ended");
});

test("loss of faction does not end a personal career; free officer can enter new service", () => {
  const state = setup(); const city = officerCity(state);
  for (const c of state.cities) if (c.factionId === state.playerFactionId) c.factionId = "cao";
  // Choose an actual surviving faction rather than synthesize a person.
  city.factionId = state.factions.find(f => f.id !== state.playerFactionId && f.id !== "neutral").id;
  syncPlayerIdentity(state); assert.equal(playerRole(state), "free"); assert.equal(getCampaignStatus(state).status, "active");
  assert.equal(perform(state, "serve").ok, true); assert.equal(playerOfficer(state).factionId, city.factionId);
});

test("skill layout contains 48 normal and two hidden stable slots", () => {
  assert.equal(rules.character.skillGroups.filter(g => !g.hidden).reduce((n,g) => n + g.names.length, 0), 48);
  assert.equal(rules.character.skillGroups.filter(g => g.hidden).reduce((n,g) => n + g.names.length, 0), 2);
});
