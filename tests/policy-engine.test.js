import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { advanceResearch, getPolicyOverview, normalizeFactionResearch, reformIncome, rollbackTechnology,
  rollbackTechnologyPreview, technologyStatus, unlockTechnology } from "../src/js/game/technology.js";
import { heavenCycleStatus } from "../src/js/game/heaven-cycle.js";
import { unitTypeAvailability } from "../src/js/game/troops.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const fixture = () => ({ year: 196, month: 1, playerFactionId: "a", eventLog: [], tasks: [],
  factions: [{ id: "a", name: "甲", researchPoints: 10000, unlockedTechnologies: [] },
    { id: "b", name: "乙", researchPoints: 0, unlockedTechnologies: [] }, { id: "neutral", name: "无主" }],
  cities: [{ id: "home", factionId: "a" }, { id: "away", factionId: "b" }] });
const buy = (state, ...ids) => ids.map((id) => {
  const result = unlockTechnology(state, "a", id, rules);
  assert.equal(result.ok, true, `${id}: ${result.message}`);
  return result;
});

test("policy data supplies nine three-node groups, independent axes and the existing six troop unlocks", () => {
  const state = fixture();
  const overview = getPolicyOverview(state, "a", rules);
  assert.deepEqual(overview.directions.map((direction) => direction.id), ["wang", "ba", "zheng", "qi"]);
  assert.equal(overview.groups.length, 9);
  for (const group of overview.groups) {
    assert.equal(group.total, 3);
    assert.equal(group.bonus, 10);
    assert.equal(group.owned, 0);
    assert.equal(group.complete, false);
    for (const node of group.nodes) {
      assert.equal(node.direction, group.direction);
      assert.ok(Number.isSafeInteger(node.cost));
      assert.ok(node.unitType || node.placeholder);
      if (node.placeholder) assert.match(node.description, /效果待定/);
      for (const dependency of node.prerequisites) assert.ok(rules.technologies[dependency]);
    }
  }
  assert.deepEqual(Object.values(rules.technologies).filter((node) => node.unitType).map((node) => node.unitType).sort(),
    ["heavyCavalry", "guard", "raiderCavalry", "dragoon", "elephant", "rattan"].sort());
});

test("funded child ideas remain locked until every prerequisite is researched", () => {
  const state = fixture();
  const before = structuredClone(state);
  const blocked = technologyStatus(state, "a", "dragoon", rules);
  assert.equal(blocked.affordable, true);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.prerequisitesMet, false);
  assert.deepEqual(blocked.missingPrerequisites, ["raiderCavalry"]);
  assert.equal(unlockTechnology(state, "a", "dragoon", rules).ok, false);
  assert.deepEqual(state, before);
  buy(state, "crossbowEngineering", "raiderCavalry");
  assert.equal(technologyStatus(state, "a", "dragoon", rules).ok, true);
  const custom = structuredClone(rules);
  custom.technologies.dragoon.prerequisites.push("guard");
  assert.deepEqual(technologyStatus(state, "a", "dragoon", custom).missingPrerequisites, ["guard"]);
});

test("tilting one axis raises only its opposite price and balancing reduces the penalty", () => {
  const state = fixture();
  buy(state, "agriculturalRelief", "openMarkets", "publicGranaries");
  assert.equal(technologyStatus(state, "a", "militaryRegisters", rules).costMultiplier, 1.45);
  assert.equal(technologyStatus(state, "a", "militaryRegisters", rules).cost, 116);
  assert.equal(technologyStatus(state, "a", "virtuousRule", rules).costMultiplier, 1);
  assert.equal(technologyStatus(state, "a", "militaryDiscipline", rules).costMultiplier, 1);
  assert.equal(technologyStatus(state, "a", "crossbowEngineering", rules).costMultiplier, 1);
  buy(state, "militaryRegisters");
  assert.equal(technologyStatus(state, "a", "centralAuthority", rules).costMultiplier, 1.3);
  buy(state, "martialLaw", "warEconomy");
  assert.equal(technologyStatus(state, "a", "centralAuthority", rules).costMultiplier, 1);
  assert.equal(technologyStatus(state, "a", "virtuousRule", rules).costMultiplier, 1);
  const directions = getPolicyOverview(state, "a", rules).directions;
  assert.equal(directions[0].owned, 3);
  assert.equal(directions[0].oppositionOwned, 3);
});

