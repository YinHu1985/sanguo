import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles/main.css", import.meta.url), "utf8");
const colors = await readFile(new URL("../src/styles/map-colors.css", import.meta.url), "utf8");
const theme = await readFile(new URL("../src/styles/classic-theme.css", import.meta.url), "utf8");

test("atlas drops the redundant title card but keeps a reusable ornamented silk surface", () => {
  assert.doesNotMatch(html, /山川形胜|id="atlas-city-count"|id="faction-legend"|class="map-toolbar"/);
  assert.match(theme, /\.ornate-map-window\s*\{/);
  assert.match(theme, /\.ornate-map-window::before/);
  assert.match(theme, /\.ornate-map-window::after/);
  assert.match(theme, /\.strategy-screen \.map-toolbar, \.ornate-map-window, \.battle-header/);
});

test("city detail and orders float left while the roster and map tools float right", () => {
  assert.match(css, /\.strategy-screen \.city-detail-panel\s*\{[^}]*left:\s*22px;[^}]*right:\s*auto;[^}]*overflow:\s*auto;/);
  assert.match(css, /\.strategy-screen \.command-deck\s*\{\s*left:\s*22px;\s*right:\s*auto;/);
  assert.match(css, /\.strategy-screen \.city-roster-panel\s*\{[^}]*left:\s*auto;\s*right:\s*22px;/);
  assert.match(css, /\.atlas-tools\s*\{[^}]*left:\s*auto;\s*right:\s*22px;\s*bottom:\s*25px;/);
  assert.match(css, /\.strategy-screen \.city-list\s*\{\s*display:\s*block;/,
    "the narrow legacy three-column list must not leak into the right-hand roster");
});

test("tool and roster sizing reserve independent corners, with compact-screen access via city directory", () => {
  assert.match(css, /\.atlas-tools\s*\{[^}]*max-width:\s*calc\(100% - 330px\);[^}]*max-height:\s*215px;\s*overflow:\s*auto;/);
  assert.match(css, /\.strategy-screen \.city-roster-panel\s*\{[^}]*top:\s*112px;[^}]*max-height:\s*calc\(100% - 364px\);/);
  assert.match(css, /\.atlas-tools\s*\{\s*left:\s*auto;\s*right:\s*10px;\s*bottom:\s*26px;/);
  assert.match(theme, /--hud-bottom:\s*255px;\s*--hud-orders-height:\s*170px;/);
  assert.match(html, /id="atlas-directory"/);
});

test("map colors are an independent non-interactive layer under routes and cities", () => {
  const background = html.indexOf('class="atlas-geography"');
  const territories = html.indexOf('id="territory-layer"');
  const routes = html.indexOf('id="route-layer"');
  const cities = html.indexOf('id="city-node-layer"');
  assert.ok(background < territories && territories < routes && routes < cities);
  assert.match(html, /id="territory-layer"[^>]*viewBox="0 0 1800 1500"[^>]*aria-hidden="true"/);
  assert.match(colors, /\.territory-layer\s*\{[^}]*pointer-events:\s*none;/);
  for (const mode of ["none", "faction", "diplomacy", "province"]) {
    assert.match(html, new RegExp(`<option value="${mode}">`));
  }
  assert.match(html, /id="map-color-legend"[^>]*aria-live="polite"/);
  assert.match(html, /id="map-color-note"/);
});
