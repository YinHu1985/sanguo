import { BattleEngine } from "./battle.js";
import { simulateBattleMonth } from "./battle-simulation.js";
import { addEvent } from "./state.js";
import { resolveOccupation } from "./campaign.js";
import { formationOfficerIds, formationCapacity, armyLimits } from "./army.js";
import { sumEquipment, addEquipment, EQUIPMENT_KEYS, formationComposition, equipmentAvailable } from "./troops.js";
import { activeBattleCampaigns, cityBesieged, restoreWarLocks, markWarRations, officerAtWar } from "./war-state.js";
import { cancelCityTasks } from "./tasks.js";

export { activeBattleCampaigns, cityBesieged } from "./war-state.js";
export const listBattleCampaigns = (state) => state.battles ?? [];
const cityById = (state, id) => state.cities.find((city) => city.id === id);
const recordById = (state, id) => state.battles?.find((record) => record.id === (typeof id === "string" ? id : id?.id));
const amount = (n) => Number.isSafeInteger(n) && n >= 0;
const quality = (n) => Number.isFinite(n) && n >= 0 && n <= 100;
const validComposition = (unit, rules) => {
  if (unit.composition && (typeof unit.composition !== "object" || Array.isArray(unit.composition)
    || Object.entries(unit.composition).some(([id, count]) => !rules.troopTypes?.[id] || !amount(count)))) return false;
  return Object.values(formationComposition(unit, rules)).reduce((sum, count) => sum + count, 0) === unit.troops;
};
const fail = (message) => ({ ok: false, message });
const currentTargetTurn = (state) => state.turnResolution?.targetTurn ?? (state.elapsedMonths ?? 0) + 1;
const rationDays = (record, battle, side) => Math.min(30, Math.max(0, battle.rationDaysPaid
  ? battle.rationDaysPaid[side] - (record.rationStart?.[side] ?? 0)
  : battle.day - (record.sliceStartDay ?? 1) + 1));
function commitCampaignState(state, draft) {
  for (const key of ["cities", "officers", "tasks", "battles"]) if (Array.isArray(draft[key])) {
    draft[key] = draft[key].map((entry) => {
      const old = state[key]?.find((item) => item.id === entry.id);
      if (!old) return entry;
      for (const property of Object.keys(old)) if (!(property in entry)) delete old[property];
      return Object.assign(old, entry);
    });
  }
  Object.assign(state, draft);
}
const weighted = (units, key, fallback = 80) => {
  const total = units.reduce((sum, unit) => sum + unit.troops, 0);
  return total ? Math.round(units.reduce((sum, unit) => sum + unit.troops * unit[key], 0) / total) : fallback;
};
const merge = (city, units) => {
  const troops = units.reduce((sum, unit) => sum + unit.troops, 0), total = city.troops + troops;
  for (const key of ["training", "morale"]) if (total) city[key] = Math.round((city[key] * city.troops + weighted(units, key) * troops) / total);
  city.troops = total;
};
function moveOfficer(state, id, city) {
  const officer = state.officers.find((entry) => entry.id === id);
  if (!officer) return;
  for (const place of state.cities) {
    place.officerIds = place.officerIds.filter((value) => value !== id);
    if (place.governorId === id) place.governorId = null;
  }
  officer.locationCityId = city.id;
  if (!city.officerIds.includes(id)) city.officerIds.push(id);
}

/** Finished battles are reports, not resumable engines. Keep the entire history
 * without filling browser storage with another map and full officer roster. */
export function archiveBattleSnapshot(snapshot) {
  return { archiveSchemaVersion: 1, status: "ended", day: snapshot.day, phase: snapshot.phase,
    winner: snapshot.winner, outcomeReason: snapshot.outcomeReason,
    units: (snapshot.units ?? []).map((unit) => Object.fromEntries(["id", "side", "name", "officerId", "officerIds", "troops", "composition", "training", "morale"]
      .filter((key) => unit[key] !== undefined).map((key) => [key, structuredClone(unit[key])]))),
    defenderReserveTroops: snapshot.defenderReserveTroops ?? 0,
    supplies: structuredClone(snapshot.supplies),
    siege: snapshot.siege ? { hp: snapshot.siege.hp, maxHp: snapshot.siege.maxHp } : null,
    log: structuredClone((snapshot.log ?? []).slice(0, 36)) };
}