test("opposition pricing is configurable, capped, and rounds decimal bills correctly", () => {
  const state = fixture();
  state.factions[0].unlockedTechnologies = ["agriculturalRelief"];
  const custom = structuredClone(rules);
  custom.research.oppositionCostPerNode = 10;
  assert.equal(technologyStatus(state, "a", "militaryRegisters", custom).costMultiplier, 3);
  custom.research.oppositionCostPerNode = 0.1;
  custom.technologies.militaryRegisters.cost = 200;
  assert.equal(technologyStatus(state, "a", "militaryRegisters", custom).cost, 220);
  custom.technologies.militaryRegisters.cost = 201;
  assert.equal(technologyStatus(state, "a", "militaryRegisters", custom).cost, 222);
});

test("the military axis prices strange and conventional doctrines independently of domestic ideas", () => {
  const state = fixture();
  buy(state, "militaryDiscipline", "heavyCavalry", "guard");
  assert.equal(technologyStatus(state, "a", "crossbowEngineering", rules).cost, 145);
  assert.equal(technologyStatus(state, "a", "agriculturalRelief", rules).cost, 80);
  assert.equal(technologyStatus(state, "a", "militaryRegisters", rules).cost, 80);
  buy(state, "crossbowEngineering", "raiderCavalry", "dragoon");
  assert.equal(technologyStatus(state, "a", "regionalWarfare", rules).costMultiplier, 1);
  assert.equal(technologyStatus(state, "a", "supplyRoutes", rules).costMultiplier, 1);
});

test("completion grants a derived monthly bonus, not immediate spendable reform", () => {
  const state = fixture();
  const original = state.factions[0].researchPoints;
  const results = buy(state, "agriculturalRelief", "openMarkets", "publicGranaries");
  assert.equal(state.factions[0].researchPoints, original - results.reduce((sum, result) => sum + result.cost, 0));
  assert.deepEqual(results[2].completedGroups, ["wangProsperity"]);
  const income = reformIncome(state, "a", rules);
  assert.equal(income.baseGain, 100);
  assert.equal(income.groupBonus, 10);
  assert.equal(income.subtotal, 110);
  assert.equal(income.multiplier, 0.7);
  assert.equal(income.gain, 77);
  assert.ok(income.breakdown.some((entry) => entry.id === "group:wangProsperity" && entry.amount === 10));
  const before = state.factions[0].researchPoints;
  const reports = advanceResearch(state, rules);
  assert.equal(reports[0].gain, 77);
  assert.equal(state.factions[0].researchPoints, before + 77);
  assert.equal(reformIncome(state, "a", rules).gain, 66, "monthly strengthening affects the next income");
});

test("a purchase is a victory; a cascading rollback is one defeat without any refund", () => {
  const state = fixture();
  buy(state, "crossbowEngineering", "raiderCavalry", "dragoon");
  assert.equal(heavenCycleStatus(state.factions[0], rules).phase, "victory");
  assert.equal(heavenCycleStatus(state.factions[0], rules).strength, 3);
  const before = structuredClone(state);
  const preview = rollbackTechnologyPreview(state, "a", "crossbowEngineering", rules);
  assert.deepEqual(preview.removedIds, ["crossbowEngineering", "raiderCavalry", "dragoon"]);
  assert.deepEqual(preview.lostGroups, ["qiArchery"]);
  assert.equal(preview.refund, 0);
  assert.deepEqual(state, before);
  const result = rollbackTechnology(state, "a", "crossbowEngineering", rules);
  assert.equal(result.ok, true);
  assert.equal(state.factions[0].researchPoints, before.factions[0].researchPoints);
  assert.deepEqual(state.factions[0].unlockedTechnologies, []);
  assert.equal(reformIncome(state, "a", rules).groupBonus, 0);
  assert.equal(heavenCycleStatus(state.factions[0], rules).phase, "defeat");
  assert.equal(heavenCycleStatus(state.factions[0], rules).strength, 1);
  assert.equal(reformIncome(state, "a", rules).gain, 110);
  const after = structuredClone(state);
  assert.equal(rollbackTechnology(state, "a", "crossbowEngineering", rules).ok, false);
  assert.deepEqual(state, after, "repeat callbacks cannot create additional defeats");
});

