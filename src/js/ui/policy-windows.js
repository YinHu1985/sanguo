import { getPolicyOverview, rollbackTechnology, rollbackTechnologyPreview, technologyStatus, unlockTechnology } from "../game/technology.js";
import { heavenCycleStatus } from "../game/heaven-cycle.js";
import { EQUIPMENT_LABELS } from "./equipment-view.js";
import { confirmDialog, escapeHtml as esc, number, openDialog, showToast } from "./components.js";

export const POLICY_SECTIONS = Object.freeze([{ id: "technology", label: "理念与科技", mark: "革" }]);
const DIRECTION_ORDER = ["wang", "ba", "zheng", "qi"];
const multiplier = (value) => `×${Number(Number(value ?? 1).toFixed(2))}`;
const technologyName = (rules, id) => rules.technologies?.[id]?.name ?? id;
const knownTechnology = (rules, id) => Object.hasOwn(rules.technologies ?? {}, id);

function technologyCardMarkup(state, rules, id, editable) {
  const technology = rules.technologies?.[id];
  if (!technology) return "";
  const status = technologyStatus(state, state.playerFactionId, id, rules);
  const title = technologyName(rules, id);
  const type = technology.unitType ? rules.troopTypes?.[technology.unitType] : null;
  const equipment = Object.entries(type?.equipment ?? {}).filter(([, count]) => count > 0)
    .map(([key, count]) => `${EQUIPMENT_LABELS[key] ?? key} ×${count}`).join("、") || "无需额外装备";
  const prerequisites = technology.prerequisites ?? [];
  const ready = status.ok && editable;
  const reason = !editable ? "请先结束当前军情或回合结算" : status.message ?? "";
  const actionText = status.unlocked ? "回退理念" : !status.prerequisitesMet ? "前置未完成"
    : !status.affordable ? `尚缺 ${number(Math.max(0, status.cost - status.points))}` : "研习采纳";
  return `<article class="technology-card idea-node ${status.unlocked ? "is-unlocked" : ready ? "is-available" : "is-locked"}" data-technology="${esc(id)}">
    <header><span class="technology-seal" aria-hidden="true">${esc(title.slice(0, 1))}</span><div><small>${technology.placeholder ? "理念占位 · 效果待定" : "兵制科技 · 解锁兵种"}</small><h3>${esc(title)}</h3></div><span class="technology-status">${status.unlocked ? "已采纳" : "未采纳"}</span></header>
    <p>${esc(technology.description ?? (technology.placeholder ? "具体效果留待后续设计。" : "开放本势力的对应兵种编成。"))}</p>
    ${type ? `<div class="technology-requirements"><small>${esc(type.name)} · 每名士兵配备</small><strong>${esc(equipment)}</strong></div>` : ""}
    <div class="idea-prerequisites"><span>${prerequisites.length ? "前置" : "起始理念"}</span>${prerequisites.map((item) => `<b class="${status.missingPrerequisites?.includes(item) ? "is-missing" : "is-met"}">${esc(technologyName(rules, item))}</b>`).join("<i>＋</i>")}</div>
    <footer><span>${status.unlocked ? "已采纳 · 可回退" : `改革力 <strong>${number(status.cost)}</strong>${status.costMultiplier > 1 ? `<small>基础 ${number(status.baseCost)} · 对立 ${multiplier(status.costMultiplier)}</small>` : ""}`}</span>
      <button class="btn ${status.unlocked ? "idea-retract" : "btn-primary"}" type="button" ${status.unlocked ? `data-rollback-technology="${esc(id)}"` : `data-unlock-technology="${esc(id)}"`} aria-label="${esc(`${status.unlocked ? "回退" : "研习"} ${title}`)}" ${(status.unlocked ? !editable : !ready) ? "disabled" : ""} title="${esc(status.unlocked ? "回退会取消依赖理念，不返还改革力" : reason)}">${actionText}</button>
    </footer></article>`;
}

/** Flat catalog stays reusable independently of the policy window. */
export function technologyCardsMarkup(state, rules, editable = true, ids = Object.keys(rules.technologies ?? {})) {
  return ids.map((id) => technologyCardMarkup(state, rules, id, editable)).join("");
}

