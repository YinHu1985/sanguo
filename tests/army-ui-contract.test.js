import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createArmyComposer } from "../src/js/ui/army-composer.js";
import { formationOfficerIds } from "../src/js/game/army.js";
import { calculateCombatStats } from "../src/js/game/combat-stats.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const marchSource = await readFile(new URL("../src/js/ui/march-window.js", import.meta.url), "utf8");
const campaignSource = await readFile(new URL("../src/js/ui/campaign-windows.js", import.meta.url), "utf8");

// Only the component's data/validation API is exercised here, not browser layout or DOM parsing.
function installElementSink(context) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => {
    const nodes = new Map();
    return { innerHTML: "", className: "", querySelectorAll: () => [], querySelector: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } });
      return nodes.get(selector);
    } };
  } };
  context.after(() => { globalThis.document = previous; });
}

function data(troops = 20000) {
  const officers = Array.from({ length: 6 }, (_, index) => ({ id: `o${index}`, name: `将${index}`, rank: "校尉", factionId: "a", locationCityId: "home",
    status: "active", war: 60, intelligence: 80, leadership: 90 - index, politics: 60, charm: 60 }));
  return { city: { id: "home", name: "本城", factionId: "a", troops, horses: 6000, crossbows: 0, armor: 0, officerIds: officers.map((officer) => officer.id) }, officers, rules };
}

test("composer uses one shared troop quantity and all members in its validated group", (context) => {
  installElementSink(context);
  const fixture = data();
  fixture.officers[0].rank = "君主";
  const composer = createArmyComposer({ ...fixture, formations: [{ officerIds: ["o0", "o1"], troops: 6000, unitType: "cavalry" }] });
  assert.equal(composer.validate().ok, true);
  assert.equal(composer.totalTroops(), 6000);
  assert.equal(composer.getFormations().length, 1);
  assert.deepEqual(composer.getFormations().flatMap(formationOfficerIds), ["o0", "o1"]);
  assert.equal(composer.getFormations()[0].unitType, "cavalry");
});

test("composer validation enforces each group's leader capacity, member count and city's total soldiers", (context) => {
  installElementSink(context);
  for (const formations of [
    [{ officerIds: ["o0"], troops: 3100 }],
    [{ officerIds: ["o0", "o1", "o2", "o3"], troops: 1000 }],
    [{ officerIds: ["o0"], troops: 1500 }, { officerIds: ["o1"], troops: 1500 }]
  ]) {
    const composer = createArmyComposer({ ...data(2000), formations });
    assert.equal(composer.validate().ok, false);
  }
});

test("defending composer accepts existing partial hundreds but attacking composer retains the 500 minimum", (context) => {
  installElementSink(context);
  const formations = [{ officerIds: ["o0"], troops: 137 }];
  assert.equal(createArmyComposer({ ...data(), formations, defending: true }).validate().ok, true);
  assert.equal(createArmyComposer({ ...data(), formations }).validate().ok, false);
});

test("an officer's assignment is unique globally even when an initial payload repeats it", (context) => {
  installElementSink(context);
  const composer = createArmyComposer({ ...data(), formations: [
    { officerIds: ["o0", "o1"], troops: 1000 }, { officerIds: ["o1", "o2"], troops: 1000 }
  ] });
  const ids = composer.getFormations().flatMap(formationOfficerIds);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter((id) => id === "o1").length, 1);
});

test("attack auto-composition leaves subminimum tail troops at home instead of producing an invalid zero or tiny group", (context) => {
  installElementSink(context);
  for (const troopCount of [15050, 15100, 15499]) {
    const composer = createArmyComposer(data(troopCount));
    composer.element.querySelector("[data-auto-form]").handlers.click();
    assert.equal(composer.validate().ok, true, `${troopCount} city troops should generate a valid attack army`);
    assert.equal(composer.totalTroops(), 15000);
    assert.ok(composer.getFormations().every((formation) => formation.troops >= 500 && formation.troops % 100 === 0));
  }
});

