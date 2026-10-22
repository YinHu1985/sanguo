import { BattleEngine } from "./battle.js";
import { areAllied, resolveOccupation } from "./campaign.js";
import { mergeTroops } from "./rules.js";
import { addEvent } from "./state.js";
import { armyLimits, createDefenderFormations, formationCapacity, formationOfficerIds } from "./army.js";
import { normalizeCityDefense } from "./city-defense.js";
import { commitBattleDraft, planEscapedDefenders, remainingCityDefense, returnEscapedDefenders } from "./battle-result.js";

const cityById = (state, id) => state.cities.find((city) => city.id === id);
const officerById = (state, id) => state.officers.find((officer) => officer.id === id);
const amount = (value) => Number.isSafeInteger(value) && value >= 0;
const quality = (value) => Number.isFinite(value) && value >= 0 && value <= 100;
const storesValid = (stores) => stores && amount(stores.food) && amount(stores.gold);
const cityValid = (city) => city && Array.isArray(city.officerIds) && amount(city.troops)
  && storesValid(city) && quality(city.training) && quality(city.morale);
const activeOfficer = (officer, factionId) => officer && officer.factionId === factionId
  && officer.status !== "free" && officer.status !== "captured";
const weightedQuality = (units, key, fallback) => {
  const total = units.reduce((sum, unit) => sum + unit.troops, 0);
  return total ? Math.round(units.reduce((sum, unit) => sum + unit.troops * unit[key], 0) / total) : fallback;
};
const rejected = (message) => ({ ok: false, message });

