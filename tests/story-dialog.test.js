import test from "node:test";
import assert from "node:assert/strict";
import { buildTurnOpening, localStoryPortrait, normalizeStoryPages } from "../src/js/ui/story-dialog.js";

test("story text stays plain and text arrays are paragraphs rather than pages", () => {
  const pages = normalizeStoryPages({ text: ["<img src=x onerror=boom>", "第二段"] });
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].paragraphs, ["<img src=x onerror=boom>", "第二段"]);
  assert.equal(pages[0].speaker, null);
});

test("story sequences inherit options and can switch from character to narration", () => {
  const pages = normalizeStoryPages({
    speaker: { name: "刘备", portrait: "assets/portraits/liu-bei.webp" },
    caption: "建安元年",
    pages: ["第一段", ["第二段", "另一行"], { speaker: null, text: "旁白", caption: "" }]
  });
  assert.equal(pages.length, 3);
  assert.equal(pages[0].speaker, "刘备");
  assert.equal(pages[0].portrait, "assets/portraits/liu-bei.webp");
  assert.deepEqual(pages[1].paragraphs, ["第二段", "另一行"]);
  assert.equal(pages[2].speaker, null);
  assert.equal(pages[2].portrait, null);
  assert.equal(pages[2].caption, "");
});

test("changing speaker does not inherit the previous character portrait", () => {
  const pages = normalizeStoryPages({ speaker: "刘备", portrait: "./assets/portraits/liu-bei.png", pages: [
    { speaker: "关羽", text: "在。" },
    { speaker: { name: "关羽", portrait: "assets/portraits/guan-yu.png" }, text: "在。" }
  ] });
  assert.equal(pages[0].portrait, null);
  assert.equal(pages[1].portrait, "assets/portraits/guan-yu.png");
});

test("story portraits are only bundled image paths", () => {
  for (const path of ["https://example.com/me.png", "//example.com/me.png", "javascript:alert(1)", "data:image/png,x", "placeholder", "assets/../secret.png", "/private/me.png", "assets/me.html"]) {
    assert.equal(localStoryPortrait(path), null, path);
  }
  for (const path of ["assets/portraits/a.svg", "./assets/portraits/刘备.webp", "/assets/portraits/name.jpg"]) assert.equal(localStoryPortrait(path), path);
});

test("turn opening uses real active faction lord and never creates a reporter", () => {
  const state = { year: 196, month: 11, playerFactionId: "liu", commandsRemaining: 6,
    factions: [{ id: "liu", name: "刘备军", lord: "liu-bei" }],
    officers: [{ id: "liu-bei", name: "刘备", factionId: "liu", status: "active", portrait: "placeholder" }] };
  const report = buildTurnOpening(state);
  assert.deepEqual(report.speaker, { name: "刘备", portrait: null });
  assert.match(report.caption, /196 年 11 月/);
  assert.match(report.text.join(""), /6 道指令/);
  state.officers[0].status = "captured";
  assert.equal(buildTurnOpening(state).speaker, null);
  state.officers = [];
  assert.equal(buildTurnOpening(state).speaker, null);
});
