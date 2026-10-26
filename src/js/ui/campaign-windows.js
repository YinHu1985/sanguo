import { availableOfficers, cityOfficers, getCity, getFaction, getOfficer, playerCities } from "../game/rules.js";
import { areAllied, employCandidates, getCampaignStatus, getRelation, previewEmploy } from "../game/campaign.js";
import { createDefenderFormations } from "../game/army.js";
import { createArmyComposer } from "./army-composer.js";
import { equipmentStoresMarkup } from "./equipment-view.js";
import { queueTask } from "../game/tasks.js";
import { taskOrderNote } from "./task-windows.js";
import { createDataTable, escapeHtml as esc, number, openDialog, showToast } from "./components.js";
import { cityEconomyMarkup } from "./economy-windows.js";
import { ambushPreparationMarkup } from "./stratagem-windows.js";
import { dailyFoodCost } from "../game/economy.js";
import { commandLimitEnabled } from "../game/commands.js";
import { capability } from "../game/capabilities.js";

export function cityTheme(city, manifest) {
  return manifest.themes[manifest.regionThemes[city.region] ?? "central"];
}

/** Keep eligibility in campaign rules; the window also explains nearby rejected candidates. */
export function employCandidateRows(state, cityId, rules, executorId) {
  const city = getCity(state, cityId);
  if (!city) return [];
  const eligible = employCandidates(state, cityId, rules);
  const eligibleIds = new Set(eligible.map((officer) => officer.id));
  const neighboring = state.officers.filter((officer) => {
    const origin = getCity(state, officer.locationCityId);
    return origin && city.adjacent?.includes(origin.id) && officer.factionId === origin.factionId
      && officer.factionId !== state.playerFactionId && officer.factionId !== "neutral"
      && origin.officerIds.includes(officer.id) && !["free", "captured"].includes(officer.status)
      && officer.rank !== "君主" && !state.factions.some((faction) => faction.lord === officer.id);
  });
  return [...new Map([...eligible, ...neighboring].map((officer) => [officer.id, officer])).values()].map((officer) => {
    const origin = getCity(state, officer.locationCityId);
    const enemyRecruit = !["free", "captured"].includes(officer.status);
    const available = eligibleIds.has(officer.id);
    const checked = previewEmploy(state, cityId, executorId, officer.id, rules);
    return { officer, origin, enemyRecruit, available,
      kind: enemyRecruit ? "邻城武将" : officer.status === "captured" ? "俘虏" : "在野",
      condition: available ? enemyRecruit ? `邻接敌城 · 忠诚≤${rules.personnel?.enemyEmployMaxLoyalty ?? 60} · 未执行任务` : "本城已发现 · 可以延请"
        : checked.message ?? "当前不符合登用条件" };
  });
}

export function employPreviewMarkup(preview, rules) {
  const chance = Number.isFinite(preview?.chance) ? `${Math.round(preview.chance * 100)}%` : "—";
  return `<strong>礼金 ${number(preview?.cost ?? rules.personnel?.employCost ?? 200)} · 成功率 ${chance}</strong><p class="${preview?.ok ? "economy-note" : "economy-warning"}">${esc(preview?.message || "请选择执行武将与登用对象。")}</p><p>${preview?.enemyRecruit ? "成功后仅该武将转投我方并迁至本城，不带走原城兵力、钱粮或城池。" : "成功后该武将加入本城。"}月末重新校验并判定成败，失败也消耗礼金与行动。</p>`;
}

