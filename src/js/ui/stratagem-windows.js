import { availableOfficers, cityOfficers, getCity, getFaction, playerCities } from "../game/rules.js";
import { activeAmbushPreparation, getStratagemConfig, previewStratagem, STRATAGEM_ACTIONS } from "../game/stratagems.js";
import { queueTask } from "../game/tasks.js";
import { confirmDialog, createDataTable, escapeHtml as esc, number, openDialog, showToast } from "./components.js";
import { taskOrderNote } from "./task-windows.js";
import { commandLimitEnabled } from "../game/commands.js";

const descriptions = {
  rumor: "派遣武将在目标城散播流言，动摇当地民心。成功与否均在月末判定，失败仍消耗费用与行动。",
  discord: "选择目标城的一名非君主武将，挑拨其与君主的关系、降低忠诚，为后续登用创造机会。",
  surrender: "向弱势势力提出整体归附。成功将改变该势力全部城池与所属武将的归属，不只是当前选中的城池。",
  prepareAmbush: "由本城武将准备防御伏兵，不是立即在地图上放置部队。准备在月末生效，供下一次有效的防守野战使用。"
};

/** Preview text is shared with contract tests; all values derived from rules remain escaped. */
export function stratagemPreviewMarkup(preview, config = {}, commandRules = {}) {
  const chance = Number.isFinite(preview?.chance) ? `${Math.round(preview.chance * 100)}%` : "—";
  const cost = preview?.cost ?? config.cost ?? 0;
  return `<strong>预计费用 金 ${number(cost)} · 成功率 ${chance}</strong><p>${esc(preview?.effect ?? "选择出发城、执行武将及目标后查看具体效果。")}</p><p class="${preview?.ok ? "economy-note" : "economy-warning"}">${esc(preview?.message || (preview?.ok ? "可以签发；月末按届时局势重新校验并结算。" : "当前条件不足，不能签发。"))}</p><small>月末重新校验并结算；签发仅占用费用、${commandLimitEnabled(commandRules) ? "一道指令与" : ""}执行武将，本窗口不会提前改变目标城池或武将。</small>`;
}

/** Show only a still-owned, unconsumed and unexpired preparation using the engine's validity check. */
export function ambushPreparationMarkup(city, state) {
  const preparation = activeAmbushPreparation(city, state);
  if (!preparation) return "";
  const turn = Number.isSafeInteger(state?.elapsedMonths) && state.elapsedMonths >= 0 ? state.elapsedMonths : 0;
  const months = preparation.expiresTurn - turn;
  return `<div class="result-preview ambush-preparation-note"><strong>伏兵准备 · 有效 · 剩余 ${number(months)} 个月</strong><p>下次防守野战中，首次有效伏击的一击伤害 +${Math.round(preparation.bonus * 100)}%，使用后消耗。</p><small>再次准备只刷新有效期，不叠加加成，仍须支付本次费用。</small></div>`;
}