/** Open a tactical defense from cargo already reserved by prepareInvasion. Never charge it again. */
export function createInvasionBattle(state, invasionId, rules, map, options = {}) {
  const invasion = state.pendingInvasions?.find((entry) => entry.id === invasionId && !entry.resolved);
  if (!invasion) return rejected("这场入侵已经处理或不再存在");
  const source = cityById(state, invasion.sourceId);
  const target = cityById(state, invasion.targetId);
  if (!cityValid(source) || !cityValid(target) || source.id === target.id
    || source.factionId !== invasion.attackerFactionId || target.factionId !== invasion.defenderFactionId
    || target.factionId !== state.playerFactionId || areAllied(state, source.factionId, target.factionId)) {
    return rejected("入侵双方的城池或归属已经变化，无法迎战");
  }
  const mode = options.mode ?? (invasion.resolutionMode === "siege" ? "siege" : "field");
  if (!["field", "siege"].includes(mode)) return rejected("守城战斗模式无效");
  const defenders = target.officerIds.map((id) => officerById(state, id)).filter((officer) => activeOfficer(officer, target.factionId));
  if (!defenders.length && mode === "field") return rejected("城中没有将领，守军只能守城，不能出城迎战");
  if (defenders.length !== target.officerIds.length || new Set(target.officerIds).size !== target.officerIds.length) {
    return rejected("城中守将的归属或驻地数据无效");
  }
  const ids = invasion.officerIds;
  // Legacy pending orders can lack divisions, but still contain the actual
  // reserved army and its real officers. Reuse exactly those soldiers, never add any.
  const divisions = invasion.divisions === undefined && Array.isArray(ids)
    ? [{ officerIds: [...ids], troops: invasion.troops, unitType: "infantry" }] : invasion.divisions;
  const { maxUnits, maxOfficersPerUnit: maxOfficers } = armyLimits(rules);
  const groupIds = Array.isArray(divisions) ? divisions.flatMap(formationOfficerIds) : [];
  const invalidFormation = (division, city) => {
    const officers = formationOfficerIds(division);
    return !officers.length || officers.length > maxOfficers || new Set(officers).size !== officers.length
      || officers.some((id) => !city.officerIds.includes(id) || !activeOfficer(officerById(state, id), city.factionId))
      || !amount(division.troops) || division.troops === 0
      || division.troops > formationCapacity(officers.map((id) => officerById(state, id)), rules)
      || !["infantry", "cavalry", "archer"].includes(division.unitType ?? "infantry");
  };
  if (!Array.isArray(divisions) || !divisions.length || divisions.length > maxUnits
    || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
    || groupIds.length !== ids.length || new Set(groupIds).size !== groupIds.length || groupIds.some((id) => !ids.includes(id))
    || divisions.some((division) => {
      return invalidFormation(division, source);
    }) || !amount(invasion.troops) || invasion.troops !== divisions.reduce((sum, division) => sum + division.troops, 0)
    || !storesValid(invasion.supplies) || !quality(invasion.training) || !quality(invasion.morale)) {
    return rejected("入侵军的将领、兵力或随军钱粮数据无效");
  }
  const defenderDivisions = options.defenderDivisions ?? invasion.defenderDivisions;
  if (defenderDivisions !== undefined) {
    const selectedIds = Array.isArray(defenderDivisions) ? defenderDivisions.flatMap(formationOfficerIds) : [];
    if (!Array.isArray(defenderDivisions) || defenderDivisions.length > maxUnits
      || (mode === "field" && !defenderDivisions.length) || new Set(selectedIds).size !== selectedIds.length
      || defenderDivisions.some((division) => invalidFormation(division, target))
      || defenderDivisions.reduce((sum, division) => sum + division.troops, 0) > target.troops) {
      return rejected("守军编组的将领或兵力无效");
    }
  }
  const deployedDefenders = defenderDivisions ?? createDefenderFormations(target, state.officers, rules);
  if (!map || !Array.isArray(map.attackerStarts) || map.attackerStarts.length < divisions.length
    || !Array.isArray(map.defenderStarts) || map.defenderStarts.length < deployedDefenders.length) {
    return rejected("战场部署位置不足，无法迎战");
  }
  try {
    const battle = new BattleEngine({
      sourceCity: { ...structuredClone(source), training: invasion.training, morale: invasion.morale },
      targetCity: structuredClone(target), divisions: structuredClone(divisions), officers: structuredClone(state.officers),
      supplies: { ...invasion.supplies }, rules, map, playerSide: "enemy", mode,
      ...(defenderDivisions === undefined ? {} : { defenderDivisions: structuredClone(defenderDivisions) }),
      canDefenderRetreat: state.cities.some((city) => city.id !== target.id && city.factionId === target.factionId)
    });
    battle.invasionId = invasion.id;
    battle.armyOfficerIds = [...ids];
    return { ok: true, battle };
  } catch {
    return rejected("战场数据无效，未扣除任何额外兵力或钱粮");
  }
}

