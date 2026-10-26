import { getCity, getOfficer } from "../game/rules.js";
import { taskIsActive, taskLedgerRecords } from "../game/monthly-settlement.js";
import { escapeHtml as esc, number, openDialog } from "./components.js";
import { EQUIPMENT_KEYS, EQUIPMENT_NAMES } from "../game/equipment.js";
import { commandLimitEnabled } from "../game/commands.js";

export { taskIsActive } from "../game/monthly-settlement.js";

export function taskTimingText(rules, kind) {
  const defaults = rules.tasks?.defaultTiming ?? "turn_end";
  const base = typeof defaults === "string" ? { timing: defaults } : defaults;
  const config = { ...base, ...(rules.tasks?.actions?.[kind] ?? {}) };
  const battleNote = kind === "march" ? "届时进入战场。" : "";
  if (config.timing === "immediate") return `签发后立即执行。${battleNote}`;
  if (config.timing === "multi_turn") return `预计 ${config.duration ?? 1} 个回合后完成；期间执行武将持续忙碌。${battleNote}`;
  return `结束本月后完成。${battleNote}`;
}

export function taskOrderNote(rules, kind) {
  return `<p class="task-order-note"><strong>任务制</strong> ${esc(taskTimingText(rules, kind))}<br>签发时占用${commandLimitEnabled(rules) ? "一道指令、" : ""}执行武将和所需物资；${commandLimitEnabled(rules) ? "" : "测试期间指令数不限；"}可在「任务簿」查看进度。</p>`;
}

export function taskCounts(state) {
  const { active, completed } = taskLedgerRecords(state);
  const personal = personalTaskRecords(state);
  return {
    active: active.length + personal.active.length,
    completed: completed.length + personal.completed.length
  };
}

export function personalTaskRecords(state, turn = state.elapsedMonths ?? 0) {
  const records = (state.personal?.assignments ?? []).map(task => ({ ...task, personalAssignment: true }));
  const active = records.filter(task => ["active", "ready"].includes(task.status));
  return { active, completed: records.filter(task => !active.includes(task) && task.endedTurn === turn),
    older: records.filter(task => !active.includes(task) && task.endedTurn !== turn).reverse() };
}

