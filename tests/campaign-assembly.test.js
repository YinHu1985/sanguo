import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runWorldTurn } from "../src/js/game/campaign.js";
import { monthlyFoodCost } from "../src/js/game/economy.js";

const baseRules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const person = (id, locationCityId, extra = {}) => ({ id, name: id, factionId: "ai", locationCityId, status: "active", rank: "从事",
  leadership: 80, war: 80, politics: 80, intelligence: 80, charm: 80, merit: 0, acted: false, ...extra });
const city = (id, factionId, troops, officerIds, adjacent) => ({ id, name: id, factionId, troops, officerIds, adjacent,
  agriculture: 100, commerce: 100, popularSupport: 100, training: 100, morale: 100, wallLevel: 3, defense: 100,
  gold: 5000, food: 100000, governorId: officerIds[0] ?? null, horses: 0, crossbows: 0, armor: 0 });
function fixture() {
  const front = city("front", "ai", 18000, ["front-officer"], ["enemy", "bridge"]);
  const bridge = city("bridge", "ai", 6000, ["bridge-officer"], ["front", "donor"]);
  const donor = city("donor", "ai", 6000, ["lord", "aide"], ["bridge"]);
  const enemy = city("enemy", "player", 40000, ["player-lord"], ["front"]);
  const state = { year: 196, month: 10, elapsedMonths: 8, playerFactionId: "player", commandsRemaining: 6, eventLog: [], pendingInvasions: [],
    factions: [{ id: "ai", name: "邻军" }, { id: "player", name: "我军" }], cities: [front, bridge, donor, enemy],
    officers: [person("front-officer", "front"), person("bridge-officer", "bridge"),
      person("lord", "donor", { rank: "君主", leadership: 100 }), person("aide", "donor"),
      person("player-lord", "enemy", { factionId: "player", rank: "君主" })] };
  return { state, front, bridge, donor, enemy, rules: structuredClone(baseRules), aide: state.officers[3], lord: state.officers[2] };
}
const material = (entry) => Object.fromEntries(["troops", "food", "training", "morale", "horses", "crossbows", "armor"].map((key) => [key, entry[key]]));

test("a full understaffed border may migrate a commander along its friendly route without another troop convoy", () => {
  const { state, front, donor, bridge, rules, aide, lord } = fixture();
  const before = state.cities.map(material);
  const donorGold = donor.gold;
  const report = runWorldTurn(state, rules, () => 0.5);
  assert.equal(aide.locationCityId, "front");
  assert.deepEqual(front.officerIds, ["front-officer", "aide"]);
  assert.deepEqual(donor.officerIds, ["lord"], "the interior city keeps a real officer");
  assert.deepEqual(bridge.officerIds, ["bridge-officer"], "the route's intermediate officer is not moved");
  assert.equal(lord.locationCityId, "donor");
  assert.equal(donor.gold, donorGold - rules.actions.officerTransfer, "officer-only migration pays no nonexistent convoy fee");
  assert.equal(front.gold, 5000);
  assert.equal(aide.acted, true);
  assert.equal(front.assemblyReady, true);
  assert.deepEqual(state.cities.map(material), before, "migration must not conjure or move any soldiers, grain or equipment");
  assert.equal(state.commandsRemaining, 6);
  assert.equal(report.battles.length, 0, "the unchanged attack ratio threshold still rejects an overwhelmingly stronger enemy");
  const snapshot = structuredClone(state);
  runWorldTurn(state, rules, () => 0.5);
  assert.deepEqual(state, snapshot, "a repeated world-turn call cannot migrate or pay twice");
});

test("a nearly full border with less than one minimum convoy of room can also finish commander assembly", () => {
  const { state, front, donor, rules, aide } = fixture();
  front.troops = 17600;
  const troops = donor.troops;
  runWorldTurn(state, rules, () => 0.5);
  assert.equal(aide.locationCityId, front.id);
  assert.equal(front.troops, 17600);
  assert.equal(donor.troops, troops);
  assert.equal(donor.gold, 5000 - rules.actions.officerTransfer);
});

test("a full border already able to command its assembled army does not import surplus officers", () => {
  const { state, front, donor, rules, aide } = fixture();
  rules.ranks["从事"] = 15000;
  runWorldTurn(state, rules, () => 0.5);
  assert.equal(aide.locationCityId, donor.id);
  assert.deepEqual(front.officerIds, ["front-officer"]);
  assert.equal(donor.gold, 5000);
});

