import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ambushPreparationMarkup, createStratagemUI, stratagemPreviewMarkup } from "../src/js/ui/stratagem-windows.js";
import { createCampaignUI, employCandidateRows, employPreviewMarkup } from "../src/js/ui/campaign-windows.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));
const officer = (id, factionId, locationCityId, extra = {}) => ({ id, name: id, factionId, locationCityId, status: "active",
  rank: "校尉", intelligence: 80, charm: 80, loyalty: 50, acted: false, ...extra });
const city = (id, factionId, officerIds, adjacent, troops = 5000) => ({ id, name: id, factionId, officerIds, adjacent, troops,
  gold: 5000, food: 10000, training: 80, morale: 80, popularSupport: 70 });
function fixture() {
  return { year: 196, month: 1, elapsedMonths: 0, playerFactionId: "a", commandsRemaining: 6, eventLog: [], tasks: [],
    factions: [{ id: "a", name: "我军", lord: "envoy" }, { id: "b", name: "敌军", lord: "lord" }, { id: "c", name: "远方" }],
    cities: [city("home", "a", ["envoy", "helper"], ["enemy"], 20000), city("enemy", "b", ["lord", "low", "high", "busy"], ["home"]), city("far", "c", ["far-officer"], [])],
    officers: [officer("envoy", "a", "home", { rank: "君主" }), officer("helper", "a", "home"),
      officer("lord", "b", "enemy", { rank: "君主" }), officer("low", "b", "enemy", { acted: true }),
      officer("high", "b", "enemy", { loyalty: 90 }), officer("busy", "b", "enemy", { taskId: "busy-task" }),
      officer("far-officer", "c", "far"), officer("free", null, "home", { status: "free", discovered: true }),
      officer("captured", null, "home", { status: "captured", discovered: true, captorFactionId: "a" }),
      officer("hidden", null, "home", { status: "free", discovered: false })] };
}

// A focused DOM harness exercises real shared dialogs and queueTask; it does not assert layout.
function installDocument(t) {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const doc = { activeElement: null, defaultView: { matchMedia: () => ({ matches: true }) }, addEventListener() {}, removeEventListener() {} };
  function element(tag = "div") {
    const node = { tag, ownerDocument: doc, children: [], attributes: {}, dataset: {}, style: {}, className: "", listeners: new Map(), value: "", isConnected: true,
      append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
      remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); },
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      async emit(name) { return this.listeners.get(name)?.({ target: this }); },
      focus() { doc.activeElement = this; }, getClientRects() { return [{}]; },
      contains(other) { return this === other || this.children.some((child) => child.contains(other)); },
      closest(selector) { return this.className.split(" ").includes(selector.slice(1)) ? this : this.parent?.closest(selector) ?? null; },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
      querySelectorAll(selector) {
        const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
        if (selector === "*") return descendants;
        if (selector.startsWith("button:")) return descendants.filter((child) => child.tag === "button" && !child.disabled);
        return descendants.filter((child) => selector.split(",").some((part) => {
          const item = part.trim();
          return item.startsWith(".") ? child.className.split(" ").includes(item.slice(1))
            : item.startsWith("[") ? item.slice(1, -1) in child.attributes : child.tag === item;
        }));
      },
      insertAdjacentHTML(position, value) { this.markup += value; },
      get innerHTML() { return this.markup ?? ""; },
      set innerHTML(value) {
        this.markup = value; this.children = [];
        if (this.tag === "select") {
          this.options = [...value.matchAll(/<option\b([^>]*)>([^]*?)<\/option>/g)].map((match) => ({
            value: match[1].match(/value="([^"]*)"/)?.[1] ?? "", disabled: /\bdisabled\b/.test(match[1]), label: match[2]
          }));
          this.value = this.options.find((option) => !option.disabled)?.value ?? "";
          return;
        }
        if (value.includes('class="modal ')) {
          const panel = element(); panel.className = "modal";
          for (const [name, tag] of [["modal-body", "div"], ["modal-close", "button"], ["dialog-cancel", "button"], ["dialog-confirm", "button"]]) {
            const child = element(tag); child.className = name; panel.append(child);
          }
          this.append(panel); return;
        }
        for (const match of value.matchAll(/<(select|div)\b([^>]*\bdata-[^>]*)>/g)) {
          const child = element(match[1]);
          for (const attr of match[2].matchAll(/\b(data-[\w-]+)(?:="([^"]*)")?/g)) child.attributes[attr[1]] = attr[2] ?? "";
          if (child.tag === "select") child.innerHTML = value.slice(match.index + match[0].length).split("</select>")[0];
          this.append(child);
        }
      }
    };
    return node;
  }
  const root = element(), toasts = element();
  doc.createElement = element;
  doc.querySelector = (selector) => selector === "#modal-root" ? root : toasts;
  globalThis.document = doc;
  globalThis.window = { ...doc.defaultView, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1 };
  t.after(() => { globalThis.document = previousDocument; globalThis.window = previousWindow; });
  return { root, toasts, current: () => root.children.filter((child) => child.dataset.windowClosing !== "true").at(-1) };
}

