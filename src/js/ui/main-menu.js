import { showToast } from "./components.js";
import { chooseLoadSlot } from "./save-windows.js";
export { saveCardMarkup } from "./save-windows.js";

export function createMainMenu({ getSaves, onNew, onLoad, onContinue, onAudio, rules = {} }) {
  const root = document.querySelector("#main-menu");
  let busy = false;
  let canContinue = false;
  const refresh = () => {
    const saves = getSaves();
    root.querySelectorAll("[data-menu-action]").forEach((button) => { button.disabled = busy; });
    root.querySelector('[data-menu-action="load"]').disabled = busy || !saves.length;
    root.querySelector('[data-menu-action="continue"]').hidden = !canContinue;
    root.querySelector("#menu-save-summary").textContent = saves.length
      ? `${saves[0].label} · ${saves[0].officerName ? `${saves[0].officerName} · ` : ""}${saves[0].factionName} · ${saves[0].year} 年 ${saves[0].month} 月`
      : "尚无存档 · 选择新游戏，开启征程";
  };
  async function chooseSave() {
    const saves = getSaves();
    if (!saves.length) { showToast("当前浏览器暂无可读取的存档", "error"); return; }
    const chosen = await chooseLoadSlot(saves, { rules });
    if (chosen) await onLoad(chosen);
  }
  const actions = { new: onNew, load: chooseSave, continue: onContinue, audio: onAudio };
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-menu-action]");
    if (!button || button.disabled || busy) return;
    busy = true; refresh();
    try { await actions[button.dataset.menuAction]?.(); }
    catch (error) { showToast(error.message || "操作未完成，请重试", "error"); }
    finally {
      busy = false; refresh();
      if (!root.hidden && !button.disabled) button.focus({ preventScroll: true });
    }
  });
  return {
    show({ resumable = false } = {}) {
      canContinue = resumable; root.hidden = false; refresh();
      requestAnimationFrame(() => root.querySelector(`[data-menu-action="${resumable ? "continue" : "new"}"]`)?.focus());
    },
    hide() { root.hidden = true; },
    refresh
  };
}