/** Commit tactical defense atomically; ally/enemy still mean attacker/defender in the engine. */
export function settleDefensiveBattle(state, battle, winner, { retreated = false } = {}) {
  if (!battle || battle.settled) return rejected("此战已经结算或不存在");
  retreated ||= battle.defenderRetreated === true;
  if (!["ally", "enemy"].includes(winner) || !["active", "ended"].includes(battle.status)
    || (battle.status === "ended" && battle.winner !== winner)
    || (battle.status !== "ended" && !(retreated && winner === "ally"))
    || (retreated && winner !== "ally")) return rejected("战斗胜负无效");
  const invasion = state.pendingInvasions?.find((entry) => entry.id === battle.invasionId && !entry.resolved);
  const target = cityById(state, battle.targetCityId);
  const source = cityById(state, battle.sourceCityId);
  const initialDefenderTroops = target?.troops;
  if (!invasion || invasion.sourceId !== battle.sourceCityId || invasion.targetId !== battle.targetCityId
    || !cityValid(target) || target.factionId !== state.playerFactionId || target.factionId !== invasion.defenderFactionId
    || invasion.attackerFactionId === target.factionId || battle.playerSide !== "enemy") {
    return rejected("入侵命令或守城归属已经变化，无法结算");
  }
  if (!quality(invasion.training) || !quality(invasion.morale)
    || !storesValid(invasion.supplies) || !storesValid(battle.supplies?.ally) || !storesValid(battle.supplies?.enemy)
    || battle.supplies.ally.food > invasion.supplies.food || battle.supplies.ally.gold > invasion.supplies.gold
    || battle.supplies.enemy.food > target.food || battle.supplies.enemy.gold > target.gold
    || !Array.isArray(battle.units) || !battle.units.length
    || new Set(battle.units.map((unit) => unit.id)).size !== battle.units.length
    || battle.units.some((unit) => !["ally", "enemy"].includes(unit.side) || !amount(unit.troops)
      || !quality(unit.training) || !quality(unit.morale))) return rejected("战场兵力或钱粮数据无效");
  const attackers = battle.units.filter((unit) => unit.side === "ally" && unit.troops > 0);
  const defenders = battle.units.filter((unit) => unit.side === "enemy" && unit.troops > 0);
  const reserves = battle.defenderReserveTroops ?? 0;
  const reserveTraining = battle.defenderReserveTraining ?? target.training;
  const reserveMorale = battle.defenderReserveMorale ?? target.morale;
  if (!amount(reserves) || !quality(reserveTraining) || !quality(reserveMorale)) return rejected("守军预备队数据无效");
  const defendingArmy = [...defenders, { troops: reserves, training: reserveTraining, morale: reserveMorale }];
  const attackerSurvivors = attackers.reduce((sum, unit) => sum + unit.troops, 0);
  const defenderSurvivors = defendingArmy.reduce((sum, unit) => sum + unit.troops, 0);
  const escaped = planEscapedDefenders(state, battle, target);
  const defense = remainingCityDefense(battle, target);
  const ids = battle.armyOfficerIds;
  const attackingOfficerIds = battle.units.filter((unit) => unit.side === "ally").flatMap(formationOfficerIds);
  if (!amount(invasion.troops) || !amount(attackerSurvivors) || attackerSurvivors > invasion.troops
    || !amount(defenderSurvivors) || !escaped.ok || defenderSurvivors + escaped.troops > target.troops
    || defense === null || (winner === "ally" && attackerSurvivors === 0)
    || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
    || !Array.isArray(invasion.officerIds) || ids.length !== invasion.officerIds.length
    || ids.some((id) => !invasion.officerIds.includes(id))
    || attackingOfficerIds.length !== ids.length || new Set(attackingOfficerIds).size !== ids.length
    || attackingOfficerIds.some((id) => !ids.includes(id))) {
    return rejected("参战将领或存活兵力无效");
  }
  // A victorious army needs a valid strategic origin for the existing occupation transaction.
  // A defeated army may still return to another friendly seat if its old origin has fallen.
  if (winner === "ally" && (!cityValid(source) || source.factionId !== invasion.attackerFactionId
    || ids.some((id) => !source.officerIds.includes(id) || !activeOfficer(officerById(state, id), invasion.attackerFactionId)))) {
    return rejected("进攻军驻地或将领已经变化，无法办理占领");
  }
  const supplies = { attacker: { ...battle.supplies.ally }, defender: { ...battle.supplies.enemy } };
  const attackingTraining = weightedQuality(attackers, "training", invasion.training);
  const attackingMorale = weightedQuality(attackers, "morale", invasion.morale);
  const defendingTraining = weightedQuality(defendingArmy, "training", target.training);
  const defendingMorale = weightedQuality(defendingArmy, "morale", target.morale);
  const draft = structuredClone(state);
  const draftTarget = cityById(draft, target.id);
  const draftSource = cityById(draft, battle.sourceCityId);
  draftTarget.food = supplies.defender.food;
  draftTarget.gold = supplies.defender.gold;
  draftTarget.troops = defenderSurvivors;
  draftTarget.training = defendingTraining;
  draftTarget.morale = defendingMorale;
  Object.assign(draftTarget, normalizeCityDefense(target), { defense });
  returnEscapedDefenders(draft, escaped);
  const defenderOfficerIds = draftTarget.officerIds.filter((id) => activeOfficer(officerById(draft, id), invasion.defenderFactionId));
  let occupation = null;
  let returnCityId = null;
  let retreatCityId = escaped.retreatCityId;
  let escapedTroops = escaped.troops;
  if (winner === "enemy") {
    const home = draftSource?.factionId === invasion.attackerFactionId ? draftSource
      : draft.cities.find((city) => city.factionId === invasion.attackerFactionId);
    if (home) {
      if (!cityValid(home) || !amount(home.troops + attackerSurvivors)
        || !amount(home.food + supplies.attacker.food) || !amount(home.gold + supplies.attacker.gold)) {
        return rejected("进攻军的撤退驻地数据无效");
      }
      mergeTroops(home, attackerSurvivors, attackingTraining, attackingMorale);
      home.food += supplies.attacker.food;
      home.gold += supplies.attacker.gold;
      returnCityId = home.id;
    }
  } else {
    if (!amount(draftTarget.food + supplies.attacker.food) || !amount(draftTarget.gold + supplies.attacker.gold)) {
      return rejected("占领后的城池钱粮超过有效范围");
    }
    occupation = resolveOccupation(draft, { sourceId: draftSource.id, targetId: draftTarget.id, officerIds: ids,
      troops: attackerSurvivors, training: attackingTraining, morale: attackingMorale, ...supplies.attacker });
    if (!occupation.ok) return rejected(occupation.message);
    if (retreated && defenderSurvivors > 0) {
      // Keep retreating soldiers with the actual escaped commanders, including legacy retreat routing.
      const escapedCommander = occupation.escapedOfficerIds.map((id) => officerById(draft, id)).find(Boolean);
      const home = escapedCommander ? cityById(draft, escapedCommander.locationCityId) : null;
      if (home && home.factionId === invasion.defenderFactionId) {
        if (!cityValid(home) || !amount(home.troops + defenderSurvivors)) return rejected("守军撤退驻地数据无效");
        mergeTroops(home, defenderSurvivors, defendingTraining, defendingMorale);
        escapedTroops += defenderSurvivors;
        retreatCityId = home.id;
      }
    }
  }
  defenderOfficerIds.forEach((id) => { const officer = officerById(draft, id); if (officer) officer.acted = true; });
  const playerWon = winner === "enemy";
  const returnName = returnCityId ? cityById(draft, returnCityId).name : null;
  const message = playerWon
    ? `${target.name}迎战获胜，守军余 ${defenderSurvivors}。${returnName ? `来军退回${returnName}。` : "来军已无驻地，残部解散。"}`
    : retreated ? `${target.name}弃城撤退，城池及剩余仓储落入敌手。${retreatCityId ? `${escapedTroops}名守军随将领撤往${cityById(draft, retreatCityId).name}。` : "无城可退，残部解散，守将被俘。"}`
      : `${target.name}迎战失利，城池失守。${occupation.message}`;
  const pending = draft.pendingInvasions.find((entry) => entry.id === invasion.id);
  pending.resolved = true;
  pending.supplies = { food: 0, gold: 0 };
  draft.pendingInvasions = draft.pendingInvasions.filter((entry) => !entry.resolved);
  addEvent(draft, message);
  commitBattleDraft(state, draft);
  battle.settled = true;
  return { ok: true, source: cityById(state, battle.sourceCityId) ?? null, target: cityById(state, target.id), playerWon,
    attackerSurvivors, defenderSurvivors, attackerLosses: invasion.troops - attackerSurvivors,
    defenderLosses: initialDefenderTroops - defenderSurvivors - escaped.troops, supplies, message, occupation, returnCityId,
    escapedTroops, retreatCityId, retreated, days: battle.day, outcomeType: battle.outcomeType, outcomeReason: battle.outcomeReason };
}
