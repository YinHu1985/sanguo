import test from "node:test";
import assert from "node:assert/strict";
import { animatePanel, createSceneTransitionController, enterWindow, isTopWindow, leaveWindow, prefersReducedMotion } from "../src/js/ui/scene-transitions.js";
import { openDialog } from "../src/js/ui/components.js";

function element(doc, className = "") {
  return {
    ownerDocument: doc, className, dataset: {}, style: {}, attributes: {}, children: [], listeners: new Map(), isConnected: false,
    append(...nodes) { for (const node of nodes) { node.parent = this; node.isConnected = true; this.children.push(node); } },
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); },
    removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((entry) => entry !== callback)); },
    dispatch(name, properties = {}) { for (const callback of this.listeners.get(name) ?? []) callback({ target: this, ...properties }); },
    contains(target) { return this === target || this.children.some((node) => node.contains(target)); },
    focus() { doc.activeElement = this; },
    getClientRects() { return this.hidden ? [] : [{}]; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    querySelectorAll(selector) {
      const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return descendants;
      if (selector.startsWith("button:")) return descendants.filter((node) => node.button && !node.hidden && !node.disabled);
      const classes = selector.split(",").map((value) => value.trim().replace(/^\./, ""));
      return descendants.filter((node) => classes.includes(node.className));
    },
    set innerHTML(value) {
      if (!value.includes('class="modal ')) return;
      const panel = element(doc, "modal");
      const body = element(doc, "modal-body");
      const close = element(doc, "modal-close"); close.button = true;
      const cancel = element(doc, "dialog-cancel"); cancel.button = true;
      const confirm = element(doc, "dialog-confirm"); confirm.button = true;
      panel.append(body, close, cancel, confirm);
      this.append(panel);
    }
  };
}

function harness(reduced = false) {
  const doc = { activeElement: null };
  doc.createElement = () => element(doc);
  doc.body = element(doc);
  doc.defaultView = { matchMedia: () => ({ matches: reduced }) };
  const callbacks = new Map();
  let sequence = 0;
  const controller = createSceneTransitionController({
    getDocument: () => doc,
    reducedMotion: () => reduced,
    schedule: (callback) => { const id = ++sequence; callbacks.set(id, callback); return id; },
    unschedule: (id) => callbacks.delete(id)
  });
  return { doc, callbacks, controller };
}

test("scene transitions run once per actual scene change, never on a same-scene render", () => {
  const { doc, controller, callbacks } = harness();
  assert.equal(controller("strategy"), true);
  const first = doc.body.children[0];
  assert.equal(first.dataset.fromScene, "opening");
  assert.equal(first.dataset.toScene, "strategy");
  assert.equal(first.attributes["aria-hidden"], "true");
  assert.equal(controller("strategy"), false);
  assert.equal(callbacks.size, 1);
  assert.equal(doc.body.children[0], first);
  assert.equal(controller("field"), true);
  assert.equal(first.isConnected, false);
  assert.equal(doc.body.children.length, 1);
  assert.equal(callbacks.size, 1);
  assert.equal(doc.body.children[0].dataset.fromScene, "strategy");
  assert.equal(doc.body.children[0].dataset.toScene, "field");
});

test("rapid scene changes replace the old veil and clean up without changing screen state", () => {
  const { doc, controller, callbacks } = harness();
  for (const scene of ["menu", "strategy", "field", "siege", "strategy"]) assert.equal(controller(scene), true);
  assert.equal(doc.body.children.length, 1);
  assert.equal(callbacks.size, 1);
  [...callbacks.values()][0]();
  assert.equal(doc.body.children.length, 0);
  assert.equal(callbacks.size, 0);
  assert.equal(controller("strategy"), false);
});

test("invalid scene names and absent documents are harmless", () => {
  const { doc, controller } = harness();
  assert.equal(controller("unknown"), false);
  assert.equal(doc.body.children.length, 0);
  const missing = createSceneTransitionController({ getDocument: () => null });
  assert.equal(missing("menu"), true);
  assert.equal(missing("menu"), false);
});

test("reduced motion changes scenes immediately without a veil", () => {
  const { doc, controller, callbacks } = harness(true);
  assert.equal(prefersReducedMotion(doc.defaultView), true);
  assert.equal(controller("strategy"), true);
  assert.equal(controller("strategy"), false);
  assert.equal(controller("field"), true);
  assert.equal(doc.body.children.length, 0);
  assert.equal(callbacks.size, 0);
});