export function enableWarCampaigns(state, map) {
  state.warCampaignsVersion = 1;
  state.battles ??= [];
  if (!Number.isSafeInteger(state.nextBattleId) || state.nextBattleId < 1) state.nextBattleId = 1;
  while (state.battles.some((record) => record.id === `war-${state.nextBattleId}`)) state.nextBattleId += 1;
  for (const record of state.battles) if (record.status === "ended" && !record.snapshot?.archiveSchemaVersion && record.snapshot) {
    record.snapshot = archiveBattleSnapshot(record.snapshot);
  }
  if (map) state.warBattleMap = structuredClone(map);
  restoreWarLocks(state);
  return state;
}

function registerBattle(state, order, rules, map, { kind, taskId, invasionId, mode = "field", defenderDivisions, targetTurn = currentTargetTurn(state) } = {}) {
  const existing = activeBattleCampaigns(state).find((record) => taskId && record.taskId === taskId || invasionId && record.invasionId === invasionId);
  if (existing) return { ok: true, record: existing };
  const actualState = state;
  state = structuredClone(state);
  const source = cityById(state, order.sourceCityId ?? order.sourceId), target = cityById(state, order.targetCityId ?? order.targetId);
  const attackerFactionId = order.attackerFactionId ?? source?.factionId;
  if (!amount(targetTurn) || !["field", "siege"].includes(mode)) return fail("战役回合或守城模式无效");
  if (!source || !target || attackerFactionId === target.factionId || cityBesieged(state, target.id)) return fail("目标城已处于战役中或归属已经变化");
  if (!Array.isArray(order.divisions) || !order.divisions.length || order.divisions.some((unit) => !amount(unit.troops)
    || unit.troops === 0 || !validComposition(unit, rules)) || ![order.supplies?.food, order.supplies?.gold, target.troops, target.food, target.gold].every(amount)
    || !quality(order.training ?? source.training) || !quality(order.morale ?? source.morale)
    || !quality(target.training) || !quality(target.morale)) return fail("出征军队或守城账本无效");
  cancelCityTasks(state, target.id, targetTurn);
  const attackerIds = order.armyOfficerIds ?? order.officerIds ?? order.divisions.flatMap(formationOfficerIds);
  if (!attackerIds.length || new Set(attackerIds).size !== attackerIds.length
    || order.divisions.flatMap(formationOfficerIds).length !== attackerIds.length
    || order.divisions.flatMap(formationOfficerIds).some((id) => !attackerIds.includes(id))
    || attackerIds.some((id) => { const officer = state.officers.find((entry) => entry.id === id);
      return !officer || officer.battleId || officer.factionId !== attackerFactionId || ["free", "captured"].includes(officer.status); })) return fail("参战将领不可用或已在其他战场");
  // A field army fighting elsewhere is not also available in its home city's defense.
  const targetView = { ...target, officerIds: target.officerIds.filter((id) => !officerAtWar(state, id)) };
  if (defenderDivisions !== undefined) {
    const ids = Array.isArray(defenderDivisions) ? defenderDivisions.flatMap(formationOfficerIds) : [];
    const limits = armyLimits(rules);
    if (!Array.isArray(defenderDivisions) || (mode === "field" && targetView.officerIds.length > 0 && !defenderDivisions.length)
      || defenderDivisions.length > limits.maxUnits || new Set(ids).size !== ids.length
      || defenderDivisions.some((unit) => { const members = formationOfficerIds(unit).map((id) => state.officers.find((entry) => entry.id === id));
        return !members.length || members.length > limits.maxOfficersPerUnit || members.some((officer) => !officer || !targetView.officerIds.includes(officer.id))
          || !amount(unit.troops) || !validComposition(unit, rules) || unit.troops > formationCapacity(members, rules);
      }) || !equipmentAvailable(target, sumEquipment(defenderDivisions, rules))) return fail("守城编组的将领、兵额或装备无效");
  }
  let battle;
  try {
    battle = new BattleEngine({ sourceCity: { ...source, factionId: attackerFactionId, officerIds: [...attackerIds], training: order.training ?? source.training, morale: order.morale ?? source.morale },
      targetCity: targetView, divisions: structuredClone(order.divisions), supplies: { ...order.supplies }, officers: structuredClone(state.officers),
      state, rules, map: map ?? state.warBattleMap, campaignMode: true, mode: targetView.officerIds.length ? mode : "siege",
      ...(defenderDivisions ? { defenderDivisions: structuredClone(defenderDivisions) } : {}),
      playerSide: attackerFactionId === state.playerFactionId ? "ally" : "enemy",
      canDefenderRetreat: state.cities.some((city) => city.id !== target.id && city.factionId === target.factionId && !cityBesieged(state, city.id)) });
  } catch (error) { return fail(`无法建立战役：${error.message}`); }
  if (order.equipment) battle.attackerEquipmentCommitted = { ...order.equipment };
  else delete battle.attackerEquipmentCommitted;
  state.battles ??= [];
  let nextId = state.nextBattleId ?? 1;
  while (state.battles.some((record) => record.id === `war-${nextId}`)) nextId += 1;
  if (!Number.isSafeInteger(nextId) || nextId < 1 || !Number.isSafeInteger(nextId + 1)) return fail("战役编号超出安全范围");
  const id = `war-${nextId}`; state.nextBattleId = nextId + 1;
  const record = { id, kind, taskId, invasionId, sourceCityId: source.id, targetCityId: target.id,
    attackerFactionId, defenderFactionId: target.factionId,
    officerIds: [...new Set([...attackerIds, ...targetView.officerIds])], attackerOfficerIds: [...attackerIds],
    status: "active", revision: 0, startedTurn: targetTurn, processingTurn: targetTurn, lastProcessedTurn: targetTurn - 1,
    sliceStartDay: 1, rationStart: { ally: 0, enemy: 0 },
    initialAttackerTroops: battle.units.filter((unit) => unit.side === "ally").reduce((sum, unit) => sum + unit.troops, 0),
    initialDefenderTroops: target.troops, accountedEquipment: { ...battle.defenderEquipmentCommitted }, snapshot: battle.snapshot() };
  battle.campaignRevision = 0;
  state.battles.push(record);
  if (taskId) { const task = state.tasks.find((entry) => entry.id === taskId); task.status = "in_battle"; task.battleId = id; }
  if (invasionId) state.pendingInvasions = (state.pendingInvasions ?? []).filter((entry) => entry.id !== invasionId);
  restoreWarLocks(state);
  const saved = checkpointBattle(state, id, battle, { targetTurn });
  if (!saved.ok) return saved;
  commitCampaignState(actualState, state);
  return { ok: true, record: recordById(actualState, id) };
}

