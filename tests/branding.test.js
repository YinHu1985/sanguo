import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialState, storageKey } from "../src/js/game/state.js";
import { listCampaignSaves, loadCampaignSlot, persistCampaignSelection, saveManualSlot } from "../src/js/game/save-slots.js";
import { AUDIO_STORAGE_KEY } from "../src/js/ui/game-audio.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const plainText = (html) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, "");

test("browser title, title-screen heading and in-game brand consistently identify 52三国志", async () => {
  const html = await read("src/index.html");
  assert.equal(html.match(/<title>(.*?)<\/title>/s)?.[1], "52三国志");
  assert.equal(plainText(html.match(/<h1[^>]*class="menu-title"[^>]*>(.*?)<\/h1>/s)?.[1] ?? ""), "52三国志");
  const brand = html.match(/<div class="brand">([\s\S]*?)<div class="topbar-actions">/)?.[1] ?? "";
  assert.equal(plainText(brand.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1] ?? ""), "52三国志");
  assert.doesNotMatch(html, /汉末<span>州郡|汉末<span>·<\/span>州郡|汉末[·・•]?州郡印|alt="汉末印"/);
});

test("the shared seal names 伍贰三国 and stays accessible in both game scenes", async () => {
  const html = await read("src/index.html");
  const seal = await read("src/assets/seal.svg");
  assert.match(seal, /<title\b[^>]*>伍贰三国印<\/title>/);
  assert.match(seal, /role="img"/);
  assert.match(seal, /aria-labelledby="[^"]+"/);
  assert.doesNotMatch(seal, /汉末州郡印/);
  const images = [...html.matchAll(/<img\b[^>]*src="\.\/assets\/seal\.svg(?:\?[^\"]*)?"[^>]*>/g)];
  assert.equal(images.length, 2);
  for (const [image] of images) assert.match(image, /alt="伍贰三国印"/);
  assert.match(html, /rel="icon"[^>]*href="\.\/assets\/seal\.svg(?:\?[^\"]*)?"/);
});

test("branding changes do not rename the established campaign and sound preference namespaces", async () => {
  assert.equal(storageKey("jianan-196"), "hanmo-zhoujun-save-v2:jianan-196");
  assert.equal(AUDIO_STORAGE_KEY, "hanmo-audio-v1");
  const stateSource = await read("src/js/game/state.js");
  assert.match(stateSource, /LEGACY_STORAGE_KEY = "hanmo-zhoujun-save-v1"/);
  for (const suffix of ["before-placeholder-cleanup", "before-economy-v2", "before-tasks-v1", "before-army-v1"]) {
    assert.ok(stateSource.includes(`"${suffix}"`), `${suffix} must remain recoverable under its old name`);
  }
});

test("legacy, automatic and manual records remain discoverable under their original storage keys", async () => {
  const scenario = JSON.parse(await read("src/data/scenario.json"));
  const rules = JSON.parse(await read("src/data/rules.json"));
  const state = { ...createInitialState(scenario, rules), started: true };
  const raw = JSON.stringify(state);
  const base = `hanmo-zhoujun-save-v2:${scenario.id}`;
  const previousRaw = JSON.stringify({ ...state, year: state.year - 1 });
  const records = new Map([["hanmo-zhoujun-save-v1", raw], [base, raw], [`${base}:previous`, previousRaw]]);
  const written = [];
  const storage = { getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => { records.set(key, value); written.push(key); }, removeItem: (key) => records.delete(key) };
  for (const number of [1, 2, 3]) saveManualSlot(`manual-${number}`, state, storage);
  assert.deepEqual(written, [1, 2, 3].map((number) => `${base}:manual-${number}`));
  assert.deepEqual(listCampaignSaves(scenario.id, storage).map((slot) => slot.id),
    ["active", "previous", "legacy", "manual-1", "manual-2", "manual-3"]);
  for (const slot of ["active", "previous", "legacy", "manual-1", "manual-2", "manual-3"]) {
    assert.equal(loadCampaignSlot(slot, scenario, rules, storage).playerFactionId, state.playerFactionId);
  }
  const next = structuredClone(state);
  next.month = next.month % 12 + 1;
  persistCampaignSelection(next, { archiveCurrent: true }, storage);
  assert.ok(written.includes(`${base}:menu-write-journal`));
  assert.ok(written.includes(`${base}:previous`));
  assert.equal(records.get(`${base}:previous`), raw);
  assert.equal(records.get("hanmo-zhoujun-save-v1"), raw);
  assert.equal(records.get(`${base}:manual-1`), raw);
  // Re-read an old format to verify the migration backup namespace too.
  const old = { ...state };
  delete old.armyVersion;
  const oldRaw = JSON.stringify(old);
  records.set(`${base}:manual-2`, oldRaw);
  const loaded = loadCampaignSlot("manual-2", scenario, rules, storage);
  persistCampaignSelection(loaded, { archiveCurrent: true }, storage);
  assert.equal(records.get(`${base}:before-menu-upgrade`), oldRaw);
  assert.ok([...records.keys()].every((key) => key.startsWith("hanmo-zhoujun-save-")), "visual branding must not create a new save namespace");
});

