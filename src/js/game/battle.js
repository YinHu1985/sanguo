import { dailyFoodCost } from "./economy.js";
import { aggregateAbilities, createDefenderFormations, formationCapacity, formationOfficerIds, normalizeFormations } from "./army.js";
import { ATTACK_ORDERS, DEFENSE_ORDERS, createSiegeState, damageSiegeLayers, effectiveTroops, evaluateSiegeDay, getSiegeConfig, interceptionLosses, normalizeSiegeState } from "./siege.js";
import { computeFieldVisibility, getFieldConfig, hexDistance, unitVisible } from "./field-visibility.js";
import { aggregateTroopStats, applyArmyLosses, applyFormationLosses, formationComposition, primaryTroopType, sumEquipment } from "./troops.js";
import { calculateCombatStats, getCombatConfig } from "./combat-stats.js";
import { getStrategyConfig, strategySuccessChance } from "./battle-strategies.js";
import { activeAmbushPreparation } from "./stratagems.js";
import { initializeBattleStatuses, getBattleStatus, applyBattleStatus, removeBattleStatus,
  clearBattleStatuses, consumeActivationStatuses, getControllingStatus } from "./battle-statuses.js";

const UNIT_TYPES = {
  infantry: { name: "步兵", actionPoints: 6, initiative: 0, attack: 1, range: 1, attackCost: 3 },
  cavalry: { name: "骑兵", actionPoints: 8, initiative: 10, attack: 1.08, range: 1, attackCost: 4 },
  archer: { name: "弓兵", actionPoints: 6, initiative: 4, attack: 0.92, range: 2, attackCost: 3 }
};

const FIRE_COST = 4;
const RANGED_DEFAULTS = { shootActionPoints: 2, fireArrowActionPoints: 3, fireArrowGoldCost: 30, fireArrowChance: 0.3 };
// An uncommanded garrison is a troop formation, not a generated character.
const GARRISON_STATS = { war: 35, intelligence: 25, leadership: 30, politics: 25, charm: 30, deploymentLimit: 2000 };
const keyOf = (x, y) => `${x},${y}`;

