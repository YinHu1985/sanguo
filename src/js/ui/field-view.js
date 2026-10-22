import { escapeHtml as esc, number } from "./components.js";

/** Odd columns are shifted down half a square; include that half-row in the board. */
export function fieldGridMetrics(map) {
  const columns = map.width;
  const rows = map.height + (columns > 1 ? 0.5 : 0);
  return { columns, rows, aspectRatio: columns / rows };
}

/** A side-filtered render projection: hidden units never enter markup or labels. */
export function fieldTilesMarkup(battle, { side = battle.playerSide, mode = null,
  animatedUnitId = null, animatedTargetId = null, animationClass = null, ambushFlash = null } = {}) {
  const grid = fieldGridMetrics(battle.map);
  const visibility = battle.getVisibility(side);
  const active = battle.activeUnit;
  const moving = mode === "move" || mode === "cautious";
  const reachable = moving && active?.side === side ? battle.reachableTiles(active, { cautious: mode === "cautious" }) : [];
  const targets = active?.side !== side ? [] : mode === "attack" ? battle.attackTargets(active) : mode === "fire" ? battle.fireTargets(active) : [];
  const reachableKeys = new Set(reachable.map((tile) => `${tile.x},${tile.y}`));
  const targetIds = new Set(targets.map((unit) => unit.id));
  const visibleUnits = battle.fieldUnits().filter((unit) => unit.side === side || visibility.unitIds.has(unit.id));
  const unitsByTile = new Map(visibleUnits.map((unit) => [`${unit.position.x},${unit.position.y}`, unit]));
  const knownZoc = new Set(visibleUnits.filter((unit) => unit.side !== side)
    .flatMap((unit) => battle.neighbors(unit.position).map((tile) => `${tile.x},${tile.y}`)));
  return Array.from({ length: battle.map.width * battle.map.height }, (_, index) => {
    const x = index % battle.map.width;
    const y = Math.floor(index / battle.map.width);
    const key = `${x},${y}`;
    const visible = visibility.visible.has(key);
    const explored = visibility.explored.has(key);
    const unit = unitsByTile.get(key);
    const stronghold = battle.stronghold?.x === x && battle.stronghold?.y === y;
    // Geography is public. Fog conceals live military intelligence, never terrain.
    const terrain = battle.terrainAt(x, y);
    const terrainLabel = battle.rules.terrain[terrain]?.name ?? terrain;
    const unitAnimation = unit?.id === animatedUnitId ? animationClass : unit?.id === animatedTargetId ? "is-hit" : "";
    const title = [stronghold ? "防守方主据点 · 进入后转攻城" : terrainLabel,
      !visible ? "战争迷雾 · 敌军动向不明" : "",
      unit ? `${unit.name} · ${number(unit.troops)}兵${unit.ambushing ? " · 埋伏中" : ""}` : "",
      knownZoc.has(key) ? "敌军控制区" : "", `坐标 ${x + 1},${y + 1}`].filter(Boolean).join(" · ");
    const flash = ambushFlash?.x === x && ambushFlash?.y === y;
    return `<button class="battle-tile ${terrain} ${stronghold ? "stronghold" : ""} ${visible ? "" : explored ? "fog-explored" : "fog-unseen"} ${knownZoc.has(key) ? "enemy-zoc" : ""} ${reachableKeys.has(key) ? "reachable" : ""} ${unit && targetIds.has(unit.id) ? "targetable" : ""}" type="button" data-x="${x}" data-y="${y}" ${unit ? `data-unit-id="${esc(unit.id)}"` : ""} style="--tile-left:${x * 100 / grid.columns}%;--tile-top:${(y + (x % 2) * .5) * 100 / grid.rows}%;--tile-width:${100 / grid.columns}%;--tile-height:${100 / grid.rows}%;--depth:${y}" aria-label="${esc(title)}">
      ${unit ? `<span class="unit-piece ${unit.side !== side ? "enemy" : ""} ${unit.id === active?.id ? "active" : ""} ${unitAnimation ?? ""} ${unit.ambushing ? "is-ambushing" : ""}"><i class="unit-standard">${esc(unit.name[0])}</i><span class="unit-readout"><strong>${esc(unit.name)}</strong><small>${number(unit.troops)}${unit.ambushing ? " · 伏" : ""}</small></span></span>` : ""}
      ${stronghold ? '<span class="stronghold-label">主据点 · 城池</span>' : ""}
      ${flash ? `<span class="ambush-damage" role="status">伏击 −${number(ambushFlash.damage)}</span>` : ""}
    </button>`;
  }).join("");
}
