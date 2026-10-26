import { escapeHtml as esc, openDialog } from "./components.js";

export function gameMenuBlockReason({ state, battle, processingEnemy, advancingMonth, showingOpening, switchingCampaign }) {
  if (battle || processingEnemy) return "当前正在战斗。每个动作后会自动保存战场；请在本月战事暂停或结束、回到大地图后使用手动存档、读档或返回主菜单。";
  if (switchingCampaign || advancingMonth || showingOpening || state?.turnResolution
    || state?.pendingInvasions?.some((order) => !order.resolved)
    || state?.tasks?.some((task) => task.status === "awaiting_battle" && !state?.battles?.some((record) => record.taskId === task.id && record.status === "paused"))
    || state?.battles?.some((record) => record.status === "active")) {
    return "当前正在处理月结或军情。请完成本轮汇报与结算后再存档、读档或返回主菜单。";
  }
  return state?.started ? "" : "尚未开始征程。";
}

export async function chooseGameMenu({ summary, blockedReason = "", canLoad = true }) {
  const body = document.createElement("div");
  body.className = "system-menu";
  body.innerHTML = `<p class="system-menu-summary">${esc(summary)}</p>
    ${blockedReason ? `<p class="system-menu-warning" role="status">${esc(blockedReason)}</p>` : ""}
    <div class="system-menu-options">${[
      ["save", "存", "存档", "保存到独立的手动存档位"],
      ["load", "读", "读档", canLoad ? "选择自动或手动存档继续" : "暂无可读取的存档"],
      ["audio", "乐", "声音设置", "音乐、音效与静音"],
      ["title", "返", "返回主菜单", "确认后返回游戏标题画面"]
    ].map(([id, mark, label, hint]) => `<button type="button" class="system-menu-option" data-system-action="${id}" ${id !== "audio" && (blockedReason || id === "load" && !canLoad) ? "disabled" : ""}>
      <i>${mark}</i><span><strong>${label}</strong><small>${hint}</small></span><b aria-hidden="true">›</b></button>`).join("")}</div>`;
  let chosen = null;
  body.addEventListener("click", (event) => {
    const button = event.target.closest("[data-system-action]");
    if (!button || button.disabled) return;
    chosen = button.dataset.systemAction;
    // Resolve and close this window before opening the chosen child window.
    body.closest(".modal").querySelector(".dialog-confirm").click();
  });
  return openDialog({ title: "游戏菜单", content: body, confirmText: "继续游戏", hideCancel: true, onConfirm: () => chosen });
}
