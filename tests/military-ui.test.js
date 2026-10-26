import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { technologyCardsMarkup, POLICY_SECTIONS } from "../src/js/ui/policy-windows.js";
import { equipmentStoresMarkup } from "../src/js/ui/equipment-view.js";
import { rangedProjectileMarkup } from "../src/js/ui/field-view.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const state = (points = 0, unlocked = []) => ({ playerFactionId: "a", cities: [{ factionId: "a" }],
  factions: [{ id: "a", researchPoints: points, unlockedTechnologies: unlocked }] });

test("equipment display exposes three independent warehouse stores", () => {
  const html = equipmentStoresMarkup({ horses: 1200, crossbows: 30, armor: 0 });
  assert.match(html, /良马.*1,200/);
  assert.match(html, /劲弩.*30/);
  assert.match(html, /甲胄.*>0</);
  assert.match(equipmentStoresMarkup({}), /data-equipment="horses">0</);
});

test("policy lists all ideas and six advanced troop unlocks, but insufficient reform disables purchase", () => {
  const html = technologyCardsMarkup(state(), rules);
  assert.equal((html.match(/data-unlock-technology=/g) ?? []).length, 27);
  assert.equal((html.match(/ disabled/g) ?? []).length, 27);
  for (const name of ["突骑兵", "重骑兵", "近卫队", "龙骑兵", "象兵", "藤甲兵"]) assert.ok(html.includes(name), name);
  assert.equal(POLICY_SECTIONS[0].id, "technology");
});

test("policy unlock states, prices and equipment requirements follow shared rules", () => {
  const html = technologyCardsMarkup(state(2000, ["heavyCavalry"]), rules);
  assert.equal((html.match(/ disabled/g) ?? []).length, 17, "nine root ideas and the owned node's rollback are enabled");
  assert.match(html, /is-unlocked[^]*data-technology="heavyCavalry"/);
  assert.match(html, /data-rollback-technology="heavyCavalry"/);
  assert.match(html, /良马 ×1、劲弩 ×1、甲胄 ×1/);
  const blocked = technologyCardsMarkup(state(2000), rules, false);
  assert.equal((blocked.match(/ disabled/g) ?? []).length, 27);
});

test("policy escapes external configuration copy", () => {
  const custom = structuredClone(rules);
  custom.technologies.heavyCavalry.name = '<img onerror="alert(1)">';
  const html = technologyCardsMarkup(state(2000), custom);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

test("projectile follows the column-offset square centers and hides unseen actors", () => {
  const units = [{ id: "a", position: { x: 0, y: 1 } }, { id: "b", position: { x: 1, y: 1 } }];
  const grid = { columns: 8, rows: 6.5 };
  const html = rangedProjectileMarkup(units, grid, "a", "b", "is-fire-arrow");
  assert.match(html, /viewBox="0 0 800 650"/);
  assert.match(html, /M50,150 L150,200/);
  assert.match(html, /fire-projectile/);
  assert.equal(rangedProjectileMarkup(units.slice(1), grid, "a", "b", "is-shooting"), "");
  assert.equal(rangedProjectileMarkup(units, grid, "a", "b", "is-striking"), "");
});

test("main screen wires policies, equipment, shooting and fire arrows", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  for (const id of ["policies-button", "research-points-label", "city-equipment"]) assert.ok(html.includes(`id="${id}"`));
  for (const mode of ["shoot", "fireArrow"]) assert.ok(html.includes(`data-mode="${mode}"`));
  assert.ok(html.indexOf('id="policies-button"') > html.indexOf('id="strategy-screen"'));
  const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  assert.match(app, /battle\.shoot\(unit\.id\)/);
  assert.match(app, /battle\.fireArrow\(unit\.id\)/);
  assert.match(app, /ensureTaskBattle\(state, task, rules, battleMap/);
  const campaign = await readFile(new URL("../src/js/game/war-campaigns.js", import.meta.url), "utf8");
  assert.match(campaign, /battle\.attackerEquipmentCommitted = \{ \.\.\.order\.equipment \}/);
});
