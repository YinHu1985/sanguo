import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { heavenCycleStatus } from "../src/js/game/heaven-cycle.js";
import { createInitialState, migrateState } from "../src/js/game/state.js";
import { heavenIndicatorMarkup } from "../src/js/ui/heaven-view.js";
import { createPolicyUI } from "../src/js/ui/policy-windows.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const scenario = JSON.parse(await readFile(new URL("../src/data/scenario.json", import.meta.url), "utf8"));
const faction = (phase, strength, lastReason = "") => ({ id: "a", heavenCycle: { phase, strength, lastReason } });

function assertMatchesStatus(entry, config = rules) {
  const status = heavenCycleStatus(entry, config);
  const html = heavenIndicatorMarkup(entry, config);
  const percent = Math.round((status.multiplier - 1) * 100);
  const modifier = percent === 0 ? "无修正" : `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
  assert.ok(html.includes(`data-heaven-phase="${status.phase}"`));
  assert.ok(html.includes(`data-heaven-strength="${status.strength}"`));
  assert.ok(html.includes(`transform="rotate(${status.angle} 32 32)"`));
  assert.ok(html.includes(`<strong>${status.label}</strong>`));
  assert.ok(html.includes(`<b>${modifier}</b>`));
  assert.ok(html.includes(`<i>${status.strength}/${status.maxStrength}</i>`));
  return html;
}

test("topbar indicator uses the shared cycle status for both sides and both endpoints", () => {
  for (const phase of ["victory", "defeat"]) {
    for (const strength of [1, 3, 6, 100]) assertMatchesStatus(faction(phase, strength));
  }
  assert.match(assertMatchesStatus(faction("victory", 1)), /胜兵必骄[^]*−10%/);
  assert.match(assertMatchesStatus(faction("victory", 6)), /骄兵必败[^]*−60%/);
  assert.match(assertMatchesStatus(faction("defeat", 1)), /败兵必哀[^]*\+10%/);
  assert.match(assertMatchesStatus(faction("defeat", 6)), /哀兵必胜[^]*\+60%/);
});

test("neutral, missing and malformed records render safely without inventing momentum", () => {
  for (const entry of [undefined, null, { id: "a" }, faction("neutral", 0),
    { id: "neutral", heavenCycle: { phase: "victory", strength: 6 } },
    { id: "a", heavenCycle: null }, faction('bad\" onclick=\"bad', 6)]) {
    const html = assertMatchesStatus(entry);
    assert.match(html, /data-heaven-phase="neutral"/);
    assert.match(html, /天意未动/);
    assert.match(html, /<b>无修正<\/b>/);
    assert.doesNotMatch(html, /NaN|Infinity|onclick=/);
  }
  for (const strength of [NaN, Infinity, -1, "5", 1.5]) {
    const html = assertMatchesStatus(faction("victory", strength, { malformed: true }));
    assert.match(html, /data-heaven-strength="1"/);
    assert.doesNotMatch(html, /NaN|Infinity|\[object Object\]/);
  }
});

test("topbar rendering follows configured limits and rates rather than duplicating balance rules", () => {
  const config = { research: { heavenCycle: { maxStrength: 10, victoryPenaltyPerStrength: .05, defeatBonusPerStrength: .02 } } };
  assert.match(assertMatchesStatus(faction("victory", 3), config), /−15%/);
  assert.match(assertMatchesStatus(faction("defeat", 3), config), /\+6%/);
  assert.match(assertMatchesStatus(faction("victory", 10), config), /10\/10/);
});

test("last event reasons are escaped in the tooltip and cannot create HTML or attributes", () => {
  const html = assertMatchesStatus(faction("defeat", 2, '失去 <img src=x onerror=bad> \" onclick=\"bad & 军府'));
  assert.match(html, /最近：失去 &lt;img src=x onerror=bad&gt; &quot; onclick=&quot;bad &amp; 军府/);
  assert.doesNotMatch(html, /<img|" onclick="|" onerror="/);
  assert.equal((html.match(/\btitle="/g) ?? []).length, 1);
});

test("repeated topbar rendering never advances, normalizes or mutates a saved cycle", () => {
  const entries = [{ id: "a" }, faction("neutral", 0), faction("victory", 100, "取得许昌"), faction("defeat", -2)];
  const before = structuredClone(entries), config = structuredClone(rules), originalConfig = structuredClone(config);
  for (const entry of entries) for (let index = 0; index < 5; index++) heavenIndicatorMarkup(entry, config);
  assert.deepEqual(entries, before);
  assert.deepEqual(config, originalConfig);
});

test("every playable opening faction displays the initial victory debuff", () => {
  const initial = createInitialState(scenario, rules);
  for (const entry of initial.factions.filter((item) => item.id !== "neutral")) {
    const html = assertMatchesStatus(entry);
    assert.match(html, /data-heaven-phase="victory"/);
    assert.match(html, /胜兵必骄/);
    assert.match(html, /<b>−10%<\/b>/);
    assert.match(html, /data-heaven-strength="1"/);
  }
  const neutral = initial.factions.find((item) => item.id === "neutral");
  if (neutral) assert.match(assertMatchesStatus(neutral), /data-heaven-phase="neutral"/);
});

test("rehydrated campaign indicators show each saved phase and strength instead of opening defaults", () => {
  const saved = createInitialState(scenario, rules);
  const playable = saved.factions.filter((item) => item.id !== "neutral");
  playable[0].heavenCycle = { phase: "defeat", strength: 4, lastReason: "失去陈留" };
  playable[1].heavenCycle = { phase: "victory", strength: 5, lastReason: "取得下邳" };
  playable[2].heavenCycle = { phase: "neutral", strength: 0, lastReason: "" };
  const restored = migrateState(JSON.parse(JSON.stringify(saved)), scenario, rules);
  for (const before of playable.slice(0, 3)) {
    const loaded = restored.factions.find((item) => item.id === before.id);
    assert.equal(heavenIndicatorMarkup(loaded, rules), heavenIndicatorMarkup(before, rules));
    assertMatchesStatus(loaded);
  }
});

test("the council owns the indicator, refreshes it from player state, and opens read-only details", async () => {
  const index = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  const topbar = index.match(/<header class="topbar">[^]*?<\/header>/)?.[0] ?? "";
  assert.doesNotMatch(topbar, /id="(?:heaven-button|policies-button|personal-home-button|audio-button)"/);
  assert.match(topbar, /id="personal-journal-button"/);
  const council = index.slice(index.indexOf('id="strategy-screen"'), index.indexOf('id="battle-screen"'));
  assert.match(council, /<button[^>]*id="heaven-button"[^>]*aria-label="查看天意循环"[^>]*aria-haspopup="dialog"/);
  assert.match(council, /id="policies-button"/);
  assert.doesNotMatch(index, /id="request-expedition-button"/);
  assert.equal((index.match(/id="heaven-button"/g) ?? []).length, 1);
  assert.match(app, /import\s*\{\s*heavenIndicatorMarkup\s*\}\s*from\s*"\.\/ui\/heaven-view\.js"/);
  const ribbon = app.match(/function renderTurnRibbon\(\)\s*\{[^]*?\n\}/)?.[0] ?? "";
  assert.match(ribbon, /querySelector\("#heaven-button"\)\.innerHTML\s*=\s*heavenIndicatorMarkup\(getFaction\(state, state\.playerFactionId\), rules\)/);
  assert.match(app, /querySelector\("#heaven-button"\)\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*if\s*\(state\.started\)\s*policyUI\.showHeavenCycle\(\)/);
});

test("topbar detail dialog is read-only and reads the current loaded campaign on each opening", async () => {
  let current = createInitialState(scenario, rules);
  const openings = [], initial = structuredClone(current);
  const ui = createPolicyUI({ getState: () => current, rules, canEdit: () => false,
    onChange: () => assert.fail("viewing heaven details must not save or mutate policies"),
    dialogs: {
      open: async (options) => { openings.push(options); return true; },
      confirm: () => assert.fail("read-only heaven details must not ask to apply a policy"),
      toast: () => assert.fail("read-only heaven details should open without errors")
    }
  });
  assert.equal(typeof ui.showHeavenCycle, "function");
  await ui.showHeavenCycle();
  assert.equal(openings[0].title, "天意与改革规则");
  assert.equal(openings[0].hideCancel, true);
  assert.equal(openings[0].confirmText, "返回军府");
  assert.equal(openings[0].onConfirm, undefined);
  assert.match(openings[0].content, /胜兵必骄/);
  assert.deepEqual(current, initial);
  const loaded = createInitialState(scenario, rules);
  loaded.factions.find((item) => item.id === loaded.playerFactionId).heavenCycle = {
    phase: "defeat", strength: 6, lastReason: "失去城池后的存档"
  };
  current = migrateState(JSON.parse(JSON.stringify(loaded)), scenario, rules);
  const before = structuredClone(current);
  await ui.showHeavenCycle();
  assert.match(openings[1].content, /哀兵必胜/);
  assert.match(openings[1].content, /\+60%/);
  assert.match(openings[1].content, /class="heaven-panel defeat"/);
  assert.deepEqual(current, before);
});