test("strategy previews show rule-backed cost, chance, effects and deferred settlement while escaping text", () => {
  const html = stratagemPreviewMarkup({ ok: true, chance: 0.72, cost: 321, effect: '<img src="x">民心 -12', message: "可执行" });
  assert.match(html, /金 321.*72%/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /月末/);
  assert.match(html, /不会提前改变/);
  assert.match(stratagemPreviewMarkup({ ok: false, message: "本月指令已用尽" }, { cost: 200 }), /economy-warning[^]*本月指令已用尽/);
});

test("enemy recruitment lists local free and captured plus adjacent non-lords with rule-derived rejection reasons", () => {
  const state = fixture();
  const before = structuredClone(state);
  const rows = employCandidateRows(state, "home", rules, "envoy");
  assert.deepEqual(rows.filter((row) => row.available).map((row) => row.officer.id).sort(), ["captured", "free", "low"]);
  assert.deepEqual(rows.filter((row) => !row.available).map((row) => row.officer.id).sort(), ["busy", "high"]);
  assert.equal(rows.find((row) => row.officer.id === "low").origin.id, "enemy");
  assert.match(rows.find((row) => row.officer.id === "high").condition, /忠诚.*60/);
  assert.match(rows.find((row) => row.officer.id === "busy").condition, /执行任务/);
  assert.deepEqual(state, before);
});

test("allied officers remain visible but cannot be selected and preview explains the restriction", () => {
  const state = fixture();
  state.relations = { "a|b": { friendliness: 90, allianceUntil: state.year * 12 + state.month + 6 } };
  const row = employCandidateRows(state, "home", rules, "envoy").find((entry) => entry.officer.id === "low");
  assert.equal(row.available, false);
  assert.match(row.condition, /盟友/);
  assert.match(employPreviewMarkup({ ok: false, message: "盟友不可招揽" }, rules), /economy-warning[^]*盟友不可招揽/);
  assert.match(employPreviewMarkup({ ok: true, chance: 0.4, enemyRecruit: true }, rules), /40%[^]*不带走原城兵力、钱粮或城池/);
});

test("rumor window opens without mutation and confirmation queues, rather than instantly changing the target", async (t) => {
  const dom = installDocument(t), state = fixture();
  const before = structuredClone(state), changes = [];
  const pending = createStratagemUI({ getState: () => state, rules, onChange: (message) => changes.push(message) }).showStratagem("rumor", "enemy");
  assert.deepEqual(state, before);
  const body = dom.current().querySelector(".modal-body");
  assert.equal(body.querySelector("[data-stratagem-source]").value, "home");
  assert.equal(body.querySelector("[data-stratagem-executor]").value, "envoy");
  assert.match(body.querySelector("[data-stratagem-preview]").innerHTML, /民心/);
  await dom.current().querySelector(".dialog-confirm").emit("click");
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(state.tasks[0].kind, "stratagem");
  assert.deepEqual(state.tasks[0].payload, { action: "rumor", targetId: "enemy" });
  assert.equal(state.tasks[0].status, "running");
  assert.equal(state.cities[1].popularSupport, before.cities[1].popularSupport);
  assert.equal(state.cities[1].morale, before.cities[1].morale);
  assert.equal(changes.length, 1);
});