/** Layers follow actual dependencies, not the order of entries in the data file. */
export function ideaTreeLayers(group, rules) {
  const ids = group.nodeIds ?? [], members = new Set(ids), depths = new Map();
  function depth(id, visiting = new Set()) {
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) return 0;
    const next = new Set(visiting).add(id);
    const parents = (rules.technologies?.[id]?.prerequisites ?? []).filter((parent) => members.has(parent));
    const value = parents.length ? 1 + Math.max(...parents.map((parent) => depth(parent, next))) : 0;
    depths.set(id, value);
    return value;
  }
  for (const id of ids) depth(id);
  const layers = [];
  for (const id of ids) (layers[depths.get(id)] ??= []).push(id);
  return layers.filter(Boolean);
}

function treeConnections(previous, current, rules) {
  const paths = current.flatMap((id, index) => {
    const x = 100 * (index + .5) / current.length;
    return (rules.technologies?.[id]?.prerequisites ?? []).filter((parent) => previous.includes(parent)).map((parent) => {
      const parentX = 100 * (previous.indexOf(parent) + .5) / previous.length;
      return `<path d="M${parentX},0 V10 H${x} V23"/><path class="idea-link-tip" d="M${x - 1.2},18 L${x},24 L${x + 1.2},18"/>`;
    });
  }).join("");
  return `<svg class="idea-tree-links" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`;
}

export function ideaGroupsMarkup(state, rules, groups, editable = true) {
  return groups.map((group) => {
    const layers = ideaTreeLayers(group, rules);
    const bonus = group.completionBonus?.reformFlat ?? group.bonus ?? 0;
    return `<section class="idea-group ${group.complete ? "is-complete" : ""}" data-idea-group="${esc(group.id)}">
      <header class="idea-group-heading"><div><span class="kicker">理念组</span><h3>${esc(group.name)}</h3></div><span class="idea-group-count">${number(group.owned)}<small> / ${number(group.total)}</small></span></header>
      <p class="idea-group-description">${esc(group.description ?? "")}</p>
      <div class="idea-group-bonus ${group.complete ? "is-active" : ""}"><span>${group.complete ? "◆ 整组奖励生效" : "◇ 全部采纳后"}</span><strong>月改革力 +${number(bonus)}</strong><small>计入天意修正前的基础收入</small></div>
      <div class="idea-tree">${layers.map((layer, index) => `${index ? treeConnections(layers[index - 1], layer, rules) : ""}<div class="idea-tree-tier" data-depth="${index}" style="--idea-columns:${layer.length}">${technologyCardsMarkup(state, rules, editable, layer)}</div>`).join("")}</div></section>`;
  }).join("");
}

export function heavenCycleMarkup(faction, rules) {
  const heaven = heavenCycleStatus(faction, rules);
  const modifier = Math.round((heaven.multiplier - 1) * 100);
  return `<aside class="heaven-panel ${esc(heaven.phase)}" aria-label="天意循环"><div class="heaven-wheel" role="img" aria-label="${esc(`天意循环，${heaven.label}，改革力收入${modifier >= 0 ? "增加" : "减少"}${Math.abs(modifier)}%，进程${Math.round(heaven.progress * 100)}%`)}">
    <svg viewBox="0 0 200 148" aria-hidden="true"><circle class="heaven-ring" cx="100" cy="74" r="47"/><circle class="heaven-inner-ring" cx="100" cy="74" r="39"/>
      <path class="heaven-cycle-route" d="M104 27 A47 47 0 0 1 147 70 M143 63 L147 70 L151 63 M96 121 A47 47 0 0 1 53 78 M49 85 L53 78 L57 85"/>
      <g class="heaven-pointer ${heaven.phase === "neutral" ? "is-neutral" : ""}" transform="rotate(${Number(heaven.angle) || 0} 100 74)"><path d="M100 31 L96 43 L100 40 L104 43 Z"/><path d="M100 40 V50"/></g>
      <text x="100" y="15" text-anchor="middle">骄兵必败</text><text x="153" y="77">败兵必哀</text><text x="100" y="143" text-anchor="middle">哀兵必胜</text><text x="47" y="77" text-anchor="end">胜兵必骄</text>
      <text class="heaven-wheel-title" x="100" y="71" text-anchor="middle">天意</text><text class="heaven-wheel-factor" x="100" y="91" text-anchor="middle">${multiplier(heaven.multiplier)}</text>
    </svg></div><div class="heaven-caption"><strong>${esc(heaven.label)}</strong><span class="heaven-modifier">${modifier === 0 ? "收支平常" : `改革力收入 ${modifier > 0 ? "+" : "−"}${Math.abs(modifier)}%`}</span><small>${heaven.phase === "neutral" ? "尚无胜败，静候天时" : `循环 ${number(heaven.strength)} / ${number(heaven.maxStrength)} · 每月渐强`}</small></div></aside>`;
}