test("city panel animation deduplicates a selected-city key", async () => {
  const { doc } = harness();
  const panel = element(doc);
  let motions = 0;
  panel.animate = () => { motions += 1; return { finished: Promise.resolve() }; };
  assert.equal(animatePanel(panel, "xuchang"), true);
  assert.equal(animatePanel(panel, "xuchang"), false);
  assert.equal(animatePanel(panel, "wan"), true);
  assert.equal(motions, 2);
  assert.equal(animatePanel(null, "wan"), false);
});

test("closing immediately releases input ownership before its visual finishes", async () => {
  const { doc } = harness();
  const root = element(doc);
  const lower = element(doc);
  const upper = element(doc);
  let finish;
  upper.animate = () => ({ finished: new Promise((resolve) => { finish = resolve; }) });
  root.append(lower, upper);
  assert.equal(isTopWindow(root, upper), true);
  const closing = leaveWindow(upper);
  assert.equal(upper.inert, true);
  assert.equal(upper.style.pointerEvents, "none");
  assert.equal(upper.attributes["aria-hidden"], "true");
  assert.equal(isTopWindow(root, lower), true);
  assert.equal(upper.isConnected, true);
  finish();
  await closing;
  assert.equal(upper.isConnected, false);
});

test("cancelled animations and old browsers still remove closing windows", async () => {
  const { doc } = harness();
  const backdrop = element(doc);
  doc.body.append(backdrop);
  backdrop.animate = () => ({ finished: Promise.reject(new Error("cancelled")) });
  await leaveWindow(backdrop);
  assert.equal(backdrop.isConnected, false);
  await enterWindow(element(doc));
});

test("reduced motion also skips panel and window animations", async () => {
  const { doc } = harness(true);
  const backdrop = element(doc);
  const panel = element(doc, "modal");
  let motions = 0;
  backdrop.animate = panel.animate = () => { motions += 1; return { finished: Promise.resolve() }; };
  backdrop.append(panel);
  await enterWindow(backdrop);
  animatePanel(panel, "city");
  await leaveWindow(backdrop);
  assert.equal(motions, 0);
});

function installDialogDocument(t) {
  const { doc } = harness(true);
  const root = element(doc);
  const toastRoot = element(doc);
  const previous = element(doc);
  previous.isConnected = true;
  doc.activeElement = previous;
  doc.querySelector = (selector) => selector === "#modal-root" ? root : toastRoot;
  doc.listeners = new Map();
  doc.addEventListener = root.addEventListener.bind(doc);
  doc.removeEventListener = root.removeEventListener.bind(doc);
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, setTimeout: () => 0, ...doc.defaultView };
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
  return { root, doc, previous };
}

test("async modal confirmation is locked against duplicate clicks and dismissals", async (t) => {
  const { root, doc, previous } = installDialogDocument(t);
  let calls = 0;
  let finish;
  const result = openDialog({ title: "签发", content: "内容", onConfirm: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); } });
  const backdrop = root.children[0];
  const confirm = backdrop.querySelector(".dialog-confirm");
  confirm.dispatch("click");
  confirm.dispatch("click");
  backdrop.querySelector(".modal-close").dispatch("click");
  assert.equal(calls, 1);
  assert.equal(confirm.disabled, true);
  assert.equal(backdrop.dataset.windowClosing, undefined);
  finish("issued");
  assert.equal(await result, "issued");
  assert.equal(doc.activeElement, previous);
  assert.equal(backdrop.dataset.windowClosing, "true");
});

test("false modal validation keeps the window open and permits another confirmation", async (t) => {
  const { root } = installDialogDocument(t);
  let valid = false;
  const result = openDialog({ title: "验证", content: "内容", onConfirm: () => valid });
  const backdrop = root.children[0];
  const confirm = backdrop.querySelector(".dialog-confirm");
  confirm.dispatch("click");
  await Promise.resolve();
  assert.equal(confirm.disabled, false);
  assert.equal(backdrop.dataset.windowClosing, undefined);
  valid = true;
  confirm.dispatch("click");
  assert.equal(await result, true);
});

test("a fading modal no longer blocks a new modal or steals restored focus", async (t) => {
  const { root, doc } = installDialogDocument(t);
  const first = openDialog({ title: "第一窗", content: "内容" });
  const firstBackdrop = root.children[0];
  firstBackdrop.querySelector(".dialog-cancel").dispatch("click");
  const second = openDialog({ title: "第二窗", content: "内容" });
  const secondBackdrop = root.children.at(-1);
  const secondButton = secondBackdrop.querySelector(".dialog-confirm");
  secondButton.focus();
  assert.equal(isTopWindow(root, secondBackdrop), true);
  await first;
  assert.equal(doc.activeElement, secondButton);
  secondButton.dispatch("click");
  assert.equal(await second, true);
});
