import { escapeHtml as esc, number } from "./components.js";
import { battleStatusLabels } from "./battle-automation.js";
import { getBattleStatus } from "../game/battle-statuses.js";

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
  const targets = active?.side !== side ? [] : mode === "attack" ? battle.attackTargets(active) : mode === "fire" ? battle.fireTargets(active)
    : ["doubt", "provoke"].includes(mode) ? battle.strategyTargets(mode, active)
      : mode === "shoot" ? battle.shootTargets(active) : mode === "fireArrow" ? battle.fireArrowTargets(active) : [];
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
    const doubt = getBattleStatus(unit, "doubt"), provocation = getBattleStatus(unit, "provocation");
    const stronghold = battle.stronghold?.x === x && battle.stronghold?.y === y;
    const attackerCamp = battle.attackerCamp?.x === x && battle.attackerCamp?.y === y;
    // Geography is public. Fog conceals live military intelligence, never terrain.
    const terrain = battle.terrainAt(x, y);
    const terrainLabel = battle.rules.terrain[terrain]?.name ?? terrain;
    const unitAnimation = unit?.id === animatedUnitId ? animationClass : unit?.id === animatedTargetId ? "is-hit" : "";
    const title = [stronghold ? "防守方主据点 · 进入后转攻城" : attackerCamp ? "进攻方大本营 · 守军占领即击败攻军" : terrainLabel,
      !visible ? "战争迷雾 · 敌军动向不明" : "",
      unit ? `${unit.name} · ${number(unit.troops)}兵${unit.ambushing ? " · 埋伏中" : ""}` : "",
      ...battleStatusLabels(unit),
      knownZoc.has(key) ? "敌军控制区" : "", `坐标 ${x + 1},${y + 1}`].filter(Boolean).join(" · ");
    const flash = ambushFlash?.x === x && ambushFlash?.y === y;
    return `<button class="battle-tile ${terrain} ${stronghold || attackerCamp ? "stronghold" : ""} ${attackerCamp ? "attacker-camp" : ""} ${visible ? "" : explored ? "fog-explored" : "fog-unseen"} ${knownZoc.has(key) ? "enemy-zoc" : ""} ${reachableKeys.has(key) ? "reachable" : ""} ${unit && targetIds.has(unit.id) ? "targetable" : ""}" type="button" data-x="${x}" data-y="${y}" ${unit ? `data-unit-id="${esc(unit.id)}"` : ""} style="--tile-left:${x * 100 / grid.columns}%;--tile-top:${(y + (x % 2) * .5) * 100 / grid.rows}%;--tile-width:${100 / grid.columns}%;--tile-height:${100 / grid.rows}%;--depth:${y}" aria-label="${esc(title)}">
      ${unit ? `<span class="unit-piece ${unit.side !== side ? "enemy" : ""} ${unit.id === active?.id ? "active" : ""} ${unitAnimation ?? ""} ${unit.ambushing ? "is-ambushing" : ""}"><i class="unit-standard">${esc(unit.name[0])}</i><span class="unit-readout"><strong>${esc(unit.name)}</strong><small>${number(unit.troops)}${unit.ambushing ? " · 伏" : ""}${doubt ? ` · 疑${doubt.remainingActivations > 1 ? doubt.remainingActivations : ""}` : ""}${provocation ? ` · 诱${provocation.remainingActivations > 1 ? provocation.remainingActivations : ""}` : ""}</small></span></span>` : ""}
      ${stronghold ? '<span class="stronghold-label">主据点 · 城池</span>' : ""}
      ${attackerCamp ? '<span class="stronghold-label">攻方大本营</span>' : ""}
      ${flash ? `<span class="ambush-damage" role="status">伏击 −${number(ambushFlash.damage)}</span>` : ""}
    </button>`;
  }).join("") + rangedProjectileMarkup(visibleUnits, grid, animatedUnitId, animatedTargetId, animationClass);
}

/** Receives only visible units; an animation must never reveal an unseen actor. */
export function rangedProjectileMarkup(visibleUnits, grid, actorId, targetId, animationClass) {
  if (!["is-shooting", "is-fire-arrow"].includes(animationClass)) return "";
  const actor = visibleUnits.find((unit) => unit.id === actorId);
  const target = visibleUnits.find((unit) => unit.id === targetId);
  if (!actor || !target) return "";
  const center = ({ x, y }) => [(x + .5) * 100, (y + .5 + (x % 2) * .5) * 100];
  const [x1, y1] = center(actor.position), [x2, y2] = center(target.position);
  const path = `M${x1},${y1} L${x2},${y2}`;
  const fire = animationClass === "is-fire-arrow";
  return `<svg class="battle-projectile ${fire ? "fire-projectile" : ""}" viewBox="0 0 ${grid.columns * 100} ${grid.rows * 100}" aria-hidden="true"><path class="projectile-trail" d="${path}"/><g class="projectile-flight">${[0, .05, .1].map((delay) => `<path class="flying-arrow" d="M-20,0 L12,0 M4,-5 L12,0 L4,5" fill="none"><animateMotion dur=".28s" begin="${delay}s" fill="freeze" rotate="auto" path="${path}"/></path>`).join("")}</g></svg>`;
}