test("rollback removes descendants but not parents or siblings and immediately reprices the axis", () => {
  const state = fixture();
  buy(state, "agriculturalRelief", "openMarkets", "publicGranaries");
  const beforePoints = state.factions[0].researchPoints;
  const result = rollbackTechnology(state, "a", "openMarkets", rules);
  assert.deepEqual(result.removedIds, ["openMarkets"]);
  assert.deepEqual(state.factions[0].unlockedTechnologies, ["agriculturalRelief", "publicGranaries"]);
  assert.equal(technologyStatus(state, "a", "militaryRegisters", rules).costMultiplier, 1.3);
  assert.equal(getPolicyOverview(state, "a", rules).groups[0].complete, false);
  assert.equal(state.factions[0].researchPoints, beforePoints);
  buy(state, "openMarkets");
  assert.ok(state.factions[0].researchPoints < beforePoints);
  assert.equal(reformIncome(state, "a", rules).groupBonus, 10, "reacquiring a group never stacks its bonus");
});

test("dependency rollback crosses group boundaries and terminates on cyclic input", () => {
  const state = fixture();
  const custom = structuredClone(rules);
  custom.technologies.virtuousRule.prerequisites = ["openMarkets"];
  custom.technologies.openMarkets.prerequisites = ["virtuousRule", "agriculturalRelief"];
  state.factions[0].unlockedTechnologies = ["agriculturalRelief", "openMarkets", "virtuousRule", "meritOfficials", "countySchools", "moddedLegacyNode"];
  const preview = rollbackTechnologyPreview(state, "a", "openMarkets", custom);
  assert.deepEqual(new Set(preview.removedIds), new Set(["openMarkets", "virtuousRule", "meritOfficials", "countySchools"]));
  assert.deepEqual(preview.lostGroups, ["wangGovernance"]);
  assert.equal(rollbackTechnology(state, "a", "openMarkets", custom).ok, true);
  assert.deepEqual(state.factions[0].unlockedTechnologies, ["agriculturalRelief", "moddedLegacyNode"]);
});

test("legacy unlocks remain usable without invented prerequisites, bonuses or victories", () => {
  const state = fixture();
  state.factions[0].unlockedTechnologies = ["guard", "guard", "moddedLegacyNode"];
  normalizeFactionResearch(state.factions[0], rules);
  assert.deepEqual(state.factions[0].unlockedTechnologies, ["guard", "moddedLegacyNode"]);
  assert.equal(heavenCycleStatus(state.factions[0], rules).phase, "neutral");
  assert.equal(unitTypeAvailability("guard", { state, factionId: "a", rules }).available, true);
  assert.equal(technologyStatus(state, "a", "guard", rules).unlocked, true);
  assert.equal(technologyStatus(state, "a", "militaryDiscipline", rules).ok, true);
  assert.equal(reformIncome(state, "a", rules).groupBonus, 0);
});

test("rollback traverses absent intermediates in a sparse legacy prerequisite tree", () => {
  const state = fixture();
  state.factions[0].unlockedTechnologies = ["crossbowEngineering", "dragoon", "guard"];
  const result = rollbackTechnology(state, "a", "crossbowEngineering", rules);
  assert.deepEqual(result.removedIds, ["crossbowEngineering", "dragoon"]);
  assert.deepEqual(state.factions[0].unlockedTechnologies, ["guard"]);
});

test("rollback revokes future troop selection while leaving existing battlefield composition alone", () => {
  const state = fixture();
  buy(state, "militaryDiscipline", "heavyCavalry");
  state.warCampaigns = [{ formations: [{ composition: { infantry: 500, heavyCavalry: 1500 } }] }];
  const deployed = structuredClone(state.warCampaigns);
  assert.equal(unitTypeAvailability("heavyCavalry", { state, factionId: "a", rules }).available, true);
  rollbackTechnology(state, "a", "militaryDiscipline", rules);
  assert.equal(unitTypeAvailability("heavyCavalry", { state, factionId: "a", rules }).available, false);
  assert.deepEqual(state.warCampaigns, deployed);
  for (const type of ["infantry", "archer", "heavyInfantry", "crossbowman", "cavalry"]) {
    assert.equal(unitTypeAvailability(type, { state, factionId: "a", rules }).available, true);
  }
});

