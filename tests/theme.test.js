import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, isAbsolute } from "node:path";

const sourceRoot = new URL("../src/", import.meta.url);
const indexUrl = new URL("index.html", sourceRoot);
const themeUrl = new URL("styles/classic-theme.css", sourceRoot);
const storyThemeUrl = new URL("styles/story-dialog.css", sourceRoot);
const warfareThemeUrl = new URL("styles/warfare.css", sourceRoot);
const stylesDirectory = new URL("styles/", sourceRoot);
const uiDirectory = new URL("assets/ui/", sourceRoot);

async function readCss(url) {
  return (await readFile(url, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
}

// Leaf blocks also cover rules nested inside our responsive media queries.
function cssRules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(",").map((value) => value.trim()),
    declarations: new Map([...body.matchAll(/([\w-]+)\s*:\s*([^;{}]+)(?:;|$)/g)]
      .map(([, property, value]) => [property.toLowerCase(), value.trim()]))
  }));
}

async function assertLocalFile(reference, base) {
  assert.ok(reference && !reference.startsWith("//"), `Expected a local resource: ${reference}`);
  const resolved = new URL(reference, base);
  assert.equal(resolved.protocol, "file:", `Resource must not use a remote/data URL: ${reference}`);
  assert.equal(resolved.host, "", `Resource must not use a network file host: ${reference}`);
  resolved.search = "";
  resolved.hash = "";
  const path = fileURLToPath(resolved);
  const relativePath = relative(fileURLToPath(sourceRoot), path);
  assert.ok(relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath), `Resource must stay inside src: ${reference}`);
  assert.equal((await stat(path)).isFile(), true, `Missing local file: ${reference}`);
  return resolved;
}