function policyAxesMarkup(overview) {
  return [["内政", "wang", "ba"], ["军事", "zheng", "qi"]].map(([label, firstId, secondId]) => {
    const first = overview.directions.find((direction) => direction.id === firstId), second = overview.directions.find((direction) => direction.id === secondId);
    if (!first || !second) return "";
    const total = first.owned + second.owned;
    const position = total ? 50 + 40 * (second.owned - first.owned) / total : 50;
    return `<div class="policy-axis" data-policy-axis="${esc(first.axis)}"><span class="policy-axis-title">${label}</span><div class="policy-axis-ends"><span><b>${esc(first.name)}</b> ${number(first.owned)} 项 <small>研习 ${multiplier(first.costMultiplier)}</small></span><span><small>研习 ${multiplier(second.costMultiplier)}</small> ${number(second.owned)} 项 <b>${esc(second.name)}</b></span></div><div class="policy-axis-track"><i style="left:${position}%"></i></div></div>`;
  }).join("");
}

function routeNodeMarkup(state, rules, id, selectedId, depth) {
  const technology = rules.technologies[id], status = technologyStatus(state, state.playerFactionId, id, rules);
  const title = technologyName(rules, id);
  const label = status.unlocked ? "已采纳" : status.ok ? "可研习" : status.message;
  return `<button class="policy-tech-node ${status.unlocked ? "is-owned" : status.ok ? "is-ready" : "is-locked"} ${selectedId === id ? "is-selected" : ""}" type="button" data-select-technology="${esc(id)}" aria-label="${esc(`查看 ${title}`)}" aria-pressed="${selectedId === id}" title="${esc(`${title} · ${label}${status.unlocked ? "" : ` · 改革力 ${number(status.cost)}`}`)}" style="--node-depth:${depth}"><span class="policy-node-mark" aria-hidden="true">${status.unlocked ? "✓" : status.ok ? "◇" : "·"}</span><span class="policy-node-name">${esc(title)}</span><span class="policy-node-cost">${status.unlocked ? "已采纳" : number(status.cost)}</span></button>`;
}

/** Every local prerequisite has an edge, including edges that skip a layer. */
function compactGroupMarkup(state, rules, group, selectedId) {
  const layers = ideaTreeLayers(group, rules), ids = layers.flat();
  const depth = new Map(layers.flatMap((layer, index) => layer.map((id) => [id, Math.min(index, 3)])));
  const edges = ids.flatMap((id, row) => (rules.technologies[id].prerequisites ?? []).filter((parent) => ids.includes(parent)).map((parent) => {
    const x = depth.get(parent) * 12 + 5, toX = depth.get(id) * 12 + 11;
    const y = ids.indexOf(parent) * 25 + 11.5, toY = row * 25 + 11.5;
    return `<path d="M${x + 6} ${y} H${x} V${toY} H${toX}"/><path d="M${toX - 3} ${toY - 2} L${toX} ${toY} L${toX - 3} ${toY + 2}"/>`;
  })).join("");
  return `<section class="policy-route-group ${group.complete ? "is-complete" : ""}" data-idea-group="${esc(group.id)}"><header><h4>${esc(group.name)}</h4><span title="${esc(`全部采纳后每月基础改革力 +${group.bonus}`)}">${number(group.owned)}/${number(group.total)} <b>${group.complete ? "◆" : "◇"} +${number(group.bonus)}</b></span></header><div class="policy-route-nodes"><svg class="policy-route-edges" viewBox="0 0 48 ${Math.max(1, ids.length * 25 - 2)}" preserveAspectRatio="none" aria-hidden="true">${edges}</svg>${ids.map((id) => routeNodeMarkup(state, rules, id, selectedId, depth.get(id))).join("")}</div></section>`;
}

function technologyLink(rules, id) {
  return knownTechnology(rules, id) ? `<button class="policy-detail-link" type="button" data-select-technology="${esc(id)}">${esc(technologyName(rules, id))}</button>` : esc(id);
}