/** Dedicated windows allow future entry points to reuse the same order workflow. */
export function createStratagemUI({ getState, rules, onChange = () => {} }) {
  async function showStratagem(action, targetCityId) {
    if (!STRATAGEM_ACTIONS.includes(action)) return showToast("无此计略指令", "error");
    const current = getState();
    const target = getCity(current, targetCityId);
    if (!target) return showToast("目标城池已不存在，请重新选择", "error");
    const config = getStratagemConfig(rules)[action];
    const ownCities = playerCities(current).filter((city) => action !== "prepareAmbush" || city.id === targetCityId)
      .sort((first, second) => Number(second.adjacent?.includes(targetCityId)) - Number(first.adjacent?.includes(targetCityId)));
    if (!ownCities.length) return openDialog({ title: `${target.name} · ${config.name}`, confirmText: "返回地图", hideCancel: true,
      content: `<p class="modal-description">${esc(action === "prepareAmbush" ? "伏兵准备只能在己方本城执行，请在地图上选择本势力城池。" : "本势力已无可用出发城。")}</p>` });
    const faction = getFaction(current, target.factionId);
    const targets = action === "discord" ? cityOfficers(current, target).filter((officer) => officer.factionId === target.factionId
      && officer.id !== faction?.lord && officer.rank !== "君主") : [];
    const body = document.createElement("div");
    body.className = "stratagem-window";
    body.innerHTML = `<p class="modal-description">${esc(descriptions[action])}</p>
      ${action === "prepareAmbush" ? ambushPreparationMarkup(target, current) : ""}
      ${action === "prepareAmbush" ? `<p class="economy-note">下一次有效防守野战中，首次有效伏击的一击伤害提高 ${Math.round((config.bonus ?? 0.25) * 100)}%，只生效一次；有效期 ${number(config.durationMonths ?? 3)} 个月，不叠加。开战后由战场指令在树林或山地实际埋伏。</p>` : ""}
      <div data-stratagem-target-summary></div><div class="form-grid"><div class="field"><label for="stratagem-source">${action === "prepareAmbush" ? "准备据点" : "计略出发城"}</label><select id="stratagem-source" data-stratagem-source>${ownCities.map((city) => `<option value="${esc(city.id)}">${esc(city.name)} · 金 ${number(city.gold)} · 待命 ${availableOfficers(current, city).length} 将</option>`).join("")}</select></div>
      <div class="field"><label for="stratagem-executor">执行武将</label><select id="stratagem-executor" data-stratagem-executor></select></div>
      ${action === "discord" ? `<div class="field"><label for="stratagem-target-officer">离间对象 · 不含君主</label><select id="stratagem-target-officer" data-stratagem-target-officer>${targets.map((officer) => `<option value="${esc(officer.id)}">${esc(officer.name)} · 忠诚 ${number(officer.loyalty)}</option>`).join("") || '<option value="">城内没有可离间的非君主武将</option>'}</select></div>` : ""}</div>
      <div class="result-preview" data-stratagem-preview aria-live="polite"></div>${taskOrderNote(rules, "stratagem")}`;
    body.querySelector("[data-stratagem-target-summary]").append(createDataTable([
      { label: "目标据点", render: (city) => city.name }, { label: "所属势力", render: () => faction?.name ?? "无主" },
      { label: "驻军", render: (city) => number(city.troops) }, { label: "民心", render: (city) => number(city.popularSupport) }
    ], [target]));
    const sourceInput = body.querySelector("[data-stratagem-source]");
    const executorInput = body.querySelector("[data-stratagem-executor]");
    const targetOfficerInput = body.querySelector("[data-stratagem-target-officer]");
    const options = () => action === "discord" ? { targetOfficerId: targetOfficerInput.value } : {};
    const preview = () => previewStratagem(getState(), sourceInput.value, targetCityId, executorInput.value, action, rules, options());
    const refresh = () => {
      const checked = preview();
      body.querySelector("[data-stratagem-preview]").innerHTML = stratagemPreviewMarkup(checked, config, getState());
      const button = body.closest(".modal")?.querySelector(".dialog-confirm");
      if (button) { button.disabled = !checked.ok; button.title = checked.ok ? "签发后在月末结算" : checked.message; }
    };
    const refreshExecutors = () => {
      const live = getState();
      const source = getCity(live, sourceInput.value);
      const previous = executorInput.value;
      const officers = source ? availableOfficers(live, source) : [];
      executorInput.innerHTML = officers.map((officer) => `<option value="${esc(officer.id)}">${esc(officer.name)} · 智 ${number(officer.intelligence)} · 魅 ${number(officer.charm)}</option>`).join("") || '<option value="">本城暂无待命武将</option>';
      if (officers.some((officer) => officer.id === previous)) executorInput.value = previous;
      executorInput.disabled = !officers.length;
      refresh();
    };
    sourceInput.addEventListener("change", refreshExecutors);
    executorInput.addEventListener("change", refresh);
    targetOfficerInput?.addEventListener("change", refresh);
    refreshExecutors();
    const dialog = openDialog({ title: `${target.name} · ${config.name}`, content: body, confirmText: "签发计略令", wide: true,
      onConfirm: async () => {
        const checked = preview();
        if (!checked.ok) { refresh(); window.requestAnimationFrame(refresh); showToast(checked.message, "error"); return false; }
        if (action === "surrender") {
          const live = getState();
          const targetFaction = getCity(live, targetCityId)?.factionId;
          const cities = live.cities.filter((city) => city.factionId === targetFaction);
          const name = getFaction(live, targetFaction).name;
          if (!await confirmDialog({ title: "确认劝降整个势力", mark: "附", confirmText: "确认签发劝降令",
            message: `此计针对<strong>${esc(name)}全势力</strong>，成功后其 <strong>${cities.length}</strong> 座城池与所属武将整体归附。<br>${esc(checked.effect ?? "")}<br>仍在月末判定成败，失败也会消耗金 ${number(checked.cost)}。是否签发？` })) return false;
        }
        const outcome = queueTask(getState(), { kind: "stratagem", cityId: sourceInput.value, officerIds: [executorInput.value],
          payload: { action, targetId: targetCityId, ...options() } }, rules);
        if (!outcome.ok) { refresh(); window.requestAnimationFrame(refresh); showToast(outcome.message, "error"); return false; }
        return outcome;
      } });
    refresh();
    const result = await dialog;
    if (result) await onChange(result.message);
    return result;
  }
  return { showStratagem };
}
