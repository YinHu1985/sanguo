import { technologyStatus, unlockTechnology } from "../game/technology.js";
import { EQUIPMENT_LABELS } from "./equipment-view.js";
import { confirmDialog, escapeHtml as esc, number, openDialog, showToast } from "./components.js";

/** Separate policy sections keep future laws/government rules out of city commands. */
export const POLICY_SECTIONS = Object.freeze([{ id: "technology", label: "科技", mark: "研" }]);

export function technologyCardsMarkup(state, rules, editable = true) {
  return Object.entries(rules.technologies ?? {}).map(([id, technology]) => {
    const status = technologyStatus(state, state.playerFactionId, id, rules);
    const type = rules.troopTypes?.[technology.unitType ?? id] ?? {};
    const equipment = Object.entries(type.equipment ?? {}).filter(([, count]) => count > 0)
      .map(([key, count]) => `${EQUIPMENT_LABELS[key] ?? key} ×${count}`).join("、") || "无需额外装备";
    const title = technology.name ?? type.name ?? id;
    return `<article class="technology-card ${status.unlocked ? "is-unlocked" : ""}" data-technology="${esc(id)}">
      <header><span class="technology-seal" aria-hidden="true">${esc((type.name ?? title).slice(0, 1))}</span><div><small>兵制研究</small><h3>${esc(title)}</h3></div><span class="technology-status">${status.unlocked ? "已掌握" : "未解锁"}</span></header>
      <p>${esc(technology.description ?? type.description ?? "研究后永久开放本势力的对应兵种。")}</p>
      <div class="technology-requirements"><small>每名士兵配备</small><strong>${esc(equipment)}</strong></div>
      <footer><span>${status.unlocked ? "已完成研究" : `研究点 <strong>${number(status.cost)}</strong>`}</span><button class="btn ${status.unlocked ? "" : "btn-primary"}" type="button" data-unlock-technology="${esc(id)}" ${status.unlocked || !status.affordable || !editable ? "disabled" : ""} title="${esc(!editable ? "请先结束当前军情或回合结算" : status.message ?? "")}">${status.unlocked ? "已解锁" : status.affordable ? "研究解锁" : `尚缺 ${number(Math.max(0, status.cost - status.points))}`}</button></footer>
    </article>`;
  }).join("");
}

export function createPolicyUI({ getState, rules, onChange = () => {}, canEdit = () => true }) {
  async function showPolicies() {
    const body = document.createElement("div");
    body.className = "policy-window";
    let busy = false;
    function render() {
      const state = getState();
      const faction = state.factions.find((item) => item.id === state.playerFactionId);
      const foundational = Object.values(rules.troopTypes ?? {}).filter((type) => !type.technology)
        .map((type) => esc(type.name)).join(" · ");
      body.innerHTML = `<div class="policy-heading"><div><span class="kicker">${esc(faction?.name ?? "本势力")} · 全局政务</span><h3>修文备武，积研成军</h3><p>研究点由势力共用，不属于任何城池；每月自动增长，无积累上限。</p></div><div class="research-balance"><small>可用研究点</small><strong>${number(faction?.researchPoints)}</strong><span>每月 +${number(rules.research?.monthlyGain ?? 100)}</span></div></div>
        <nav class="policy-tabs" aria-label="全局政策类别">${POLICY_SECTIONS.map((section) => `<span class="active">${section.mark} · ${section.label}</span>`).join("")}<small>后续可扩展政令与制度</small></nav>
        <p class="policy-explanation">研究立即生效，永久开放兵种编成，不消耗城市金钱、武将行动或本月指令。解锁不赠送装备，编成仍须本城库存充足。</p>
        <div class="technology-grid">${technologyCardsMarkup(state, rules, canEdit())}</div>
        <div class="policy-foundation"><span>初始兵制</span><strong>${foundational}</strong><small>已有兵制，无需研究。后续将领特许解锁由独立接口扩展。</small></div>`;
      body.querySelectorAll("[data-unlock-technology]").forEach((button) => button.addEventListener("click", async () => {
        if (busy || !canEdit()) return;
        busy = true;
        try {
          const id = button.dataset.unlockTechnology;
          const status = technologyStatus(getState(), getState().playerFactionId, id, rules);
          if (status.unlocked || !status.affordable) return;
          const technology = rules.technologies[id];
          const confirmed = await confirmDialog({ title: "研究新兵制", mark: "研", confirmText: "完成研究",
            message: `耗费 <strong>${number(status.cost)}</strong> 研究点，永久解锁<strong>${esc(technology.name ?? id)}</strong>。<br>研究即刻生效；良马、劲弩和甲胄仍需在据点中生产。` });
          if (!confirmed || !canEdit()) return;
          const outcome = unlockTechnology(getState(), getState().playerFactionId, id, rules);
          if (!outcome.ok) showToast(outcome.message, "error");
          else await onChange(outcome.message);
        } finally {
          busy = false;
          render();
        }
      }));
    }
    render();
    return openDialog({ title: "全局政策 · 科技", content: body, confirmText: "返回军府", hideCancel: true, wide: true });
  }
  return { showPolicies };
}
