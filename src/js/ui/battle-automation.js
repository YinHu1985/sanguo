import { BATTLE_STATUS_DEFINITIONS, getBattleStatus, getControllingStatus } from "../game/battle-statuses.js";

/** Automatic activations are side-agnostic: control strategies can affect the player too. */
export function needsAutomaticBattleAction(battle) {
  if (!battle || battle.status !== "active") return false;
  if (battle.phase === "field") return Boolean(battle.activeUnit &&
    (battle.hasForcedAction() || battle.activeUnit.side === battle.aiSide));
  if (battle.pendingDecision) return battle.pendingDecision.side === battle.aiSide;
  return Boolean(battle.siege?.orders[battle.playerSide] && !battle.siege.orders[battle.aiSide]);
}

/** One result per call, so every forced step and ambush can be animated by the view. */
export function runAutomaticBattleStep(battle) {
  if (!needsAutomaticBattleAction(battle)) return { ok: false, message: "当前等待玩家下令。" };
  if (battle.phase !== "field") return battle.runAISiegeDecision();
  return battle.hasForcedAction() ? battle.runForcedTurn() : battle.runEnemyTurn();
}

export function battleControlLabel(unit) {
  const status = getControllingStatus(unit);
  return status ? statusLabel(status) : "";
}
function statusLabel(status) {
  const count = status.remainingActivations;
  if (status.type === "doubt") return count === 1 ? "疑兵 · 跳过下次行动" : `疑兵 · 跳过接下来 ${count} 次行动`;
  if (status.type === "provocation") {
    if (status.active) return `中计追击 · 强制行动中${count > 1 ? `（含本次剩 ${count} 次）` : ""}`;
    return count === 1 ? "挑衅 · 下次强制追击" : `挑衅 · 接下来 ${count} 次行动强制追击`;
  }
  return `${BATTLE_STATUS_DEFINITIONS[status.type]?.name ?? status.type} · 剩余 ${count} 次行动`;
}

/** Multiple simultaneous effects stay visible even when a higher-priority one suppresses another. */
export function battleStatusLabels(unit) {
  return Object.keys(BATTLE_STATUS_DEFINITIONS).map(type => getBattleStatus(unit, type)).filter(Boolean).map(statusLabel);
}
