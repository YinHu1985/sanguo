import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { warLedgerRows, warLedgerMarkup } from "../src/js/ui/war-windows.js";
import { gameMenuBlockReason } from "../src/js/ui/game-menu.js";

const snapshot = { day: 30, phase: "siege", units: [
  { side: "ally", troops: 1234 }, { side: "enemy", troops: 2345 }], defenderReserveTroops: 500,
  siege: { hp: 40, maxHp: 100 }, supplies: { ally: { food: 600, gold: 80 }, enemy: { food: 900, gold: 100 } },
  log: [{ day: 30, message: "公开军情" }, { day: 29, message: "敌方隐蔽行动", audience: ["enemy"] },
    { day: 28, message: "我军报告", audience: ["ally"] }] };
const fixture = () => ({ started: true, playerFactionId: "a", cities: [{ id: "x", name: "许昌" }, { id: "y", name: "宛" }],
  factions: [{ id: "a", name: "曹操军" }, { id: "b", name: "张绣军" }, { id: "c", name: "袁绍军" }],
  tasks: [], pendingInvasions: [], battles: [
    { id: "one", status: "paused", sourceCityId: "x", targetCityId: "y", attackerFactionId: "a", defenderFactionId: "b", snapshot: structuredClone(snapshot) },
    { id: "two", status: "paused", sourceCityId: "y", targetCityId: "x", attackerFactionId: "b", defenderFactionId: "c", snapshot: structuredClone(snapshot) },
    { id: "old", status: "ended", attackerFactionId: "a", defenderFactionId: "c", sourceCityId: "x", targetCityId: "y", snapshot: structuredClone(snapshot), result: { message: "攻方退军" } }
  ] });

test("war ledger tracks separate player and AI wars without mutating or advancing their snapshots", () => {
  const state = fixture(), before = structuredClone(state), rows = warLedgerRows(state);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.id === "one").defenderTroops, 2845);
  assert.equal(rows.find((row) => row.id === "one").wallPercent, 40);
  assert.equal(rows.find((row) => row.id === "two").playerSide, null);
  assert.equal(rows.find((row) => row.id === "two").food, null);
  assert.deepEqual(state, before);
  assert.match(warLedgerMarkup(state), /后台模拟/);
  assert.doesNotMatch(warLedgerMarkup(state), /攻方退军/);
  assert.match(warLedgerMarkup(state, "all"), /攻方退军/);
  assert.doesNotMatch(warLedgerMarkup(state, "ours"), /后台模拟/);
});

test("player war reports retain fog audience restrictions and escape display data", () => {
  const state = fixture();
  const row = warLedgerRows(state).find((entry) => entry.id === "one");
  assert.deepEqual(row.log.map((entry) => entry.message), ["公开军情", "我军报告"]);
  state.cities[1].name = '<img src=x onerror="bad()">';
  state.battles[0].id = '" onclick="bad()';
  const html = warLedgerMarkup(state);
  assert.doesNotMatch(html, /<img|data-war-report="" onclick/);
  assert.match(html, /&lt;img/);
});

test("paused multiwar campaigns allow the menu but unfinished atomic battle/month work blocks it", () => {
  const state = fixture();
  state.tasks.push({ id: "expedition", status: "in_battle" });
  assert.equal(gameMenuBlockReason({ state }), "");
  state.battles[0].status = "active";
  assert.match(gameMenuBlockReason({ state }), /月结或军情/);
  assert.match(gameMenuBlockReason({ state, battle: {} }), /自动保存战场/);
});

test("app checkpoints human movement, attacks, siege commands and automatic actions before continuing", async () => {
  const source = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  assert.match(source, /onCampaignBattle: runCampaignBattle/);
  assert.match(source, /finalResult = battle\.moveStep[\s\S]*?checkpointCurrentBattle\(\)/);
  assert.match(source, /const result = runAutomaticBattleStep\(battle\);[\s\S]*?checkpointCurrentBattle\(\)/);
  assert.match(source, /async function performSiegeAction[\s\S]*?checkpointCurrentBattle\(\)/);
  assert.match(source, /battle\.status === "paused".*resolveCampaignCheckpoint/);
});

test("a storage failure warns once without rejecting committed tactical actions, and saving can recover", async () => {
  const source = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  const saveFunction = source.slice(source.indexOf("function saveBattleState()"), source.indexOf("function clearBattleAnimation()"));
  const messages = [], state = { committedActions: 1 };
  let fail = true, saves = 0;
  const save = new Function("state", "saveState", "showToast", `let battleSaveWarning = false; ${saveFunction}; return saveBattleState;`)(state,
    (value) => { assert.equal(value, state); if (fail) throw new Error("quota"); saves++; }, (...args) => messages.push(args));
  assert.doesNotThrow(save);
  assert.doesNotThrow(save);
  assert.equal(messages.length, 1);
  assert.match(messages[0][0], /请勿刷新或关闭/);
  assert.equal(state.committedActions, 1);
  fail = false;
  save(); assert.equal(saves, 1);
  fail = true;
  save(); assert.equal(messages.length, 2, "a later storage outage warns again");
  for (const [name, next] of [["animateMoveTo", "animateAmbushes"], ["performBattleAction", "performSiegeAction"], ["performSiegeAction", "processEnemyTurns"]]) {
    const action = source.slice(source.indexOf(`async function ${name}`), source.indexOf(`async function ${next}`));
    assert.match(action, /finally\s*\{ clearBattleAnimation\(\); \}/, `${name} must release the input lock even on failure`);
  }
});