test("both policy operations reject foreign factions and monthly resolution without writes", () => {
  const state = fixture();
  buy(state, "agriculturalRelief");
  state.factions[1].unlockedTechnologies = ["agriculturalRelief"];
  for (const operate of [unlockTechnology, rollbackTechnology]) {
    for (const patch of [{ turnResolution: { stage: "income" } }, { tasks: [{ status: "awaiting_battle" }] }]) {
      const blocked = { ...structuredClone(state), ...patch };
      const before = structuredClone(blocked);
      assert.equal(operate(blocked, "a", "agriculturalRelief", rules).ok, false);
      assert.deepEqual(blocked, before);
    }
    const before = structuredClone(state);
    assert.equal(operate(state, "b", "agriculturalRelief", rules).ok, false);
    assert.deepEqual(state, before);
  }
});

test("read-only policy previews never normalize state or record fate; duplicate purchase is atomic", () => {
  const state = fixture();
  const before = structuredClone(state);
  for (const factionId of ["a", "b", "neutral", "missing"]) {
    getPolicyOverview(state, factionId, rules);
    reformIncome(state, factionId, rules);
    technologyStatus(state, factionId, "heavyCavalry", rules);
    rollbackTechnologyPreview(state, factionId, "heavyCavalry", rules);
  }
  assert.deepEqual(state, before);
  buy(state, "agriculturalRelief");
  const after = structuredClone(state);
  assert.equal(unlockTechnology(state, "a", "agriculturalRelief", rules).ok, false);
  assert.deepEqual(state, after);
});

test("the monthly income pipeline supports future named flat and multiplier effects", () => {
  const state = fixture();
  buy(state, "agriculturalRelief");
  const income = reformIncome(state, "a", rules, { modifiers: [
    { id: "event", label: "临时变法", amount: 20 }, { id: "policy", label: "未来政策", multiplier: 1.5 }
  ] });
  assert.equal(income.flatBonus, 20);
  assert.equal(income.subtotal, 120);
  assert.equal(income.gain, 162);
  assert.ok(income.breakdown.some((entry) => entry.id === "event" && entry.amount === 20));
  assert.ok(income.breakdown.some((entry) => entry.id === "policy" && entry.multiplier === 1.5));
  assert.equal(reformIncome(state, "neutral", rules, { modifiers: [{ amount: 1000 }] }).gain, 0);
  state.cities = [];
  assert.equal(reformIncome(state, "a", rules, { modifiers: [{ amount: 1000 }] }).gain, 0);
});

test("defeat income grows monthly, caps, then a new victory immediately clears the boon", () => {
  const state = fixture();
  buy(state, "agriculturalRelief");
  rollbackTechnology(state, "a", "agriculturalRelief", rules);
  const gains = [];
  for (let month = 0; month < 8; month++) gains.push(advanceResearch(state, rules)[0].gain);
  assert.deepEqual(gains, [110, 120, 130, 140, 150, 160, 160, 160]);
  buy(state, "agriculturalRelief");
  assert.equal(reformIncome(state, "a", rules).gain, 90);
  for (let month = 0; month < 8; month++) advanceResearch(state, rules);
  assert.equal(reformIncome(state, "a", rules).gain, 40);
  assert.equal(reformIncome(state, "b", rules).gain, 100, "factions have independent cycles");
});

test("an empty idea group cannot grant free completion income", () => {
  const state = fixture();
  const custom = structuredClone(rules);
  custom.ideaGroups.empty = { name: "未开放", direction: "wang", completionBonus: { reformFlat: 99999 } };
  assert.equal(getPolicyOverview(state, "a", custom).groups.at(-1).complete, false);
  assert.equal(reformIncome(state, "a", custom).groupBonus, 0);
});

test("unknown saved IDs cannot masquerade as configured ideas or generate rollback defeats", () => {
  const state = fixture();
  state.factions[0].unlockedTechnologies = ["constructor", "moddedLegacyNode"];
  const before = structuredClone(state);
  for (const id of ["constructor", "toString", "moddedLegacyNode"]) {
    assert.equal(technologyStatus(state, "a", id, rules).ok, false);
    assert.equal(rollbackTechnology(state, "a", id, rules).ok, false);
  }
  assert.deepEqual(state, before);
});