export function ensureTaskBattle(state, taskOrId, rules, map, options = {}) {
  const task = state.tasks?.find((entry) => entry.id === (typeof taskOrId === "string" ? taskOrId : taskOrId?.id));
  if (!task) return fail("出征任务不存在");
  const existing = (state.battles ?? []).find((record) => record.taskId === task.id);
  if (existing) return { ok: true, record: existing };
  if (task.status !== "awaiting_battle" || !task.battle) return fail("出征尚未到达");
  return registerBattle(state, task.battle, rules, map, { ...options, kind: "march", taskId: task.id });
}

export function ensureInvasionBattle(state, invasionOrId, rules, map, options = {}) {
  const id = typeof invasionOrId === "string" ? invasionOrId : invasionOrId?.id;
  const existing = (state.battles ?? []).find((record) => record.invasionId === id);
  if (existing) return { ok: true, record: existing };
  const invasion = state.pendingInvasions?.find((entry) => entry.id === id && !entry.resolved);
  if (!invasion) return fail("入侵记录不存在或已处理");
  return registerBattle(state, invasion, rules, map, { mode: invasion.resolutionMode ?? "field", defenderDivisions: invasion.defenderDivisions,
    ...options, kind: invasion.attackerFactionId === state.playerFactionId || invasion.defenderFactionId === state.playerFactionId ? "invasion" : "ai", invasionId: id });
}

