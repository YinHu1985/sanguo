import { areAllied } from "../game/campaign.js";
import { escapeHtml as esc, openDialog } from "./components.js";

const PREFERENCE_KEY = "hanmo-zhoujun-map-color-v1";
const SVG_NS = "http://www.w3.org/2000/svg";
const normalizeColor = (color, fallback = "#858b81") => /^#[\da-f]{6}$/i.test(color ?? "") ? color : fallback;
export const normalizeMapMode = (mode, config) => config.modes.some((entry) => entry.id === mode) ? mode : config.defaultMode ?? "none";

/** Display preferences are separate from campaign saves and never advance time. */
export function readMapMode(config, storage) {
  try { return normalizeMapMode((storage === undefined ? globalThis.localStorage : storage)?.getItem(PREFERENCE_KEY), config); }
  catch { return config.defaultMode ?? "none"; }
}

export function writeMapMode(mode, config, storage) {
  const normalized = normalizeMapMode(mode, config);
  try { (storage === undefined ? globalThis.localStorage : storage)?.setItem(PREFERENCE_KEY, normalized); } catch { /* The map still works without storage. */ }
  return normalized;
}

function diplomaticGroup(state, factionId) {
  if (!factionId || factionId === "neutral") return "neutral";
  if (factionId === state.playerFactionId) return "self";
  // War records, rather than low friendliness, indicate actual hostilities.
  const wars = [...(state.battles ?? []).filter((war) => war.status !== "ended"),
    ...(state.pendingInvasions ?? []).filter((invasion) => !invasion.resolved)];
  if (wars.some((war) => [war.attackerFactionId, war.defenderFactionId].includes(state.playerFactionId)
    && [war.attackerFactionId, war.defenderFactionId].includes(factionId))) return "war";
  // Alliances are bilateral: an ally's ally does not automatically join our bloc.
  return areAllied(state, state.playerFactionId, factionId) ? "ally" : "unaffiliated";
}

/** Resolver contract: (city, state, config, modeDefinition) -> { key, label, color }.
 * The key identifies equal-colored groups and controls which internal borders hide.
 * Resolvers must be pure; they never receive geometry or DOM elements.
 * Keep this registry export for existing callers; prefer registerMapColorResolver. */
export const MAP_COLOR_RESOLVERS = {
  faction: (city, state, config) => {
    const faction = state.factions.find((entry) => entry.id === city.factionId);
    const neutral = !city.factionId || city.factionId === "neutral";
    return { key: neutral ? "neutral" : `faction:${city.factionId}`, label: neutral ? "无主城池" : faction?.name ?? "归属不明",
      color: neutral ? config.colors.neutral : faction?.color ?? config.colors.unknown };
  },
  diplomacy: (city, state, config) => {
    const key = diplomaticGroup(state, city.factionId);
    const entry = config.diplomacy.find((item) => item.id === key);
    return { key, label: entry?.label ?? "未知关系", color: entry?.color ?? config.colors.unknown };
  },
  province: (city, state, config) => {
    const entry = config.provinces.find((item) => item.id === city.province);
    return { key: `province:${city.province ?? "unknown"}`, label: entry?.label ?? city.province ?? "州郡未定",
      color: entry?.color ?? config.colors.unknown };
  }
};

/** Add a display rule, then refer to its id through a mode's `resolver` field.
 * If omitted, the mode id is also its resolver id. Returns a cleanup function so
 * optional modules and tests can unregister their own rule without touching others. */
export function registerMapColorResolver(id, resolver, { replace = false } = {}) {
  if (typeof id !== "string" || !/^[a-z][a-z0-9_-]*$/i.test(id) || id === "none") throw new TypeError("Map color resolver requires a valid, non-reserved id");
  if (typeof resolver !== "function") throw new TypeError("Map color resolver must be a function");
  const existed = Object.hasOwn(MAP_COLOR_RESOLVERS, id);
  if (existed && !replace) throw new Error(`Map color resolver already registered: ${id}`);
  const previous = MAP_COLOR_RESOLVERS[id];
  MAP_COLOR_RESOLVERS[id] = resolver;
  return () => {
    if (MAP_COLOR_RESOLVERS[id] !== resolver) return;
    if (existed) MAP_COLOR_RESOLVERS[id] = previous;
    else delete MAP_COLOR_RESOLVERS[id];
  };
}

