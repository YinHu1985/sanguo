import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chooseGameMenu, gameMenuBlockReason } from "../src/js/ui/game-menu.js";
import { chooseLoadSlot, saveCardMarkup, saveGameDialog } from "../src/js/ui/save-windows.js";

const activeState = () => ({ started: true, tasks: [], pendingInvasions: [], turnResolution: null });
const save = (changes = {}) => ({ id: "manual-1", label: "手动存档 1", factionName: "曹操军", year: 196,
  month: 11, cities: 6, commands: 4, pending: false, empty: false, invalid: false, ...changes });
const emptySlot = (number, invalid = false) => ({ id: `manual-${number}`, label: `手动存档 ${number}`, empty: true, invalid });

test("game menu blocks battle, enemy animation and every unfinished campaign transition", () => {
  for (const flags of [{ battle: {} }, { processingEnemy: true }]) {
    assert.match(gameMenuBlockReason({ state: activeState(), ...flags }), /当前正在战斗/);
  }
  for (const flags of [{ advancingMonth: true }, { showingOpening: true }, { switchingCampaign: true }]) {
    assert.match(gameMenuBlockReason({ state: activeState(), ...flags }), /月结或军情/);
  }
  for (const changes of [{ turnResolution: { stage: "opening" } }, { turnResolution: { stage: "tasks" } },
    { tasks: [{ status: "awaiting_battle" }] }, { pendingInvasions: [{ resolved: false }] },
    { pendingInvasions: [{}] }]) {
    assert.match(gameMenuBlockReason({ state: { ...activeState(), ...changes } }), /月结或军情/);
  }
});

test("settled campaigns can save while ordinary future tasks remain queued", () => {
  assert.equal(gameMenuBlockReason({ state: activeState() }), "");
  assert.equal(gameMenuBlockReason({ state: { ...activeState(), tasks: [{ status: "running" }],
    pendingInvasions: [{ resolved: true }] } }), "");
  assert.match(gameMenuBlockReason({ state: { started: false } }), /尚未开始/);
  assert.match(gameMenuBlockReason({}), /尚未开始/);
});

test("save cards distinguish empty, damaged and unfinished-checkpoint slots", () => {
  const empty = saveCardMarkup(emptySlot(2), true);
  assert.match(empty, /空白存档/);
  assert.match(empty, /value="manual-2" checked/);
  assert.doesNotMatch(empty, /undefined|月结尚未完成/);
  const damaged = saveCardMarkup(emptySlot(3, true));
  assert.match(damaged, /存档无法读取/);
  assert.match(damaged, /覆盖前会再次确认/);
  assert.doesNotMatch(damaged, /undefined/);
  assert.match(saveCardMarkup(save({ pending: true })), /月结尚未完成/);
  assert.match(saveCardMarkup(save()), /战略进度已保存在本机/);
});

test("save cards escape every externally supplied display field and radio value", () => {
  const attack = '<img src=x onerror="alert(1)">';
  for (const key of ["id", "label", "factionName", "year", "month", "cities", "commands"]) {
    const html = saveCardMarkup(save({ [key]: attack }));
    assert.ok(!html.includes("<img"), `${key} must never become live HTML`);
    assert.match(html, /&lt;img/);
  }
});

// A minimal DOM fixture exercises the real shared dialog controller, including
// nested confirmation ownership, while leaving browser layout to visual QA.
function element(doc, className = "") {
  return {
    ownerDocument: doc, className, dataset: {}, attributes: {}, style: {}, children: [], listeners: new Map(), isConnected: false,
    append(...nodes) { for (const node of nodes) { node.parent = this; node.isConnected = true; this.children.push(node); } },
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); },
    removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== fn)); },
    click() {
      if (this.disabled) return;
      const event = { target: this };
      for (let current = this; current; current = current.parent) {
        for (const fn of current.listeners.get("click") ?? []) fn(event);
      }
    },
    contains(target) { return this === target || this.children.some((child) => child.contains(target)); },
    focus() { doc.activeElement = this; },
    getClientRects() { return this.hidden ? [] : [{}]; },
    matches(selector) {
      if (selector === "*") return true;
      if (selector.startsWith("button:")) return this.button && !this.hidden && !this.disabled;
      if (selector === '[data-system-action]') return Boolean(this.dataset.systemAction);
      if (selector === 'input[name="save-slot"]:checked') return this.input && this.checked;
      return selector.startsWith(".") && this.className.split(" ").includes(selector.slice(1));
    },
    closest(selector) { for (let item = this; item; item = item.parent) if (item.matches(selector)) return item; return null; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    querySelectorAll(selector) {
      const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
      const selectors = selector.split(",").map((part) => part.trim());
      return descendants.filter((item) => selectors.some((part) => item.matches(part)));
    },
    get innerHTML() { return this.html ?? ""; },
    set innerHTML(html) {
      this.html = html;
      if (html.includes('class="modal ')) {
        const panel = element(doc, "modal");
        const body = element(doc, "modal-body");
        panel.append(body);
        for (const cls of ["modal-close", "dialog-cancel", "dialog-confirm"]) {
          if (!html.includes(cls)) continue;
          const button = element(doc, cls); button.button = true; panel.append(button);
        }
        this.append(panel);
      } else {
        for (const match of html.matchAll(/<input type="radio" name="save-slot" value="([^"]*)"\s*(checked)?/g)) {
          const radio = element(doc); radio.input = true; radio.value = match[1]; radio.checked = Boolean(match[2]); this.append(radio);
        }
        for (const match of html.matchAll(/<button[^>]*data-system-action="([^"]*)"([^>]*)>/g)) {
          const button = element(doc, "system-menu-option"); button.button = true;
          button.dataset.systemAction = match[1]; button.disabled = match[2].includes("disabled"); this.append(button);
        }
      }
    }
  };
}