export function getBattleEngine(state, id, rules, { targetTurn = currentTargetTurn(state) } = {}) {
  if (!amount(targetTurn)) return fail("战役回合无效");
  const record = recordById(state, id);
  if (!record || record.status === "ended") return fail("战役已经结束或不存在");
  let battle;
  try { battle = BattleEngine.fromSnapshot(record.snapshot, { rules }); }
  catch (error) { return fail(`战役存档无法恢复：${error.message}`); }
  battle.campaignRevision = record.revision ?? 0;
  battle.canDefenderRetreat = state.cities.some((city) => city.id !== record.targetCityId && city.factionId === record.defenderFactionId && !cityBesieged(state, city.id));
  if (battle.status === "paused" && record.lastProcessedTurn < targetTurn) {
    record.rationStart = { ...(battle.rationDaysPaid ?? {}) };
    const resumed = battle.resumeMonth();
    if (!resumed.ok) return resumed;
    record.processingTurn = targetTurn;
    record.sliceStartDay = battle.day;
  }
  return { ok: true, battle, record };
}

function finishCampaign(state, record, battle) {
  const target = cityById(state, record.targetCityId);
  const defenderSurvivors = target.troops;
  const attackers = battle.units.filter((unit) => unit.side === "ally" && unit.troops > 0);
  const attackTroops = attackers.reduce((sum, unit) => sum + unit.troops, 0);
  const equipment = battle.attackerEquipmentCommitted ? sumEquipment(attackers, battle.rules) : {};
  const home = [cityById(state, record.sourceCityId), ...state.cities].find((city) => city && city.factionId === record.attackerFactionId && !cityBesieged(state, city.id));
  let occupation = null;
  if (battle.winner === "ally") {
    // A field army remains an independent force even after its former base falls.
    const temporary = { id: `detached-${record.id}`, name: "行营", factionId: record.attackerFactionId,
      officerIds: [...record.attackerOfficerIds], governorId: null, troops: 0, gold: 0, food: 0, training: weighted(attackers, "training"), morale: weighted(attackers, "morale"), adjacent: [] };
    state.cities.push(temporary);
    for (const id of record.attackerOfficerIds) moveOfficer(state, id, temporary);
    occupation = resolveOccupation(state, { sourceId: temporary.id, targetId: target.id, officerIds: record.attackerOfficerIds,
      troops: attackTroops, training: weighted(attackers, "training"), morale: weighted(attackers, "morale"), ...battle.supplies.ally, equipment }, battle.rng);
    state.cities = state.cities.filter((city) => city.id !== temporary.id);
    if (!occupation.ok) throw new Error(occupation.message);
    markWarRations(target, record.processingTurn, target.troops, { replace: true, days: rationDays(record, battle, "ally") });
  } else if (home) {
    merge(home, attackers); home.food += battle.supplies.ally.food; home.gold += battle.supplies.ally.gold; addEquipment(home, equipment);
    markWarRations(home, record.processingTurn, attackTroops, { days: rationDays(record, battle, "ally") });
    for (const id of record.attackerOfficerIds) moveOfficer(state, id, home);
  } else {
    for (const id of record.attackerOfficerIds) {
      const officer = state.officers.find((entry) => entry.id === id);
      moveOfficer(state, id, target);
      target.officerIds = target.officerIds.filter((value) => value !== id);
      Object.assign(officer, { status: "captured", factionId: null, captorFactionId: target.factionId, discovered: true });
    }
  }
  record.status = "ended";
  record.result = { ok: true, winner: battle.winner, winnerFactionId: battle.winner === "ally" ? record.attackerFactionId : record.defenderFactionId,
    allyTroops: attackTroops, attackerSurvivors: attackTroops, defenderSurvivors, occupation,
    playerWon: (battle.winner === "ally" ? record.attackerFactionId : record.defenderFactionId) === state.playerFactionId,
    message: `${target.name}战役结束：${battle.outcomeReason ?? (battle.winner === "ally" ? "攻方获胜" : "守方获胜")}。`, days: battle.day };
  if (record.taskId) {
    const task = state.tasks.find((entry) => entry.id === record.taskId);
    if (task) { task.status = "completed"; task.completedTurn = record.processingTurn; task.result = { ...record.result, success: battle.winner === "ally" }; }
  }
  for (const id of record.officerIds) {
    const officer = state.officers.find((entry) => entry.id === id);
    if (!officer) continue;
    if (officer.battleId === record.id) delete officer.battleId;
    if (officer.taskId === record.taskId) delete officer.taskId;
    officer.acted = true;
  }
  if (target.battleId === record.id) delete target.battleId;
  addEvent(state, record.result.message);
}