test("discord exposes only target-city non-lords and submits the selected victim in a deferred order", async (t) => {
  const dom = installDocument(t), state = fixture();
  const pending = createStratagemUI({ getState: () => state, rules }).showStratagem("discord", "enemy");
  const target = dom.current().querySelector("[data-stratagem-target-officer]");
  assert.deepEqual(target.options.map((option) => option.value), ["low", "high", "busy"]);
  target.value = "high";
  await target.emit("change");
  assert.match(dom.current().querySelector("[data-stratagem-preview]").innerHTML, /high.*忠诚/);
  await dom.current().querySelector(".dialog-confirm").emit("click");
  await pending;
  assert.equal(state.tasks[0].payload.targetOfficerId, "high");
  assert.equal(state.officers.find((officer) => officer.id === "high").loyalty, 90);
});

test("surrender requires a second explicit confirmation of whole-faction consequences", async (t) => {
  const dom = installDocument(t), state = fixture();
  const pending = createStratagemUI({ getState: () => state, rules }).showStratagem("surrender", "enemy");
  const first = dom.current();
  const confirm = first.querySelector(".dialog-confirm").emit("click");
  assert.notEqual(dom.current(), first);
  assert.match(dom.current().querySelector(".modal-body").innerHTML, /敌军全势力[^]*整体归附/);
  assert.equal(state.tasks.length, 0);
  await dom.current().querySelector(".dialog-confirm").emit("click");
  await confirm; await pending;
  assert.equal(state.tasks[0].payload.action, "surrender");
  assert.equal(state.cities[1].factionId, "b");
});

test("own-city ambush preparation explains one-use duration and stays pending until month-end", async (t) => {
  const dom = installDocument(t), state = fixture();
  const pending = createStratagemUI({ getState: () => state, rules }).showStratagem("prepareAmbush", "home");
  const content = dom.current().querySelector(".modal-body").children[0];
  assert.match(content.innerHTML, /首次有效伏击的一击[^]*25%[^]*3 个月，不叠加/);
  assert.deepEqual(content.querySelector("[data-stratagem-source]").options.map((option) => option.value), ["home"]);
  await dom.current().querySelector(".dialog-confirm").emit("click");
  await pending;
  assert.equal(state.tasks[0].payload.action, "prepareAmbush");
  assert.equal(state.cities[0].ambushPreparation, undefined);
});

test("enemy employment uses the reusable window, disables ineligible targets, and preserves target before settlement", async (t) => {
  const dom = installDocument(t), state = fixture();
  const pending = createCampaignUI({ getState: () => state, rules, onChange() {} }).showEmploy("home");
  const target = dom.current().querySelector("[data-target]");
  assert.equal(target.options.find((option) => option.value === "high").disabled, true);
  assert.equal(target.options.find((option) => option.value === "busy").disabled, true);
  assert.match(target.options.find((option) => option.value === "low").label, /enemy.*忠诚 50/);
  target.value = "low";
  await target.emit("change");
  assert.match(dom.current().querySelector("[data-employ-preview]").innerHTML, /不带走原城兵力/);
  await dom.current().querySelector(".dialog-confirm").emit("click");
  await pending;
  assert.equal(state.tasks[0].kind, "employ");
  assert.equal(state.tasks[0].payload.targetId, "low");
  assert.equal(state.officers.find((officer) => officer.id === "low").factionId, "b");
  assert.equal(state.officers.find((officer) => officer.id === "low").locationCityId, "enemy");
});