export function policyDetailMarkup(state, rules, selectedId, editable = true) {
  const technology = knownTechnology(rules, selectedId) ? rules.technologies[selectedId] : null;
  if (!technology) return `<aside class="policy-inspector" data-policy-detail=""><p>选择任意理念，查看研习条件与详细效果。</p></aside>`;
  const status = technologyStatus(state, state.playerFactionId, selectedId, rules);
  const group = getPolicyOverview(state, state.playerFactionId, rules).groups.find((entry) => entry.id === technology.group);
  const prerequisites = technology.prerequisites ?? [];
  const successors = Object.entries(rules.technologies).filter(([, node]) => node.prerequisites?.includes(selectedId)).map(([id]) => id);
  const troop = rules.troopTypes?.[technology.unitType];
  const equipment = Object.entries(troop?.equipment ?? {}).map(([key, count]) => `${EQUIPMENT_LABELS[key] ?? key} ×${count}`).join("、") || "无需额外装备";
  const enabled = editable && (status.unlocked || status.ok);
  const reason = !editable ? "请先结束当前军情或回合结算" : status.unlocked ? "回退不退款，依赖理念将一并取消" : status.message;
  return `<aside class="policy-inspector" data-policy-detail="${esc(selectedId)}" aria-label="理念详情"><div class="policy-detail-copy"><small>${esc(rules.policyDirections?.[technology.direction]?.name ?? "")}之道 · ${esc(group?.name ?? "理念")} · ${technology.placeholder ? "理念占位／效果待定" : "兵种解锁"}</small><h3>${esc(technology.name)}</h3><p>${esc(technology.description ?? "具体效果待定。")}</p>${troop ? `<p class="policy-detail-equipment">${esc(troop.name)}：${esc(equipment)}／人</p>` : ""}</div><div class="policy-detail-context"><p><span>前置</span>${prerequisites.length ? prerequisites.map((id) => technologyLink(rules, id)).join(" ＋ ") : "无，可直接研习"}</p><p><span>后继</span>${successors.length ? successors.map((id) => technologyLink(rules, id)).join("、") : "本路线终点"}</p><p><span>整组</span>${number(group?.owned)} / ${number(group?.total)} · 全部采纳后月改革力 +${number(group?.bonus)}${group?.complete ? "（已生效）" : ""}</p></div><div class="policy-detail-action"><div class="policy-detail-price">${status.unlocked ? "已采纳" : `改革力 <strong>${number(status.cost)}</strong>`}</div>${!status.unlocked ? `<small>基础 ${number(status.baseCost)} · 倾向 ${multiplier(status.costMultiplier)}</small>` : ""}<button class="btn ${status.unlocked ? "idea-retract" : "btn-primary"}" type="button" ${status.unlocked ? `data-rollback-technology="${esc(selectedId)}"` : `data-unlock-technology="${esc(selectedId)}"`} aria-label="${esc(`${status.unlocked ? "回退" : "研习"} ${technology.name}`)}" ${enabled ? "" : "disabled"}>${status.unlocked ? "回退理念" : "研习采纳"}</button><small class="policy-detail-reason">${esc(reason)}</small></div></aside>`;
}

function policyHelpMarkup(state, rules) {
  const faction = state.factions.find((item) => item.id === state.playerFactionId);
  const opening = heavenCycleStatus({ id: "opening", heavenCycle: { phase: "victory", strength: 1 } }, rules);
  const current = heavenCycleStatus(faction, rules);
  return `<div class="policy-help">${heavenCycleMarkup(faction, rules)}${current.lastReason ? `<p>最近变化：${esc(current.lastReason)}</p>` : ""}<p>新开局各势力从「胜兵必骄」第 1 档起步，立即开始降低改革力收入（当前规则收入 ${multiplier(opening.multiplier)}），随后按月加强。读档延续存档中的阶段与强度，不会重新起算。</p><p>两条倾向独立计算。偏向一端越深，对立端的研习花费越高；两端均衡则回归基础花费，始终不会锁死另一方向。</p><p>新采纳理念或取得城池计为胜，进入逐渐加强的减益；回退理念或失去城池计为败，清除减益并进入逐渐加强的增益。同类胜败与每月推进都会使当前循环加深，反向事件会重新起步。</p><p>回退不返还改革力，并连带取消依赖的后继理念；不再完整的理念组会失去奖励。已编成的出征部队不变，后续编组须重新解锁。</p><p>理念占位的具体内政、军事效果尚未实装，但照常参与倾向、整组奖励和天意计算。初始五种兵种不受理念树限制；其他兵制解锁不赠送装备。研习不消耗城市金钱、武将行动或本月指令。</p></div>`;
}

