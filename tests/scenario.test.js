import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const json = async (name) => JSON.parse(await readFile(new URL(`../src/data/${name}.json`, import.meta.url), "utf8"));
const [scenario, atlas, rules, bios] = await Promise.all(["scenario", "strategic-atlas", "rules", "officer-bios"].map(json));
const cities = new Map(scenario.cities.map((city) => [city.id, city]));
const factions = new Map(scenario.factions.map((faction) => [faction.id, faction]));
const officers = new Map(scenario.officers.map((officer) => [officer.id, officer]));

test("the Jian'an campaign covers every atlas city without requiring an owner or stationed officers", () => {
  assert.equal(scenario.id, "jianan-196");
  assert.equal(scenario.year, 196);
  assert.equal(scenario.month, 11);
  assert.equal(cities.size, 81);
  assert.equal(cities.size, scenario.cities.length);
  assert.deepEqual(new Set(cities.keys()), new Set(atlas.cities.map((city) => city.id)));
  const stationed = new Set();
  for (const city of cities.values()) {
    assert.ok(city.factionId === "neutral" || factions.has(city.factionId), `${city.name} has an invalid owner`);
    assert.ok(Array.isArray(city.officerIds), `${city.name} needs an officer list, possibly empty`);
    assert.ok(city.governorId === null || city.officerIds.includes(city.governorId), `${city.name} appointed governor must reside there`);
    assert.ok(Number.isInteger(city.troops) && city.troops >= 0, `${city.name} has an invalid garrison`);
    for (const id of city.officerIds) {
      assert.ok(!stationed.has(id), `${id} cannot serve in two cities`);
      stationed.add(id);
      const officer = officers.get(id);
      assert.ok(officer, `${city.name} lists unknown officer ${id}`);
      assert.equal(officer.status, "active");
      assert.equal(officer.factionId, city.factionId);
      assert.equal(officer.locationCityId, city.id);
    }
    for (const key of ["agriculture", "commerce", "popularSupport", "training", "morale"]) {
      assert.ok(city[key] >= 0 && city[key] <= 100, `${city.name} invalid ${key}`);
    }
    assert.ok(city.gold > 0 && city.food > city.troops * 0.5, `${city.name} needs operating reserves`);
  }
  assert.equal(stationed.size, scenario.officers.filter((officer) => officer.status === "active").length);
});

test("every playable faction has a real lord, a capital and usable staff", () => {
  assert.equal(factions.size, scenario.factions.length);
  assert.equal(factions.size, 25);
  for (const faction of factions.values()) {
    assert.equal(faction.playable, true);
    const capital = cities.get(faction.capitalId);
    const lord = officers.get(faction.lord);
    assert.ok(capital && lord, `${faction.name} needs both a capital and lord`);
    assert.equal(capital.factionId, faction.id);
    assert.equal(lord.factionId, faction.id);
    assert.equal(lord.status, "active");
    assert.equal(lord.rank, "君主");
    assert.ok(capital.officerIds.includes(lord.id));
    assert.ok(faction.description.length > 10);
  }
});

test("officer records have unique identities, bounded abilities and valid recruitment metadata", () => {
  assert.equal(officers.size, scenario.officers.length);
  assert.equal(new Set(scenario.officers.map((officer) => officer.name)).size, officers.size);
  for (const officer of officers.values()) {
    assert.ok(rules.ranks[officer.rank], `${officer.name} invalid rank`);
    assert.ok(bios[officer.id]?.length > 12, `${officer.name} needs a biography`);
    assert.ok(officer.loyalty >= 70 && officer.loyalty <= 100);
    for (const key of ["war", "intelligence", "leadership", "politics", "charm"]) {
      assert.ok(Number.isInteger(officer[key]) && officer[key] >= 1 && officer[key] <= 100, `${officer.name} invalid ${key}`);
    }
    if (officer.status === "free") {
      assert.equal(officer.factionId, "neutral");
      assert.equal(officer.discovered, false);
      assert.ok(cities.has(officer.locationCityId));
      assert.ok(!scenario.cities.some((city) => city.officerIds.includes(officer.id)));
    }
  }
  assert.ok(scenario.officers.filter((officer) => officer.status === "free").length >= 10);
});

test("removed filler officers cannot return, and unstaffed cities retain independently configured garrisons", () => {
  assert.equal(scenario.removedPlaceholderOfficerIds.length, 17);
  assert.equal(new Set(scenario.removedPlaceholderOfficerIds).size, 17);
  for (const id of scenario.removedPlaceholderOfficerIds) {
    assert.ok(!officers.has(id), `${id} is deleted migration metadata, not an officer`);
    assert.ok(!(id in bios), `${id} must not retain a biography`);
  }
  assert.deepEqual(new Set(Object.keys(bios)), new Set(officers.keys()));
  for (const officer of officers.values()) {
    assert.ok(!officer.fictional, `${officer.name} must not be a fabricated filler`);
    assert.doesNotMatch(officer.name, /(?:郡丞|主簿|守备)$/);
    assert.doesNotMatch(officer.id, /-local-\d+$/);
    assert.doesNotMatch(bios[officer.id], /【虚构/);
  }
  for (const id of ["chaisang", "yunnan", "nanhai", "yulin", "hepu"]) {
    const city = cities.get(id);
    assert.deepEqual(city.officerIds, [], `${city.name} must not be automatically staffed`);
    assert.equal(city.governorId, null);
    assert.equal(city.troops, 3700, `${city.name} garrison must survive removal of filler officers`);
  }
  for (const id of ["jibei", "chenliu"]) {
    assert.equal(cities.get(id).governorId, null, `${id} should not silently receive a new governor`);
  }
});

test("196 campaign landmarks do not accidentally reuse the earlier prototype assignments", () => {
  assert.equal(cities.get("xiaopei").factionId, "liu-bei");
  assert.equal(cities.get("xuzhou").factionId, "lu-bu");
  assert.equal(cities.get("xuchang").factionId, "cao-cao");
  assert.equal(cities.get("beihai").factionId, "yuan-shao");
  assert.equal(cities.get("kuaiji").factionId, "sun-ce");
  assert.equal(cities.get("yuzhang").factionId, "liu-yao");
  assert.equal(officers.get("zhou-yu").factionId, "yuan-shu");
  for (const id of ["cao-bao", "yan-gang", "yu-du", "sun-jian", "dong-zhuo", "liu-yan"]) assert.ok(!officers.has(id), `${id} should not be alive in 196`);
  for (const id of ["zhuge-liang", "sun-quan"]) assert.ok(!officers.has(id), `${id} should not be an early powerful commander`);
});

test("every atlas region resolves to a local city-theme image", async () => {
  const manifest = await json("city-themes");
  assert.equal(Object.keys(manifest.themes).length, 5);
  for (const city of atlas.cities) {
    const theme = manifest.themes[manifest.regionThemes[city.region]];
    assert.ok(theme, `${city.name} needs a regional scene`);
    assert.ok(theme.image.startsWith("./assets/cities/"));
  }
  for (const theme of Object.values(manifest.themes)) {
    const bytes = await readFile(new URL(`../src/${theme.image.slice(2)}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  }
});