/** Validate the deliberately small, declaration-free XML subset used by our static SVG assets. */
function assertStaticSvg(source, name) {
  assert.doesNotMatch(source, /<!DOCTYPE|<!ENTITY|<\?|<!\[CDATA\[/i, `${name}: no XML declarations, entities or executable containers`);
  assert.doesNotMatch(source, /<\s*(?:[\w.-]+:)?(?:script|image|foreignObject)\b/i, `${name}: vector-only, no script or embedded document`);
  assert.doesNotMatch(source, /\bon[\w:-]+\s*=|data\s*:\s*image\//i, `${name}: no event handlers or embedded raster data`);
  const xml = source.replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  let rootCount = 0;
  let cursor = 0;
  for (const match of xml.matchAll(/<[^>]*>/g)) {
    const text = xml.slice(cursor, match.index);
    assert.doesNotMatch(text, /<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i, `${name}: malformed XML text`);
    if (!stack.length) assert.equal(text.trim(), "", `${name}: text outside the SVG root`);
    cursor = match.index + match[0].length;
    const tag = match[0].match(/^<(\/?)([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/);
    assert.ok(tag, `${name}: malformed XML tag`);
    const [, closing, element, rawAttributes, selfClosing] = tag;
    if (closing) {
      assert.equal(rawAttributes.trim(), "", `${name}: closing tag cannot have attributes`);
      assert.equal(selfClosing, "", `${name}: malformed closing tag`);
      assert.equal(stack.pop(), element, `${name}: mismatched closing tag`);
      continue;
    }
    const attributes = new Map();
    const remainder = rawAttributes.replace(/\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g, (_, key, doubleQuoted, singleQuoted) => {
      assert.equal(attributes.has(key), false, `${name}: duplicate ${key} attribute`);
      const value = doubleQuoted ?? singleQuoted;
      assert.doesNotMatch(value, /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i, `${name}: malformed XML attribute`);
      if (/^(?:xlink:)?href$/i.test(key)) assert.match(value, /^#[\w.-]+$/, `${name}: references must stay inside the SVG`);
      attributes.set(key, value);
      return "";
    });
    assert.equal(remainder.trim(), "", `${name}: malformed XML attributes`);
    if (!stack.length) {
      rootCount += 1;
      assert.equal(element, "svg", `${name}: root must be svg`);
      assert.equal(attributes.get("xmlns"), "http://www.w3.org/2000/svg", `${name}: SVG namespace required`);
    }
    if (!selfClosing) stack.push(element);
  }
  assert.equal(xml.slice(cursor).trim(), "", `${name}: unparsed text after the root`);
  assert.equal(rootCount, 1, `${name}: exactly one SVG root required`);
  assert.deepEqual(stack, [], `${name}: unclosed XML element`);
}

test("the page loads the classic theme from a local stylesheet file", async () => {
  const html = await readFile(indexUrl, "utf8");
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => ({
    rel: tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1],
    href: tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
  }));
  const themeLinks = links.filter((link) => link.rel?.split(/\s+/).includes("stylesheet")
    && link.href?.split(/[?#]/)[0].endsWith("/classic-theme.css"));
  assert.equal(themeLinks.length, 1, "The theme must be loaded once as a stylesheet");
  assert.equal((await assertLocalFile(themeLinks[0].href, indexUrl)).href, themeUrl.href);
});

test("classic, story and warfare themes only reference existing local assets", async () => {
  for (const stylesheet of [themeUrl, storyThemeUrl, warfareThemeUrl]) {
    const css = await readCss(stylesheet);
    const urls = [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)]
      .map((match) => (match[1] ?? match[2] ?? match[3]).trim());
    assert.ok(urls.length > 0, `${stylesheet.pathname}: expected local decorative assets`);
    for (const reference of new Set(urls)) await assertLocalFile(reference, stylesheet);
  }
});

test("frame borders do not reintroduce per-side reversed bevel shading", async () => {
  const files = (await readdir(stylesDirectory)).filter((name) => name.endsWith(".css"));
  assert.ok(files.length > 0, "Expected bundled stylesheets");
  for (const name of files) {
    const css = await readCss(new URL(name, stylesDirectory));
    for (const [, property, value] of css.matchAll(/\b(border(?:-[\w-]+)?)\s*:\s*([^;{}]+)/gi)) {
      assert.doesNotMatch(value, /\b(?:ridge|groove|inset|outset)\b/i,
        `${name}: ${property} must use a continuous frame rather than browser bevel shading`);
    }
  }
});

test("story portrait stays circular with one size variable at every breakpoint", async () => {
  const css = await readCss(storyThemeUrl);
  const rules = cssRules(css);
  assert.doesNotMatch(css, /--story-portrait-(?:width|height)\b/, "No separate ellipse dimensions");
  assert.ok([...css.matchAll(/--story-portrait-size\s*:/g)].length >= 3,
    "Desktop, narrow and compact layouts each set the shared portrait size");
  for (const selector of [".story-portrait", ".story-portrait-inner"]) {
    const portraitRules = rules.filter((rule) => rule.selectors.includes(selector));
    assert.ok(portraitRules.length > 0, `${selector}: expected frame styles`);
    const base = portraitRules[0].declarations;
    const dimension = selector === ".story-portrait" ? "var(--story-portrait-size)" : "100%";
    assert.equal(base.get("width"), dimension, `${selector}: shared width`);
    assert.equal(base.get("height"), dimension, `${selector}: shared height`);
    assert.equal(base.get("border-radius"), "50%", `${selector}: circular border`);
    for (const { declarations } of portraitRules) {
      for (const property of ["width", "height"]) {
        if (declarations.has(property)) assert.equal(declarations.get(property), dimension,
          `${selector}: responsive ${property} must keep the shared square dimensions`);
      }
      if (declarations.has("border-radius")) assert.equal(declarations.get("border-radius"), "50%",
        `${selector}: responsive borders must remain circular`);
      assert.doesNotMatch(declarations.get("transform") ?? "", /rotate/i,
        `${selector}: frame and portrait should not be counter-rotated`);
    }
  }
});

test("all UI SVG decorations are well-formed static text vectors without scripts or raster images", async () => {
  const files = (await readdir(uiDirectory)).filter((name) => name.endsWith(".svg"));
  assert.ok(files.length > 0, "Expected local UI SVG decorations");
  for (const name of files) {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(new URL(name, uiDirectory)));
    assertStaticSvg(source, name);
  }
});