test("march and defense windows keep task actors flattened and preserve the chosen defender group data", () => {
  assert.match(marchSource, /officerIds\s*:\s*divisions\.flatMap\(formationOfficerIds\)/);
  assert.match(marchSource, /queueTask\(state/);
  assert.doesNotMatch(marchSource, /commitArmyDeparture\s*\(/);
  assert.match(campaignSource, /pending\.defenderDivisions\s*=\s*result\.defenderDivisions/);
  assert.match(campaignSource, /defending:\s*true/);
  assert.doesNotMatch(campaignSource, /autoResolveInvasion\s*\(/);
});

test("composer displays every troop type, disables locked inputs and allows mixed integer counts", (context) => {
  installElementSink(context);
  const fixture = data();
  const state = { factions: [{ id: "a", unlockedTechnologies: [] }] };
  const formations = [{ officerIds: ["o0"], troops: 1001, composition: { infantry: 701, archer: 300 } }];
  const composer = createArmyComposer({ ...fixture, state, formations });
  assert.equal(composer.validate().ok, true);
  assert.deepEqual(composer.getFormations()[0].composition, { infantry: 701, archer: 300 });
  for (const id of Object.keys(rules.troopTypes)) assert.ok(composer.element.innerHTML.includes(`data-troop-type="${id}"`));
  assert.match(composer.element.innerHTML, /data-troop-type="heavyCavalry"[^>]+disabled/);
  state.factions[0].unlockedTechnologies.push("heavyCavalry");
  const unlocked = createArmyComposer({ ...fixture, state, formations });
  assert.doesNotMatch(unlocked.element.innerHTML, /data-troop-type="heavyCavalry"[^>]+disabled/);
});

test("composer validates one shared equipment stock across all mixed formations", (context) => {
  installElementSink(context);
  const fixture = data();
  fixture.city.horses = 500;
  const formations = [
    { officerIds: ["o0"], troops: 1000, composition: { infantry: 700, cavalry: 300 } },
    { officerIds: ["o1"], troops: 1000, composition: { infantry: 700, cavalry: 300 } }
  ];
  const composer = createArmyComposer({ ...fixture, formations });
  assert.equal(composer.validate().ok, false);
  fixture.city.horses = 600;
  assert.equal(composer.validate().ok, true);
});

test("composer previews the same final combat panel used by the field, including actual AP and vision", (context) => {
  installElementSink(context);
  const fixture = data();
  Object.assign(fixture.city, { training: 80, morale: 70 });
  const composition = { infantry: 1100, archer: 100, cavalry: 800 };
  const formation = { officerIds: ["o0", "o1"], troops: 2000, composition };
  const expected = calculateCombatStats({ ...formation, officers: fixture.officers.slice(0, 2), training: 80, morale: 70 }, rules);
  const composer = createArmyComposer({ ...fixture, formations: [formation] });
  const panel = composer.element.querySelector('[data-mix-stats="0"]').innerHTML;
  const amount = (value) => Math.round(value).toLocaleString("zh-CN");
  for (const value of [`肉搏火力 ${amount(expected.meleeAttack)}`, `肉搏防护 ${expected.meleeDefense.toFixed(2)}`,
    `远程火力 ${amount(expected.rangedAttack)}`, `远程防护 ${expected.rangedDefense.toFixed(2)}`,
    `行动力 ${expected.actionPoints}`, `视野 ${expected.vision} 格`]) assert.ok(panel.includes(value), value);
  assert.doesNotMatch(panel, /机动 6\.0/);
});

test("composer explains casualty exposure using the same editable coefficients as the engine", (context) => {
  installElementSink(context);
  const fixture = data();
  const customRules = structuredClone(rules);
  customRules.battle.casualties.profiles.melee.infantry = 3;
  customRules.battle.casualties.profiles.ranged.infantry = 1.4;
  const composer = createArmyComposer({ ...fixture, rules: customRules,
    formations: [{ officerIds: ["o0"], troops: 2000, composition: { infantry: 1500, archer: 500 } }] });
  assert.match(composer.element.innerHTML, /暴露：近 3 \/ 远 1\.4/);
  const summary = composer.element.querySelector('[data-formation-summary]').innerHTML;
  assert.match(summary, /剩余人数 × 暴露系数/);
  assert.match(summary, /装备随对应兵种的实际损失消耗/);
  assert.doesNotMatch(summary, /战损按比例损失装备/);
});

test("commander selector preserves the explicit first officer and can reassign leadership without changing abilities", (context) => {
  installElementSink(context);
  const fixture = data();
  fixture.officers[1].rank = "君主";
  fixture.officers[1].intelligence = 99;
  const composer = createArmyComposer({ ...fixture, formations: [{ officerIds: ["o1", "o0"], troops: 6000, composition: { infantry: 4000, archer: 2000 } }] });
  assert.equal(composer.getFormations()[0].officerIds[0], "o1");
  assert.equal(composer.getFormations()[0].officerId, "o1");
  assert.equal(composer.validate().ok, true);
  assert.match(composer.element.innerHTML, /data-commander="0"/);
  assert.match(composer.element.innerHTML, /主将 · 决定本队兵额/);
  assert.equal(composer.setCommander(0, "o0"), true);
  assert.deepEqual(composer.getFormations()[0].officerIds, ["o0", "o1"]);
  assert.equal(composer.totalTroops(), 3000);
  assert.deepEqual(composer.getFormations()[0].composition, { infantry: 2000, archer: 1000 });
  assert.match(composer.element.innerHTML, /智 99/);
  assert.equal(composer.validate().ok, true);
  assert.equal(composer.setCommander(0, "o5"), false, "a general outside the formation cannot become its leader");
});

test("default and automatic player composition use the same valid grouping policy", (context) => {
  installElementSink(context);
  const composer = createArmyComposer(data());
  const initial = composer.getFormations();
  assert.equal(composer.validate().ok, true);
  assert.equal(initial.length, 6);
  assert.ok(initial.every((formation) => formation.officerIds.length <= 3 && formation.troops <= 3000));
  composer.element.querySelector("[data-auto-form]").handlers.click();
  assert.deepEqual(composer.getFormations(), initial);
});
