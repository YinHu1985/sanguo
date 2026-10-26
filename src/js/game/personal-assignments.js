import { playerOfficer, officerCity, growOfficer } from "./character-state.js";
import { emitDomainEvent } from "./domain-events.js";

const ongoing = task => ["active", "ready"].includes(task.status);
export const currentAssignment = state => state.personal?.assignments?.find(ongoing);

/** Employer and city are fixed at acceptance. Reserved reward is never silently minted. */
export function refreshPersonalAssignments(state) {
  if (!state.personal) return;
  const officer = playerOfficer(state);
  for (const task of state.personal.assignments ?? []) {
    if (!ongoing(task)) continue;
    const city = state.cities.find(c => c.id === task.cityId);
    const invalid = !officer || officer.factionId !== task.factionId || officer.status === "free"
      || officer.status === "captured" || city?.factionId !== task.factionId;
    if (!invalid && !(task.status === "active" && state.elapsedMonths >= task.deadlineTurn)) continue;
    task.status = invalid ? "cancelled" : "expired";
    task.endedTurn = state.elapsedMonths;
    const treasury = city?.factionId === task.factionId ? city : state.cities.find(c => c.factionId === task.factionId);
    if (treasury) treasury.gold += task.reservedGold;
    task.reservedGold = 0;
    state.personal.journal.unshift(`${task.title}：${invalid ? "任职或城池归属改变，委托取消" : "逾期未完成"}，未领赏。`);
    state.personal.journal = state.personal.journal.slice(0, 60);
  }
}

export function acceptAssignment(state, project, preview, rules) {
  refreshPersonalAssignments(state);
  if (currentAssignment(state)) return { ok: false, message: "请先完成并复命当前公务，或等期限结束" };
  const officer = playerOfficer(state), city = officerCity(state), config = rules.character.assignment;
  const target = Math.min(preview.progress * config.workBatches, preview.remaining ?? Infinity);
  if (!(target > 0)) return { ok: false, message: "该项目已无需建设，不能领取公务" };
  const reward = Math.ceil(preview.expense * target / preview.progress) + config.rewardBonus;
  if (city.gold < reward) return { ok: false, message: `城库不足以预留赏金 ${reward}，请另择任务或稍后再来` };
  city.gold -= reward;
  const task = {
    id: `assignment:${++state.personal.assignmentSequence}`, title: preview.title, project,
    officerId: officer.id, cityId: city.id, factionId: city.factionId, status: "active",
    acceptedTurn: state.elapsedMonths, deadlineTurn: state.elapsedMonths + config.durationMonths,
    target, progress: 0, unit: preview.unit, reward, reservedGold: reward,
    merit: config.merit, xp: config.xp, ability: preview.ability
  };
  state.personal.assignments.push(task);
  return { ok: true, task, message: `领命：${city.name}${task.title} ${target}${task.unit}，限 ${config.durationMonths} 个月。亲自出资完成后回议政厅复命，赏私金 ${reward}。` };
}

export function creditAssignment(state, project, progress) {
  refreshPersonalAssignments(state);
  const task = currentAssignment(state);
  if (!task || task.status !== "active" || task.project !== project || task.cityId !== officerCity(state)?.id) return;
  task.progress = Math.min(task.target, task.progress + progress);
  if (task.progress >= task.target) {
    task.status = "ready";
    state.personal.journal.unshift(`${task.title}工作已完成，请到议政厅复命领赏。`);
  }
}

export function reportAssignment(state) {
  refreshPersonalAssignments(state);
  const task = currentAssignment(state), city = officerCity(state);
  if (!task || task.status !== "ready") return { ok: false, message: "尚无完成的公务可供复命" };
  if (city?.id !== task.cityId) return { ok: false, message: "请返回领命城池复命" };
  const officer = playerOfficer(state);
  task.status = "completed"; task.endedTurn = state.elapsedMonths;
  state.personal.gold += task.reservedGold; task.reservedGold = 0;
  officer.merit = (officer.merit ?? 0) + task.merit;
  growOfficer(officer, task.ability, task.xp);
  emitDomainEvent(state, { id: `${task.id}:completed`, type: "assignment.completed", officerIds: [officer.id] });
  return { ok: true, task, message: `复命获准：${task.title}，私金 +${task.reward}、功勋 +${task.merit}、历练 +${task.xp}。` };
}
