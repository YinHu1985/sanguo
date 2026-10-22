import { getCity, mergeTroops } from "./rules.js";
import { resolveOccupation } from "./campaign.js";
import { formationOfficerIds } from "./army.js";
import { normalizeCityDefense } from "./city-defense.js";

const validAmount = (value) => Number.isSafeInteger(value) && value >= 0;
const validQuality = (value) => Number.isFinite(value) && value >= 0 && value <= 100;
const weightedQuality = (units, key, fallback) => {
  const troops = units.reduce((sum, unit) => sum + unit.troops, 0);
  return troops ? Math.round(units.reduce((sum, unit) => sum + unit.troops * unit[key], 0) / troops) : fallback;
};

export function remainingCityDefense(battle, city) {
  const defense = battle.cityDefense ?? city.defense ?? 100;
  return validQuality(defense) ? defense : null;
}

/** Only already escaped soldiers are moved; this transaction never inflicts new losses. */
export function planEscapedDefenders(state, battle, target) {
  const units = battle.escapedDefenderUnits ?? [];
  if (!Array.isArray(units) || units.some((unit) => !unit || (unit.side && unit.side !== "enemy")
    || !validAmount(unit.troops) || !validQuality(unit.training) || !validQuality(unit.morale))) {
    return { ok: false, message: "撤离守军数据无效" };
  }
  const officerIds = units.flatMap(formationOfficerIds);
  const remainingIds = battle.units.filter((unit) => unit.side === "enemy").flatMap(formationOfficerIds);
  const troops = units.reduce((sum, unit) => sum + unit.troops, 0);
  if (!validAmount(troops) || new Set(officerIds).size !== officerIds.length
    || officerIds.some((id) => {
      const officer = state.officers.find((entry) => entry.id === id);
      return remainingIds.includes(id) || !target.officerIds.includes(id) || !officer
        || officer.factionId !== target.factionId || officer.status === "free" || officer.status === "captured";
    })) return { ok: false, message: "撤离守军的将领或兵力无效" };
  if (!units.length) return { ok: true, units, officerIds, troops: 0, retreatCityId: null };
  const visited = new Set([target.id]);
  const frontier = [target];
  let home = null;
  while (frontier.length && !home) {
    const city = frontier.shift();
    if (city.id !== target.id && city.factionId === target.factionId) { home = city; break; }
    for (const id of city.adjacent ?? []) {
      if (visited.has(id)) continue;
      visited.add(id);
      const next = getCity(state, id);
      if (next) frontier.push(next);
    }
  }
  home ??= state.cities.find((city) => city.id !== target.id && city.factionId === target.factionId);
  if (!home || !validAmount(home.troops + troops) || !validQuality(home.training) || !validQuality(home.morale)) {
    return { ok: false, message: "撤离守军没有有效的己方退路" };
  }
  return { ok: true, units, officerIds, troops, retreatCityId: home.id };
}

export function returnEscapedDefenders(state, plan) {
  if (!plan.units.length) return;
  const home = getCity(state, plan.retreatCityId);
  mergeTroops(home, plan.troops, weightedQuality(plan.units, "training", home.training), weightedQuality(plan.units, "morale", home.morale));
  for (const id of plan.officerIds) {
    for (const city of state.cities) {
      city.officerIds = city.officerIds.filter((officerId) => officerId !== id);
      if (city.governorId === id) city.governorId = null;
    }
    const officer = state.officers.find((entry) => entry.id === id);
    Object.assign(officer, { locationCityId: home.id, acted: true });
    home.officerIds.push(id);
  }
}

/** Keep public city/officer references usable while committing a validated draft atomically. */
export function commitBattleDraft(state, draft) {
  const cities = draft.cities.map((city) => Object.assign(getCity(state, city.id) ?? {}, city));
  const officers = draft.officers.map((officer) => Object.assign(state.officers.find((entry) => entry.id === officer.id) ?? {}, officer));
  Object.assign(state, draft, { cities, officers });
}