test("commander shortage is measured by rank capacity, not a hardcoded count of three officers", () => {
  const { state, front, rules, aide } = fixture();
  for (const id of ["front-second", "front-third"]) {
    state.officers.push(person(id, "front"));
    front.officerIds.push(id);
  }
  runWorldTurn(state, rules, () => 0.5);
  assert.equal(front.officerIds.length, 4);
  assert.equal(aide.locationCityId, front.id);
});

test("migration never consumes the donor's last officer, a ruler, an acted officer or a task-locked officer", () => {
  for (const change of ["last-officer", "acted", "task", "captured", "all-rulers"]) {
    const { state, front, donor, rules, aide, lord } = fixture();
    if (change === "last-officer") { donor.officerIds = [aide.id]; donor.governorId = aide.id; state.officers = state.officers.filter((officer) => officer.id !== lord.id); }
    if (change === "acted") aide.acted = true;
    if (change === "task") aide.taskId = "busy-task";
    if (change === "captured") aide.status = "captured";
    if (change === "all-rulers") aide.rank = "君主";
    const donorStaff = [...donor.officerIds];
    runWorldTurn(state, rules, () => 0.5);
    assert.deepEqual(front.officerIds, ["front-officer"], change);
    assert.deepEqual(donor.officerIds, donorStaff, change);
    assert.equal(aide.locationCityId, donor.id, change);
    assert.equal(donor.gold, 5000, change);
    if (change !== "last-officer") assert.equal(lord.locationCityId, donor.id, change);
  }
});

test("officer-only assembly cannot cross a neutral, enemy or merely allied intermediate city", () => {
  for (const blocker of ["neutral", "player", "ally"]) {
    const { state, front, bridge, donor, rules, aide } = fixture();
    donor.troops = 11000; // Already meets recruitment targets even beside an enemy blocker.
    bridge.factionId = blocker;
    bridge.officerIds = blocker === "neutral" ? [] : ["bridge-officer"];
    bridge.governorId = bridge.officerIds[0] ?? null;
    const officer = state.officers.find((entry) => entry.id === "bridge-officer");
    officer.factionId = blocker;
    if (blocker === "neutral") officer.status = "free";
    if (blocker === "ally") {
      state.factions.push({ id: "ally", name: "盟军" });
      state.relations = { "ai|ally": { allianceUntil: 99999 } };
    }
    // Decline unrelated invasion proposals so the assertion isolates migration.
    runWorldTurn(state, rules, () => 0.99);
    assert.deepEqual(front.officerIds, ["front-officer"], blocker);
    assert.equal(aide.locationCityId, donor.id, blocker);
    assert.equal(donor.gold, 5000, blocker);
  }
});

test("an officer-only migration must pay from its own donor and cannot invent a missing fee", () => {
  const { state, front, donor, rules, aide } = fixture();
  donor.gold = rules.actions.officerTransfer - 1;
  donor.food = monthlyFoodCost(donor.troops, rules) * 3;
  const before = material(donor);
  runWorldTurn(state, rules, () => 0.5);
  assert.equal(aide.locationCityId, donor.id);
  assert.deepEqual(front.officerIds, ["front-officer"]);
  assert.equal(donor.gold, rules.actions.officerTransfer - 1);
  assert.deepEqual(material(donor), before);
});

test("a donor may pay its exact migration fee without needing troop-transport resources", () => {
  const { state, front, donor, rules, aide } = fixture();
  donor.troops = 100;
  donor.gold = rules.actions.officerTransfer;
  donor.food = monthlyFoodCost(donor.troops, rules) * 3;
  const before = material(donor);
  runWorldTurn(state, rules, () => 0.5);
  assert.equal(aide.locationCityId, front.id);
  assert.equal(donor.gold, 0);
  assert.deepEqual(material(donor), before);
  assert.deepEqual(donor.officerIds, ["lord"]);
});

test("the existing one-assembly-per-faction limit includes officer-only migrations", () => {
  const { state, front, donor, bridge, enemy, rules } = fixture();
  const other = city("other-front", "ai", 18000, ["other-officer"], ["bridge", "enemy"]);
  bridge.adjacent.push(other.id);
  enemy.adjacent.push(other.id);
  state.cities.push(other);
  state.officers.push(person("other-officer", other.id), person("second-aide", donor.id));
  donor.officerIds.push("second-aide");
  const report = runWorldTurn(state, rules, () => 0.5);
  const migrated = ["aide", "second-aide"].map((id) => state.officers.find((officer) => officer.id === id))
    .filter((officer) => [front.id, other.id].includes(officer.locationCityId));
  assert.equal(migrated.length, 1);
  assert.equal(donor.officerIds.length, 2);
  assert.equal(donor.gold, 5000 - rules.actions.officerTransfer);
  assert.ok(report.summary.includes("诸势力于 1 处边境集结军队，内地城保留守军。"));
});