/** Reusable heat-map rule. `bands` may be read from external JSON:
 * [{ id: "low", min: 0, label: "兵少", color: "#..." }, ...].
 * Each min is inclusive; the next min is exclusive. Missing/non-finite values
 * and values below the first band use the separate unknown style, never zero.
 * Read only the desired metric through value(city, state, config, definition).
 * Example: registerMapColorResolver("troops", createNumericMapColorResolver({
 *   value: city => city.troops, bands: config.troopBands, keyPrefix: "troops"
 * })); No geometry, camera or renderer change is needed. */
export function createNumericMapColorResolver({ value, bands, keyPrefix = "band", unknown = {} }) {
  if (typeof value !== "function" || !Array.isArray(bands) || !bands.length) throw new TypeError("Numeric map colors require a value getter and bands");
  const thresholds = bands.map((band) => ({ ...band })).sort((a, b) => a.min - b.min);
  const ids = new Set();
  thresholds.forEach((band, index) => {
    if (typeof band.id !== "string" || !band.id || ids.has(band.id) || !Number.isFinite(band.min)
      || (index && thresholds[index - 1].min === band.min)) throw new TypeError("Numeric map bands require unique ids and finite, distinct minimums");
    ids.add(band.id);
  });
  const fallback = { key: `${keyPrefix}:unknown`, label: "数据未知", color: "#858b81", ...unknown };
  return (city, state, config, definition) => {
    const amount = value(city, state, config, definition);
    const band = Number.isFinite(amount) ? thresholds.findLast((entry) => amount >= entry.min) : null;
    return band ? { key: `${keyPrefix}:${band.id}`, label: band.label ?? band.id, color: band.color, value: amount }
      : { ...fallback, value: Number.isFinite(amount) ? amount : null };
  };
}