// Windows own presentation only. Rules remain callable from any entry point.
export function createCampaignUI({ getState, scenario, rules, themes, onStart, onChange, onSelectCity, onOfficer, onTrade, onManualDefense }) {
  const state = () => getState();
  const closeWindow = (body) => body.closest(".modal")?.querySelector(".modal-close")?.click();
  const officerOptions = (city) => availableOfficers(state(), city).map((officer) => `<option value="${officer.id}">${esc(officer.name)} · 智 ${officer.intelligence} 魅 ${officer.charm}</option>`).join("");
  const actionWindow = async (title, body, confirmText, execute, kind, refresh) => {
    body.insertAdjacentHTML("beforeend", taskOrderNote(rules, kind));
    const dialog = openDialog({ title, content: body, confirmText, onConfirm: () => {
      const outcome = execute();
      if (!outcome.ok) { showToast(outcome.message, "error"); return false; }
      return outcome;
    } });
    refresh?.();
    const result = await dialog;
    if (result) await onChange(result.message);
    return result;
  };

  async function chooseScenario({ allowCancel = false, hasExistingSave = false } = {}) {
    const body = document.createElement("div");
    body.className = "scenario-selection";
    const factions = scenario.factions.filter((faction) => faction.playable !== false && faction.id !== "neutral");
    body.innerHTML = `<div class="scenario-banner"><span class="kicker">${esc(scenario.subtitle)} · 公元 ${scenario.year} 年 ${scenario.month} 月</span><h3>${esc(scenario.title)}</h3><p>${esc(scenario.description ?? scenario.introduction ?? "群雄并起，逐鹿天下。")}</p><div class="scenario-counts">${scenario.cities.length} 座城池　/　${factions.length} 方势力　/　${scenario.officers.length} 位人物</div></div>
      <p class="modal-description">先选势力，再选一位武将开始人生。君主统筹全局、太守治理本城、普通武将请领公务。所有进度仅存于本机浏览器。</p>
      <div class="faction-choice-grid">${factions.map((faction) => {
        const cities = scenario.cities.filter((city) => city.factionId === faction.id);
        const officers = scenario.officers.filter((officer) => officer.factionId === faction.id);
        return `<label class="faction-choice" style="--faction:${faction.color}"><input type="radio" name="faction" value="${faction.id}" ${faction.id === state().playerFactionId ? "checked" : ""}><span class="faction-choice-title">${esc(faction.name)}</span><small>${cities.length} 城 · ${officers.length} 将 · ${number(cities.reduce((sum, city) => sum + city.troops, 0))} 兵</small></label>`;
      }).join("")}</div><div class="faction-choice-detail"></div>
      <details class="scenario-notes"><summary>史实取舍与剧本说明</summary><p>${esc(scenario.introduction ?? "")}</p>${(scenario.historicalNotes ?? []).map((note) => `<p>${esc(typeof note === "string" ? note : note.text ?? JSON.stringify(note))}</p>`).join("")}<p>本作采用同一时间截面，不会在推进月份时强制复演历史。城池资源、五维数值与任职配置为游戏化设计；允许城池无将领，也允许无主空城，不添加占位人物。</p></details>
      ${state().started || hasExistingSave ? '<p class="save-warning">开启新局会替换当前剧本的活动存档；系统会保留上一局快照。旧版徐州剧本存档不受影响。</p>' : ""}`;
    const update = () => {
      const faction = factions.find((item) => item.id === body.querySelector("input:checked")?.value) ?? factions[0];
      const capital = scenario.cities.find((city) => city.id === faction.capitalId) ?? scenario.cities.find((city) => city.factionId === faction.id);
      body.querySelector(".faction-choice-detail").innerHTML = `<strong>${esc(faction.name)} · 治所 ${esc(capital.name)}</strong><p>${esc(faction.description ?? "审时度势，经营城池，逐鹿天下。")}</p><label>选择主角 <select name="protagonist">${scenario.officers.filter(o => o.factionId === faction.id && !["free", "captured"].includes(o.status)).map(o => {
        const city = scenario.cities.find(c => c.officerIds.includes(o.id));
        return `<option value="${esc(o.id)}">${esc(o.name)} · ${o.rank === "君主" ? "君主" : city?.governorId === o.id ? "太守" : "武将"} · ${esc(city?.name ?? "")}</option>`;
      }).join("")}</select></label>`;
    };
    body.querySelectorAll("input").forEach((input) => input.addEventListener("change", update));
    update();
    const chosen = await openDialog({ title: "选择剧本 · 群雄逐鹿", content: body, confirmText: "以此武将开始", hideCancel: !allowCancel && !state().started, dismissible: allowCancel || state().started, wide: true,
      onConfirm: () => ({ factionId: body.querySelector("input:checked")?.value, officerId: body.querySelector('[name="protagonist"]').value }) });
    if (chosen?.officerId) await onStart(chosen.factionId, chosen.officerId);
  }

  async function showFactions() {
    const current = state();
    const body = document.createElement("div");
    body.innerHTML = '<p class="modal-description">点击治所查阅城池资料。本窗口只读；亲善、结盟等政令请前往议政厅。</p>';
    const rows = current.factions.filter((faction) => faction.id !== "neutral").map((faction) => {
      const cities = current.cities.filter((city) => city.factionId === faction.id);
      const capital = cities.find((city) => city.id === faction.capitalId) ?? cities[0];
      const relation = getRelation(current, current.playerFactionId, faction.id);
      return { ...faction, cities, capital, relation };
    }).sort((a, b) => b.cities.length - a.cities.length);
    body.append(createDataTable([
      { label: "势力", html: true, render: (row) => `<span class="faction-table-name"><i style="background:${row.color}"></i>${esc(row.name)}${row.id === current.playerFactionId ? " · 我" : ""}</span>` },
      { label: "治所", html: true, render: (row) => row.capital ? `<button class="text-button" data-city="${row.capital.id}">${esc(row.capital.name)}</button>` : "已灭亡" },
      { label: "城池", numeric: true, render: (row) => row.cities.length },
      { label: "武将", numeric: true, render: (row) => current.officers.filter((officer) => officer.factionId === row.id && officer.status === "active").length },
      { label: "总兵力", numeric: true, render: (row) => number(row.cities.reduce((sum, city) => sum + city.troops, 0)) },
      { label: "对我关系", render: (row) => row.id === current.playerFactionId ? "本势力" : areAllied(current, current.playerFactionId, row.id) ? `同盟 · 余 ${row.relation.allianceUntil - (current.year * 12 + current.month)} 月` : `友好 ${row.relation.friendliness}` }
    ], rows));
    body.querySelectorAll("[data-city]").forEach((button) => button.addEventListener("click", () => showCity(button.dataset.city, { readOnly: true })));
    await openDialog({ title: "天下势力", content: body, confirmText: "返回地图", hideCancel: true, wide: true });
  }

  async function showCity(cityId, { readOnly = false } = {}) {
    const current = state();
    const city = getCity(current, cityId);
    const theme = cityTheme(city, themes);
    const body = document.createElement("div");
    body.innerHTML = `<div class="city-overview-hero"><img src="${theme.image}" alt="${esc(theme.name)}区域城景"><div><span>${esc(city.province)} · ${esc(city.region)}</span><h3>${esc(city.name)}</h3><p>${esc(getFaction(current, city.factionId).name)} · 太守 ${esc(getOfficer(current, city.governorId)?.name ?? "未任命")}</p></div></div>
      <p class="theme-caption">${esc(theme.name)} · ${esc(theme.description)}（区域共用主题画，非单城考据复原）</p>
      <div class="city-overview-stats">${[["金", number(city.gold)], ["粮", number(city.food)], ["驻军", number(city.troops)], ["农业", city.agriculture], ["商业", city.commerce], ["民心", city.popularSupport], ["训练", city.training], ["士气", city.morale], ["城墙等级", city.wallLevel], ["城防度", city.defense], ["扩筑进度", `${city.wallProgress}/100`]].map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join("")}</div>
      <div class="equipment-stores city-overview-equipment" aria-label="军备库存">${equipmentStoresMarkup(city)}</div>
      ${ambushPreparationMarkup(city, current)}
      ${cityEconomyMarkup(current, city, rules)}
      ${!readOnly && city.factionId === current.playerFactionId ? '<button type="button" class="btn" data-city-trade>商人 · 买卖粮食</button>' : ""}
      <h3 class="window-section-title">城内武将</h3>`;
    body.append(createDataTable([
      { label: "姓名", html: true, render: (officer) => `<button class="text-button" data-officer="${officer.id}">${esc(officer.name)}</button>` }, { key: "rank", label: "职位" },
      { key: "war", label: "武" }, { key: "intelligence", label: "智" }, { key: "leadership", label: "统" }, { key: "politics", label: "政" }, { key: "charm", label: "魅" },
      { key: "loyalty", label: "忠诚" }, { label: "月俸", render: (officer) => rules.economy.salaryByRank[officer.rank] ?? 40 },
      { label: "状态", render: (officer) => officer.battleId ? "跨月作战中" : officer.taskId ? "执行任务中" : officer.acted ? "已行动" : "待命" }
    ], cityOfficers(current, city)));
    const neighbors = document.createElement("div");
    neighbors.className = "city-neighbor-links";
    neighbors.innerHTML = `<small>相邻城池</small>${city.adjacent.map((id) => { const other = getCity(current, id); return `<button class="btn" data-city="${id}">${esc(other.name)} · ${esc(getFaction(current, other.factionId).name)}</button>`; }).join("")}`;
    body.append(neighbors);
    body.querySelector("[data-city-trade]")?.addEventListener("click", () => { closeWindow(body); onTrade?.(cityId); });
    body.querySelectorAll("[data-officer]").forEach((button) => button.addEventListener("click", () => onOfficer(getOfficer(current, button.dataset.officer))));
    body.querySelectorAll("[data-city]").forEach((button) => button.addEventListener("click", () => { closeWindow(body); if (readOnly) showCity(button.dataset.city, { readOnly: true }); else onSelectCity(button.dataset.city, true); }));
    await openDialog({ title: `${city.name} · 城池全览`, content: body, confirmText: "返回军府", hideCancel: true, wide: true });
  }

  async function showSearch(cityId) {
    const city = getCity(state(), cityId);
    const body = document.createElement("div");
    body.innerHTML = `<p class="modal-description">派一名武将走访${esc(city.name)}，寻找当地尚未发现的在野人物。智力影响发现机会，寻得后仍需另行登用。</p><div class="field"><label>执行武将</label><select>${officerOptions(city)}</select></div><div class="result-preview">花费金 ${rules.personnel?.searchCost ?? 100} · 消耗${commandLimitEnabled(state()) ? "一道指令及" : ""}该武将本月行动。</div>`;
    await actionWindow(`${city.name} · 寻访人才`, body, "派遣寻访", () => queueTask(state(), { kind: "search", cityId, officerIds: [body.querySelector("select").value], payload: {} }, rules), "search");
  }

  async function showEmploy(cityId) {
    const current = state();
    const city = getCity(current, cityId);
    if (!city || city.factionId !== current.playerFactionId) return showToast("请选择我方登用出发城", "error");
    const executorId = availableOfficers(current, city)[0]?.id;
    const rows = employCandidateRows(current, cityId, rules, executorId);
    if (!rows.length) return openDialog({ title: `${city.name} · 登用人才`, content: '<p class="modal-description">城内暂无已发现的在野人才、俘虏，相邻城池也没有可招揽的非君主武将。可先寻访；对于低忠诚的邻城敌将，也可在此派遣使者登用。</p>', confirmText: "返回", hideCancel: true });
    const body = document.createElement("div");
    body.innerHTML = `<p class="modal-description">使者的魅力与智力影响成功机会，俘虏较难说服。敌将须在邻接敌城、非君主、忠诚不高于 ${number(rules.personnel?.enemyEmployMaxLoyalty ?? 60)} 且未执行任务；盟友不可招揽，可先用离间降低忠诚。</p><div data-employ-candidates></div><div class="form-grid"><div class="field"><label for="employ-envoy">执行武将</label><select id="employ-envoy" data-envoy>${officerOptions(city) || '<option value="">本城暂无待命武将</option>'}</select></div><div class="field"><label for="employ-target">登用对象 · 来源 / 忠诚</label><select id="employ-target" data-target>${rows.some((row) => row.available) ? "" : '<option value="">暂无符合条件的登用对象</option>'}${rows.map((row) => `<option value="${esc(row.officer.id)}" ${row.available ? "" : "disabled"}>${esc(row.officer.name)} · ${esc(row.origin?.name ?? "驻地不明")} / ${esc(row.kind)} · 忠诚 ${number(row.officer.loyalty ?? 0)}${row.available ? "" : ` · ${esc(row.condition)}`}</option>`).join("")}</select></div></div><div class="result-preview" data-employ-preview aria-live="polite"></div>`;
    body.querySelector("[data-employ-candidates]").append(createDataTable([
      { label: "姓名", render: (row) => row.officer.name }, { label: "来源城", render: (row) => row.origin?.name ?? "驻地不明" },
      { label: "身份", key: "kind" }, { label: "忠诚", render: (row) => row.officer.loyalty ?? "—", numeric: true },
      { label: "登用条件", key: "condition" }
    ], rows));
    const envoy = body.querySelector("[data-envoy]");
    const target = body.querySelector("[data-target]");
    const preview = () => previewEmploy(state(), cityId, envoy.value, target.value, rules);
    const refresh = () => {
      const checked = preview();
      body.querySelector("[data-employ-preview]").innerHTML = employPreviewMarkup(checked, rules);
      const button = body.closest(".modal")?.querySelector(".dialog-confirm");
      if (button) { button.disabled = !checked.ok; button.title = checked.ok ? "签发后在月末结算" : checked.message; }
    };
    envoy.addEventListener("change", refresh);
    target.addEventListener("change", refresh);
    refresh();
    await actionWindow(`${city.name} · 登用人才`, body, "签发登用令", () => {
      const checked = preview();
      if (!checked.ok) { refresh(); window.requestAnimationFrame(refresh); return checked; }
      return queueTask(state(), { kind: "employ", cityId, officerIds: [envoy.value], payload: { targetId: target.value } }, rules);
    }, "employ", refresh);
  }

  async function showOfficerTransfer(cityId) {
    const city = getCity(state(), cityId);
    const destinations = playerCities(state()).filter((item) => item.id !== cityId);
    if (!destinations.length) return showToast("尚无其他领地可迁任", "error");
    const body = document.createElement("div");
    body.innerHTML = `<p class="modal-description">迁任武将本人，不携带城中军队。目的地须由我方城池相连；所选武将本月都将视为已行动，共消耗${commandLimitEnabled(state()) ? "一道指令和" : ""}金 ${rules.actions.officerTransfer}。月底俸禄由届时所在城池支付。</p><div class="field"><label>迁任目的地</label><select>${destinations.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join("")}</select></div><div class="selection-list">${availableOfficers(state(), city).map((officer) => `<label class="selection-card"><input type="checkbox" value="${officer.id}"><strong>${esc(officer.name)}</strong><small>${esc(officer.rank)} · 政 ${officer.politics} 统 ${officer.leadership}</small></label>`).join("")}</div>`;
    await actionWindow(`${city.name} · 武将迁任`, body, "签发任命", () => queueTask(state(), { kind: "officerTransfer", cityId, officerIds: [...body.querySelectorAll("input:checked")].map((input) => input.value), payload: { targetId: body.querySelector("select").value } }, rules), "officerTransfer");
  }

  async function showDiplomacy(targetFactionId, action) {
    const current = state();
    const faction = getFaction(current, targetFactionId);
    const ownCities = playerCities(current).filter((city) => availableOfficers(current, city).length);
    if (!ownCities.length) return showToast("本月已无可出使的武将", "error");
    const relation = getRelation(current, current.playerFactionId, targetFactionId);
    const body = document.createElement("div");
    const cost = action === "alliance" ? rules.diplomacy?.allianceCost ?? 600 : rules.diplomacy?.goodwillCost ?? 300;
    body.innerHTML = `<p class="modal-description">与${esc(faction.name)}友好度 ${relation.friendliness}。${action === "alliance" ? "友好至少 45 可议盟，成功后六个月内不得互相进攻。" : "赠礼必定改善友好度，提升幅度受使者魅力影响。"}</p><div class="form-grid"><div class="field"><label>使团出发城</label><select data-source>${ownCities.map((city) => `<option value="${city.id}">${esc(city.name)} · 金 ${number(city.gold)}</option>`).join("")}</select></div><div class="field"><label>出使武将</label><select data-envoy></select></div></div><div class="result-preview">礼金 ${cost} · 消耗${commandLimitEnabled(state()) ? "一道指令及" : ""}使者本月行动。议盟失败也会消耗礼金。</div>`;
    const update = () => { body.querySelector("[data-envoy]").innerHTML = officerOptions(getCity(current, body.querySelector("[data-source]").value)); };
    body.querySelector("[data-source]").addEventListener("change", update); update();
    await actionWindow(`${faction.name} · ${action === "alliance" ? "结盟" : "亲善"}`, body, "派遣使团", () => queueTask(state(), { kind: "diplomacy", cityId: body.querySelector("[data-source]").value, officerIds: [body.querySelector("[data-envoy]").value], payload: { targetFactionId, action } }, rules), "diplomacy");
  }

  async function showJournal(title = "军府记事") {
    const current = state();
    const body = document.createElement("div");
    const status = getCampaignStatus(current);
    body.innerHTML = `<div class="journal-summary">领土 ${status.ownedCities} / ${status.totalCities} 城 · 天下尚有 ${status.rivalFactions} 方对手</div><div class="campaign-journal">${current.eventLog.map((event) => `<article><time>${event.year} 年 ${event.month} 月</time><p>${esc(event.text)}</p></article>`).join("")}</div>`;
    await openDialog({ title, content: body, confirmText: "阅毕", hideCancel: true, wide: true });
  }

  async function processPendingInvasions() {
    while (state().pendingInvasions?.some((item) => !item.resolved)) {
      const invasion = state().pendingInvasions.find((item) => !item.resolved);
      const invasionId = invasion.id;
      const latestInvasion = () => state().pendingInvasions?.find((item) => item.id === invasionId && !item.resolved);
      const enterManualDefense = async () => {
        if (typeof onManualDefense !== "function") {
          showToast("手动迎战尚未就绪，军情已保留，请重试；不会自动结算。", "error");
          return false;
        }
        try {
          const pending = latestInvasion();
          if (!pending) return true;
          const report = await onManualDefense(pending);
          if (latestInvasion()) {
            showToast(report?.message ?? "迎战尚未完成，军情已保留，可重新进入战场。", "error");
            return false;
          }
          return true;
        } catch (error) {
          console.error("无法进入手动守城战", error);
          showToast("暂时无法进入战场，军情已保留，请重试。", "error");
          return false;
        }
      };
      // A committed manual choice survives reload. Never silently change it
      // back to automatic defense or resolve the same invasion twice.
      if (["manual", "field", "siege"].includes(invasion.resolutionMode)) {
        if (!await enterManualDefense()) return false;
        continue;
      }
      const city = getCity(state(), invasion.targetId);
      if (state().playerOfficerId && !capability(state(), "government", { cityId: city.id }).ok) {
        invasion.resolutionMode = "field";
        if (!await enterManualDefense()) return false;
        continue;
      }
      const source = getCity(state(), invasion.sourceId);
      const hasDefenders = cityOfficers(state(), city).some((officer) => officer.factionId === city.factionId);
      const body = document.createElement("div");
      body.innerHTML = `<div class="invasion-banner"><span>边境急报</span><h3>${esc(city.name)}遭到进攻</h3><p>${esc(getFaction(state(), invasion.attackerFactionId).name)}由${esc(source.name)}出兵 ${number(invasion.troops)} 人。</p></div><div class="result-preview">我军 ${number(city.troops)} 兵 · 训练 ${city.training} · 士气 ${city.morale}<br>${city.wallLevel} 级城墙 · 城防度 ${city.defense}/100。野战与攻城共享钱粮，每月最多推进30日，未分胜负则下月续战。</div><div class="selection-list"><label class="selection-card"><input type="radio" name="stance" value="siege" checked><span><strong>直接守城</strong><small>直接进入攻城战，全军统一计算，每日亲自选择守城指令</small></span></label><label class="selection-card"><input type="radio" name="stance" value="field"><span><strong>出城野战</strong><small>编组部队在错格战场迟滞敌军；敌军进入主据点即转入攻城</small></span></label></div><div data-defense-composer hidden></div>`;
      if (!hasDefenders || city.troops <= 0) {
        body.querySelector('[value="field"]').disabled = true;
        body.querySelector('[value="field"]').closest("label").title = "城中无将领或无兵力，无法出城野战";
        body.querySelector('[value="field"]').closest("label").querySelector("small").textContent = "城中无将领或无兵力，无法编组野战；不生成占位人物";
      }
      const supplies = document.createElement("div");
      supplies.className = "result-preview";
      supplies.innerHTML = `攻方随军：粮 ${number(invasion.supplies?.food)} · 金 ${number(invasion.supplies?.gold)}，当前日耗 ${number(dailyFoodCost(invasion.troops, rules))}。<br>我城军需：粮 ${number(city.food)} · 金 ${number(city.gold)}，全城驻军当前日耗 ${number(dailyFoodCost(city.troops, rules))}。<br>两种模式都由你指挥。守军共用城内钱粮，断粮即败；本月 ${rules.battleDayLimit} 日结束后保留战场，下月续战，不再因期限自动击退攻方。`;
      body.append(supplies);
      const commanderList = cityOfficers(state(), city);
      const composer = hasDefenders && city.troops > 0 ? createArmyComposer({ state: state(), city, officers: commanderList, rules, defending: true,
        formations: createDefenderFormations(city, commanderList, rules, { state: state() }) }) : null;
      if (composer) body.querySelector("[data-defense-composer]").append(composer.element);
      body.querySelectorAll('input[name="stance"]').forEach((input) => input.addEventListener("change", () => {
        const confirm = body.closest(".modal")?.querySelector(".dialog-confirm");
        const field = body.querySelector('input[name="stance"]:checked').value === "field";
        body.querySelector("[data-defense-composer]").hidden = !field;
        if (confirm) confirm.textContent = field ? "进入野战" : "进入守城战";
      }));
      const result = await openDialog({ title: "军情处置", content: body, confirmText: "进入守城战", hideCancel: true, dismissible: false, wide: true,
        onConfirm: () => {
          const pending = latestInvasion();
          if (!pending) return { skipped: true };
          const mode = body.querySelector('input[name="stance"]:checked').value;
          if (typeof onManualDefense !== "function") {
            showToast("战斗入口尚未就绪，军情已保留，请重试。", "error");
            return false;
          }
          if (mode === "field") {
            const checked = composer?.validate();
            if (!checked?.ok) { showToast(checked?.message ?? "城中无可出战部队", "error"); return false; }
            return { manual: true, mode, defenderDivisions: checked.formations };
          }
          return { manual: true, mode };
        } });
      if (!result || result.skipped) continue;
      if (result.manual) {
        const pending = latestInvasion();
        if (!pending) continue;
        pending.resolutionMode = result.mode;
        if (result.defenderDivisions) pending.defenderDivisions = result.defenderDivisions;
        await onChange(`${getCity(state(), pending.targetId)?.name ?? "我城"}${result.mode === "field" ? "守军出城列阵" : "守军登城备战"}。`);
        if (!await enterManualDefense()) return false;
        continue;
      }
      await onChange(result.message);
      await openDialog({ title: "守城战报", content: `<p class="confirm-copy">${esc(result.message)}</p>`, confirmText: "阅毕", hideCancel: true });
    }
    return true;
  }

  async function showOutcome() {
    const current = state();
    const result = getCampaignStatus(current);
    if (result.status === "active" || current.outcomeAcknowledged === result.status) return;
    current.outcomeAcknowledged = result.status;
    onChange(result.status === "victory" ? "天下一统" : "势力已无立足之地");
    await openDialog({ title: result.status === "victory" ? "九州归一" : "征途落幕", content: `<div class="confirm-mark">${result.status === "victory" ? "统" : "终"}</div><p class="confirm-copy">${result.status === "victory" ? "天下城池尽归麾下，群雄之争告一段落。" : "本势力已失去全部城池。本局战报与地图仍可查阅，可从「选择剧本」重启征程。"}</p>`, confirmText: "查看天下", hideCancel: true });
  }
  return { chooseScenario, showFactions, showCity, showSearch, showEmploy, showOfficerTransfer, showDiplomacy, showJournal, processPendingInvasions, showOutcome };
}