export function policyWindowMarkup(state, rules, editable = true, selectedTechnologyId = null) {
  const faction = state.factions.find((item) => item.id === state.playerFactionId);
  const overview = getPolicyOverview(state, state.playerFactionId, rules), income = overview.income;
  const directions = [...overview.directions].sort((a, b) => DIRECTION_ORDER.indexOf(a.id) - DIRECTION_ORDER.indexOf(b.id));
  const selectedId = knownTechnology(rules, selectedTechnologyId) ? selectedTechnologyId : Object.keys(rules.technologies ?? {})[0];
  return `<div class="policy-atlas-summary"><div class="reform-overview"><span class="kicker">${esc(faction?.name ?? "本势力")} · 改革之议</span><div class="reform-ledger"><div><small>改革力</small><strong data-reform-balance>${number(overview.points)}</strong></div><div><small>预计月收入</small><strong class="reform-monthly" data-reform-monthly>+${number(income.gain)}</strong></div></div><p class="reform-income-breakdown">基础 ${number(income.baseGain)} ＋ 理念组 ${number(income.groupBonus)} → 天意 ${multiplier(income.multiplier)}</p></div><div class="policy-axes">${policyAxesMarkup(overview)}</div></div>
    <div class="policy-atlas-legend"><span>四道并览 · 选择任意节点查看详情</span><span><i>✓</i> 已采纳　<i>◇</i> 可研习　<i>·</i> 条件未满足　◇／◆ 整组奖励</span><button class="policy-detail-link" type="button" data-policy-help aria-label="查看天意与改革规则">规则说明 ↗</button></div>
    <div class="policy-roadmap-scroll"><div class="policy-roadmap" data-policy-board aria-label="全部路线与科技">${directions.map((direction) => `<section class="policy-route" data-policy-direction="${esc(direction.id)}" aria-label="${esc(direction.name)}之道"><header class="policy-route-heading"><span class="direction-seal">${esc(direction.name)}</span><div><strong>${direction.axis === "domestic" ? "内政" : "军事"} · ${number(direction.owned)} / ${number(direction.total)}</strong><small>研习 ${multiplier(direction.costMultiplier)}</small></div></header><p class="policy-route-description">${esc(direction.description)}</p>${direction.groups.map((group) => compactGroupMarkup(state, rules, group, selectedId)).join("")}</section>`).join("")}</div></div>
    ${policyDetailMarkup(state, rules, selectedId, editable)}`;
}

export function rollbackConfirmationMarkup(preview, rules) {
  const names = preview.removedIds.map((id) => `<li>${esc(technologyName(rules, id))}</li>`).join("");
  const lost = (preview.lostGroups ?? []).map((id) => esc(rules.ideaGroups?.[id]?.name ?? id)).join("、");
  return `将回退以下 <strong>${number(preview.removedIds.length)}</strong> 项理念（包含依赖的后继）：<ul class="policy-rollback-list">${names}</ul>${lost ? `<p>失去整组奖励：<strong>${lost}</strong>。</p>` : ""}<p><strong>不返还改革力。</strong>本次回退计一次败，天意转入增益循环；已编成的出征部队不变，后续编组须重新解锁。</p>`;
}