export function createTaskUI({ getState, onSelectCity }) {
  function renderSummary() {
    const counts = taskCounts(getState());
    const button = document.querySelector("#tasks-button");
    if (!button) return;
    button.innerHTML = `任务簿 <span class="task-count">${counts.active}</span><small>本回合完成 ${counts.completed}</small>`;
    button.setAttribute("aria-label", `任务簿 · 执行中 ${counts.active} · 本回合完成 ${counts.completed}`);
  }

  async function showTasks({ tab = "all", completedTurn, settlement = null } = {}) {
    const state = getState();
    const body = document.createElement("div");
    body.className = "task-ledger";
    const currentTurn = state.elapsedMonths ?? 0;
    const reportTurn = completedTurn ?? currentTurn;
    const records = taskLedgerRecords(state, { turn: reportTurn });
    const personal = personalTaskRecords(state, reportTurn);
    const active = [...personal.active, ...records.active];
    const completed = [...personal.completed, ...(settlement?.tasks ?? records.completed)];
    const older = [...personal.older, ...records.older];
    const counts = { active: active.length, completed: completed.length };
    const renderTask = (task) => {
      const city = getCity(state, task.cityId);
      if (task.personalAssignment) {
        const status = { active: `余 ${Math.max(0, task.deadlineTurn - currentTurn)} 个月（含本月）`, ready: "达标待复命", completed: "已复命领赏", expired: "逾期未完成", cancelled: "委托取消" }[task.status];
        return `<article class="task-record"><div class="task-record-heading"><strong>个人公务 · ${esc(task.title)}</strong><span class="task-state">${esc(status)}</span></div><p>${esc(city?.name ?? "原城池")} · 亲自完成 ${task.progress}/${task.target}${esc(task.unit)} · 赏金 ${task.reward}</p><div class="task-progress"><i style="width:${Math.min(100, 100 * task.progress / task.target)}%"></i></div><p class="task-record-result">本人自付私金与行动力，地点建设即时生效；达标后回领命城池议政厅复命。过月不会自动代办。</p></article>`;
      }
      const target = getCity(state, task.targetId ?? task.payload?.targetId);
      const active = taskIsActive(task);
      const remaining = Math.max(0, task.dueTurn - currentTurn);
      const duration = Math.max(1, task.dueTurn - task.submittedTurn);
      const progress = active ? Math.min(95, Math.max(6, 100 * (1 - remaining / duration))) : 100;
      const status = task.status === "in_battle" ? "跨月作战中" : task.status === "awaiting_battle" ? "等待战斗" : task.status === "running" ? `余 ${remaining} 回合` : task.status === "failed" ? "未能完成" : "已完成";
      const actors = (task.officerIds ?? []).map((id) => getOfficer(state, id)?.name ?? "已离任").join("、");
      return `<article class="task-record ${esc(task.status)}">
        <div class="task-record-heading"><strong>${esc(task.title ?? task.kind)}</strong><span class="task-state">${status}</span></div>
        <p class="task-location"><button type="button" class="text-button" data-task-city="${esc(city?.id ?? "")}" ${city ? "" : "disabled"}>${esc(city?.name ?? "原城池")}</button>${target ? ` → ${esc(target.name)}` : ""}<span>${esc(actors)}</span></p>
        <div class="task-progress" aria-hidden="true"><i style="width:${progress}%"></i></div>
        <p class="task-record-result">${esc(active ? task.status === "in_battle" ? "部队持续在战场作战，每月最多推进30日，参战将领继续占用。详见顶部战役簿。" : task.status === "awaiting_battle" ? "军队已集结，等待战场结算。" : `已签发，任务成果尚未生效。${task.kind === "transfer" ? ` 运送兵 ${number(task.payload.troops)} · 金 ${number(task.payload.gold)} · 粮 ${number(task.payload.food)}${EQUIPMENT_KEYS.filter((key) => task.payload[key] > 0).map((key) => ` · ${EQUIPMENT_NAMES[key]} ${number(task.payload[key])}`).join("")}。` : ""}` : task.result?.message ?? task.message ?? "任务已结算。")}</p>
      </article>`;
    };
    const renderLedger = () => {
      const activeSection = `<section><h3 class="window-section-title">正在执行</h3>${active.map(renderTask).join("") || '<p class="task-empty">当前没有在执行的任务，可从城池指令下达。</p>'}</section>`;
      const completedSection = `<section><h3 class="window-section-title">${settlement ? "上期任务结算" : "本回合刚完成"}</h3>${completed.map(renderTask).join("") || '<p class="task-empty">过月后，这里会记录刚刚结算的任务及结果。</p>'}</section>`;
      body.innerHTML = `<div class="task-ledger-summary"><div><small>正在执行</small><strong>${counts.active}</strong></div><div><small>${settlement ? "本期结算" : "本回合刚完成"}</small><strong>${counts.completed}</strong></div><p>${settlement ? "以下任务已在上月结束时结算。跨月执行的任务仍会继续，军府已将战报及失败原因一并列明。" : "政令任务预留官库物资与执行武将，过月结算。个人限期公务不占用将领：请自行到地点出资办事，达标后到议政厅复命。"}</p></div>
        ${settlement ? "" : `<nav class="task-ledger-tabs" aria-label="任务记录分类">${[["all", "全部记录"], ["active", "正在执行"], ["completed", "本月结算"]].map(([key, label]) => `<button class="btn ${tab === key ? "btn-primary" : ""}" type="button" data-task-tab="${key}" aria-pressed="${tab === key}">${label}</button>`).join("")}</nav>`}
        ${tab === "all" ? `<div class="task-ledger-columns">${activeSection}${completedSection}</div>` : tab === "active" ? activeSection : completedSection}
        ${tab === "all" && !settlement && older.length ? `<details class="task-history"><summary>往期记录 · ${older.length} 项</summary>${older.map(renderTask).join("")}</details>` : ""}`;
      body.querySelectorAll("[data-task-tab]").forEach((button) => button.addEventListener("click", () => {
        tab = button.dataset.taskTab;
        renderLedger();
        body.querySelector(`[data-task-tab="${tab}"]`)?.focus();
      }));
      body.querySelectorAll("[data-task-city]").forEach((button) => button.addEventListener("click", () => {
        body.closest(".modal")?.querySelector(".modal-close")?.click();
        onSelectCity?.(button.dataset.taskCity, true);
      }));
    };
    renderLedger();
    await openDialog({ title: settlement ? `月初任务结算 · ${settlement.year}年${settlement.month}月` : "军府任务簿", content: body, confirmText: "返回理政", hideCancel: true, wide: true });
  }
  const showSettlement = (report) => report?.tasks?.length
    ? showTasks({ tab: "completed", completedTurn: report.turn, settlement: report }) : Promise.resolve(false);
  return { renderSummary, showTasks, showSettlement };
}
