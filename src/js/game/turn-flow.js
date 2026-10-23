import { advanceMonth } from "./rules.js";
import { getCampaignStatus, runWorldTurn } from "./campaign.js";
import { getReadyBattleTask, settleTasks } from "./tasks.js";
import { ensureTaskBattle, advanceBattleMonths, battlesDueThisMonth } from "./war-campaigns.js";

const STAGES = new Set(["tasks", "invasions", "opening"]);
const activeResolutions = new WeakMap();
const currentTurn = (state) => state.elapsedMonths ?? 0;
const hasPendingInvasions = (state) => (state.pendingInvasions ?? []).some((invasion) => !invasion.resolved);

/** Opening a checkpoint does not itself settle tasks, spend resources or move time. */
export function beginTurnResolution(state) {
  if (state.turnResolution) return { ok: true, resumed: true, ...state.turnResolution };
  const targetTurn = currentTurn(state) + 1;
  if (!Number.isSafeInteger(targetTurn) || targetTurn < 1) return { ok: false, message: "当前回合编号无效" };
  state.turnResolution = { stage: "tasks", targetTurn };
  return { ok: true, resumed: false, ...state.turnResolution };
}

async function resolveTurn(state, rules, { save = () => {}, onBattle, onInvasions, onOpening } = {}) {
  if (!state.turnResolution) return { ok: true, completed: false, idle: true };
  const targetTurn = state.turnResolution.targetTurn;
  if (!STAGES.has(state.turnResolution.stage) || !Number.isSafeInteger(targetTurn) || targetTurn < 1
    || !Number.isSafeInteger(currentTurn(state)) || currentTurn(state) < 0 || currentTurn(state) > targetTurn) {
    return { ok: false, message: "回合结算记录无效，未执行重复结算" };
  }
  if (state.turnResolution.stage === "tasks" && currentTurn(state) < targetTurn - 1) {
    return { ok: false, message: "回合结算记录与当前月份不一致" };
  }

  if (state.turnResolution.stage === "tasks") {
    // settleTasks replaces parts of state with its committed draft; always read
    // the current checkpoint/task from state, never retain a stale object ref.
    while (currentTurn(state) < targetTurn) {
      const report = settleTasks(state, rules, { targetTurn });
      await save(state);
      if (!report.ok) return report;
      const battleTask = getReadyBattleTask(state);
      if (!battleTask) {
        if ((state.tasks ?? []).some((task) => task.status === "running" && task.dueTurn <= targetTurn)) {
          return { ok: true, completed: false, waiting: "tasks", targetTurn };
        }
        break;
      }
      if (!onBattle) return { ok: true, completed: false, waiting: "battle", taskId: battleTask.id, targetTurn };
      await onBattle(battleTask);
      await save(state);
      if ((state.tasks ?? []).some((task) => task.id === battleTask.id && task.status === "awaiting_battle")) {
        return { ok: true, completed: false, waiting: "battle", taskId: battleTask.id, targetTurn };
      }
    }
    // These operations are deliberately synchronous and share a checkpoint.
    // If a callback/save previously failed after time advanced, targetTurn and
    // runWorldTurn's own month marker prevent charging a second month's upkeep.
    if (currentTurn(state) < targetTurn) advanceMonth(state, rules);
    if (getCampaignStatus(state).status === "active") runWorldTurn(state, rules);
    state.turnResolution.stage = "invasions";
    await save(state);
  }

  if (state.turnResolution.stage === "invasions") {
    if (hasPendingInvasions(state)) {
      if (!onInvasions) return { ok: true, completed: false, waiting: "invasions", targetTurn };
      await onInvasions();
      await save(state);
      if (hasPendingInvasions(state)) return { ok: true, completed: false, waiting: "invasions", targetTurn };
    }
    state.turnResolution.stage = "opening";
    await save(state);
  }

  if (state.turnResolution.stage === "opening") {
    if (!onOpening) return { ok: true, completed: false, waiting: "opening", targetTurn };
    await onOpening();
    state.turnResolution = null;
    await save(state);
  }
  return { ok: true, completed: true, targetTurn };
}

