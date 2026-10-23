import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { allocateTroopLosses, applyArmyLosses, applyFormationLosses, casualtyExposure, compositionEquipment } from "../src/js/game/troops.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const sum = (values) => Object.values(values).reduce((total, value) => total + value, 0);
const unit = (composition) => ({ troops: sum(composition), composition: { ...composition }, unitType: "infantry" });
const combined = (units) => Object.fromEntries(Object.keys(rules.troopTypes).map((id) => [id,
  units.reduce((total, formation) => total + (formation.composition[id] ?? 0), 0)]).filter(([, count]) => count));

test("four configurable profiles cover all eleven types with positive finite coefficients", () => {
  for (const damageType of ["melee", "ranged", "fire", "attrition"]) {
    for (const id of Object.keys(rules.troopTypes)) {
      const configured = rules.battle.casualties.profiles[damageType][id];
      assert.ok(Number.isFinite(configured) && configured > 0);
      assert.equal(casualtyExposure(id, rules, damageType), configured);
    }
  }
  assert.equal(casualtyExposure("heavyInfantry", rules, "melee"), 2);
  assert.equal(casualtyExposure("guard", rules, "melee"), 1.5);
  assert.equal(casualtyExposure("heavyInfantry", rules, "ranged"), 1.2);
  assert.equal(casualtyExposure("guard", rules, "ranged"), 1.1);
});

test("melee concentrates a fixed total on exposed troops without multiplying total casualties", () => {
  const composition = { heavyInfantry: 1000, archer: 1000 };
  const before = structuredClone(composition);
  assert.deepEqual(allocateTroopLosses(composition, 300, rules, "melee"), { heavyInfantry: 200, archer: 100 });
  assert.deepEqual(composition, before, "the allocator is pure");
  assert.deepEqual(allocateTroopLosses({ infantry: 1000, guard: 1000, cavalry: 1000 }, 450, rules, "melee"),
    { infantry: 200, guard: 150, cavalry: 100 });
});

test("ranged exposure has a weaker front-line preference; fire and attrition remain proportional", () => {
  const composition = { heavyInfantry: 1000, archer: 1000 };
  assert.deepEqual(allocateTroopLosses(composition, 220, rules, "ranged"), { heavyInfantry: 120, archer: 100 });
  for (const type of ["fire", "attrition", "future-unknown"]) {
    assert.deepEqual(allocateTroopLosses(composition, 220, rules, type), { heavyInfantry: 110, archer: 110 });
  }
  assert.deepEqual(allocateTroopLosses(composition, 220), { heavyInfantry: 110, archer: 110 });
});

test("large losses saturate a small exposed contingent and reassign every remaining casualty", () => {
  assert.deepEqual(allocateTroopLosses({ heavyInfantry: 100, archer: 900 }, 900, rules, "melee"), { heavyInfantry: 100, archer: 800 });
  const custom = { battle: { casualties: { profiles: { melee: { heavyInfantry: 20, infantry: 10, archer: 1 } } } } };
  assert.deepEqual(allocateTroopLosses({ heavyInfantry: 10, infantry: 20, archer: 970 }, 900, custom, "melee"),
    { heavyInfantry: 10, infantry: 20, archer: 870 });
});

test("rounding is deterministic, conserves tiny integer losses and cannot overdraw a type", () => {
  assert.deepEqual(allocateTroopLosses({ infantry: 1, archer: 1, cavalry: 1 }, 1, rules), { infantry: 1 });
  assert.deepEqual(allocateTroopLosses({ infantry: 1, archer: 1, cavalry: 1 }, 2, rules), { infantry: 1, archer: 1 });
  assert.deepEqual(allocateTroopLosses({ infantry: 1, archer: 1, cavalry: 1 }, 2.9, rules), { infantry: 1, archer: 1 });
  assert.deepEqual(allocateTroopLosses({ infantry: 0, archer: 1 }, 100, rules, "melee"), { archer: 1 });
});

