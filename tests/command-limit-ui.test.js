import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { commandLimitEnabled } from "../src/js/game/commands.js";
import { buildTurnOpening } from "../src/js/ui/story-dialog.js";
import { taskOrderNote } from "../src/js/ui/task-windows.js";
import { stratagemPreviewMarkup } from "../src/js/ui/stratagem-windows.js";
import { saveCardMarkup } from "../src/js/ui/save-windows.js";
import { createEconomyUI } from "../src/js/ui/economy-windows.js";

const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
const unlimited = { commandLimitEnabled: false };

test("turn openings explain unlimited orders for both the lord and narrator without freeing officers", () => {
  for (const officers of [[], [{ id: "lord", name: "刘备", factionId: "liu", status: "active" }]]) {
    const state = { ...unlimited, year: 196, month: 11, commandsRemaining: 0, playerFactionId: "liu",
      factions: [{ id: "liu", name: "刘备军", lord: "lord" }], officers };
    const report = buildTurnOpening(state).text.join("");
    assert.match(report, /指令不限/);
    assert.match(report, /每人通常只能行动一次/);
    assert.doesNotMatch(report, /0 道指令/);
    state.commandLimitEnabled = true;
    assert.match(buildTurnOpening(state).text.join(""), /0 道指令/);
  }
});

test("task and strategy notices retain resource/officer costs while making order costs conditional", () => {
  assert.match(taskOrderNote({}, "trade"), /占用一道指令、执行武将和所需物资/);
  const note = taskOrderNote(unlimited, "trade");
  assert.match(note, /指令数不限/);
  assert.match(note, /占用执行武将和所需物资/);
  assert.doesNotMatch(note, /一道指令/);
  const preview = { ok: true, cost: 250, chance: 0.5 };
  assert.match(stratagemPreviewMarkup(preview), /一道指令/);
  const text = stratagemPreviewMarkup(preview, {}, unlimited);
  assert.match(text, /金 250/);
  assert.match(text, /占用费用、执行武将/);
  assert.doesNotMatch(text, /一道指令/);
});

test("save-card summaries use current rules, including old zero-order saves", () => {
  const save = { id: "active", label: "自动存档", factionName: "刘备军", year: 196, month: 11, cities: 2, commands: 0 };
  assert.match(saveCardMarkup(save), /余 0 道指令/);
  const html = saveCardMarkup(save, true, unlimited);
  assert.match(html, /指令不限/);
  assert.match(html, /checked/);
  assert.doesNotMatch(html, /余 0 道指令/);
  assert.match(saveCardMarkup({ ...save, commandLimitEnabled: false }, false, { commandLimitEnabled: true }), /余 0 道指令/);
});

test("actual HUD renderer hides spent tokens only while the limit is disabled", () => {
  const source = app.slice(app.indexOf("function renderTurnRibbon()"), app.indexOf("function renderCityList()"));
  const elements = new Map();
  const context = { state: { ...unlimited, commandsRemaining: 0, commandsMax: 6, month: 11, started: true },
    document: { querySelector: (selector) => {
      if (!elements.has(selector)) elements.set(selector, {});
      return elements.get(selector);
    } },
    getCampaignStatus: () => ({ status: "active", ownedCities: 2 }),
    getFaction: () => ({ name: "刘备军", researchPoints: 100 }), number: String,
    advancingMonth: false, battle: null, seasons: [], monthNames: [], eraLabel: () => "建安元年",
    grainExchangeRate: () => 8, rules: { economy: { harvestMonth: 7 } }, commandLimitEnabled };
  runInNewContext(`${source}; renderTurnRibbon();`, context);
  assert.equal(elements.get("#command-label").textContent, "不限");
  assert.equal(elements.get("#command-pips").hidden, true);
  assert.equal(elements.get("#command-pips").innerHTML, "");
  context.state.commandLimitEnabled = true;
  runInNewContext(`${source}; renderTurnRibbon();`, context);
  assert.equal(elements.get("#command-label").textContent, "0 / 6");
  assert.equal(elements.get("#command-pips").hidden, false);
  assert.equal((elements.get("#command-pips").innerHTML.match(/spent/g) ?? []).length, 6);
});

test("merchant entry permits exhausted budgets in unlimited mode but still requires an idle officer", async (t) => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const messages = [];
  const reachedForm = new Error("merchant form reached");
  globalThis.document = {
    querySelector: () => ({ append: (toast) => messages.push(toast.textContent) }),
    createElement: () => ({ set innerHTML(value) { throw reachedForm; } })
  };
  globalThis.window = { setTimeout() {} };
  t.after(() => { globalThis.document = previousDocument; globalThis.window = previousWindow; });
  const state = { ...unlimited, month: 11, commandsRemaining: 0, playerFactionId: "a",
    cities: [{ id: "home", name: "本城", factionId: "a", officerIds: ["officer"], gold: 100, food: 1000 }],
    officers: [{ id: "officer", acted: false, status: "active" }] };
  const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
  const ui = createEconomyUI({ getState: () => state, rules, onChange() {} });
  await assert.rejects(ui.showTrade("home"), (error) => error === reachedForm);
  assert.deepEqual(messages, []);
  state.officers[0].acted = true;
  await ui.showTrade("home");
  assert.equal(messages.at(-1), "交易需要一名未行动武将");
  state.officers[0].acted = false;
  state.commandLimitEnabled = true;
  await ui.showTrade("home");
  assert.equal(messages.at(-1), "交易需要一名未行动武将与一道指令");
});

test("city/trade buttons route through the shared switch and help/confirmation reflect active rules", async () => {
  assert.doesNotMatch(app, /state\.commandsRemaining\s*(?:<=|===|==|<)\s*0/);
  assert.match(app, /if \(!canIssueCommand\(state\) && commandSpendingActions\.has\(id\)\)/);
  assert.match(app, /tradeButton\.disabled = [^\n]*!canIssueCommand\(state\)/);
  assert.match(app, /commandLimitEnabled\(state\) \? `尚余[^\n]*测试期间本月指令不限/);
  assert.match(app, /commandLimitEnabled\(state\) \? `每月有[^\n]*测试期间君主指令数不限/);
  assert.match(app, /saveGameDialog\(\{\s*rules,/);
  assert.match(app, /createMainMenu\(\{ getSaves:[^\n]*rules,/);
  const main = await readFile(new URL("../src/js/ui/main-menu.js", import.meta.url), "utf8");
  assert.match(main, /chooseLoadSlot\(saves, \{ rules \}\)/);
});
