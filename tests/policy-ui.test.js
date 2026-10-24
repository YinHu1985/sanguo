import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPolicyUI, heavenCycleMarkup, ideaGroupsMarkup, ideaTreeLayers, policyWindowMarkup, rollbackConfirmationMarkup, technologyCardsMarkup } from "../src/js/ui/policy-windows.js";
import { getPolicyOverview, rollbackTechnologyPreview } from "../src/js/game/technology.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const state = (points = 5000, unlocked = []) => ({ playerFactionId: "a", year: 196, month: 1, eventLog: [],
  cities: [{ id: "c", factionId: "a" }], factions: [{ id: "a", name: "测试军", researchPoints: points, unlockedTechnologies: unlocked }] });
const card = (html, id) => html.match(new RegExp(`<article[^>]*data-technology="${id}"[^]*?</article>`))?.[0];

/** Small structural reader avoids counting prerequisite links as board nodes. */
function elementWithAttribute(html, attribute, value) {
  const attributePattern = value === undefined ? `${attribute}(?:="[^"]*")?` : `${attribute}="${value}"`;
  const opening = new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\b${attributePattern}(?=[\\s>])[^>]*>`).exec(html);
  if (!opening) return "";
  const tags = new RegExp(`</?${opening[1]}\\b[^>]*>`, "g");
  tags.lastIndex = opening.index;
  let depth = 0;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(opening.index, tags.lastIndex);
  }
  return "";
}

test("policy board simultaneously exposes all four directions, nine groups and every idea once", () => {
  const html = policyWindowMarkup(state(), rules);
  const board = elementWithAttribute(html, "data-policy-board");
  assert.ok(board, "the overview board is separately identifiable from detail links");
  assert.equal((html.match(/data-policy-direction=/g) ?? []).length, 4);
  assert.equal((html.match(/data-policy-axis=/g) ?? []).length, 2);
  assert.equal((board.match(/data-idea-group=/g) ?? []).length, 9);
  assert.equal((board.match(/data-select-technology=/g) ?? []).length, 27);
  for (const direction of Object.keys(rules.policyDirections)) {
    assert.match(elementWithAttribute(board, "data-policy-direction", direction), /^<section\b/);
  }
  for (const [id, technology] of Object.entries(rules.technologies)) {
    assert.equal((board.match(new RegExp(`data-select-technology="${id}"`, "g")) ?? []).length, 1, id);
    const node = elementWithAttribute(board, "data-select-technology", id);
    assert.match(node, /^<button\b/);
    assert.ok(node.includes(`aria-label="查看 ${technology.name}"`));
    assert.doesNotMatch(node, /\bdisabled\b/);
  }
  assert.doesNotMatch(board, /data-unlock-technology|data-rollback-technology|technology-card/);
  assert.equal((html.match(/data-policy-detail=/g) ?? []).length, 1);
  assert.match(html, /data-policy-detail="agriculturalRelief"/);
  assert.doesNotMatch(html, /研究点/);
  assert.match(board, /弩机骑射/);
  assert.match(board, /奇谋攻坚/);
});

test("selection changes only the detail, while locked ideas remain inspectable", () => {
  const html = policyWindowMarkup(state(), rules, true, "dragoon");
  const board = elementWithAttribute(html, "data-policy-board");
  const node = elementWithAttribute(board, "data-select-technology", "dragoon");
  const detail = elementWithAttribute(html, "data-policy-detail", "dragoon");
  assert.match(node, /aria-pressed="true"/);
  assert.doesNotMatch(node, /\bdisabled\b/);
  assert.equal((board.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((html.match(/data-unlock-technology=/g) ?? []).length, 1);
  assert.match(detail, /龙骑军制/);
  assert.match(detail, /良马 ×1、劲弩 ×1、甲胄 ×1/);
  assert.match(detail, /data-select-technology="raiderCavalry"/);
  const purchase = elementWithAttribute(detail, "data-unlock-technology", "dragoon");
  assert.match(purchase, /\bdisabled\b/);
  assert.match(detail, /前置/);
});

test("read-only state disables mutation but leaves all board selection controls available", () => {
  const html = policyWindowMarkup(state(5000, ["militaryDiscipline"]), rules, false, "militaryDiscipline");
  const board = elementWithAttribute(html, "data-policy-board");
  assert.doesNotMatch(board, /\bdisabled\b/);
  assert.equal((board.match(/data-select-technology=/g) ?? []).length, 27);
  const detail = elementWithAttribute(html, "data-policy-detail", "militaryDiscipline");
  assert.match(elementWithAttribute(detail, "data-rollback-technology", "militaryDiscipline"), /\bdisabled\b/);
  assert.equal((html.match(/data-rollback-technology=/g) ?? []).length, 1);
});

test("tree layout follows both branches and chains independently of source order", () => {
  assert.deepEqual(ideaTreeLayers({ nodeIds: ["publicGranaries", "agriculturalRelief", "openMarkets"] }, rules),
    [["agriculturalRelief"], ["publicGranaries", "openMarkets"]]);
  assert.deepEqual(ideaTreeLayers({ nodeIds: ["dragoon", "crossbowEngineering", "raiderCavalry"] }, rules),
    [["crossbowEngineering"], ["raiderCavalry"], ["dragoon"]]);
  const overview = getPolicyOverview(state(), "a", rules);
  const html = ideaGroupsMarkup(state(), rules, [overview.groups.find((group) => group.id === "wangProsperity")]);
  assert.match(html, /class="idea-tree-links"/);
  assert.match(html, /M50,0 V10 H25 V23/);
  assert.match(html, /M50,0 V10 H75 V23/);
  assert.match(html, /style="--idea-columns:2"/);
});

test("compact trees include skip-layer edges and explain external or missing prerequisites", () => {
  const custom = structuredClone(rules);
  custom.technologies.publicGranaries.prerequisites = ["agriculturalRelief", "openMarkets", "militaryDiscipline", "unknownPrerequisite"];
  const html = policyWindowMarkup(state(), custom, true, "publicGranaries");
  const group = elementWithAttribute(html, "data-idea-group", "wangProsperity");
  const connections = elementWithAttribute(group, "class", "policy-route-edges");
  assert.equal((connections.match(/<path\b/g) ?? []).length, 6, "three in-group dependencies, each with a route and arrowhead");
  const detail = elementWithAttribute(html, "data-policy-detail", "publicGranaries");
  assert.match(detail, /data-select-technology="militaryDiscipline"/);
  assert.match(detail, /unknownPrerequisite/);
  assert.match(elementWithAttribute(detail, "data-unlock-technology", "publicGranaries"), /\bdisabled\b/);
  custom.technologies.agriculturalRelief.prerequisites = ["publicGranaries"];
  const malformed = policyWindowMarkup(state(), custom);
  assert.equal((elementWithAttribute(malformed, "data-policy-board").match(/data-select-technology=/g) ?? []).length, 27, "a malformed cycle cannot hang or duplicate the board");
});

test("high balance does not bypass prerequisites and opposition markup shows actual price", () => {
  const html = technologyCardsMarkup(state(), rules);
  assert.match(card(html, "heavyCavalry"), /disabled/);
  assert.match(card(html, "heavyCavalry"), /前置未完成/);
  assert.doesNotMatch(card(html, "militaryDiscipline"), /disabled/);
  const tilted = technologyCardsMarkup(state(5000, ["agriculturalRelief", "openMarkets"]), rules);
  assert.match(card(tilted, "militaryRegisters"), /改革力 <strong>104<\/strong>/);
  assert.match(card(tilted, "militaryRegisters"), /基础 80 · 对立 ×1.3/);
});

test("group completion, placeholders and monthly income are visibly distinct", () => {
  const current = state(1234, ["agriculturalRelief", "openMarkets", "publicGranaries"]);
  current.factions[0].heavenCycle = { phase: "victory", strength: 3 };
  const html = policyWindowMarkup(current, rules);
  assert.match(html, /data-reform-balance>1,234/);
  assert.match(html, /data-reform-monthly>\+77/);
  assert.match(html, /基础 100 ＋ 理念组 10/);
  assert.match(elementWithAttribute(html, "data-idea-group", "wangProsperity"), /is-complete/);
  assert.match(html, /\+10/);
  assert.match(html, /理念占位／效果待定/);
  assert.match(html, /data-policy-help/);
});

test("heaven ring identifies all four phases and follows the shared numeric status", () => {
  const neutral = heavenCycleMarkup(state().factions[0], rules);
  for (const label of ["骄兵必败", "败兵必哀", "哀兵必胜", "胜兵必骄"]) assert.ok(neutral.includes(label));
  assert.match(neutral, /heaven-pointer is-neutral/);
  const victory = heavenCycleMarkup({ id: "a", heavenCycle: { phase: "victory", strength: 6 } }, rules);
  assert.match(victory, /rotate\(360 100 74\)/);
  assert.match(victory, /改革力收入 −60%/);
  assert.match(victory, /×0.4/);
  const defeat = heavenCycleMarkup({ id: "a", heavenCycle: { phase: "defeat", strength: 6 } }, rules);
  assert.match(defeat, /rotate\(180 100 74\)/);
  assert.match(defeat, /改革力收入 \+60%/);
});

test("rollback confirmation lists the whole affected branch, bonus loss, and no refund", () => {
  const current = state(100, ["agriculturalRelief", "openMarkets", "publicGranaries"]);
  const preview = rollbackTechnologyPreview(current, "a", "agriculturalRelief", rules);
  const html = rollbackConfirmationMarkup(preview, rules);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(html, /劝课农桑/);
  assert.match(html, /通商惠工/);
  assert.match(html, /常平义仓/);
  assert.match(html, /富民通商/);
  assert.match(html, /不返还改革力/);
  assert.match(html, /本次回退计一次败/);
});

test("external policy descriptions and rollback titles are HTML escaped", () => {
  const custom = structuredClone(rules);
  custom.ideaGroups.wangProsperity.name = '<img src=x onerror="run()">';
  custom.policyDirections.wang.description = '<script>run()</script>';
  custom.technologies.agriculturalRelief.name = '<b onclick="run()">bad</b>';
  const html = policyWindowMarkup(state(), custom);
  assert.doesNotMatch(html, /<img|<script|<b onclick/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;b onclick/);
  const confirmation = rollbackConfirmationMarkup({ removedIds: ["agriculturalRelief"], lostGroups: ["wangProsperity"] }, custom);
  assert.doesNotMatch(confirmation, /<img|<b onclick/);
});

function harness(t, current = state()) {
  const previousDocument = globalThis.document;
  let activeState = current;
  let body, finishWindow, finishConfirm;
  let confirmationCount = 0, changes = 0;
  let changeFailure = false;
  const toasts = [], helpWindows = [];
  class Body {
    constructor() { this.isConnected = false; this.buttons = []; }
    set innerHTML(value) {
      this.html = value;
      this.buttons = [...value.matchAll(/<button\b([^>]*)>([^]*?)<\/button>/g)].map(([, attributes]) => {
        const dataset = Object.fromEntries([...attributes.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([, key, val]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), val]));
        return { dataset, attributes, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, focus() {}, click() { return this.listeners.click?.(); } };
      });
    }
    querySelectorAll(selector) {
      const attribute = selector.slice(1, -1);
      return this.buttons.filter((button) => new RegExp(`\\b${attribute}(?:=|\\s|$)`).test(button.attributes));
    }
    querySelector(selector) {
      if (!selector.startsWith("[")) return null;
      const match = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
      return match ? this.buttons.find((button) => button.attributes.includes(`${match[1]}="${match[2]}"`)) : this.querySelectorAll(selector)[0] ?? null;
    }
  }
  globalThis.document = { createElement: () => new Body() };
  t.after(() => { globalThis.document = previousDocument; finishWindow?.(); });
  let editable = true;
  const ui = createPolicyUI({ getState: () => activeState, rules, canEdit: () => editable, onChange: () => { changes++; if (changeFailure) throw new Error("save failed"); }, dialogs: {
    open: ({ content }) => {
      if (typeof content === "string") { helpWindows.push(content); return Promise.resolve(true); }
      body = content; body.isConnected = true;
      return new Promise((resolve) => { finishWindow = resolve; });
    },
    confirm: () => { confirmationCount++; return new Promise((resolve) => { finishConfirm = resolve; }); },
    toast: (message) => { toasts.push(message); }
  } });
  const pending = ui.showPolicies();
  return { get current() { return activeState; }, pending, toasts, helpWindows, get body() { return body; }, get confirmations() { return confirmationCount; }, get changes() { return changes; },
    click: (attribute, id) => body.querySelector(`[${attribute}="${id}"]`).click(),
    clickDetail: (id) => body.buttons.find((button) => button.attributes.includes('class="policy-detail-link"') && button.dataset.selectTechnology === id).click(),
    clickHelp: () => body.querySelector("[data-policy-help]").click(),
    replaceState: (next) => { activeState = next; }, failSave: () => { changeFailure = true; },
    confirm: (answer = true) => finishConfirm(answer), close: () => finishWindow(), setEditable: (value) => { editable = value; } };
}

test("confirmation is single-flight and successful adoption rerenders balance and rollback", async (t) => {
  const ui = harness(t);
  const first = ui.click("data-unlock-technology", "agriculturalRelief");
  await ui.click("data-unlock-technology", "agriculturalRelief");
  assert.equal(ui.confirmations, 1);
  ui.confirm();
  await first;
  assert.equal(ui.current.factions[0].researchPoints, 4920);
  assert.equal(ui.changes, 1);
  assert.match(ui.body.html, /data-rollback-technology="agriculturalRelief"/);
  assert.match(ui.body.html, /data-policy-detail="agriculturalRelief"/);
  assert.match(ui.body.html, /data-reform-monthly>\+90/);
});

test("cancelled confirmation and closing the parent window never mutate policy", async (t) => {
  const ui = harness(t);
  const cancelled = ui.click("data-unlock-technology", "agriculturalRelief");
  ui.confirm(false);
  await cancelled;
  assert.equal(ui.current.factions[0].researchPoints, 5000);
  const closing = ui.click("data-unlock-technology", "agriculturalRelief");
  ui.close();
  await ui.pending;
  ui.confirm();
  await closing;
  assert.equal(ui.current.factions[0].researchPoints, 5000);
  assert.equal(ui.changes, 0);
});

test("cost or editability changes during a confirmation force a new review", async (t) => {
  const ui = harness(t);
  const changing = ui.click("data-unlock-technology", "agriculturalRelief");
  ui.current.factions[0].unlockedTechnologies.push("militaryRegisters");
  ui.confirm();
  await changing;
  assert.equal(ui.current.factions[0].researchPoints, 5000);
  assert.match(ui.toasts[0], /局势已变/);
  const blocked = ui.click("data-unlock-technology", "agriculturalRelief");
  ui.setEditable(false);
  ui.confirm();
  await blocked;
  assert.equal(ui.current.factions[0].researchPoints, 5000);
});

test("rollback executes the dependency closure once and keeps the selected idea", async (t) => {
  const ui = harness(t, state(900, ["militaryDiscipline", "heavyCavalry", "guard"]));
  await ui.click("data-select-technology", "militaryDiscipline");
  const rollback = ui.click("data-rollback-technology", "militaryDiscipline");
  ui.confirm();
  await rollback;
  assert.deepEqual(ui.current.factions[0].unlockedTechnologies, []);
  assert.equal(ui.current.factions[0].researchPoints, 900);
  assert.equal(ui.current.factions[0].heavenCycle.phase, "defeat");
  assert.equal(ui.current.factions[0].heavenCycle.strength, 1);
  assert.match(ui.body.html, /data-policy-detail="militaryDiscipline"/);
  assert.match(ui.body.html, /data-unlock-technology="militaryDiscipline"/);
  assert.equal(ui.changes, 1);
});

test("selecting an unavailable idea is read-only and does not trigger confirmation", async (t) => {
  const ui = harness(t, state(0));
  const before = structuredClone(ui.current);
  await ui.click("data-select-technology", "dragoon");
  assert.match(ui.body.html, /data-policy-detail="dragoon"/);
  assert.equal(ui.confirmations, 0);
  assert.equal(ui.current.factions[0].researchPoints, 0);
  assert.deepEqual(ui.current.factions[0].unlockedTechnologies, []);
  assert.equal(ui.changes, 0);
  assert.deepEqual(ui.current, before, "selection does not create a heaven-cycle outcome either");
  ui.setEditable(false);
  await ui.click("data-select-technology", "elephant");
  assert.match(ui.body.html, /data-policy-detail="elephant"/);
  assert.equal(ui.confirmations, 0);
  assert.deepEqual(ui.current, before);
});

test("invalid selected ids fall back safely without hiding any branch", () => {
  const html = policyWindowMarkup(state(), rules, true, "not-a-technology");
  assert.match(html, /data-policy-detail="agriculturalRelief"/);
  assert.equal((elementWithAttribute(html, "data-policy-board").match(/data-select-technology=/g) ?? []).length, 27);
});

test("detail prerequisite links inspect another node without changing the game", async (t) => {
  const ui = harness(t);
  const before = structuredClone(ui.current);
  await ui.click("data-select-technology", "dragoon");
  await ui.clickDetail("raiderCavalry");
  assert.match(ui.body.html, /data-policy-detail="raiderCavalry"/);
  assert.equal(ui.confirmations, 0);
  assert.deepEqual(ui.current, before);
});

test("heaven help opens a separate read-only window and keeps current selection", async (t) => {
  const ui = harness(t);
  const before = structuredClone(ui.current);
  await ui.click("data-select-technology", "guard");
  await ui.clickHelp();
  assert.equal(ui.helpWindows.length, 1);
  assert.match(ui.helpWindows[0], /天意循环/);
  assert.match(ui.helpWindows[0], /已编成的出征部队不变/);
  assert.doesNotMatch(ui.helpWindows[0], /data-unlock-technology|data-rollback-technology/);
  assert.match(ui.body.html, /data-policy-detail="guard"/);
  assert.equal(ui.confirmations, 0);
  assert.deepEqual(ui.current, before);
});

test("loading a different save of the same faction invalidates the old confirmation", async (t) => {
  const ui = harness(t);
  const original = ui.current;
  const pending = ui.click("data-unlock-technology", "agriculturalRelief");
  const loaded = state(2000);
  ui.replaceState(loaded);
  ui.confirm();
  await pending;
  assert.equal(original.factions[0].researchPoints, 5000);
  assert.equal(loaded.factions[0].researchPoints, 2000);
  assert.deepEqual(loaded.factions[0].unlockedTechnologies, []);
  assert.equal(ui.changes, 0);
  assert.match(ui.toasts[0], /征程已变更/);
});

test("a failed save after mutation reports committed state instead of offering a false retry", async (t) => {
  const ui = harness(t);
  ui.failSave();
  const pending = ui.click("data-unlock-technology", "agriculturalRelief");
  ui.confirm();
  await pending;
  assert.equal(ui.current.factions[0].researchPoints, 4920);
  assert.deepEqual(ui.current.factions[0].unlockedTechnologies, ["agriculturalRelief"]);
  assert.equal(ui.changes, 1);
  assert.match(ui.toasts[0], /政策已生效.*保存/);
  assert.match(ui.body.html, /data-rollback-technology="agriculturalRelief"/);
});