/** Pure ownership/diplomacy -> colors projection. No changes to saved game data. */
export function buildMapColorView(state, mode, config) {
  const normalized = normalizeMapMode(mode, config);
  const definition = config.modes.find((entry) => entry.id === normalized);
  const resolverId = definition?.resolver ?? normalized;
  const resolver = Object.hasOwn(MAP_COLOR_RESOLVERS, resolverId) ? MAP_COLOR_RESOLVERS[resolverId] : null;
  const cells = resolver ? state.cities.map((city) => {
    const style = resolver(city, state, config, definition);
    return { ...style, color: normalizeColor(style.color), cityId: city.id, cityName: city.name };
  }) : [];
  const groups = new Map();
  for (const cell of cells) {
    if (!groups.has(cell.key)) groups.set(cell.key, { key: cell.key, label: cell.label, color: cell.color, count: 0, cityIds: [] });
    const group = groups.get(cell.key);
    group.count += 1; group.cityIds.push(cell.cityId);
  }
  const legend = [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-Hans"));
  return { mode: normalized, visible: Boolean(resolver), opacity: definition?.opacity ?? 0.35,
    description: definition?.description ?? "", cells, legend };
}

/** Legend layout is data-driven rather than coupled to particular mode ids.
 * display: selection | all | none; palette: a config array key (optional);
 * reference: player (optional); full: whether to offer the full legend dialog. */
export function buildMapLegendView(state, view, config) {
  if (!view.visible) return { items: [], reference: "", showFullLegend: false };
  const definition = config.modes.find((entry) => entry.id === view.mode);
  const options = definition?.legend ?? {};
  const display = options.display ?? "selection";
  const palette = options.palette && Array.isArray(config[options.palette]) ? config[options.palette] : null;
  const selected = view.cells.find((cell) => cell.cityId === state.selectedCityId);
  const items = display === "none" ? [] : display === "all"
    ? palette ? palette.map((entry) => ({ key: entry.key ?? entry.id, label: entry.label, color: normalizeColor(entry.color) })) : view.legend
    : selected ? [selected] : view.legend.slice(0, 1);
  const reference = options.reference === "player"
    ? `以${state.factions.find((faction) => faction.id === state.playerFactionId)?.name ?? "我方"}为准` : "";
  return { items, reference, showFullLegend: options.full ?? display === "selection" };
}

export function visibleTerritoryEdges(edges, cells) {
  const groups = new Map(cells.map((cell) => [cell.cityId, cell.key]));
  return edges.filter((edge) => edge.cityIds.some((id) => groups.has(id))
    && (edge.cityIds.length === 1 || groups.get(edge.cityIds[0]) !== groups.get(edge.cityIds[1])));
}

const svgElement = (name, attributes = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
};

export class MapColorLayer {
  constructor({ layer, legend, note, selector, territories, config }) {
    Object.assign(this, { layer, legend, note, selector, territories, config });
    this.mode = readMapMode(config);
    this.nodes = new Map();
    this.buildGeometry();
    selector.innerHTML = config.modes.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.label)}</option>`).join("");
    selector.value = this.mode;
    selector.addEventListener("change", () => {
      this.mode = writeMapMode(selector.value, this.config);
      if (this.state) this.render(this.state);
    });
    legend.addEventListener("click", (event) => {
      if (event.target.closest("[data-map-full-legend]")) this.showFullLegend();
    });
  }

  buildGeometry() {
    const { width, height } = this.territories.projection;
    this.layer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const defs = svgElement("defs");
    const mask = svgElement("mask", { id: "territory-land-mask", maskUnits: "userSpaceOnUse", x: 0, y: 0, width, height, "mask-type": "luminance" });
    mask.append(svgElement("path", { d: this.territories.landPath, fill: "white", "fill-rule": "evenodd" }));
    if (this.territories.waterPath) mask.append(svgElement("path", { d: this.territories.waterPath, fill: "black", "fill-rule": "evenodd" }));
    defs.append(mask);
    const masked = svgElement("g", { mask: "url(#territory-land-mask)" });
    this.fills = svgElement("g", { class: "territory-fills" });
    this.boundaries = svgElement("path", { class: "territory-boundaries", fill: "none", "vector-effect": "non-scaling-stroke" });
    for (const cell of this.territories.cells) {
      const path = svgElement("path", { d: cell.path, "data-territory-city": cell.cityId, class: "territory-cell" });
      this.nodes.set(cell.cityId, path); this.fills.append(path);
    }
    masked.append(this.fills, this.boundaries);
    this.layer.replaceChildren(defs, masked);
  }

  render(state) {
    this.state = state;
    const view = buildMapColorView(state, this.mode, this.config);
    this.view = view;
    this.layer.classList.toggle("is-hidden", !view.visible);
    this.layer.dataset.mode = view.mode;
    this.layer.style.setProperty("--territory-opacity", String(view.opacity));
    const byCity = new Map(view.cells.map((cell) => [cell.cityId, cell]));
    for (const [id, node] of this.nodes) {
      const cell = byCity.get(id);
      node.setAttribute("fill", cell?.color ?? "transparent");
    }
    this.boundaries.setAttribute("d", visibleTerritoryEdges(this.territories.edges, view.cells).map((edge) => edge.path).join(" "));
    this.note.textContent = view.visible ? this.config.boundaryNote : "拖动地图 · 滚轮缩放 · 点击城池理政";
    this.selector.title = view.description;
    const legend = buildMapLegendView(state, view, this.config);
    const reference = legend.reference ? `<span class="map-legend-reference">${esc(legend.reference)}</span>` : "";
    this.legend.innerHTML = view.visible ? `${reference}${legend.items.map((entry) => `<span class="map-legend-chip"><i style="--map-color:${normalizeColor(entry.color)}"></i>${esc(entry.label)}</span>`).join("")}${legend.showFullLegend ? '<button type="button" class="text-button" data-map-full-legend>完整图例 ↗</button>' : ""}` : "";
    this.legend.hidden = !view.visible;
  }

  async showFullLegend() {
    if (!this.view?.visible) return;
    const mode = this.config.modes.find((entry) => entry.id === this.view.mode);
    await openDialog({ title: `${mode.label} · 地图图例`, content: `<p class="modal-description">${esc(this.view.description)}<br>${esc(this.config.boundaryNote)}</p><div class="map-full-legend">${this.view.legend.map((entry) => `<div class="map-legend-entry"><i style="--map-color:${entry.color}"></i><strong>${esc(entry.label)}</strong><span>${entry.count} 城</span></div>`).join("")}</div>`, confirmText: "返回地图", hideCancel: true });
  }
}