/** Commit a player's battlefield result exactly once, without UI or persistence effects. */
export function settlePlayerBattle(state, battle, winner) {
  if (!battle || battle.settled) return { ok: false, message: "此战已经结算或不存在" };
  if (!["ally", "enemy"].includes(winner) || (battle.status === "ended" && battle.winner !== winner)
    || (winner === "ally" && battle.status !== "ended")) return { ok: false, message: "战斗胜负无效" };
  const source = getCity(state, battle.sourceCityId);
  const target = getCity(state, battle.targetCityId);
  if (!source || !target || source.id === target.id || source.factionId !== state.playerFactionId || target.factionId === source.factionId) {
    return { ok: false, message: "战斗城池或归属已变化，无法结算" };
  }
  const stores = battle.supplies;
  if (!stores?.ally || !stores?.enemy || [stores.ally.food, stores.ally.gold, stores.enemy.food, stores.enemy.gold].some((value) => !validAmount(value))
    || !Array.isArray(battle.units) || battle.units.some((unit) => !["ally", "enemy"].includes(unit.side)
      || !validAmount(unit.troops) || !validQuality(unit.training) || !validQuality(unit.morale))) {
    return { ok: false, message: "战场钱粮或部队数据无效" };
  }
  const allies = battle.units.filter((unit) => unit.side === "ally" && unit.troops > 0);
  const enemies = battle.units.filter((unit) => unit.side === "enemy" && unit.troops > 0);
  const reserves = battle.defenderReserveTroops ?? 0;
  const reserveTraining = battle.defenderReserveTraining ?? target.training;
  const reserveMorale = battle.defenderReserveMorale ?? target.morale;
  const allyTroops = allies.reduce((sum, unit) => sum + unit.troops, 0);
  const enemyTroops = enemies.reduce((sum, unit) => sum + unit.troops, 0) + reserves;
  const unitOfficerIds = battle.units.filter((unit) => unit.side === "ally").flatMap(formationOfficerIds);
  const officerIds = battle.armyOfficerIds ?? unitOfficerIds;
  const escaped = planEscapedDefenders(state, battle, target);
  const defense = remainingCityDefense(battle, target);
  if (!validAmount(reserves) || !validQuality(reserveTraining) || !validQuality(reserveMorale)
    || !validAmount(allyTroops) || !validAmount(enemyTroops) || (winner === "ally" && allyTroops === 0)
    || !escaped.ok || enemyTroops + escaped.troops > target.troops || defense === null
    || !Array.isArray(officerIds) || !officerIds.length || new Set(officerIds).size !== officerIds.length
    || unitOfficerIds.length !== officerIds.length || new Set(unitOfficerIds).size !== unitOfficerIds.length
    || unitOfficerIds.some((id) => !officerIds.includes(id))
    || officerIds.some((id) => {
      const officer = state.officers.find((person) => person.id === id);
      return !officer || !source.officerIds.includes(id) || officer.factionId !== source.factionId || officer.status === "free" || officer.status === "captured";
    })) return { ok: false, message: "出征将领或存活兵力无效" };

  const supplies = { ...stores.ally };
  const training = weightedQuality(allies, "training", source.training);
  const morale = weightedQuality(allies, "morale", source.morale);
  const defendingUnits = [...enemies, { troops: reserves, training: reserveTraining, morale: reserveMorale }];
  const draft = structuredClone(state);
  const draftTarget = getCity(draft, target.id);
  const draftSource = getCity(draft, source.id);
  // The defender's stock is a battle-owned copy until this transaction; never add it to the old warehouse.
  draftTarget.food = stores.enemy.food;
  draftTarget.gold = stores.enemy.gold;
  draftTarget.troops = enemyTroops;
  draftTarget.training = weightedQuality(defendingUnits, "training", target.training);
  draftTarget.morale = weightedQuality(defendingUnits, "morale", target.morale);
  Object.assign(draftTarget, normalizeCityDefense(target), { defense });
  returnEscapedDefenders(draft, escaped);
  let occupation;
  if (winner === "ally") {
    occupation = resolveOccupation(draft, { sourceId: source.id, targetId: target.id, officerIds,
      troops: allyTroops, training, morale, ...supplies });
    if (!occupation.ok) return { ok: false, message: occupation.message };
  } else {
    if (!validAmount(source.troops + allyTroops) || !validAmount(source.food + supplies.food) || !validAmount(source.gold + supplies.gold)) {
      return { ok: false, message: "撤军后的兵力或钱粮超过有效范围" };
    }
    mergeTroops(draftSource, allyTroops, training, morale);
    draftSource.food += supplies.food;
    draftSource.gold += supplies.gold;
  }
  commitBattleDraft(state, draft);
  battle.settled = true;
  return { ok: true, source, target, allyTroops, enemyTroops, supplies,
    escapedDefenderTroops: escaped.troops, defenderRetreatCityId: escaped.retreatCityId, ...(occupation ? { occupation } : {}) };
}
