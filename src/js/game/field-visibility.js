const DEFAULTS = {
  movementScale: 0.5,
  attackCostScale: 0.5,
  minActionPoints: 2,
  maxActionPoints: 5,
  visionBonus: 1,
  cautiousMoveMultiplier: 3,
  ambushTerrains: ["forest", "hill"],
  concealmentTerrains: ["forest", "hill"],
  sightBlockingTerrains: ["forest", "hill"],
  concealmentSightLimit: 1
};
const point = (value) => value?.position ?? value;
const validPoint = (value) => value && Number.isInteger(value.x) && Number.isInteger(value.y);
const tileKey = (position) => `${position.x},${position.y}`;
const inMap = (position, map) => validPoint(position) && position.x >= 0 && position.y >= 0
  && position.x < map.width && position.y < map.height;
const terrainAt = (map, position) => map.terrain[position.y * map.width + position.x];
const liveFieldUnit = (unit) => Number.isFinite(unit?.troops) && unit.troops > 0 && !unit.inCity;

export function getFieldConfig(rules = {}) {
  const custom = rules.battle?.field ?? rules.field ?? {};
  const config = { ...DEFAULTS, ...custom };
  for (const key of ["ambushTerrains", "concealmentTerrains", "sightBlockingTerrains"]) {
    config[key] = Array.isArray(custom[key]) ? [...custom[key]] : [...DEFAULTS[key]];
  }
  return config;
}

// Odd columns are lowered by half a row. Convert the offset grid to cube coordinates,
// which makes distance and straight-line sight constant/linear-time rather than a route search.
function toCube(position) {
  const q = position.x;
  const r = position.y - (q - (q & 1)) / 2;
  return { q, r, s: -q - r };
}

function cubeRound(cube) {
  let q = Math.round(cube.q), r = Math.round(cube.r), s = Math.round(cube.s);
  const dq = Math.abs(q - cube.q), dr = Math.abs(r - cube.r), ds = Math.abs(s - cube.s);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  else s = -q - r;
  return { x: q, y: r + (q - (q & 1)) / 2 };
}

export function hexDistance(first, second) {
  const a = point(first), b = point(second);
  if (!validPoint(a) || !validPoint(b)) return Infinity;
  const ca = toCube(a), cb = toCube(b);
  return Math.max(Math.abs(ca.q - cb.q), Math.abs(ca.r - cb.r), Math.abs(ca.s - cb.s));
}

/** Includes both endpoints. The tiny common nudge resolves lines exactly on hex boundaries. */
export function hexLine(first, second, nudge = 1e-6) {
  const a = point(first), b = point(second);
  const distance = hexDistance(a, b);
  if (!Number.isFinite(distance)) return [];
  if (!distance) return [{ x: a.x, y: a.y }];
  const ca = toCube(a), cb = toCube(b);
  return Array.from({ length: distance + 1 }, (_, index) => {
    const progress = index / distance;
    return cubeRound({ q: ca.q + (cb.q - ca.q) * progress + nudge,
      r: ca.r + (cb.r - ca.r) * progress + nudge,
      s: ca.s + (cb.s - ca.s) * progress - 2 * nudge });
  });
}

function sightRange(observer, config, explicitRange, hooks) {
  // Real formations have one centrally calculated panel. Lightweight callers
  // and legacy save fixtures retain the old AP-based fallback.
  const base = explicitRange ?? observer?.combatStats?.vision ?? observer?.vision
    ?? ((Number.isFinite(observer?.maxActionPoints) ? observer.maxActionPoints : config.minActionPoints) + config.visionBonus);
  const adjusted = hooks?.visionRange?.(observer, base) ?? base;
  return Number.isFinite(adjusted) ? Math.max(0, Math.floor(adjusted)) : 0;
}

/**
 * Pure current sight, not explored terrain memory. Hooks may grant unit-specific scouting:
 * visionRange(observer, base), terrainSightLimit(observer, terrain, baseLimit),
 * canSeeThroughTerrain(observer, terrain, position, { isTarget, map, rules }).
 */