async function resolveWarTurn(state, rules, { save = () => {}, onCampaignBattle, onInvasions, onOpening, battleMap } = {}) {
  if (!state.turnResolution) return { ok: true, completed: false, idle: true };
  const targetTurn = state.turnResolution.targetTurn;
  if (!Number.isSafeInteger(targetTurn) || targetTurn < 1 || !Number.isSafeInteger(currentTurn(state)) || currentTurn(state) < 0
    || currentTurn(state) > targetTurn || currentTurn(state) < targetTurn - 1
    || !["tasks", "world", "battles", "economy", "invasions", "opening"].includes(state.turnResolution.stage)) return { ok: false, message: "战役月结记录无效" };
  if (state.turnResolution.stage === "tasks") {
    for (;;) {
      const report = settleTasks(state, rules, { targetTurn });
      if (!report.ok) return report;
      const task = getReadyBattleTask(state);
      if (!task) break;
      const created = ensureTaskBattle(state, task, rules, battleMap ?? state.warBattleMap, { targetTurn });
      if (!created.ok) return created;
      await save(state);
    }
    state.turnResolution.stage = "world";
    await save(state);
  }
  // All armies depart before the closing month's economy, so those soldiers
  // pay battlefield daily rations instead of a second garrison month's upkeep.
  if (state.turnResolution.stage === "world") {
    if (getCampaignStatus(state).status === "active") runWorldTurn(state, rules);
    state.turnResolution.stage = "invasions";
    await save(state);
  }
  const playDue = async () => {
    const background = advanceBattleMonths(state, rules, { targetTurn });
    if (!background.ok) return background;
    await save(state);
    for (const record of battlesDueThisMonth(state, targetTurn)) {
      if (!onCampaignBattle) return { ok: true, completed: false, waiting: "battle", battleId: record.id, targetTurn };
      await onCampaignBattle(record);
      await save(state);
      if (battlesDueThisMonth(state, targetTurn).some((entry) => entry.id === record.id)) {
        return { ok: true, completed: false, waiting: "battle", battleId: record.id, targetTurn };
      }
    }
    return { ok: true };
  };
  if (state.turnResolution.stage === "invasions") {
    if (hasPendingInvasions(state)) {
      if (!onInvasions) return { ok: true, completed: false, waiting: "invasions", targetTurn };
      await onInvasions(); await save(state);
      if (hasPendingInvasions(state)) return { ok: true, completed: false, waiting: "invasions", targetTurn };
    }
    state.turnResolution.stage = "battles";
    await save(state);
  }
  if (state.turnResolution.stage === "battles") {
    const played = await playDue();
    if (!played.ok || played.waiting) return played;
    state.turnResolution.stage = "economy";
    await save(state);
  }
  if (state.turnResolution.stage === "economy") {
    if (currentTurn(state) < targetTurn) advanceMonth(state, rules);
    state.turnResolution.stage = "opening";
    await save(state);
  }
  if (state.turnResolution.stage === "opening") {
    if (!onOpening) return { ok: true, completed: false, waiting: "opening", targetTurn };
    await onOpening(); state.turnResolution = null; await save(state);
  }
  return { ok: true, completed: true, targetTurn };
}

/** Resume after reload, battle or invasion; concurrent callers share one run. */
export async function resumeTurnResolution(state, rules, callbacks = {}) {
  if (activeResolutions.has(state)) return activeResolutions.get(state);
  const resolution = state.warCampaignsVersion === 1 ? resolveWarTurn(state, rules, callbacks) : resolveTurn(state, rules, callbacks);
  activeResolutions.set(state, resolution);
  try {
    return await resolution;
  } finally {
    if (activeResolutions.get(state) === resolution) activeResolutions.delete(state);
  }
}