test("formation mutation preserves real survivors, updates its dominant type and clears a destroyed unit", () => {
  const formation = unit({ heavyInfantry: 1000, archer: 1000 });
  assert.equal(applyFormationLosses(formation, 300, rules, "melee"), 300);
  assert.deepEqual(formation, { troops: 1700, composition: { heavyInfantry: 800, archer: 900 }, unitType: "archer" });
  assert.deepEqual(compositionEquipment(formation.composition, rules), { horses: 0, crossbows: 0, armor: 800 });
  assert.equal(applyFormationLosses(formation, 999999, rules, "ranged"), 1700);
  assert.deepEqual(formation, { troops: 0, composition: {}, unitType: "infantry" });
  assert.equal(applyFormationLosses(formation, 1, rules, "melee"), 0);
});

test("a later hit weights the actual survivors, not the departure-time composition", () => {
  const formation = unit({ heavyInfantry: 1000, archer: 1000 });
  applyFormationLosses(formation, 300, rules, "melee");
  const expected = allocateTroopLosses({ heavyInfantry: 800, archer: 900 }, 250, rules, "melee");
  assert.deepEqual(expected, { heavyInfantry: 160, archer: 90 });
  assert.equal(applyFormationLosses(formation, 250, rules, "melee"), 250);
  assert.deepEqual(formation.composition, { heavyInfantry: 640, archer: 810 });
});

test("army losses are weighted across types before formations, so splitting a type into another unit cannot evade exposure", () => {
  const separated = [unit({ heavyInfantry: 1000 }), unit({ archer: 1000 })];
  const mixed = [unit({ heavyInfantry: 900, archer: 100 }), unit({ heavyInfantry: 100, archer: 900 })];
  const single = [unit({ heavyInfantry: 1000, archer: 1000 })];
  for (const army of [separated, mixed, single]) {
    assert.equal(applyArmyLosses(army, 300, rules, "melee"), 300);
    assert.deepEqual(combined(army), { archer: 900, heavyInfantry: 800 });
    assert.ok(army.every((formation) => formation.troops === sum(formation.composition)));
  }
  assert.equal(separated[0].troops, 800);
  assert.equal(separated[1].troops, 900);
  assert.deepEqual(mixed[0].composition, { heavyInfantry: 720, archer: 90 });
  assert.deepEqual(mixed[1].composition, { heavyInfantry: 80, archer: 810 });
});

test("army saturation redistributes losses globally and full defeat clears every formation", () => {
  const army = [unit({ heavyInfantry: 50 }), unit({ heavyInfantry: 50, archer: 450 }), unit({ archer: 450 })];
  assert.equal(applyArmyLosses(army, 900, rules, "melee"), 900);
  assert.deepEqual(combined(army), { archer: 100 });
  assert.deepEqual(army.map((formation) => formation.troops), [0, 50, 50]);
  assert.equal(applyArmyLosses(army, 10000, rules, "fire"), 100);
  assert.ok(army.every((formation) => formation.troops === 0 && Object.keys(formation.composition).length === 0));
});

test("unknown types and invalid coefficient overrides use positive defaults, never immunity or negative deaths", () => {
  const custom = { battle: { casualties: { profiles: { melee: { default: 1.5, infantry: 0, archer: -2, cavalry: Infinity, guard: NaN } } } } };
  for (const id of ["infantry", "archer", "cavalry", "guard", "futureType"]) assert.equal(casualtyExposure(id, custom, "melee"), 1.5);
  assert.equal(casualtyExposure("infantry", {}, "melee"), 1);
  assert.equal(casualtyExposure("futureType", rules, "melee"), 1);
  assert.deepEqual(allocateTroopLosses({ infantry: 100, futureType: 100 }, 30, rules, "melee"), { infantry: 20, futureType: 10 });
  custom.battle.casualties.profiles.melee.default = -1;
  assert.equal(casualtyExposure("archer", custom, "melee"), 1);
});