/** Commit a completed atomic tactical action. No storage/UI side effects. */
export function checkpointBattle(state, id, battle, { targetTurn } = {}) {
  if (targetTurn !== undefined && !amount(targetTurn)) return fail("战役回合无效");
  const original = recordById(state, id);
  if (!original) return fail("战役不存在");
  if (original.status === "ended") return { ok: true, record: original, result: original.result, ended: true, alreadySettled: true };
  if (!battle || !["active", "paused", "ended"].includes(battle.status)
    || battle.sourceCityId !== original.sourceCityId || battle.targetCityId !== original.targetCityId) return fail("战役快照与记录不匹配");
  if (battle.campaignRevision !== (original.revision ?? 0)) return fail("战役记录已更新，不能写入过期战场");
  const liveBattle = battle;
  try { battle = BattleEngine.fromSnapshot(battle.snapshot(), { rules: battle.rules }); }
  catch (error) { return fail(`战场快照无效：${error.message}`); }
  const draft = structuredClone(state), record = recordById(draft, id), target = cityById(draft, record.targetCityId);
  if (!target || target.factionId !== record.defenderFactionId) return fail("守城归属发生变化");
  const defenders = [...battle.units.filter((unit) => unit.side === "enemy" && unit.troops > 0),
    { troops: battle.defenderReserveTroops, training: battle.defenderReserveTraining, morale: battle.defenderReserveMorale }];
  if ([...battle.units, ...(battle.escapedDefenderUnits ?? [])].some((unit) => !amount(unit.troops) || !quality(unit.training) || !quality(unit.morale) || !validComposition(unit, battle.rules))
    || !amount(battle.defenderReserveTroops) || !quality(battle.defenderReserveTraining) || !quality(battle.defenderReserveMorale)
    || !Number.isFinite(battle.cityDefense) || battle.cityDefense < 0
    || ![battle.supplies.ally.food, battle.supplies.ally.gold, battle.supplies.enemy.food, battle.supplies.enemy.gold].every(amount)) return fail("战役兵力或钱粮无效");
  if (battle.units.filter((unit) => unit.side === "ally").reduce((sum, unit) => sum + unit.troops, 0) > record.initialAttackerTroops
    || [...defenders, ...(battle.escapedDefenderUnits ?? [])].reduce((sum, unit) => sum + unit.troops, 0) > record.initialDefenderTroops) return fail("战场兵力不能超过实际投入的军队");
  const remainingEquipment = sumEquipment([...battle.units.filter((unit) => unit.side === "enemy" && unit.troops > 0), ...(battle.escapedDefenderUnits ?? [])], battle.rules);
  for (const key of EQUIPMENT_KEYS) {
    const next = (target[key] ?? 0) - (record.accountedEquipment?.[key] ?? 0) + remainingEquipment[key];
    if (!amount(next)) return fail("守军装备账本无效");
    target[key] = next;
  }
  record.accountedEquipment = remainingEquipment;
  target.troops = defenders.reduce((sum, unit) => sum + unit.troops, 0);
  markWarRations(target, targetTurn ?? record.processingTurn, target.troops, { replace: true, days: rationDays(record, battle, "enemy") });
  target.training = weighted(defenders, "training", target.training); target.morale = weighted(defenders, "morale", target.morale);
  target.food = battle.supplies.enemy.food; target.gold = battle.supplies.enemy.gold; target.defense = battle.cityDefense;
  if (battle.ambushPreparationUsedId === target.ambushPreparation?.id) delete target.ambushPreparation;
  // Escaped troops leave the war ledger once and cannot become a second standing army.
  const escaped = battle.escapedDefenderUnits ?? [];
  const escapeHome = draft.cities.find((city) => city.id !== target.id && city.factionId === record.defenderFactionId && !cityBesieged(draft, city.id));
  if (escaped.length && !escapeHome) return fail("撤回守军没有安全接收城池");
  if (escaped.length && escapeHome) {
    merge(escapeHome, escaped); const gear = sumEquipment(escaped, battle.rules); addEquipment(escapeHome, gear);
    markWarRations(escapeHome, targetTurn ?? record.processingTurn, escaped.reduce((sum, unit) => sum + unit.troops, 0), { days: rationDays(record, battle, "enemy") });
    for (const key of EQUIPMENT_KEYS) { target[key] -= gear[key]; record.accountedEquipment[key] -= gear[key]; }
    for (const unit of escaped) for (const officerId of formationOfficerIds(unit)) {
      moveOfficer(draft, officerId, escapeHome);
      record.officerIds = record.officerIds.filter((value) => value !== officerId);
      const officer = draft.officers.find((entry) => entry.id === officerId); delete officer.battleId; officer.acted = true;
    }
    battle.escapedDefenderUnits = [];
  }
  record.processingTurn = targetTurn ?? record.processingTurn;
  record.revision = (record.revision ?? 0) + 1;
  battle.campaignRevision = record.revision;
  record.status = battle.status;
  if (battle.status !== "active") record.lastProcessedTurn = record.processingTurn;
  record.snapshot = battle.snapshot();
  try { if (battle.status === "ended") finishCampaign(draft, record, battle); }
  catch (error) { return fail(error.message); }
  if (draft.cities.some((city) => ![city.troops, city.food, city.gold, ...EQUIPMENT_KEYS.map((key) => city[key] ?? 0)].every(amount))) return fail("战役结算超出安全资源范围");
  if (record.status === "ended") record.snapshot = archiveBattleSnapshot(record.snapshot);
  commitCampaignState(state, draft);
  liveBattle.campaignRevision = record.revision;
  liveBattle.escapedDefenderUnits = battle.escapedDefenderUnits;
  restoreWarLocks(state);
  return { ok: true, record: recordById(state, id), result: record.result, paused: battle.status === "paused", ended: battle.status === "ended" };
}

export const settleBattle = checkpointBattle;

export function battlesDueThisMonth(state, targetTurn = currentTargetTurn(state)) {
  return activeBattleCampaigns(state).filter((record) => record.lastProcessedTurn < targetTurn);
}

export function advanceBattleMonths(state, rules, { targetTurn = currentTargetTurn(state), backgroundOnly = true } = {}) {
  const results = [];
  for (const record of battlesDueThisMonth(state, targetTurn)) {
    if (backgroundOnly && [record.attackerFactionId, record.defenderFactionId].includes(state.playerFactionId)) continue;
    const restored = getBattleEngine(state, record.id, rules, { targetTurn });
    if (!restored.ok) return restored;
    const result = simulateBattleMonth(restored.battle);
    if (!result.ok) return result;
    const saved = checkpointBattle(state, record.id, restored.battle, { targetTurn });
    if (!saved.ok) return saved;
    results.push(saved);
  }
  return { ok: true, results };
}
