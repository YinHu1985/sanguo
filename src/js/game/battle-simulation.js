/** Headless automatic play uses exactly the same atomic commands as the UI. */
export function simulateBattleMonth(engine, { maxSteps = 20000 } = {}) {
  if (!engine || typeof engine.runAITurn !== "function") return { ok: false, message: "缺少可模拟的战役" };
  let steps = 0;
  while (engine.status === "active" && steps < maxSteps) {
    let result;
    if (engine.phase === "field") {
      const unit = engine.activeUnit;
      if (!unit) return { ok: false, status: engine.status, day: engine.day, steps, message: "野战行动队列为空" };
      result = engine.hasForcedAction(unit) ? engine.runForcedTurn() : engine.runAITurn(unit.side);
    } else if (engine.phase === "siege_transition") {
      result = engine.runAISiegeDecision(engine.pendingDecision?.side);
    } else if (engine.phase === "siege") {
      result = engine.runAISiegeDecision(engine.siege.orders.ally ? "enemy" : "ally");
    } else return { ok: false, status: engine.status, day: engine.day, steps, message: "未知战役阶段" };
    steps += 1;
    if (!result?.ok) return { ok: false, status: engine.status, day: engine.day, steps, message: result?.message ?? "战役模拟无法继续" };
  }
  if (engine.status === "active") return { ok: false, status: engine.status, day: engine.day, steps, message: "战役模拟超过安全步数上限" };
  return { ok: true, status: engine.status, day: engine.day, steps, winner: engine.winner,
    paused: engine.status === "paused", battleEnded: engine.status === "ended" };
}