test("a now-invalid strategy leaves the window open, shows why, and spends nothing", async (t) => {
  const dom = installDocument(t), state = fixture();
  const pending = createStratagemUI({ getState: () => state, rules }).showStratagem("rumor", "enemy");
  state.commandsRemaining = 0;
  const gold = state.cities[0].gold;
  await dom.current().querySelector(".dialog-confirm").emit("click");
  assert.equal(state.tasks.length, 0);
  assert.equal(state.cities[0].gold, gold);
  assert.match(dom.current().querySelector("[data-stratagem-preview]").innerHTML, /指令已用尽/);
  await dom.current().querySelector(".dialog-cancel").emit("click");
  assert.equal(await pending, null);
});

test("strategy confirmation is disabled for an empty source and re-enabled when a valid source is selected", async (t) => {
  const dom = installDocument(t), state = fixture();
  state.cities.push(city("empty", "a", [], ["enemy"]));
  const pending = createStratagemUI({ getState: () => state, rules }).showStratagem("rumor", "enemy");
  const source = dom.current().querySelector("[data-stratagem-source]");
  const confirm = dom.current().querySelector(".dialog-confirm");
  assert.equal(confirm.disabled, false);
  source.value = "empty";
  await source.emit("change");
  assert.equal(confirm.disabled, true);
  assert.match(confirm.title, /执行武将/);
  source.value = "home";
  await source.emit("change");
  assert.equal(confirm.disabled, false);
  await dom.current().querySelector(".dialog-cancel").emit("click");
  assert.equal(await pending, null);
});

test("employment confirmation is disabled when no executor is available", async (t) => {
  const dom = installDocument(t), state = fixture();
  state.officers.filter((officer) => officer.factionId === "a").forEach((officer) => { officer.acted = true; });
  const pending = createCampaignUI({ getState: () => state, rules, onChange() {} }).showEmploy("home");
  const confirm = dom.current().querySelector(".dialog-confirm");
  assert.equal(confirm.disabled, true);
  assert.match(dom.current().querySelector("[data-employ-preview]").innerHTML, /执行武将/);
  await dom.current().querySelector(".dialog-cancel").emit("click");
  await pending;
  assert.equal(state.tasks.length, 0);
});

test("ambush status counts remaining months and hides expired, consumed or former-owner records", () => {
  const state = fixture(), city = state.cities[0];
  state.elapsedMonths = 4;
  city.ambushPreparation = { id: "preparation", factionId: "a", expiresTurn: 6, bonus: 0.25 };
  const html = ambushPreparationMarkup(city, state);
  assert.match(html, /伏兵准备 · 有效 · 剩余 2 个月/);
  assert.match(html, /首次有效伏击的一击伤害 \+25%/);
  assert.match(html, /不叠加加成，仍须支付本次费用/);
  state.elapsedMonths = 6;
  assert.equal(ambushPreparationMarkup(city, state), "");
  state.elapsedMonths = 4;
  city.factionId = "b";
  assert.equal(ambushPreparationMarkup(city, state), "");
  city.factionId = "a";
  delete city.ambushPreparation;
  assert.equal(ambushPreparationMarkup(city, state), "");
});

test("reopening ambush preparation shows the existing valid preparation without refreshing or charging it", async (t) => {
  const dom = installDocument(t), state = fixture();
  state.elapsedMonths = 5;
  state.cities[0].ambushPreparation = { id: "existing", factionId: "a", expiresTurn: 8, bonus: 0.25 };
  const before = structuredClone(state);
  const pending = createStratagemUI({ getState: () => state, rules }).showStratagem("prepareAmbush", "home");
  assert.match(dom.current().querySelector(".modal-body").children[0].innerHTML, /伏兵准备 · 有效 · 剩余 3 个月/);
  assert.deepEqual(state, before);
  await dom.current().querySelector(".dialog-cancel").emit("click");
  await pending;
  assert.deepEqual(state, before);
});