test("malformed casualty requests are no-ops and a malformed army member cannot partially damage the others", () => {
  for (const composition of [null, undefined, [], { infantry: -1 }, { infantry: NaN }, { infantry: Infinity }, { infantry: 1.5 },
    { infantry: Number.MAX_SAFE_INTEGER, archer: 1 }]) assert.deepEqual(allocateTroopLosses(composition, 10, rules), {});
  for (const loss of [-1, NaN, Infinity, -Infinity, "10", null, undefined]) {
    const formation = unit({ infantry: 100, archer: 100 });
    const before = structuredClone(formation);
    assert.deepEqual(allocateTroopLosses(formation.composition, loss, rules), {});
    assert.equal(applyFormationLosses(formation, loss, rules), 0);
    assert.deepEqual(formation, before);
  }
  for (const bad of [null, "bad", { troops: NaN }, { troops: 1.5 }, { troops: 2, composition: { infantry: -2 } }]) {
    const army = [unit({ infantry: 100 }), bad];
    const before = structuredClone(army);
    assert.equal(applyArmyLosses(army, 50, rules, "melee"), 0);
    assert.deepEqual(army, before);
  }
  const duplicate = unit({ infantry: 100 });
  assert.equal(applyArmyLosses([duplicate, duplicate], 10, rules), 0);
  assert.equal(duplicate.troops, 100);
  assert.equal(applyArmyLosses(undefined, 10, rules), 0);
});

test("legacy single-type units remain compatible and zero-loss synchronization uses their current troop count", () => {
  const legacy = { troops: 100, unitType: "cavalry" };
  assert.equal(applyFormationLosses(legacy, 20, rules, "melee"), 20);
  assert.deepEqual(legacy.composition, { cavalry: 80 });
  const resized = { troops: 80, composition: { infantry: 50, archer: 50 } };
  assert.equal(applyFormationLosses(resized, 0, rules), 0);
  assert.deepEqual(resized.composition, { infantry: 40, archer: 40 });
});

test("extreme finite weights and safe-integer counts do not overflow or lose casualties to floating-point rounding", () => {
  const custom = { battle: { casualties: { profiles: { melee: { infantry: 1e308, archer: 5e-324 } } } } };
  assert.deepEqual(allocateTroopLosses({ infantry: 5, archer: 5 }, 7, custom, "melee"), { infantry: 5, archer: 2 });
  const composition = { infantry: 4503599627370495, archer: 4503599627370496 };
  for (const type of ["attrition", "melee"]) {
    const loss = Number.MAX_SAFE_INTEGER - 1;
    const casualties = allocateTroopLosses(composition, loss, rules, type);
    assert.equal(sum(casualties), loss);
    assert.ok(Object.entries(casualties).every(([id, count]) => Number.isSafeInteger(count) && count >= 0 && count <= composition[id]));
  }
  assert.deepEqual(allocateTroopLosses({ infantry: 4, archer: 6 }, Number.MAX_VALUE, rules, "melee"), { infantry: 4, archer: 6 });
});

test("seeded mixed-army casualty distributions always conserve integers and per-type inventory", () => {
  let cursor = 5171;
  const random = () => { cursor = (cursor * 1664525 + 1013904223) >>> 0; return cursor / 4294967296; };
  const ids = Object.keys(rules.troopTypes);
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const composition = Object.fromEntries(ids.map((id) => [id, Math.floor(random() * 1000)]));
    const before = sum(composition);
    const loss = Math.floor(random() * (before + 1000));
    const type = ["melee", "ranged", "fire", "attrition"][iteration % 4];
    const casualties = allocateTroopLosses(composition, loss, rules, type);
    assert.equal(sum(casualties), Math.min(before, loss));
    assert.ok(Object.entries(casualties).every(([id, count]) => Number.isSafeInteger(count) && count >= 0 && count <= composition[id]));
    const first = Object.fromEntries(ids.map((id) => [id, Math.floor(composition[id] * random())]));
    const second = Object.fromEntries(ids.map((id) => [id, composition[id] - first[id]]));
    const army = [unit(first), unit(second)];
    assert.equal(applyArmyLosses(army, loss, rules, type), Math.min(before, loss));
    const survivors = combined(army);
    assert.equal(sum(survivors), before - Math.min(before, loss));
    for (const id of ids) assert.equal(survivors[id] ?? 0, composition[id] - (casualties[id] ?? 0));
  }
});