export function createPolicyUI({ getState, rules, onChange = () => {}, canEdit = () => true,
  dialogs = { open: openDialog, confirm: confirmDialog, toast: showToast } }) {
  function showHeavenCycle() {
    return dialogs.open({ title: "天意与改革规则", content: policyHelpMarkup(getState(), rules), confirmText: "返回军府", hideCancel: true });
  }
  async function showPolicies() {
    const body = document.createElement("div");
    body.className = "policy-window policy-atlas";
    let busy = false, closed = false, selectedTechnologyId = Object.keys(rules.technologies ?? {})[0];
    const isOpen = () => !closed && body.isConnected;
    const notify = (message) => dialogs.toast(message, "error");
    async function execute(id, retract) {
      if (busy || !isOpen() || !canEdit()) return;
      busy = true;
      const originalState = getState(), originalFactionId = originalState.playerFactionId;
      let committed = false;
      try {
        const preview = retract ? rollbackTechnologyPreview(getState(), originalFactionId, id, rules) : technologyStatus(getState(), originalFactionId, id, rules);
        if (!preview.ok) { notify(preview.message); return; }
        const confirmed = await dialogs.confirm(retract ? { title: "回退理念", mark: "革", confirmText: "确认回退", message: rollbackConfirmationMarkup(preview, rules) }
          : { title: "采纳理念", mark: "革", confirmText: "研习采纳", message: `耗费 <strong>${number(preview.cost)}</strong> 改革力，采纳<strong>${esc(technologyName(rules, id))}</strong>。${preview.costMultiplier > 1 ? `<br>基础 ${number(preview.baseCost)} · 对立倾向 ${multiplier(preview.costMultiplier)}。` : ""}<p>${esc(rules.technologies[id].description ?? "")}</p><p>采纳计一次胜，天意转入或加强改革力收入减益。${rules.technologies[id].placeholder ? "此项为理念占位，具体效果待定。" : "解锁不赠送装备。"}</p>` });
        if (!confirmed || !isOpen() || !canEdit()) return;
        const state = getState();
        if (state !== originalState || state.playerFactionId !== originalFactionId) { notify("当前征程已变更，请重新打开政策窗口。"); return; }
        const fresh = retract ? rollbackTechnologyPreview(state, originalFactionId, id, rules) : technologyStatus(state, originalFactionId, id, rules);
        if (!fresh.ok) { notify(fresh.message); return; }
        const changed = retract ? JSON.stringify([...fresh.removedIds].sort()) !== JSON.stringify([...preview.removedIds].sort()) || JSON.stringify([...(fresh.lostGroups ?? [])].sort()) !== JSON.stringify([...(preview.lostGroups ?? [])].sort()) : fresh.cost !== preview.cost;
        if (changed) { notify("局势已变，花费或依赖范围发生变化，请重新确认。"); return; }
        const outcome = retract ? rollbackTechnology(state, originalFactionId, id, rules) : unlockTechnology(state, originalFactionId, id, rules);
        if (!outcome.ok) notify(outcome.message);
        else { committed = true; await onChange(outcome.message); }
      } catch (error) { notify(committed ? "政策已生效，但保存或界面更新失败，请检查存档。" : error?.message || "政策变更未能完成，请重试。"); }
      finally { busy = false; if (isOpen()) render(); }
    }
    function render() {
      const scrollParent = body.querySelector?.(".policy-roadmap-scroll"), scrollTop = scrollParent?.scrollTop, scrollLeft = scrollParent?.scrollLeft;
      body.innerHTML = policyWindowMarkup(getState(), rules, canEdit(), selectedTechnologyId);
      body.querySelectorAll("[data-select-technology]").forEach((button) => button.addEventListener("click", () => {
        if (busy || closed) return;
        selectedTechnologyId = button.dataset.selectTechnology;
        render();
        [...body.querySelectorAll("[data-select-technology]")].find((node) => node.dataset.selectTechnology === selectedTechnologyId)?.focus({ preventScroll: true });
      }));
      body.querySelector("[data-policy-help]")?.addEventListener("click", () => {
        if (!busy && isOpen()) dialogs.open({ title: "天意与改革规则", content: policyHelpMarkup(getState(), rules), confirmText: "返回理念总览", hideCancel: true });
      });
      body.querySelectorAll("[data-unlock-technology]").forEach((button) => button.addEventListener("click", () => execute(button.dataset.unlockTechnology, false)));
      body.querySelectorAll("[data-rollback-technology]").forEach((button) => button.addEventListener("click", () => execute(button.dataset.rollbackTechnology, true)));
      const nextScrollParent = body.querySelector?.(".policy-roadmap-scroll");
      if (nextScrollParent && scrollTop !== undefined) { nextScrollParent.scrollTop = scrollTop; nextScrollParent.scrollLeft = scrollLeft; }
    }
    render();
    try { return await dialogs.open({ title: "全局政策 · 理念与科技", content: body, confirmText: "返回军府", hideCancel: true, wide: true }); }
    finally { closed = true; }
  }
  return { showPolicies, showHeavenCycle };
}
