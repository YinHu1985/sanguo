import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createArmyComposer } from "../src/js/ui/army-composer.js";
import { formationOfficerIds } from "../src/js/game/army.js";

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
  return { city: { id: "home", name: "本城", factionId: "a", troops, officerIds: officers.map((officer) => officer.id) }, officers, rules };
}

test("composer uses one shared troop quantity and all members in its validated group", (context) => {
  installElementSink(context);
  const composer = createArmyComposer({ ...data(), formations: [{ officerIds: ["o0", "o1"], troops: 6000, unitType: "cavalry" }] });
  assert.equal(composer.validate().ok, true);
  assert.equal(composer.totalTroops(), 6000);
  assert.equal(composer.getFormations().length, 1);
  assert.deepEqual(composer.getFormations().flatMap(formationOfficerIds), ["o0", "o1"]);
  assert.equal(composer.getFormations()[0].unitType, "cavalry");
});

test("composer validation enforces each group's summed capacity, member count and city's total soldiers", (context) => {
  installElementSink(context);
  for (const formations of [
    [{ officerIds: ["o0"], troops: 3100 }],
    [{ officerIds: ["o0", "o1", "o2", "o3", "o4", "o5"], troops: 1000 }],
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