export class BattleEngine {
  #forcedActorId = null;
  #randomState = 0;
  #seededRandom = () => {
    this.#randomState = (this.#randomState + 0x6D2B79F5) >>> 0;
    let value = this.#randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  constructor({ sourceCity, targetCity, divisions, officers, rules, map, supplies = {}, playerSide = "ally", rng,
    mode = "field", defenderDivisions, canDefenderRetreat = false, state, campaignMode = false, seed, _snapshot, visibilityHooks }) {
    if (_snapshot) {
      this.#restore(_snapshot, { rules, map, rng, visibilityHooks });
      return;
    }
    if (playerSide !== "ally" && playerSide !== "enemy") throw new Error("无效的玩家战斗阵营");
    // Internal sides describe battle roles, not ownership: ally attacks and enemy
    // defends. Player control can change without reversing deployment or supplies.
    this.playerSide = playerSide;
    this.aiSide = playerSide === "ally" ? "enemy" : "ally";
    this.sourceCityId = sourceCity.id;
    this.targetCityId = targetCity.id;
    this.attackerFactionId = sourceCity.factionId;
    this.defenderFactionId = targetCity.factionId;
    this.campaignMode = Boolean(campaignMode);
    this.nextPauseDay = rules.battleDayLimit ?? 30;
    this.rules = rules;
    const preparation = activeAmbushPreparation(targetCity, state);
    this.defenderAmbushPreparation = preparation ? { ...preparation } : null;
    this.ambushPreparationUsedId = null;
    this.map = map;
    this.#randomState = Number.isFinite(seed) ? seed >>> 0 : Math.floor(Math.random() * 4294967296) >>> 0;
    this.rng = rng ?? this.#seededRandom;
    if (visibilityHooks) this.visibilityHooks = visibilityHooks;
    this.phase = "field";
    this.pendingDecision = null;
    this.canDefenderRetreat = canDefenderRetreat;
    this.escapedDefenderUnits = [];
    this.defenderRetreated = false;
    this.wallLevel = Math.max(1, Math.min(3, Math.floor(targetCity.wallLevel ?? 1)));
    this.cityDefense = Math.max(0, Math.min(100, targetCity.defense ?? 100));
    this.stronghold = { ...(map.stronghold ?? { x: map.width - 1, y: Math.floor(map.height / 2) }) };
    this.siege = createSiegeState(this.wallLevel, rules);
    this.day = 1;
    this.status = "active";
    this.winner = null;
    this.outcomeReason = null;
    this.outcomeType = null;
    this.queue = [];
    this.log = [];
    this.exploredTiles = { ally: new Set(), enemy: new Set() };
    const reserve = (value) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    // These are battle-owned stores. Strategic-city settlement happens outside this engine.
    this.supplies = {
      ally: { food: reserve(supplies.food), gold: reserve(supplies.gold) },
      enemy: { food: reserve(targetCity.food), gold: reserve(targetCity.gold) }
    };
    this.rationDaysPaid = { ally: 0, enemy: 0 };

    const officerMap = new Map(officers.map((officer) => [officer.id, officer]));
    this.defenderOfficers = targetCity.officerIds.map((id) => officerMap.get(id)).filter((officer) => officer
      && !["free", "captured"].includes(officer.status) && officer.factionId === targetCity.factionId);
    // An explicitly selected field force leaves every unselected soldier in the
    // city. Legacy auto-deployment keeps its existing reserve reinforcement rule.
    this.automaticDefenderReinforcements = defenderDivisions === undefined && mode !== "siege";
    const attackers = normalizeFormations(divisions);
    const attackerIds = attackers.flatMap(formationOfficerIds);
    if (!attackers.length || new Set(attackerIds).size !== attackerIds.length || attackers.some((division) => {
      const ids = formationOfficerIds(division);
      return !ids.length || ids.some((id) => {
        const officer = officerMap.get(id);
        return !officer || !sourceCity.officerIds.includes(officer.id) || officer.status === "free" || officer.status === "captured";
      });
    })) throw new Error("出征部队必须由出发城的武将带领，且不能重复编组");
    this.armyOfficerIds = attackerIds;
    this.attackerEquipmentCommitted = sumEquipment(attackers, rules);
    this.attackerOfficers = attackerIds.map((id) => officerMap.get(id));
    const usedPositions = new Set();
    const deploymentPosition = (side, index) => {
      const starts = side === "ally" ? map.attackerStarts : map.defenderStarts;
      const fallback = Array.from({ length: map.width * map.height }, (_, offset) => ({
        x: side === "ally" ? Math.floor(offset / map.height) : map.width - 1 - Math.floor(offset / map.height),
        y: offset % map.height
      }));
      const tile = [starts[index], ...starts, ...fallback].filter(Boolean).find((point) =>
        point.x >= 0 && point.y >= 0 && point.x < map.width && point.y < map.height
        && !usedPositions.has(keyOf(point.x, point.y)) && Number.isFinite(this.movementCostAt(point.x, point.y)));
      if (!tile) throw new Error("战场没有足够的合法部署位置");
      usedPositions.add(keyOf(tile.x, tile.y));
      return tile;
    };
    this.units = attackers.map((division, index) => this.#makeUnit({
      id: `ally-${division.officerIds[0]}`,
      side: "ally",
      commanders: division.officerIds.map((id) => officerMap.get(id)),
      name: division.name,
      troops: division.troops,
      training: sourceCity.training,
      morale: sourceCity.morale,
      unitType: division.unitType ?? "infantry",
      composition: formationComposition(division, rules),
      position: deploymentPosition("ally", index)
    }));

    const defenders = defenderDivisions === undefined ? createDefenderFormations(targetCity, officers, rules, { state }) : normalizeFormations(defenderDivisions);
    const defenderIds = defenders.flatMap(formationOfficerIds);
    // The caller settles this commitment against strategic stores only once the
    // battle is resolved. Constructing a preview must not consume city equipment.
    this.defenderEquipmentCommitted = sumEquipment(defenders, rules);
    if (new Set(defenderIds).size !== defenderIds.length || defenders.some((division) => !Number.isSafeInteger(division.troops)
      || division.troops < 0 || formationOfficerIds(division).some((id) => {
        const officer = officerMap.get(id);
        return !officer || !targetCity.officerIds.includes(id) || ["free", "captured"].includes(officer.status);
      }))) throw new Error("守军编组无效");
    const unassigned = targetCity.troops - defenders.reduce((sum, division) => sum + division.troops, 0);
    if (unassigned < 0) throw new Error("部署兵力超过城内兵力");
    // Reserves reinforce between days, or form a new line if the field troops are routed.
    this.defenderReserveTroops = unassigned;
    this.defenderReserveTraining = targetCity.training;
    this.defenderReserveMorale = targetCity.morale;
    defenders.forEach((division, index) => {
      const commanders = formationOfficerIds(division).map((id) => officerMap.get(id));
      this.units.push(this.#makeUnit({
        id: commanders.length ? `enemy-${commanders[0].id}` : `enemy-garrison-${targetCity.id}-${index}`,
        side: "enemy",
        commanders,
        name: division.name ?? commanders[0]?.name ?? `${targetCity.name}守军`,
        troops: division.troops,
        training: targetCity.training,
        morale: targetCity.morale,
        unitType: division.unitType ?? "infantry",
        composition: formationComposition(division, rules),
        position: deploymentPosition("enemy", index)
      }));
    });
    this.attackerCamp = this.#deriveAttackerCamp(map.attackerCamp);
    this.#writeLog(`第 1 日，两军于${targetCity.name}城外列阵。`);
    if (mode === "siege") {
      this.units.filter((unit) => unit.side === "enemy").forEach((unit) => { unit.inCity = true; });
      this.enterSiege({ direct: true });
    }
    this.#prepareDay();
  }

  /** JSON-only campaign state. Functions are runtime dependencies, never save data. */
  snapshot() {
    const data = Object.fromEntries(Object.entries(this).filter(([key, value]) => !["rules", "rng", "visibilityHooks"].includes(key)
      && typeof value !== "function"));
    return JSON.parse(JSON.stringify({ ...data, schemaVersion: 1,
      random: { algorithm: "mulberry32", state: this.#randomState, externalSource: this.rng !== this.#seededRandom } },
    (_, value) => value instanceof Set ? [...value] : value));
  }

  static fromSnapshot(snapshot, options = {}) {
    return new BattleEngine({ ...options, _snapshot: snapshot });
  }

  #restore(snapshot, { rules, map, rng, visibilityHooks }) {
    if (!snapshot || typeof snapshot !== "object" || (snapshot.schemaVersion ?? 1) !== 1 || !rules) throw new Error("战役存档版本或规则无效");
    const saved = structuredClone(snapshot);
    const restoredMap = map ?? saved.map;
    const legalPoint = (point) => point && Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y)
      && point.x >= 0 && point.y >= 0 && point.x < restoredMap?.width && point.y < restoredMap?.height;
    if (!restoredMap || !Number.isSafeInteger(restoredMap.width) || restoredMap.width < 1
      || !Number.isSafeInteger(restoredMap.height) || restoredMap.height < 1
      || !Array.isArray(restoredMap.terrain) || restoredMap.terrain.length !== restoredMap.width * restoredMap.height
      || !Array.isArray(saved.units) || !Number.isSafeInteger(saved.day) || saved.day < 1
      || !["active", "paused", "ended"].includes(saved.status)
      || !["field", "siege_transition", "siege"].includes(saved.phase)
      || !["ally", "enemy"].includes(saved.playerSide)
      || !legalPoint(saved.stronghold)
      || (saved.attackerCamp && (!legalPoint(saved.attackerCamp)
        || (saved.attackerCamp.x === saved.stronghold.x && saved.attackerCamp.y === saved.stronghold.y)))
      || (saved.nextPauseDay !== undefined && (!Number.isSafeInteger(saved.nextPauseDay) || saved.nextPauseDay < saved.day))
      || saved.units.some((unit) => !unit || typeof unit.id !== "string" || !["ally", "enemy"].includes(unit.side)
        || !Number.isSafeInteger(unit.troops) || unit.troops < 0 || !legalPoint(unit.position))
      || new Set(saved.units.map((unit) => unit.id)).size !== saved.units.length
      || !Array.isArray(saved.queue) || new Set(saved.queue).size !== saved.queue.length
      || saved.queue.some((id) => !saved.units.some((unit) => unit.id === id))
      || ["ally", "enemy"].some((side) => ["food", "gold"].some((key) => !Number.isSafeInteger(saved.supplies?.[side]?.[key]) || saved.supplies[side][key] < 0))) {
      throw new Error("战役存档中的地图、军队或钱粮记录无效");
    }
    for (const [key, value] of Object.entries(saved)) {
      if (!["__proto__", "constructor", "prototype", "rules", "rng", "random", "schemaVersion", "visibilityHooks"].includes(key)
        && !Object.getOwnPropertyDescriptor(BattleEngine.prototype, key)) this[key] = value;
    }
    this.rules = rules;
    this.map = structuredClone(restoredMap);
    this.campaignMode = Boolean(saved.campaignMode);
    this.rationDaysPaid = Object.fromEntries(["ally", "enemy"].map((side) => [side,
      Number.isSafeInteger(saved.rationDaysPaid?.[side]) && saved.rationDaysPaid[side] >= 0 ? saved.rationDaysPaid[side] : 0]));
    this.nextPauseDay = saved.nextPauseDay ?? Math.ceil(saved.day / (rules.battleDayLimit ?? 30)) * (rules.battleDayLimit ?? 30);
    this.#randomState = Number.isFinite(saved.random?.state) ? saved.random.state >>> 0 : 0;
    this.rng = rng ?? this.#seededRandom;
    if (visibilityHooks) this.visibilityHooks = visibilityHooks;
    this.exploredTiles = Object.fromEntries(["ally", "enemy"].map((side) => [side, new Set(saved.exploredTiles?.[side] ?? [])]));
    this.units.forEach((unit) => {
      initializeBattleStatuses(unit);
      if (!unit.combatStats) this.#refreshUnitTroopStats(unit);
    });
    this.siege = normalizeSiegeState(saved.siege, this.wallLevel, rules);
    this.attackerCamp = saved.attackerCamp ? { ...saved.attackerCamp } : this.#deriveAttackerCamp(this.map.attackerCamp);
  }

  #deriveAttackerCamp(preferred) {
    const legal = (point) => point && Number.isInteger(point.x) && Number.isInteger(point.y)
      && point.x >= 0 && point.y >= 0 && point.x < this.map.width && point.y < this.map.height
      && !(point.x === this.stronghold.x && point.y === this.stronghold.y)
      && Number.isFinite(this.movementCostAt(point.x, point.y));
    if (legal(preferred) && this.unitAt(preferred.x, preferred.y)?.side !== "enemy") return { ...preferred };
    const candidates = Array.from({ length: this.map.width * this.map.height }, (_, index) => ({
      x: Math.floor(index / this.map.height), y: index % this.map.height
    })).filter(legal).sort((a, b) => a.x - b.x || Math.abs(a.y - this.map.height / 2) - Math.abs(b.y - this.map.height / 2));
    const position = candidates.find((point) => !this.unitAt(point.x, point.y))
      ?? candidates.find((point) => this.unitAt(point.x, point.y)?.side === "ally");
    if (!position) throw new Error("战场缺少合法的进攻方大本营");
    return { ...position };
  }

  resumeMonth() {
    if (!this.campaignMode || this.status !== "paused") return { ok: false, message: "战役未处于月末暂停状态" };
    this.status = "active";
    this.nextPauseDay = this.day + (this.rules.battleDayLimit ?? 30);
    this.day += 1;
    this.#prepareDay();
    this.#writeLog(`战役续行，进入第 ${this.day} 日。`);
    return { ok: true, resumed: true, day: this.day, status: this.status,
      ...(this.status === "ended" ? { battleEnded: true, winner: this.winner } : {}) };
  }

  #makeUnit({ id, side, commanders = [], name, commandLimit, troops, training, morale, unitType, composition, position }) {
    const officer = commanders[0];
    const abilities = commanders.length ? aggregateAbilities(commanders, { unitType, side }) : GARRISON_STATS;
    const unit = {
      id,
      side,
      officerId: officer?.id ?? null,
      officerIds: commanders.map((commander) => commander.id),
      officerNames: commanders.map((commander) => commander.name),
      name: name ?? officer?.name,
      rank: officer?.rank ?? null,
      commandLimit: commandLimit ?? (commanders.length ? formationCapacity(commanders, this.rules) : GARRISON_STATS.deploymentLimit),
      war: abilities.war,
      intelligence: abilities.intelligence,
      leadership: abilities.leadership,
      politics: abilities.politics,
      charm: abilities.charm,
      troops,
      maxTroops: troops,
      training,
      morale,
      unitType,
      composition: { ...composition },
      attackRange: 1,
      inCity: false,
      ambushing: false,
      statuses: {},
      position: { ...position }
    };
    initializeBattleStatuses(unit);
    this.#refreshUnitTroopStats(unit);
    unit.actionPoints = unit.maxActionPoints;
    unit.activationActionPoints = unit.maxActionPoints;
    return unit;
  }

  #refreshUnitTroopStats(unit) {
    const stats = calculateCombatStats(unit, this.rules);
    unit.combatStats = stats;
    const activeTypes = Object.keys(unit.composition ?? {}).filter((id) => unit.composition[id] > 0);
    unit.unitType = primaryTroopType(unit.composition);
    const type = this.rules.troopTypes?.[activeTypes[0]] ?? UNIT_TYPES[activeTypes[0]] ?? UNIT_TYPES.infantry;
    unit.unitTypeName = activeTypes.length > 1 ? "混编部队" : type.name;
    unit.rangedRange = stats.range;
    unit.rangedTroops = stats.rangedTroops;
    unit.maxActionPoints = stats.actionPoints;
    unit.vision = stats.vision;
    if (Number.isFinite(unit.actionPoints)) unit.actionPoints = Math.min(unit.actionPoints, unit.maxActionPoints);
  }

  /** Public hook for future effects that change training, morale or abilities. */
  refreshCombatStats(unit = this.activeUnit) {
    if (!unit) return undefined;
    this.#refreshUnitTroopStats(unit);
    return unit.combatStats;
  }

  #damageUnit(unit, requested, damageType) {
    const loss = applyFormationLosses(unit, requested, this.rules, damageType);
    this.#refreshUnitTroopStats(unit);
    if (unit.troops <= 0) {
      clearBattleStatuses(unit, "removed");
      this.#cancelProvocationsFrom(unit.id);
    }
    return loss;
  }

  #cancelProvocationsFrom(sourceId) {
    for (const unit of this.units) {
      if (getBattleStatus(unit, "provocation")?.sourceId === sourceId) removeBattleStatus(unit, "provocation");
    }
  }

  #prepareDay() {
    this.#reinforceDefenders();
    this.#checkVictory();
    if (this.status !== "active") return;
    const needs = { ally: this.dailyFoodNeed("ally"), enemy: this.dailyFoodNeed("enemy") };
    const shortfall = {
      ally: this.supplies.ally.food < needs.ally,
      enemy: this.supplies.enemy.food < needs.enemy
    };
    const attackerSpent = Math.min(this.supplies.ally.food, needs.ally);
    this.supplies.ally.food -= attackerSpent;
    // An attack that cannot feed itself withdraws before the defending army
    // begins its day, so no defending rations are charged in that case.
    if (shortfall.ally) {
      this.#writeLog(`攻方耗尽余粮 ${attackerSpent.toLocaleString()}，未能供给今日军需；守方军粮未支出。`,
        { audience: this.phase === "field" ? ["ally"] : ["ally", "enemy"] });
      this.#finish("enemy", "supply", "攻方军粮不足，被迫撤退");
      return;
    }
    this.rationDaysPaid.ally += 1;
    const defenderSpent = Math.min(this.supplies.enemy.food, needs.enemy);
    this.supplies.enemy.food -= defenderSpent;
    if (this.phase === "field") {
      this.#writeLog(`今日我军军粮消耗 ${attackerSpent.toLocaleString()}。`, { audience: ["ally"] });
      this.#writeLog(`今日我军军粮消耗 ${defenderSpent.toLocaleString()}。`, { audience: ["enemy"] });
    } else this.#writeLog(`今日军粮：攻方消耗 ${attackerSpent.toLocaleString()}，守方消耗 ${defenderSpent.toLocaleString()}。`);
    if (shortfall.enemy) {
      this.#finish("ally", "supply", "守方军粮不足，无法继续防守");
      return;
    }
    this.rationDaysPaid.enemy += 1;
    if (this.phase !== "field") { this.queue = []; return; }
    this.fieldUnits().forEach((unit) => {
      this.#refreshUnitTroopStats(unit);
      unit.actionPoints = unit.maxActionPoints;
      unit.activationActionPoints = unit.maxActionPoints;
      unit.strategyAttempted = false;
    });
    this.queue = this.fieldUnits()
      .map((unit) => unit.id)
      .sort((a, b) => this.initiative(this.getUnit(b)) - this.initiative(this.getUnit(a)));
    this.#refreshVisibility();
  }

  #reinforceDefenders() {
    if (this.phase !== "field" || !this.automaticDefenderReinforcements || !(this.defenderReserveTroops > 0)) return;
    let committed = 0;
    for (const unit of this.units.filter((entry) => entry.side === "enemy" && !entry.inCity)) {
      const incoming = Math.min(this.defenderReserveTroops, Math.max(0, unit.commandLimit - unit.troops));
      if (incoming <= 0) continue;
      const wasRouted = unit.troops <= 0;
      if (wasRouted) {
        unit.ambushing = false;
        clearBattleStatuses(unit, "removed");
        const fallbackTiles = Array.from({ length: this.map.width * this.map.height }, (_, index) => ({
          x: this.map.width - 1 - (index % this.map.width), y: Math.floor(index / this.map.width)
        }));
        const position = [...this.map.defenderStarts, ...fallbackTiles].find((tile) =>
          !this.unitAt(tile.x, tile.y) && Number.isFinite(this.movementCostAt(tile.x, tile.y)));
        if (!position) continue;
        unit.position = { ...position };
      }
      const total = unit.troops + incoming;
      unit.training = Math.round((unit.training * unit.troops + this.defenderReserveTraining * incoming) / total);
      unit.morale = Math.round((unit.morale * unit.troops + this.defenderReserveMorale * incoming) / total);
      applyFormationLosses(unit, 0, this.rules);
      unit.composition.infantry = (unit.composition.infantry ?? 0) + incoming;
      unit.troops = total;
      this.#refreshUnitTroopStats(unit);
      unit.maxTroops = Math.max(unit.maxTroops, total);
      if (wasRouted) {
        unit.morale = Math.max(25, unit.morale - 10);
        this.#refreshUnitTroopStats(unit);
        // The new formation has to reorganize and acts on the following day.
        unit.actionPoints = 0;
      }
      this.defenderReserveTroops -= incoming;
      committed += incoming;
    }
    if (committed) this.#writeLog(`城中预备兵 ${committed.toLocaleString()} 人补入防线，剩余预备 ${this.defenderReserveTroops.toLocaleString()} 人。`, { audience: ["enemy"] });
  }

  #writeLog(message, { audience, units } = {}) {
    const sides = audience ?? (units?.length ? this.#eventAudience(units) : ["ally", "enemy"]);
    this.log.unshift({ day: this.day, message, audience: [...sides] });
    this.log = this.log.slice(0, 36);
  }

  #eventAudience(units) {
    if (this.phase !== "field") return ["ally", "enemy"];
    return ["ally", "enemy"].filter((side) => units.every((unit) => unit.side === side || this.isUnitVisibleTo(unit, side)));
  }

  #refreshVisibility() {
    this.getVisibility("ally");
    this.getVisibility("enemy");
    // Remember only observations made by the affected army. A hidden caster's
    // subsequent movement must never become a homing beacon through the fog.
    for (const unit of this.fieldUnits()) {
      const effect = getBattleStatus(unit, "provocation");
      const source = this.getUnit(effect?.sourceId);
      if (source && this.isUnitVisibleTo(source, unit.side)) effect.lastKnownPosition = { ...source.position };
    }
  }

  getVisibility(side = this.playerSide) {
    const visibility = this.phase === "field" ? computeFieldVisibility(this, side) : {
      tiles: new Set(Array.from({ length: this.map.width * this.map.height }, (_, index) => keyOf(index % this.map.width, Math.floor(index / this.map.width)))),
      unitIds: new Set(this.livingUnits().map((unit) => unit.id))
    };
    const explored = this.exploredTiles[side] ??= new Set();
    for (const tile of visibility.tiles) explored.add(tile);
    return { visible: visibility.tiles, explored, unitIds: visibility.unitIds };
  }

  isUnitVisibleTo(unit, side = this.playerSide) {
    if (!unit || unit.troops <= 0) return false;
    if (this.phase !== "field") return true;
    return unitVisible(this, unit, side, this.getVisibility(side).visible);
  }

  visibleUnits(side = this.playerSide) {
    const visibility = this.getVisibility(side);
    return this.fieldUnits().filter((unit) => visibility.unitIds.has(unit.id));
  }

  visibleUnitAt(x, y, side = this.playerSide) {
    return this.visibleUnits(side).find((unit) => unit.position.x === x && unit.position.y === y);
  }

  getVisibleLog(side = this.playerSide) {
    return this.log.filter((entry) => !entry.audience || entry.audience.includes(side));
  }

  get activeUnit() {
    if (this.status !== "active" || this.phase !== "field") return undefined;
    return this.getUnit(this.queue?.[0]);
  }

  getUnit(id) {
    return this.units.find((unit) => unit.id === id);
  }

  livingUnits(side) {
    return this.units.filter((unit) => unit.troops > 0 && (!side || unit.side === side));
  }

  fieldUnits(side) {
    return this.livingUnits(side).filter((unit) => !unit.inCity);
  }

  getArmyStats(side) {
    const units = this.livingUnits(side);
    const reserve = side === "enemy" ? this.defenderReserveTroops : 0;
    const troops = units.reduce((sum, unit) => sum + unit.troops, reserve);
    const weighted = (key, reserveQuality) => troops ? Math.round((units.reduce((sum, unit) => sum + unit.troops * unit[key], 0)
      + reserve * reserveQuality) / troops) : 0;
    const escapedIds = new Set(this.escapedDefenderUnits.flatMap(formationOfficerIds));
    const commanders = side === "enemy" ? this.defenderOfficers.filter((officer) => !escapedIds.has(officer.id)) : this.attackerOfficers;
    const abilities = commanders.length ? aggregateAbilities(commanders) : { ...GARRISON_STATS };
    const composition = { infantry: reserve };
    for (const unit of units) {
      for (const [id, count] of Object.entries(formationComposition(unit, this.rules))) composition[id] = (composition[id] ?? 0) + count;
    }
    const troopStats = aggregateTroopStats(composition, this.rules);
    const army = { ...abilities, troops, training: weighted("training", this.defenderReserveTraining),
      morale: weighted("morale", this.defenderReserveMorale), effectiveTroops: effectiveTroops(troops, this.wallLevel, this.rules),
      composition, troopAttack: troopStats.attack, troopDefense: troopStats.defense };
    army.combatStats = calculateCombatStats(army, this.rules);
    return army;
  }

  changeMorale(side, amount, reason = "") {
    if (!["ally", "enemy"].includes(side) || !Number.isFinite(amount)) return { ok: false, message: "士气变动无效" };
    for (const unit of this.livingUnits(side)) {
      unit.morale = Math.max(0, Math.min(100, unit.morale + amount));
      this.#refreshUnitTroopStats(unit);
    }
    if (side === "enemy") this.defenderReserveMorale = Math.max(0, Math.min(100, this.defenderReserveMorale + amount));
    if (reason) this.#writeLog(`${side === "ally" ? "攻方" : "守方"}${reason}，士气 ${amount >= 0 ? "+" : ""}${amount}。`,
      { audience: this.phase === "field" ? [side] : ["ally", "enemy"] });
    return { ok: true, morale: this.getArmyStats(side).morale };
  }

  dailyFoodNeed(side) {
    const troops = this.livingUnits(side).reduce((sum, unit) => sum + unit.troops, 0)
      + (side === "enemy" ? this.defenderReserveTroops : 0);
    return dailyFoodCost(troops, this.rules);
  }

  // The current day's ration has already been paid. This is the number of further
  // complete days affordable at current strength, not a fixed retreat deadline.
  estimateSupplyDays(side) {
    const need = this.dailyFoodNeed(side);
    return need > 0 ? Math.floor(this.supplies[side].food / need) : Infinity;
  }

  strategyGoldCost(action) {
    if (action === "fireArrow") return Math.max(0, this.rangedConfig().fireArrowGoldCost);
    if (action === "doubt" || action === "provoke") return getStrategyConfig(action, this.rules).goldCost;
    return Math.max(0, this.rules.battle?.strategyGoldCosts?.[action] ?? (action === "fire" ? 50 : 0));
  }

  initiative(unit) {
    // Recompute the pure value here as tests and future officer effects can
    // modify abilities between activations without changing troop composition.
    return calculateCombatStats(unit, this.rules).initiative;
  }

  rangedConfig() {
    return { ...RANGED_DEFAULTS, ...this.rules.battle?.ranged };
  }

  actionCost(action, unit = this.activeUnit) {
    if (!unit) return Infinity;
    const scale = getFieldConfig(this.rules).attackCostScale;
    if (action === "attack") return (unit.combatStats ?? calculateCombatStats(unit, this.rules)).attackCost;
    if (action === "fire") return Math.max(1, Math.ceil(FIRE_COST * scale));
    if (action === "doubt" || action === "provoke") return getStrategyConfig(action, this.rules).actionPoints;
    if (action === "shoot" || action === "fireArrow") return Math.max(1, Math.ceil(this.rangedConfig()[`${action}ActionPoints`]));
    return 0;
  }

  terrainAt(x, y) {
    return this.map.terrain[y * this.map.width + x];
  }

  movementCostAt(x, y, unit, { cautious = false } = {}) {
    const cost = this.rules.terrain[this.terrainAt(x, y)]?.move ?? Infinity;
    if (!Number.isFinite(cost) || !cautious) return cost;
    return Math.min(unit?.maxActionPoints ?? this.activeUnit?.maxActionPoints ?? Infinity,
      cost * getFieldConfig(this.rules).cautiousMoveMultiplier);
  }

  neighbors(position) {
    const { x, y } = position;
    const loweredColumn = x % 2 === 1;
    const candidates = loweredColumn
      ? [[x, y - 1], [x, y + 1], [x - 1, y], [x - 1, y + 1], [x + 1, y], [x + 1, y + 1]]
      : [[x, y - 1], [x, y + 1], [x - 1, y - 1], [x - 1, y], [x + 1, y - 1], [x + 1, y]];
    return candidates
      .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < this.map.width && ny < this.map.height)
      .map(([nx, ny]) => ({ x: nx, y: ny }));
  }

  unitAt(x, y) {
    return this.fieldUnits().find((unit) => unit.position.x === x && unit.position.y === y);
  }

  distance(from, to) {
    return hexDistance(from, to);
  }

  isInEnemyZoc(position, side, { knownOnly = false } = {}) {
    const candidates = knownOnly ? this.visibleUnits(side) : this.fieldUnits();
    return candidates.some((unit) => unit.side !== side && this.distance(unit.position, position) === 1);
  }

  #pathMap(unit = this.activeUnit, options = {}) {
    const startKey = keyOf(unit.position.x, unit.position.y);
    const costs = new Map([[startKey, 0]]);
    const previous = new Map();
    const frontier = [{ position: unit.position, cost: 0 }];
    const knownUnits = this.visibleUnits(unit.side);
    const occupied = new Map(knownUnits.map((entry) => [keyOf(entry.position.x, entry.position.y), entry]));
    const knownZoc = new Set(knownUnits.filter((entry) => entry.side !== unit.side)
      .flatMap((entry) => this.neighbors(entry.position).map((position) => keyOf(position.x, position.y))));
    while (frontier.length) {
      frontier.sort((a, b) => a.cost - b.cost);
      const current = frontier.shift();
      for (const neighbor of this.neighbors(current.position)) {
        const moveCost = this.movementCostAt(neighbor.x, neighbor.y, unit, options);
        const nextCost = current.cost + moveCost;
        const key = keyOf(neighbor.x, neighbor.y);
        const occupant = occupied.get(key);
        if (nextCost > unit.actionPoints || (occupant && occupant.id !== unit.id)) continue;
        if (knownZoc.has(keyOf(current.position.x, current.position.y)) && knownZoc.has(key)) continue;
        if (costs.has(key) && costs.get(key) <= nextCost) continue;
        costs.set(key, nextCost);
        previous.set(key, keyOf(current.position.x, current.position.y));
        frontier.push({ position: neighbor, cost: nextCost });
      }
    }
    return { costs, previous, startKey };
  }

  reachableTiles(unit = this.activeUnit, options = {}) {
    if (this.status !== "active" || this.phase !== "field" || !unit || unit.inCity || unit.actionPoints <= 0) return [];
    const { costs, startKey } = this.#pathMap(unit, options);
    costs.delete(startKey);
    return [...costs.entries()].map(([key, cost]) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y, cost };
    });
  }

  findPath(destination, unit = this.activeUnit, options = {}) {
    if (this.status !== "active" || this.phase !== "field" || !unit || unit.inCity) return [];
    const destinationKey = keyOf(destination.x, destination.y);
    const { costs, previous, startKey } = this.#pathMap(unit, options);
    if (!costs.has(destinationKey) || destinationKey === startKey) return [];
    const path = [];
    let cursor = destinationKey;
    while (cursor !== startKey) {
      const [x, y] = cursor.split(",").map(Number);
      path.unshift({ x, y, cost: this.movementCostAt(x, y, unit, options) });
      cursor = previous.get(cursor);
      if (!cursor) return [];
    }
    return path;
  }

  attackTargets(unit = this.activeUnit) {
    if (this.status !== "active" || this.phase !== "field" || !unit || unit.inCity || unit.actionPoints < this.actionCost("attack", unit)) return [];
    return this.visibleUnits(unit.side).filter((target) => target.side !== unit.side)
      .filter((target) => this.distance(unit.position, target.position) === 1);
  }

  shootTargets(unit = this.activeUnit, action = "shoot") {
    if (this.status !== "active" || this.phase !== "field" || !unit || unit.inCity || unit.troops <= 0
      || unit.actionPoints < this.actionCost(action, unit) || this.supplies[unit.side].gold < this.strategyGoldCost(action)) return [];
    const stats = unit.combatStats ?? calculateCombatStats(unit, this.rules);
    if (stats.rangedTroops <= 0 || stats.range < 1) return [];
    return this.visibleUnits(unit.side).filter((target) => target.side !== unit.side)
      .filter((target) => this.distance(unit.position, target.position) <= stats.range);
  }

  fireArrowTargets(unit = this.activeUnit) {
    return this.shootTargets(unit, "fireArrow");
  }

  fireTargets(unit = this.activeUnit) {
    return this.strategyTargets("fire", unit);
  }

  strategyTargets(action, unit = this.activeUnit) {
    if (!["fire", "doubt", "provoke"].includes(action) || this.status !== "active" || this.phase !== "field"
      || !unit || unit.troops <= 0 || unit.inCity || unit.actionPoints < this.actionCost(action, unit)
      || this.supplies[unit.side].gold < this.strategyGoldCost(action) || this.#manualActionBlocked(unit)) return [];
    return this.visibleUnits(unit.side).filter((target) => target.side !== unit.side)
      .filter((target) => this.distance(unit.position, target.position) === 1)
      .filter((target) => action !== "doubt" || !getBattleStatus(target, "doubt"))
      .filter((target) => action !== "provoke" || !getBattleStatus(target, "provocation"));
  }

  /** Pure status query: reading the active unit never advances or consumes a turn. */
  hasForcedAction(unit = this.activeUnit) {
    return this.status === "active" && this.phase === "field" && Boolean(unit && unit.troops > 0
      && !unit.inCity && getControllingStatus(unit));
  }

  #manualActionBlocked(unit) {
    return this.hasForcedAction(unit) && this.#forcedActorId !== unit.id;
  }

  #controlRejection() {
    return { ok: false, forced: true, message: "部队正受疑兵或挑衅影响，须先结算强制行动" };
  }

  #withForcedAction(unit, execute) {
    const previous = this.#forcedActorId;
    this.#forcedActorId = unit.id;
    try { return { ...execute(), forced: true }; }
    finally { this.#forcedActorId = previous; }
  }

  #endForcedActivation(unit, message, extra = {}) {
    unit.actionPoints = 0;
    this.#writeLog(message, { units: [unit] });
    return this.#endActivation({ ok: true, forced: true, action: "provoke-end", actorId: unit.id, message, ...extra });
  }

  /** One call is one visible step, so animations and ambushes can interrupt pursuit. */
  runForcedTurn() {
    const unit = this.activeUnit;
    if (!this.hasForcedAction(unit)) return { ok: false, message: "当前部队没有强制行动" };
    if (getControllingStatus(unit)?.type === "doubt") {
      unit.ambushing = false;
      unit.actionPoints = 0;
      const message = `${unit.name}中了疑兵之计，本次行动无法出击。`;
      this.#writeLog(message, { units: [unit] });
      return this.#endActivation({ ok: true, forced: true, action: "doubt-skip", actorId: unit.id, message });
    }
    const effect = getBattleStatus(unit, "provocation");
    const source = this.getUnit(effect.sourceId);
    if (!source || source.troops <= 0 || source.inCity || source.side === unit.side
      || !Number.isInteger(source.position?.x) || !Number.isInteger(source.position?.y)
      || source.position.x < 0 || source.position.y < 0 || source.position.x >= this.map.width || source.position.y >= this.map.height) {
      removeBattleStatus(unit, "provocation");
      const message = `${unit.name}失去追击目标，恢复指挥。`;
      this.#writeLog(message, { audience: [unit.side] });
      return { ok: true, forced: true, action: "provoke-cancel", actorId: unit.id, message, actionContinues: true };
    }
    effect.active = true;
    unit.ambushing = false;
    const visible = this.isUnitVisibleTo(source, unit.side);
    if (visible) effect.lastKnownPosition = { ...source.position };
    if (visible && this.distance(unit.position, source.position) === 1) {
      if (unit.actionPoints >= this.actionCost("attack", unit)) return this.#withForcedAction(unit, () => this.attack(source.id));
      return this.#endForcedActivation(unit, `${unit.name}追击后行动力耗尽。`);
    }
    const destination = effect.lastKnownPosition;
    const currentDistance = destination ? this.distance(unit.position, destination) : 0;
    const moves = destination ? this.reachableTiles(unit, { cautious: false }) : [];
    const best = moves.sort((a, b) => this.distance(a, destination) - this.distance(b, destination)
      || a.cost - b.cost || a.x - b.x || a.y - b.y)[0];
    if (!best || this.distance(best, destination) >= currentDistance) {
      return this.#endForcedActivation(unit, `${unit.name}无法继续追击，结束本次行动。`);
    }
    const [step] = this.findPath(best, unit, { cautious: false });
    if (!step) return this.#endForcedActivation(unit, `${unit.name}追击受阻，结束本次行动。`);
    const result = this.#withForcedAction(unit, () => this.moveStep(step.x, step.y, { cautious: false }));
    if (!result.ok) return this.#endForcedActivation(unit, result.message, { interrupted: true });
    return result;
  }

  moveStep(x, y, { cautious = false } = {}) {
    const unit = this.activeUnit;
    if (this.#manualActionBlocked(unit)) return this.#controlRejection();
    const adjacent = unit && this.neighbors(unit.position).some((tile) => tile.x === x && tile.y === y);
    const cost = this.movementCostAt(x, y, unit, { cautious });
    if (!unit || !adjacent || !Number.isFinite(cost) || cost > unit.actionPoints) return { ok: false, message: "行动力不足或该格无法进入" };
    const occupant = this.unitAt(x, y);
    const zocBlocked = this.isInEnemyZoc(unit.position, unit.side) && this.isInEnemyZoc({ x, y }, unit.side);
    if (occupant || zocBlocked) {
      const knownBlock = occupant ? this.isUnitVisibleTo(occupant, unit.side)
        : this.isInEnemyZoc(unit.position, unit.side, { knownOnly: true }) && this.isInEnemyZoc({ x, y }, unit.side, { knownOnly: true });
      const message = !knownBlock ? "前方受阻，部队停止推进" : zocBlocked ? "不能在敌军控制区内连续移动，请先脱离控制区" : "该格已有部队，无法进入";
      this.#writeLog(message, { audience: [unit.side] });
      return { ok: false, interrupted: true, message };
    }
    const beforeAudience = this.#eventAudience([unit]);
    unit.ambushing = false;
    unit.position = { x, y };
    unit.actionPoints -= cost;
    this.#refreshVisibility();
    const audience = this.#eventAudience([unit]);
    this.#writeLog(`${unit.name}${cautious ? "警戒行军，" : ""}进入${this.rules.terrain[this.terrainAt(x, y)].name}，行动力 -${cost}。`, { audience });
    const lostSight = beforeAudience.filter((side) => !audience.includes(side));
    if (lostSight.length) this.#writeLog(`${unit.name}离开我军视野。`, { audience: lostSight });
    const ambushes = [];
    if (!cautious) {
      const ambushers = this.fieldUnits().filter((entry) => entry.side !== unit.side && entry.ambushing
        && this.distance(entry.position, unit.position) === 1)
        .sort((first, second) => this.initiative(second) - this.initiative(first) || first.id.localeCompare(second.id));
      for (const ambusher of ambushers) {
        if (unit.troops <= 0) break;
        ambusher.ambushing = false;
        const hitAudience = this.#eventAudience([ambusher, unit]);
        const preparation = ambusher.side === "enemy" && !this.ambushPreparationUsedId ? this.defenderAmbushPreparation : null;
        const baseDamage = this.#attackDamage(ambusher, unit);
        const damage = this.#damageUnit(unit, Math.round(baseDamage * (1 + (preparation?.bonus ?? 0))), "melee");
        if (damage > 0 && preparation) this.ambushPreparationUsedId = preparation.id;
        unit.morale = Math.max(0, unit.morale - 5);
        this.#refreshUnitTroopStats(unit);
        ambushes.push({ actorId: ambusher.id, targetId: unit.id, damage, preparationBonus: preparation?.bonus ?? 0 });
        this.#writeLog(`${ambusher.name}伏兵突击${unit.name}，造成 ${damage.toLocaleString()} 伤亡，行军被截断。`, { audience: hitAudience });
      }
    }
    if (ambushes.length) {
      unit.actionPoints = 0;
      this.#refreshVisibility();
      if (unit.troops > 0 && unit.side === "enemy" && x === this.attackerCamp.x && y === this.attackerCamp.y) {
        this.#finish("enemy", "camp", "守军攻占进攻方大本营，进攻军败退");
        return { ok: true, action: "move", actorId: unit.id, cost, cautious, step: true, ambushes,
          interrupted: true, activationEnded: true, battleEnded: true, winner: this.winner, message: this.outcomeReason };
      }
      if (unit.troops > 0 && unit.side === "ally" && x === this.stronghold.x && y === this.stronghold.y) {
        this.enterSiege();
        return { ok: true, message: "攻军击退伏兵后夺取主据点，转入攻城", step: true, action: "move",
          actorId: unit.id, cost, cautious, ambushes, interrupted: true, activationEnded: true, phaseChanged: true };
      }
      return this.#endActivation({ ok: true, message: "遭遇伏兵，当前行军已中断", step: true, action: "move",
        actorId: unit.id, cost, cautious, ambushes, interrupted: true, activationEnded: true });
    }
    if (unit.side === "enemy" && x === this.attackerCamp.x && y === this.attackerCamp.y) {
      this.#finish("enemy", "camp", "守军攻占进攻方大本营，进攻军败退");
      return { ok: true, action: "move", actorId: unit.id, cost, cautious, step: true, battleEnded: true,
        winner: this.winner, message: this.outcomeReason };
    }
    if (unit.side === "ally" && x === this.stronghold.x && y === this.stronghold.y) {
      this.enterSiege();
      return { ok: true, message: "攻军夺取主据点，转入攻城阶段", step: true, action: "move", actorId: unit.id, cost, cautious, phaseChanged: true };
    }
    return this.#continueOrEnd({ ok: true, message: `${unit.name}移动一格`, step: true, action: "move", actorId: unit.id, cost, cautious });
  }

  move(x, y, options) {
    return this.moveStep(x, y, options);
  }

  canAmbush(unit = this.activeUnit) {
    return this.status === "active" && this.phase === "field" && Boolean(unit) && unit.troops > 0 && !unit.inCity
      && !this.#manualActionBlocked(unit)
      && !unit.ambushing && unit.actionPoints > 0 && getFieldConfig(this.rules).ambushTerrains.includes(this.terrainAt(unit.position.x, unit.position.y));
  }

  ambush() {
    const unit = this.activeUnit;
    if (this.#manualActionBlocked(unit)) return this.#controlRejection();
    if (!this.canAmbush(unit)) return { ok: false, message: "仅树林或山地中的部队可以埋伏" };
    const audience = this.#eventAudience([unit]);
    unit.ambushing = true;
    unit.actionPoints = 0;
    this.#writeLog(`${unit.name}隐蔽待机，准备截击经过的敌军。`, { audience });
    return this.#endActivation({ ok: true, action: "ambush", actorId: unit.id, message: `${unit.name}已设下埋伏` });
  }

  #attackDamage(attacker, defender) {
    const attack = attacker.combatStats ?? calculateCombatStats(attacker, this.rules);
    const defense = defender.combatStats ?? calculateCombatStats(defender, this.rules);
    const terrain = this.rules.terrain[this.terrainAt(defender.position.x, defender.position.y)];
    const roll = 0.88 + this.rng() * 0.24;
    const attacksPerActivation = Math.max(1, Math.floor((attacker.activationActionPoints ?? attack.actionPoints) / attack.attackCost));
    return Math.max(1, Math.round(attack.meleeAttack * getCombatConfig(this.rules).meleeDamageRate
      / attacksPerActivation / defense.meleeDefense * roll * (1 - terrain.defense / 100)));
  }

  attack(targetId) {
    const attacker = this.activeUnit;
    if (this.#manualActionBlocked(attacker)) return this.#controlRejection();
    const defender = this.getUnit(targetId);
    const cost = this.actionCost("attack", attacker);
    if (!attacker || attacker.actionPoints < cost) return { ok: false, message: "行动力不足，无法攻击" };
    if (!defender || !this.attackTargets(attacker).includes(defender)) return { ok: false, message: "目标不在攻击范围" };
    attacker.ambushing = false;
    const audience = this.#eventAudience([attacker, defender]);
    attacker.actionPoints -= cost;
    const damage = this.#damageUnit(defender, this.#attackDamage(attacker, defender), "melee");
    defender.morale = Math.max(0, defender.morale - 5);
    this.#refreshUnitTroopStats(defender);
    this.#writeLog(`${attacker.name}猛攻${defender.name}，斩获 ${damage.toLocaleString()}，行动力 -${cost}。`, { audience });
    if (!audience.includes(defender.side)) this.#writeLog(`${defender.name}遭到攻击，损失 ${damage.toLocaleString()}。`, { audience: [defender.side] });

    if (defender.troops > 0 && this.distance(attacker.position, defender.position) === 1
      && this.rng() < getCombatConfig(this.rules).counterChance) {
      const own = defender.combatStats, opposing = attacker.combatStats;
      const terrain = this.rules.terrain[this.terrainAt(attacker.position.x, attacker.position.y)];
      const counter = this.#damageUnit(attacker, Math.max(1, Math.round(own.meleeAttack * getCombatConfig(this.rules).counterDamageRate
        / Math.max(1, Math.floor((attacker.activationActionPoints ?? opposing.actionPoints) / opposing.attackCost))
        * (0.88 + this.rng() * 0.24) / opposing.meleeDefense * (1 - terrain.defense / 100))), "melee");
      attacker.morale = Math.max(0, attacker.morale - 3);
      this.#refreshUnitTroopStats(attacker);
      this.#writeLog(`${defender.name}反击，${attacker.name}损失 ${counter.toLocaleString()}。`, { audience });
    }
    return this.#continueOrEnd({ ok: true, message: `造成 ${damage.toLocaleString()} 兵力伤亡`, damage, action: "attack", actorId: attacker.id, targetId: defender.id, cost });
  }

  shoot(targetId) {
    return this.#rangedAttack(targetId, "shoot");
  }

  fireArrow(targetId) {
    return this.#rangedAttack(targetId, "fireArrow");
  }

  #rangedAttack(targetId, action) {
    const attacker = this.activeUnit;
    if (this.#manualActionBlocked(attacker)) return this.#controlRejection();
    const defender = this.getUnit(targetId);
    if (!attacker) return { ok: false, message: "没有可行动部队" };
    const cost = this.actionCost(action, attacker);
    const goldCost = this.strategyGoldCost(action);
    const stats = attacker.combatStats ?? calculateCombatStats(attacker, this.rules);
    if (stats.rangedTroops <= 0) return { ok: false, message: "部队未编入可射击兵种" };
    if (attacker.actionPoints < cost) return { ok: false, message: "行动力不足，无法射击" };
    if (this.supplies[attacker.side].gold < goldCost) return { ok: false, message: `随军金钱不足，火矢需要 ${goldCost} 金` };
    if (!defender || !this.shootTargets(attacker, action).includes(defender)) return { ok: false, message: "目标不在射程或尚未发现" };

    attacker.ambushing = false;
    const audience = this.#eventAudience([attacker, defender]);
    attacker.actionPoints -= cost;
    this.supplies[attacker.side].gold -= goldCost;
    const config = this.rangedConfig();
    const terrain = this.rules.terrain[this.terrainAt(defender.position.x, defender.position.y)];
    const defense = defender.combatStats ?? calculateCombatStats(defender, this.rules);
    // Total shooter power is independent of non-shooters in this formation. A
    // lone archer may shoot for one casualty, never for the whole army's power.
    const rangedDamage = this.#damageUnit(defender, Math.max(1, Math.round(stats.rangedAttack * getCombatConfig(this.rules).rangedDamageRate
      / defense.rangedDefense * (0.88 + this.rng() * 0.24) * (1 - terrain.defense / 100))), "ranged");
    defender.morale = Math.max(0, defender.morale - (rangedDamage > 0 ? 3 : 0));
    this.#refreshUnitTroopStats(defender);
    const fireTriggered = action === "fireArrow" && defender.troops > 0
      && this.rng() < Math.max(0, Math.min(1, config.fireArrowChance));
    const fireDamage = fireTriggered ? this.#applySuccessfulFire(attacker, defender, { ranged: true }) : 0;
    const damage = rangedDamage + fireDamage;
    this.#writeLog(`${attacker.name}${action === "fireArrow" ? "施放火矢" : "齐射"}${defender.name}，造成 ${rangedDamage.toLocaleString()} 伤亡`
      + `${fireTriggered ? `，引燃阵地再造成 ${fireDamage.toLocaleString()} 伤亡` : ""}，行动力 -${cost}${goldCost ? `，金钱 -${goldCost}` : ""}。`, { audience });
    if (!audience.includes(defender.side)) this.#writeLog(`${defender.name}遭到${action === "fireArrow" ? "火矢" : "射击"}，损失 ${damage.toLocaleString()}。`, { audience: [defender.side] });
    // Shooting never invokes the melee counterattack branch, even at one tile.
    return this.#continueOrEnd({ ok: true, action, actorId: attacker.id, targetId: defender.id, cost, goldCost,
      damage, rangedDamage, fireTriggered, fireDamage,
      message: `${action === "fireArrow" ? "火矢" : "射击"}造成 ${damage.toLocaleString()} 伤亡${fireTriggered ? "，火计触发" : ""}` });
  }

  /** Shared successful effect. Callers own costs/chance; fire arrows never reroll fire(). */
  #applySuccessfulFire(attacker, defender, { ranged = false } = {}) {
    const terrain = this.terrainAt(defender.position.x, defender.position.y);
    const terrainBonus = terrain === "forest" ? 1.3 : terrain === "river" ? 0.65 : 1;
    const stats = attacker.combatStats ?? calculateCombatStats(attacker, this.rules);
    const power = ranged ? stats.rangedFirePower : stats.firePower;
    const damage = this.#damageUnit(defender, Math.max(1, Math.round(power * terrainBonus)), "fire");
    // Arrow ignition impact scales with absolute shooter firepower, not with
    // the fraction of infantry standing alongside those archers.
    const moraleDamage = ranged ? Math.max(1, Math.min(11, Math.round(power / 50))) : 11;
    defender.morale = Math.max(0, defender.morale - moraleDamage);
    this.#refreshUnitTroopStats(defender);
    return damage;
  }

  fire(targetId) {
    const attacker = this.activeUnit;
    if (this.#manualActionBlocked(attacker)) return this.#controlRejection();
    const defender = this.getUnit(targetId);
    const cost = this.actionCost("fire", attacker);
    if (!attacker || attacker.actionPoints < cost) return { ok: false, message: "行动力不足，无法施放火攻" };
    if (!defender || defender.inCity || defender.side === attacker.side || defender.troops <= 0
      || !this.isUnitVisibleTo(defender, attacker.side) || this.distance(attacker.position, defender.position) !== 1) {
      return { ok: false, message: "目标不在火攻范围或尚未发现" };
    }
    const goldCost = this.strategyGoldCost("fire");
    if (this.supplies[attacker.side].gold < goldCost) return { ok: false, message: `随军金钱不足，火攻需要 ${goldCost} 金` };
    attacker.ambushing = false;
    const audience = this.#eventAudience([attacker, defender]);
    attacker.actionPoints -= cost;
    this.supplies[attacker.side].gold -= goldCost;
    const chance = Math.max(0.22, Math.min(0.85, 0.43 + (attacker.intelligence - defender.intelligence) / 150));
    if (this.rng() > chance) {
      this.#writeLog(`${attacker.name}施放火计，却被${defender.name}识破，行动力 -${cost}，金钱 -${goldCost}。`, { audience });
      if (!audience.includes(defender.side)) this.#writeLog(`${defender.name}识破了敌军的火计。`, { audience: [defender.side] });
      return this.#continueOrEnd({ ok: true, message: "火攻失败", damage: 0, action: "fire", actorId: attacker.id, targetId: defender.id, cost, goldCost });
    }
    const damage = this.#applySuccessfulFire(attacker, defender);
    this.#writeLog(`${attacker.name}火计成功！${defender.name}损失 ${damage.toLocaleString()}，行动力 -${cost}，金钱 -${goldCost}。`, { audience });
    if (!audience.includes(defender.side)) this.#writeLog(`${defender.name}遭到火攻，损失 ${damage.toLocaleString()}。`, { audience: [defender.side] });
    return this.#continueOrEnd({ ok: true, message: `火攻成功，造成 ${damage.toLocaleString()} 伤亡`, damage, action: "fire", actorId: attacker.id, targetId: defender.id, cost, goldCost });
  }

  doubt(targetId) {
    return this.#controlStrategy("doubt", targetId);
  }

  provoke(targetId) {
    return this.#controlStrategy("provoke", targetId);
  }

  #controlStrategy(action, targetId) {
    const actor = this.activeUnit;
    if (this.#manualActionBlocked(actor)) return this.#controlRejection();
    const target = this.getUnit(targetId);
    if (!actor || !target || !this.strategyTargets(action, actor).includes(target)) {
      return { ok: false, message: "计略需要邻接且已发现的敌军，不能重复施加同一状态，亦须足够行动力与金钱" };
    }
    const cost = this.actionCost(action, actor), goldCost = this.strategyGoldCost(action);
    const success = this.rng() < strategySuccessChance(action, actor, target, this.rules);
    if (success) {
      const applied = applyBattleStatus(target, action === "doubt" ? "doubt" : "provocation", {
        remainingActivations: getStrategyConfig(action, this.rules).durationActivations, sourceId: actor.id,
        ...(action === "provoke" ? { lastKnownPosition: { ...actor.position }, active: false } : {})
      });
      if (!applied.ok) return { ok: false, message: applied.message };
    }
    actor.actionPoints -= cost;
    actor.ambushing = false;
    this.supplies[actor.side].gold -= goldCost;
    const name = action === "doubt" ? "疑兵" : "挑衅";
    const message = `${actor.name}向${target.name}施展${name}${success ? "成功" : "，被对方识破"}，行动力 -${cost}，金钱 -${goldCost}。`;
    this.#writeLog(message, { units: [actor, target] });
    return this.#continueOrEnd({ ok: true, action, actorId: actor.id, targetId: target.id, success,
      effectApplied: success, damage: 0, cost, goldCost, message });
  }

  wait() {
    const unit = this.activeUnit;
    if (this.#manualActionBlocked(unit)) return this.#controlRejection();
    if (!unit) return { ok: false, message: "没有可行动部队" };
    unit.morale = Math.min(100, unit.morale + 2);
    this.#refreshUnitTroopStats(unit);
    unit.actionPoints = 0;
    this.#writeLog(`${unit.name}结束行动，整队待命，士气 +2。`, { units: [unit] });
    return this.#endActivation({ ok: true, message: `${unit.name}结束行动`, action: "wait", actorId: unit.id });
  }

  runEnemyTurn() {
    return this.runAITurn(this.aiSide);
  }

  runAITurn(side = this.aiSide) {
    if (this.phase !== "field") return this.runAISiegeDecision(side);
    const unit = this.activeUnit;
    if (!unit || unit.side !== side) return { ok: false, message: "当前并非该军行动" };
    if (this.hasForcedAction(unit)) return this.runForcedTurn();
    const strategies = ["fire", "doubt", "provoke"].flatMap((action) => this.strategyTargets(action, unit).map((target) => ({ action, target })));
    if (unit.intelligence >= 70 && !unit.strategyAttempted && strategies.length) {
      unit.strategyAttempted = true;
      if (this.rng() < 0.25) {
        const choice = strategies[Math.min(strategies.length - 1, Math.floor(this.rng() * strategies.length))];
        return this[choice.action](choice.target.id);
      }
    }
    const rangedTargets = this.shootTargets(unit).sort((a, b) => a.troops - b.troops);
    if (rangedTargets.length) {
      const target = rangedTargets[0];
      if (this.fireArrowTargets(unit).includes(target) && this.rng() < 0.4) return this.fireArrow(target.id);
      return this.shoot(target.id);
    }
    const attackTargets = this.attackTargets(unit);
    if (attackTargets.length) return this.attack(attackTargets.sort((a, b) => a.troops - b.troops)[0].id);

    const enemies = this.visibleUnits(unit.side).filter((entry) => entry.side !== unit.side);
    if (this.canAmbush(unit) && (unit.side === "enemy" || enemies.reduce((sum, entry) => sum + entry.troops, 0) > unit.troops * 1.5)) return this.ambush();
    if (unit.side === "enemy" && unit.ambushing) return this.wait();
    const cautious = enemies.some((entry) => entry.ambushing && this.distance(unit.position, entry.position) <= unit.maxActionPoints + 1);
    const moves = this.reachableTiles(unit, { cautious });
    if (!moves.length) return this.wait();
    const objectives = unit.side === "ally" ? [this.stronghold, ...enemies.map((enemy) => enemy.position)]
      : [this.attackerCamp, ...enemies.map((enemy) => enemy.position)];
    if (!objectives.length) return this.wait();
    const currentDistance = Math.min(...objectives.map((position) => this.distance(unit.position, position)));
    const best = moves.sort((a, b) => {
      const da = Math.min(...objectives.map((position) => this.distance(a, position)));
      const db = Math.min(...objectives.map((position) => this.distance(b, position)));
      return da - db || a.cost - b.cost;
    })[0];
    const bestDistance = Math.min(...objectives.map((position) => this.distance(best, position)));
    if (bestDistance >= currentDistance) return this.wait();
    const [nextStep] = this.findPath(best, unit, { cautious });
    if (!nextStep) return this.wait();
    const result = this.moveStep(nextStep.x, nextStep.y, { cautious });
    // A concealed obstruction is not permission to retry the same guessed path
    // indefinitely. The AI gives up this activation without learning enemy IDs.
    return !result.ok && result.interrupted ? { ...this.wait(), interrupted: true, message: result.message } : result;
  }

  retreatToCity(unitId = this.activeUnit?.id) {
    const unit = this.activeUnit;
    if (this.#manualActionBlocked(unit)) return this.#controlRejection();
    if (this.phase !== "field" || !unit || unit.id !== unitId || unit.side !== "enemy") {
      return { ok: false, message: "仅当前行动的守军可以退回城内" };
    }
    const audience = this.#eventAudience([unit]);
    unit.ambushing = false;
    unit.inCity = true;
    this.#cancelProvocationsFrom(unit.id);
    unit.actionPoints = 0;
    this.#writeLog(`${unit.name}军收兵回城，保留现有兵力和士气。`, { audience });
    return this.#endActivation({ ok: true, action: "return", actorId: unit.id, message: `${unit.name}军已退回城内` });
  }

  enterSiege({ direct = false } = {}) {
    if (this.status !== "active" || this.phase !== "field") return { ok: false, message: "当前无法转入攻城" };
    this.phase = "siege_transition";
    this.units.forEach((unit) => { clearBattleStatuses(unit, "siege"); unit.ambushing = false; });
    this.queue = [];
    this.siege.orders = { ally: null, enemy: null };
    this.siege.troopCap = getSiegeConfig(this.rules).effectiveTroopCap;
    this.pendingDecision = !direct && this.fieldUnits("enemy").length
      ? { side: "enemy", kind: "external", options: ["return", ...(this.canDefenderRetreat ? ["retreat"] : [])] }
      : { side: "ally", kind: "encirclement", options: ["open", "encircle"] };
    this.#writeLog(`第 ${this.day} 日转入攻城；野战已消耗的兵粮与战役天数继续累计。`);
    return { ok: true, phaseChanged: true, message: "转入攻城阶段" };
  }

  chooseTransition(action) {
    const decision = this.pendingDecision;
    if (this.status !== "active" || this.phase !== "siege_transition" || !decision?.options.includes(action)) {
      return { ok: false, message: "当前没有这项战局选择" };
    }
    const config = getSiegeConfig(this.rules);
    if (decision.kind === "external") {
      if (action === "retreat") {
        if (!this.canDefenderRetreat) return { ok: false, message: "没有可供撤退的己方城池" };
        const escaped = this.#escapeDefenders(true);
        this.#writeLog(`城外军队 ${escaped.toLocaleString()} 人脱离战场，撤向其他己方城池。`);
        this.pendingDecision = { side: "ally", kind: "encirclement", options: ["open", "encircle"] };
        if (this.getArmyStats("enemy").troops === 0) {
          this.defenderRetreated = true;
          this.#finish("ally", "retreat", "守军全部撤离，攻方占领城池");
        }
      } else {
        this.siege.returningUnitIds = this.fieldUnits("enemy").map((unit) => unit.id);
        this.fieldUnits("enemy").forEach((unit) => { unit.inCity = true; unit.actionPoints = 0; });
        this.pendingDecision = { side: "ally", kind: "response", options: ["deceive", "intercept"] };
        this.#writeLog("城外守军正在回城，攻方可诈开城门或拦截归军。");
      }
    } else if (decision.kind === "response") {
      const attacker = this.getArmyStats("ally");
      const defender = this.getArmyStats("enemy");
      if (action === "deceive") {
        const chance = Math.max(0, Math.min(1, config.deceiveChanceBase
          + (attacker.intelligence - defender.intelligence) / config.deceiveIntelligenceScale));
        const success = this.rng() < chance;
        if (success) {
          const breach = damageSiegeLayers(this.siege, config.deceiveProgress);
          this.cityDefense = Math.max(0, this.cityDefense - config.deceiveDefenseDamage);
          this.#writeLog("诈开城门成功，守军失去部分城防与城墙阵地。");
          if (breach.conquered) this.#finish("ally", "siege", "攻军诈开最后一道城门，攻占城池");
        } else this.#writeLog("诈城被识破，归军顺利入城。");
      } else {
        const returning = this.livingUnits("enemy").filter((unit) => this.siege.returningUnitIds?.includes(unit.id));
        const returningTroops = returning.reduce((sum, unit) => sum + unit.troops, 0);
        const composition = {};
        for (const unit of returning) {
          for (const [id, count] of Object.entries(formationComposition(unit, this.rules))) composition[id] = (composition[id] ?? 0) + count;
        }
        const type = aggregateTroopStats(composition, this.rules);
        const losses = interceptionLosses(attacker, { ...aggregateAbilities(returning), troops: returningTroops,
          composition, troopAttack: type.attack, troopDefense: type.defense }, this.wallLevel, this.rules);
        const defenderLoss = this.#damageArmy("enemy", losses.defenderLoss, this.siege.returningUnitIds);
        const attackerLoss = this.#damageArmy("ally", losses.attackerLoss);
        this.#writeLog(`拦截归军：守方损失 ${defenderLoss.toLocaleString()}，攻方损失 ${attackerLoss.toLocaleString()}。`);
        this.#checkVictory();
      }
      this.siege.returningUnitIds = [];
      if (this.status === "active") this.pendingDecision = { side: "ally", kind: "encirclement", options: ["open", "encircle"] };
    } else {
      this.siege.encirclement = action;
      if (action === "encircle") {
        const extra = this.siege.maxHp * (Math.max(1, config.encirclementMultiplier) - 1);
        this.siege.maxHp += extra;
        this.siege.hp += extra;
      }
      this.pendingDecision = null;
      this.phase = "siege";
      this.livingUnits("enemy").forEach((unit) => { unit.inCity = true; });
      this.#writeLog(action === "open" ? "攻方围三阙一，留出退路；守军可无损撤走。" : "攻方全面包围，需突破更长的城墙防线；守军撤退会遭追击。");
    }
    return { ok: true, message: "战局选择已执行", phaseChanged: true,
      ...(this.status === "ended" ? { battleEnded: true, winner: this.winner } : {}) };
  }

  siegeOrder(side, action) {
    const choices = side === "ally" ? ATTACK_ORDERS : side === "enemy" ? DEFENSE_ORDERS : {};
    if (this.status !== "active" || this.phase !== "siege" || !Object.hasOwn(choices, action)) {
      return { ok: false, message: "当前不能执行这项攻城命令" };
    }
    if (this.siege.orders[side]) return { ok: false, message: "本日已经下达命令，等待对方" };
    this.siege.orders[side] = action;
    if (!this.siege.orders.ally || !this.siege.orders.enemy) return { ok: true, waiting: true, message: "命令已下达，等待对方" };
    const attackOrder = this.siege.orders.ally;
    const defenseOrder = this.siege.orders.enemy;
    const result = evaluateSiegeDay({ attacker: this.getArmyStats("ally"), defender: this.getArmyStats("enemy"),
      attackOrder, defenseOrder, wallLevel: this.wallLevel, cityDefense: this.cityDefense, encirclement: this.siege.encirclement }, this.rules, this.rng);
    this.#damageArmy("ally", result.attackerLoss);
    this.#damageArmy("enemy", result.defenderLoss);
    this.changeMorale("ally", result.attackerMorale);
    this.changeMorale("enemy", result.defenderMorale);
    this.cityDefense = Math.max(0, Math.min(100, this.cityDefense - result.defenseDamage + result.repair));
    this.siege.history.unshift({ day: this.day, attackOrder, defenseOrder, ...result });
    this.siege.orders = { ally: null, enemy: null };
    for (const strategy of result.strategyResults) this.#writeLog(`${strategy.side === "ally" ? "攻方" : "守方"}${strategy.action === "tunnel" ? "地道" : "袭扰"}${strategy.success ? "成功" : "失败"}（智力判定）。`);
    this.#writeLog(`第 ${this.day} 日：${ATTACK_ORDERS[attackOrder]} / ${DEFENSE_ORDERS[defenseOrder]}；攻方损失 ${result.attackerLoss}，守方损失 ${result.defenderLoss}，推进 ${result.progress.toFixed(1)}。`);
    this.#checkVictory();
    if (this.status === "active") {
      if (result.wallRepair > 0) {
        const repaired = Math.min(result.wallRepair, this.siege.maxHp - this.siege.hp);
        this.siege.hp += repaired;
        this.#writeLog(`城墙抢修恢复 ${repaired.toFixed(1)} 点墙体。`);
      }
      const breach = damageSiegeLayers(this.siege, result.progress);
      for (const name of breach.breached) this.#writeLog(`${name}已被攻破。`);
      if (breach.conquered) this.#finish("ally", "siege", "全部城墙防线被突破，城池失守");
    }
    if (this.status === "active") this.#completeDay();
    return { ...result, action: "siege", dayCompleted: true, message: "双方攻守命令结算完毕",
      ...(this.status === "paused" ? { monthPaused: true } : {}),
      ...(this.status === "ended" ? { battleEnded: true, winner: this.winner } : {}) };
  }

  runAISiegeDecision(side = this.aiSide) {
    if (this.status !== "active") return { ok: false, message: "战斗已经结束" };
    const config = getSiegeConfig(this.rules);
    if (this.phase === "siege_transition") {
      const decision = this.pendingDecision;
      if (!decision || decision.side !== side) return { ok: false, message: "等待对方决定" };
      const attacker = this.getArmyStats("ally");
      const defender = this.getArmyStats("enemy");
      if (decision.kind === "external") return this.chooseTransition("return");
      if (decision.kind === "response") return this.chooseTransition(attacker.intelligence > defender.intelligence + config.aiDeceiveIntelligenceAdvantage ? "deceive" : "intercept");
      return this.chooseTransition("encircle");
    }
    if (this.phase !== "siege" || this.siege.orders[side]) return { ok: false, message: "等待对方下令" };
    const own = this.getArmyStats(side);
    const opposing = this.getArmyStats(side === "ally" ? "enemy" : "ally");
    if (side === "ally") return this.siegeOrder("ally", this.cityDefense > config.aiTunnelDefenseThreshold && own.intelligence >= config.aiTunnelIntelligenceThreshold ? "tunnel"
      : own.troops > opposing.troops * config.aiAssaultTroopRatio ? "assault" : "ram");
    if (this.siege.encirclement === "open" && this.canDefenderRetreat && own.troops < opposing.troops * config.aiRetreatTroopRatio) return this.retreatArmy("enemy");
    return this.siegeOrder("enemy", own.morale < config.aiRotateMoraleThreshold ? "rotate" : this.cityDefense < config.aiRepairDefenseThreshold ? "repair"
      : own.troops > opposing.troops * config.aiSortieTroopRatio ? "sortie" : "rotate");
  }

  retreatArmy(side = this.playerSide) {
    if (this.status !== "active" || !["ally", "enemy"].includes(side)) return { ok: false, message: "当前无法撤军" };
    if (side === "ally") {
      this.#finish("enemy", "retreat", "进攻军主动撤退");
      return { ok: true, battleEnded: true, winner: this.winner, retreated: true, message: "进攻军已撤退" };
    }
    if (!this.canDefenderRetreat) return { ok: false, message: "没有可供撤退的己方城池" };
    if (this.phase === "siege_transition") return { ok: false, message: "请先完成外军与包围方式的战局选择" };
    const losses = this.phase === "siege" && this.siege.encirclement === "encircle"
      ? this.#damageArmy("enemy", Math.round(this.getArmyStats("ally").effectiveTroops * getSiegeConfig(this.rules).encircledRetreatLossRate)) : 0;
    const escapedTroops = this.#escapeDefenders(false);
    this.defenderRetreated = true;
    this.#finish("ally", "retreat", `守军弃城撤退，${escapedTroops.toLocaleString()} 人脱离，损失 ${losses.toLocaleString()} 人`);
    return { ok: true, battleEnded: true, winner: this.winner, retreated: true, escapedTroops, losses,
      safeRetreat: losses === 0, message: "守军已撤向其他己方城池" };
  }

  #damageArmy(side, requested, onlyIds = null, damageType = "melee") {
    const units = this.livingUnits(side).filter((unit) => !onlyIds || onlyIds.includes(unit.id));
    const reserve = side === "enemy" && !onlyIds ? this.defenderReserveTroops : 0;
    // Siege is one army: first apportion casualties by troop exposure across
    // every participating formation, including the city's infantry reserves.
    const reserves = { troops: reserve, composition: { infantry: reserve }, unitType: "infantry" };
    const loss = applyArmyLosses([...units, ...(reserve ? [reserves] : [])], requested, this.rules, damageType);
    for (const unit of units) this.#refreshUnitTroopStats(unit);
    if (reserve) this.defenderReserveTroops = reserves.troops;
    return loss;
  }

  #escapeDefenders(fieldOnly) {
    const escaped = (fieldOnly ? this.fieldUnits("enemy") : this.livingUnits("enemy"));
    this.escapedDefenderUnits.push(...structuredClone(escaped));
    const ids = new Set(escaped.map((unit) => unit.id));
    this.units = this.units.filter((unit) => !ids.has(unit.id));
    let troops = escaped.reduce((sum, unit) => sum + unit.troops, 0);
    if (!fieldOnly && this.defenderReserveTroops > 0) {
      this.escapedDefenderUnits.push({ id: `escaped-reserve-${this.day}`, side: "enemy", officerId: null, officerIds: [],
        name: "城内预备兵", troops: this.defenderReserveTroops, composition: { infantry: this.defenderReserveTroops },
        training: this.defenderReserveTraining, morale: this.defenderReserveMorale });
      troops += this.defenderReserveTroops;
      this.defenderReserveTroops = 0;
    }
    return troops;
  }

  #continueOrEnd(result) {
    this.#checkVictory();
    if (this.status !== "active") return { ...result, battleEnded: true, winner: this.winner };
    if (this.phase !== "field") return { ...result, phaseChanged: true };
    const unit = this.activeUnit;
    if (!unit || unit.troops <= 0 || unit.actionPoints <= 0) return this.#endActivation(result);
    return { ...result, actionContinues: true, remainingActionPoints: unit.actionPoints };
  }

  #endActivation(result) {
    const endingUnit = this.activeUnit;
    if (endingUnit) consumeActivationStatuses(endingUnit);
    this.#checkVictory();
    if (this.status !== "active") return { ...result, battleEnded: true, winner: this.winner };
    if (this.phase !== "field") return { ...result, phaseChanged: true };
    this.queue.shift();
    this.queue = this.queue.filter((id) => this.getUnit(id)?.troops > 0 && !this.getUnit(id)?.inCity);
    if (this.queue.length === 0) {
      this.#completeDay();
      if (this.status === "paused") return { ...result, activationEnded: true, monthPaused: true };
      if (this.status !== "active") return { ...result, battleEnded: true, winner: this.winner };
    }
    return { ...result, activationEnded: true };
  }

  #completeDay() {
    if (this.campaignMode && this.day >= this.nextPauseDay) {
      this.status = "paused";
      this.queue = [];
      this.#writeLog(`第 ${this.day} 日结束，战役转入月末休整，待下月继续。`);
    } else if (!this.campaignMode && this.day >= (this.rules.battleDayLimit ?? 30)) {
      this.#finish("enemy", "time", "战役期限已至，攻方撤退");
    } else {
      this.day += 1;
      this.#prepareDay();
      if (this.status === "active" && this.phase === "field") this.#writeLog(`第 ${this.day} 日，双方重新整队并恢复行动力。`);
    }
  }

  #checkVictory() {
    if (this.status !== "active") return;
    if (this.livingUnits("ally").length === 0) {
      this.#finish("enemy", "rout", "攻方部队溃灭");
      return;
    }
    if (this.livingUnits("enemy").length === 0 && this.defenderReserveTroops > 0) this.#reinforceDefenders();
    if (this.livingUnits("enemy").length === 0 && this.defenderReserveTroops === 0) {
      this.#finish("ally", "rout", "守方部队溃灭");
    } else if (this.phase === "field" && this.fieldUnits("enemy").length === 0) {
      this.enterSiege();
    }
  }

  #finish(winner, type, reason) {
    this.units.forEach((unit) => { clearBattleStatuses(unit, "battleEnd"); });
    this.status = "ended";
    this.winner = winner;
    this.outcomeType = type;
    this.outcomeReason = reason;
    this.queue = [];
    this.pendingDecision = null;
    this.#writeLog(`${reason}。${winner === "ally" ? "攻方胜利。" : "守方胜利。"}`);
  }
}

export { UNIT_TYPES, FIRE_COST };