function installDocument(t) {
  const doc = { activeElement: null, defaultView: { matchMedia: () => ({ matches: true }) }, listeners: new Map() };
  const root = element(doc);
  const toasts = element(doc);
  doc.createElement = () => element(doc);
  doc.querySelector = (selector) => selector === "#modal-root" ? root : toasts;
  doc.addEventListener = root.addEventListener.bind(doc);
  doc.removeEventListener = root.removeEventListener.bind(doc);
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, setTimeout: () => 0, ...doc.defaultView };
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
  return { root, toasts, top: () => root.children.filter((item) => item.dataset.windowClosing !== "true").at(-1) };
}
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

test("game menu opens with three options and disables only load when no saves exist", async (t) => {
  const { top } = installDocument(t);
  const result = chooseGameMenu({ summary: "曹操军", canLoad: false });
  const options = top().querySelectorAll("[data-system-action]");
  assert.deepEqual(options.map((item) => [item.dataset.systemAction, item.disabled]), [["save", false], ["load", true], ["title", false]]);
  top().querySelector(".dialog-confirm").click();
  assert.equal(await result, null, "continue closes without navigating to the title scene");
});

test("a blocked menu disables save, load and title, and escapes its summary and warning", async (t) => {
  const { top } = installDocument(t);
  const result = chooseGameMenu({ summary: "<img>势力", blockedReason: "<b>处理中" });
  const body = top().querySelector(".system-menu");
  assert.doesNotMatch(body.innerHTML, /<img>|<b>处理中/);
  assert.match(body.innerHTML, /&lt;img&gt;/);
  assert.match(body.innerHTML, /&lt;b&gt;处理中/);
  assert.ok(top().querySelectorAll("[data-system-action]").every((item) => item.disabled));
  top().querySelector(".modal-close").click();
  assert.equal(await result, null);
});

test("choosing a game-menu option closes the parent and returns only the chosen action", async (t) => {
  const { top } = installDocument(t);
  const result = chooseGameMenu({ summary: "刘备军" });
  const backdrop = top();
  backdrop.querySelectorAll("[data-system-action]").find((item) => item.dataset.systemAction === "save").click();
  assert.equal(await result, "save");
  assert.equal(backdrop.dataset.windowClosing, "true");
});

test("title load selection uses the shared chooser without an unnecessary replace-current prompt", async (t) => {
  const { top, root } = installDocument(t);
  assert.equal(await chooseLoadSlot([]), null);
  assert.equal(root.children.length, 0);
  const result = chooseLoadSlot([save()]);
  top().querySelector(".dialog-confirm").click();
  assert.equal(await result, "manual-1");
});

test("in-game loading requires confirmation and cancellation keeps the load list open", async (t) => {
  const { top } = installDocument(t);
  const result = chooseLoadSlot([save()], { inGame: true });
  const list = top();
  list.querySelector(".dialog-confirm").click();
  assert.notEqual(top(), list);
  assert.match(top().innerHTML, /确认读取存档/);
  top().querySelector(".dialog-cancel").click();
  await flush();
  assert.equal(top(), list);
  assert.equal(list.querySelector(".dialog-confirm").disabled, false);
  list.querySelector(".dialog-confirm").click();
  top().querySelector(".dialog-confirm").click();
  assert.equal(await result, "manual-1");
});

test("save chooser initially selects the first clean empty slot, never a damaged one", async (t) => {
  const { top } = installDocument(t);
  let chosen;
  const result = saveGameDialog({ getSlots: () => [emptySlot(1, true), save({ id: "manual-2" }), emptySlot(3)],
    onSave: (id) => { chosen = id; } });
  assert.equal(top().querySelector('input[name="save-slot"]:checked').value, "manual-3");
  top().querySelector(".dialog-confirm").click();
  assert.equal(await result, "manual-3");
  assert.equal(chosen, "manual-3");
});

