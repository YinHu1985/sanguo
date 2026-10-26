import { playerOfficer, officerCity } from "./character-state.js";

export function playerRole(state) {
  if (!state.playerOfficerId) return "ruler";
  const officer = playerOfficer(state);
  if (!officer || officer.status === "free" || officer.status === "captured") return "free";
  const faction = state.factions.find(f => f.id === officer.factionId);
  if (officer.rank === "君主" || faction?.lord === officer.name || faction?.lord === officer.id) return "ruler";
  if (officerCity(state)?.governorId === officer.id) return "governor";
  return "officer";
}
export const ROLE_LABELS = { ruler: "君主", governor: "太守", officer: "在仕武将", free: "在野武将" };

/** One eligibility boundary, shared by UI and command services. No mutations. */
export function capability(state, action, { cityId, kind } = {}) {
  const role = playerRole(state), officer = playerOfficer(state);
  let reason = "";
  if (action === "policy" && role !== "ruler") reason = "只有君主可以调整全局政策";
  if (action === "government") {
    if (role === "free" || role === "officer") reason = "当前身份只能查阅政务，请通过议政厅请领公务";
    else if (role === "governor" && (cityId !== officerCity(state)?.id || ["governor", "diplomacy"].includes(kind))) reason = "太守只能处理本城事务，不能任命太守或代表势力外交";
  }
  if (action === "personal" && (!officer || officer.battleId || officer.taskId || state.turnResolution)) reason = "正在执行公务或随军作战，暂不能开展个人行动";
  return { ok: !reason, reason, message: reason };
}

export function isAIManagedCity(state, city) {
  if (city.factionId === "neutral") return false;
  if (city.factionId !== state.playerFactionId) return true;
  return Boolean(state.playerOfficerId && !capability(state, "government", { cityId: city.id }).ok);
}

export function participatesInBattle(state, record) {
  if (!state.playerOfficerId) return [record.attackerFactionId, record.defenderFactionId].includes(state.playerFactionId);
  return (record.snapshot?.units ?? []).some(u => (u.officerIds ?? [u.officerId]).includes(state.playerOfficerId));
}

export function configureBattleControl(state, record, battle) {
  if (!state.playerOfficerId) return battle;
  const unit = battle.units.find(u => (u.officerIds ?? [u.officerId]).includes(state.playerOfficerId));
  const side = unit?.side ?? (record.attackerFactionId === state.playerFactionId ? "ally" : "enemy");
  battle.playerSide = side; battle.aiSide = side === "ally" ? "enemy" : "ally";
  battle.personalControl = { officerId: state.playerOfficerId, commander: record.commanders?.[side] === state.playerOfficerId, unitId: unit?.id ?? null };
  return battle;
}
export function canControlUnit(battle, unit = battle.activeUnit) {
  return Boolean(unit && unit.side === battle.playerSide && (!battle.personalControl || battle.personalControl.commander || unit.id === battle.personalControl.unitId));
}
export const canControlArmy = battle => !battle.personalControl || battle.personalControl.commander;

/** Data-only requirement interface for future skills, offices and items. Unknown clauses fail closed. */
export function checkRequirements(requirements, { officer, faction, city, grants = [] } = {}) {
  const reasons = [];
  for (const rule of requirements ?? []) {
    let met = false;
    if (rule.type === "grant") met = grants.includes(rule.id);
    if (rule.type === "technology") met = faction?.unlockedTechnologies?.includes(rule.id) ?? false;
    if (rule.type === "ability") met = Number.isFinite(officer?.[rule.id]) && officer[rule.id] >= rule.min;
    if (rule.type === "resource") met = Number.isFinite(city?.[rule.id]) && city[rule.id] >= rule.min;
    if (!met) reasons.push(rule.reason ?? `条件未满足：${rule.type}/${rule.id}`);
  }
  return { ok: reasons.length === 0, reasons, reason: reasons.join("；") };
}