test("bundled Chinese fonts are real OpenType and WOFF2 files, not placeholders or download error pages", async () => {
  const fonts = [
    ["SourceHanSansCN-Regular.otf", "OTTO"],
    ["AlimamaDaoLiTi-Regular.woff2", "wOF2"]
  ];
  for (const [file, signature] of fonts) {
    const bytes = await readFile(new URL(`../src/assets/fonts/${file}`, import.meta.url));
    assert.equal(bytes.subarray(0, 4).toString("ascii"), signature, `${file} must have its actual font format signature`);
    assert.ok(bytes.length > 1_000_000, `${file} must contain the bundled Chinese glyph set`);
  }
});

test("body and display typography both prefer bundled file-based fonts on every operating system", async () => {
  const css = await read("src/styles/typography.css");
  const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => ({
    family: match[1].match(/font-family:\s*"([^"]+)"/)?.[1], body: match[1]
  }));
  const sans = css.match(/--sans:\s*"([^"]+)"/)?.[1];
  const display = css.match(/--display:\s*"([^"]+)"/)?.[1];
  assert.ok(sans && display && sans !== display, "body and decorative headings keep separate named faces");
  for (const family of [sans, display]) {
    const face = faces.find((entry) => entry.family === family);
    assert.ok(face, `${family} must have its own bundled @font-face`);
    assert.match(face.body, /src:\s*url\("\.\.\/assets\/fonts\/[^\"]+\.(?:otf|woff2)"\)/);
    assert.doesNotMatch(face.body, /\blocal\s*\(|https?:\/\//, "OS-installed or remote fonts must not determine the primary face");
  }
  assert.match(css, /--display:\s*"[^"]+",\s*"Sanguo Hei"/, "rare decorative glyphs fall back to the bundled body font");
  assert.match(css, /body, button, input, select, textarea, table\s*\{\s*font-family:\s*var\(--sans\)/);
});

test("the typography stylesheet loads after theme styles so their system font stacks cannot override it", async () => {
  const html = await read("src/index.html");
  const styles = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]
    .map((match) => match[1].split("?")[0]);
  const typographyIndex = styles.indexOf("./styles/typography.css");
  assert.ok(typographyIndex >= 0);
  for (const file of ["main.css", "classic-theme.css", "main-menu.css", "story-dialog.css", "warfare.css"]) {
    const index = styles.indexOf(`./styles/${file}`);
    assert.ok(index >= 0 && index < typographyIndex, `${file} must load before the shared typography overrides`);
  }
});

test("the four seal characters are outlined paths, with no font rendering dependency", async () => {
  const seal = await read("src/assets/seal.svg");
  assert.doesNotMatch(seal, /<text\b|@font-face/i, "the standalone SVG must render identically without installed or downloaded fonts");
  const glyphs = seal.match(/<!--\s*seal-glyphs:start\s*-->([\s\S]*?)<!--\s*seal-glyphs:end\s*-->/)?.[1];
  assert.ok(glyphs, "keep the glyph group distinct from decorative frame paths");
  const paths = [...glyphs.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*>/g)];
  assert.equal(paths.length, 4, "伍、贰、三、国 each have a vector outline");
  for (const [, outline] of paths) {
    assert.ok(outline.length > 30, "glyph outlines cannot be empty placeholders");
    assert.match(outline, /[mM]/);
  }
});