test("saving re-reads the slot before writing so newly occupied records still require overwrite confirmation", async (t) => {
  const { top } = installDocument(t);
  let slots = [emptySlot(1)];
  let writes = 0;
  const result = saveGameDialog({ getSlots: () => slots, onSave: () => { writes += 1; } });
  const list = top();
  slots = [save()];
  list.querySelector(".dialog-confirm").click();
  assert.match(top().innerHTML, /覆盖存档/);
  assert.equal(writes, 0);
  top().querySelector(".dialog-cancel").click();
  await flush();
  assert.equal(top(), list);
  assert.equal(writes, 0);
  list.querySelector(".dialog-cancel").click();
  assert.equal(await result, null);
});

test("damaged manual records are overwritten only after an explicit extra confirmation", async (t) => {
  const { top } = installDocument(t);
  let writes = 0;
  const result = saveGameDialog({ getSlots: () => [emptySlot(1, true)], onSave: () => { writes += 1; } });
  top().querySelector(".dialog-confirm").click();
  assert.match(top().querySelector(".modal-body").innerHTML, /无法读取的原记录将被替换/);
  assert.equal(writes, 0);
  top().querySelector(".dialog-confirm").click();
  assert.equal(await result, "manual-1");
  assert.equal(writes, 1);
});

test("a failed manual write remains in the save chooser and reports failure instead of claiming success", async (t) => {
  const { top, toasts } = installDocument(t);
  let writes = 0;
  const result = saveGameDialog({ getSlots: () => [emptySlot(1)], onSave: () => { writes += 1; throw new Error("配额不足，未改动旧档"); } });
  const list = top();
  list.querySelector(".dialog-confirm").click();
  await flush();
  assert.equal(writes, 1);
  assert.equal(top(), list);
  assert.equal(list.querySelector(".dialog-confirm").disabled, false);
  assert.equal(toasts.children[0].textContent, "配额不足，未改动旧档");
  list.querySelector(".dialog-cancel").click();
  assert.equal(await result, null);
});

test("top-right game control opens the system menu and has no one-click title binding", async () => {
  const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  assert.match(html, /id="game-menu-button"[^>]*aria-haspopup="dialog"[^>]*>菜单<\/button>/);
  assert.match(app, /querySelector\("#game-menu-button"\)\.addEventListener\("click", openGameMenu\)/);
  assert.doesNotMatch(app, /(?:reset-button|game-menu-button)[^\n]*addEventListener\([^\n]*(?:showMainMenu|returnToTitle)/);
  const menu = app.slice(app.indexOf("async function openGameMenu()"), app.indexOf("async function startCampaign("));
  assert.match(menu, /if \(systemMenuOpen \|\| menuOpen \|\| !sessionEntered\) return/);
  assert.match(menu, /blockedReason: systemMenuBlockReason\(\)/);
  assert.match(menu, /requireSafeCampaignSwitch\(\);\s*saveManualSlot\(slotId, state\)/);
  assert.match(menu, /if \(slotId\) \{\s*requireSafeCampaignSwitch\(\);\s*nextAction = \(\) => loadFromMenu\(slotId\)/);
  assert.ok(menu.indexOf("systemMenuOpen = false") < menu.indexOf("await nextAction()"), "release modal ownership before resuming a loaded month or battle");
  const returning = menu.slice(menu.indexOf('action === "title"'));
  assert.match(returning, /await confirmDialog/);
  assert.match(returning, /if \(confirmed\) \{\s*requireSafeCampaignSwitch\(\);\s*saveState\(state\);\s*nextAction = showMainMenu/);
});

test("title and game menus share the load chooser and campaign-switch implementation", async () => {
  const app = await readFile(new URL("../src/js/app.js", import.meta.url), "utf8");
  const title = await readFile(new URL("../src/js/ui/main-menu.js", import.meta.url), "utf8");
  assert.match(title, /import \{ chooseLoadSlot \} from "\.\/save-windows\.js"/);
  assert.match(title, /await chooseLoadSlot\(saves, \{ rules \}\)/);
  assert.match(app, /await chooseLoadSlot\(listCampaignSaves\(scenario\.id\), \{ inGame: true, rules \}\)/);
  assert.match(app, /onLoad: loadFromMenu/);
  assert.match(app, /nextAction = \(\) => loadFromMenu\(slotId\)/);
  const load = app.slice(app.indexOf("async function loadFromMenu("), app.indexOf("function setMapReading("));
  assert.match(load, /if \(switchingCampaign\) throw new Error/);
  assert.match(load, /finally \{ switchingCampaign = false; \}/);
  assert.ok(load.indexOf("persistCampaignSelection(") < load.indexOf("state = loaded"), "commit durable storage before swapping the live game");
});