export function canSeeTile({ observer, target, map, rules = {}, range, hooks = {} }) {
  const source = point(observer), destination = point(target);
  if (!map || !Array.isArray(map.terrain) || !inMap(source, map) || !inMap(destination, map)) return false;
  const distance = hexDistance(source, destination);
  if (!distance) return true;
  const config = getFieldConfig(rules);
  if (distance > sightRange(observer, config, range, hooks)) return false;
  // Adjacent terrain is always readable, even when the observer is inside woods/hills.
  if (distance === 1) return true;
  const seesThrough = (position, isTarget) => hooks.canSeeThroughTerrain?.(observer, terrainAt(map, position), position,
    { isTarget, map, rules }) === true;
  const terrain = terrainAt(map, destination);
  const baseLimit = config.concealmentTerrains.includes(terrain) ? config.concealmentSightLimit : Infinity;
  const terrainLimit = hooks.terrainSightLimit?.(observer, terrain, baseLimit) ?? baseLimit;
  if (distance > terrainLimit && !seesThrough(destination, true)) return false;
  // Check both infinitesimal sides when a sight ray lies on a tile edge. This
  // conservative supercover prevents looking around a blocking terrain corner.
  const checked = new Set();
  for (const nudge of [1e-6, -1e-6]) {
    const line = hexLine(source, destination, nudge);
    for (const position of line.slice(1, -1)) {
      const key = tileKey(position);
      if (checked.has(key)) continue;
      checked.add(key);
      // An edge-following ray can touch the empty half-hex outside the board;
      // that off-board space is not an opaque wall between two valid tiles.
      if (!inMap(position, map)) continue;
      if (config.sightBlockingTerrains.includes(terrainAt(map, position)) && !seesThrough(position, false)) return false;
    }
  }
  return true;
}

const observersFor = (battle, side) => (battle.units ?? []).filter((unit) => unit.side === side && liveFieldUnit(unit) && inMap(point(unit), battle.map));
function visibleFromTiles(battle, unit, side, tiles, observers) {
  if (!liveFieldUnit(unit) || !inMap(point(unit), battle.map)) return false;
  if (unit.side === side) return true;
  if (!tiles.has(tileKey(point(unit)))) return false;
  // Ambush is a prepared reaction, not a second invisibility state: nearby
  // scouts see soldiers once their forest/hill tile is visible. Future special
  // camouflage can explicitly override this through the detection hook.
  if (!unit.ambushing) return true;
  const hooks = battle.visibilityHooks ?? {};
  if (typeof hooks.detectAmbush !== "function") return true;
  return observers.some((observer) => canSeeTile({ observer, target: unit, map: battle.map, rules: battle.rules, hooks })
    && hooks.detectAmbush(observer, unit, { map: battle.map, rules: battle.rules, side, distance: hexDistance(observer, unit) }) !== false);
}

/**
 * Shared current sight for one side. The engine owns explored history separately.
 * This function only reads battle.units/map/rules/visibilityHooks; it invokes no engine methods.
 */
export function computeFieldVisibility(battle, side = battle?.playerSide) {
  const tiles = new Set(), unitIds = new Set();
  if (!battle?.map || !Array.isArray(battle.map.terrain)) return { tiles, unitIds };
  const observers = observersFor(battle, side);
  const hooks = battle.visibilityHooks ?? {};
  const config = getFieldConfig(battle.rules);
  for (const observer of observers) {
    const range = sightRange(observer, config, undefined, hooks);
    const origin = point(observer);
    // In offset coordinates a single hex step never changes x or y by more than one.
    const left = Math.max(0, origin.x - range), right = Math.min(battle.map.width - 1, origin.x + range);
    const top = Math.max(0, origin.y - range), bottom = Math.min(battle.map.height - 1, origin.y + range);
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const target = { x, y };
        if (canSeeTile({ observer, target, map: battle.map, rules: battle.rules, hooks })) tiles.add(tileKey(target));
      }
    }
  }
  for (const unit of battle.units ?? []) {
    if (visibleFromTiles(battle, unit, side, tiles, observers)) unitIds.add(unit.id);
  }
  return { tiles, unitIds };
}

/** Supply a current tiles Set when checking many units to avoid rebuilding shared sight. */
export function unitVisible(battle, unit, side = battle?.playerSide, visibleTiles) {
  if (!battle?.map) return false;
  if (!(visibleTiles instanceof Set)) return computeFieldVisibility(battle, side).unitIds.has(unit?.id);
  return visibleFromTiles(battle, unit, side, visibleTiles, observersFor(battle, side));
}
