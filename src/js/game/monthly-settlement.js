const FINISHED = new Set(["completed", "failed"]);
const ACTIVE = new Set(["running", "awaiting_battle", "in_battle"]);

export const taskIsActive = (task) => ACTIVE.has(task.status);

/** Old player-only ledgers did not always record an explicit faction. */
export const taskBelongsToPlayer = (state, task) => !task.factionId || !state.playerFactionId || task.factionId === state.playerFactionId;

export function taskLedgerRecords(state, { turn = state.elapsedMonths ?? 0 } = {}) {
  const tasks = (state.tasks ?? []).filter((task) => taskBelongsToPlayer(state, task));
  return {
    active: tasks.filter(taskIsActive),
    completed: tasks.filter((task) => FINISHED.has(task.status) && task.completedTurn === turn),
    older: tasks.filter((task) => FINISHED.has(task.status) && task.completedTurn < turn).slice(-50).reverse()
  };
}

/**
 * A report belongs to the opening month, not the month in which an order was
 * issued. Never display a partial report while an expedition or invasion is
 * keeping the turn checkpoint open. This query is read-only and reload-safe.
 */
export function pendingMonthlySettlement(state) {
  const turn = state.elapsedMonths ?? 0;
  if (!Number.isSafeInteger(turn) || turn < 1 || state.started === false || !state.playerFactionId) return null;
  if (state.turnResolution && state.turnResolution.stage !== "opening") return null;
  if ((state.pendingInvasions ?? []).some((invasion) => !invasion.resolved)) return null;
  if ((state.tasks ?? []).some((task) => taskBelongsToPlayer(state, task) && task.status === "awaiting_battle")) return null;
  const readTurn = Object.hasOwn(state.monthlySettlementRead ?? {}, state.playerFactionId)
    ? state.monthlySettlementRead[state.playerFactionId] : -1;
  if (Number.isSafeInteger(readTurn) && readTurn >= turn) return null;
  const tasks = taskLedgerRecords(state, { turn }).completed.filter((task) =>
    !Number.isSafeInteger(task.submittedTurn) || task.submittedTurn < turn);
  if (!tasks.length) return null;
  return { factionId: state.playerFactionId, turn, year: state.year, month: state.month, tasks };
}

/** Mark before opening the modal, then persist alongside the normal save. */
export function markMonthlySettlementRead(state, report) {
  if (!report || report.factionId !== state.playerFactionId || report.turn !== (state.elapsedMonths ?? 0)
    || !Number.isSafeInteger(report.turn) || report.turn < 1 || !report.tasks?.length) return false;
  state.monthlySettlementRead = { ...(state.monthlySettlementRead ?? {}), [report.factionId]: report.turn };
  return true;
}
