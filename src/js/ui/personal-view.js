import { ABILITIES, playerOfficer, officerCity } from "../game/character-state.js";
import { ROLE_LABELS, playerRole, capability } from "../game/capabilities.js";
import { DUTIES, personalActionCost, performPersonalAction, previewPersonalWork } from "../game/personal.js";
import { currentAssignment } from "../game/personal-assignments.js";
import { escapeHtml as esc, openDialog, showToast } from "./components.js";

export function createPersonalUI({ getState, rules, themes, bios, onChange, onCouncil, onMonth, onProfile }) {
  const root = document.querySelector("#personal-screen");
  const cost = action => personalActionCost(getState(), action, rules);
  function render() {
    const state = getState(), officer = playerOfficer(state);
    if (!officer) return;
    const city = officerCity(state), theme = themes.themes[themes.regionThemes[city?.region] ?? "central"];
    root.style.setProperty("--personal-scene", `url("${new URL(theme.image, document.baseURI).href}")`);
    const active = (state.tasks ?? []).filter(t => t.officerIds.includes(officer.id) && ["running", "in_battle", "awaiting_battle"].includes(t.status));
    const assignment = currentAssignment(state);
    const placeButton = place => `<button data-place="${esc(place.id)}" title="${esc(place.note)}${place.projects ? ` · 自付私金 · ${cost("cityWork")} 行动力` : ""}"><span aria-hidden="true">${esc(place.glyph)}</span><b>${esc(place.name)}</b><small aria-hidden="true">›</small></button>`;
    const civicPlaces = rules.character.locations.filter(place => place.projects || place.id === "council");
    const lifePlaces = rules.character.locations.filter(place => ["home", "visit", "tavern"].includes(place.id));
    root.innerHTML = `<div class="personal-vignette"></div><div class="personal-date"><span>${state.year}年 · ${state.month}月</span><h2>${esc(city?.name ?? "旅途")}</h2></div>
      <aside class="personal-card personal-profile" aria-label="主角概况"><div class="personal-identity"><div class="personal-monogram" aria-label="头像预留">${esc(officer.name.slice(-1))}</div><div><h2>${esc(officer.name)}<small>${esc(ROLE_LABELS[playerRole(state)])}</small></h2><p>${esc(state.factions.find(f => f.id === officer.factionId)?.name ?? "在野")} · ${esc(officer.rank ?? "未仕")}</p></div></div>
      <div class="personal-ledger"><span>行动力 <b>${state.personal.ap}<small>/${rules.character.monthlyAP}</small></b></span><span>私金 <b>${state.personal.gold}</b></span></div>
      <div class="personal-profile-links"><button class="btn" data-place="profile">列传与能力</button><button class="btn" data-place="skills">技艺 · 宝物</button></div></aside>
      <nav class="personal-locations personal-civic" aria-label="城务地点"><h3>城中设施</h3>${civicPlaces.map(placeButton).join("")}</nav>
      <nav class="personal-locations personal-life" aria-label="生活地点"><h3>起居交游</h3>${lifePlaces.map(placeButton).join("")}</nav>
      <aside class="personal-card personal-duty-summary" aria-label="当前公务"><h3>在办公务</h3>${assignment ? `<p class="personal-duty"><b>${esc(assignment.title)}</b><span>${esc(state.cities.find(c => c.id === assignment.cityId)?.name)} · ${assignment.progress}/${assignment.target}${esc(assignment.unit)}</span><span>${assignment.status === "ready" ? "已达标 · 请往议政厅复命" : `期限还余 ${Math.max(0, assignment.deadlineTurn - state.elapsedMonths)} 个月（含本月）`}</span></p>` : ""}${active.map(t => `<p class="personal-duty"><b>${esc(t.title)}</b><span>${t.status === "running" ? "已领命 · 月末执行" : "随军出征中"}</span></p>`).join("") || (!assignment ? '<p class="muted">暂无公务 · 可至议政厅请领</p>' : "")}</aside>
      <div class="personal-bottom-right"><button class="btn" data-place="travel">驿站 <small>外出赴任</small></button><button class="btn btn-primary" data-place="month">待命 <small>结束本月</small></button></div>`;
    root.querySelectorAll("[data-place]").forEach(button => button.addEventListener("click", () => openPlace(button.dataset.place)));
  }
  function commit(action, payload) {
    const result = performPersonalAction(getState(), action, payload, rules);
    if (!result.ok) { showToast(result.message, "error"); return false; }
    onChange(result.message); return true;
  }
  async function chooseAction(title, action, options, key, description) {
    const body = document.createElement("div");
    const blocked = capability(getState(), "personal");
    const firstAvailable = options.find(o => !o.disabled)?.id;
    body.innerHTML = `<p class="modal-description">${esc(description)}<br>消耗个人行动力 ${cost(action)}，当前 ${getState().personal.ap}；私金 ${getState().personal.gold}。${!blocked.ok ? esc(blocked.reason) : ""}</p><div class="selection-list">${options.map(o => `<label class="selection-card"><input type="radio" name="personal-choice" value="${esc(o.id)}" ${o.id === firstAvailable ? "checked" : ""} ${o.disabled ? "disabled" : ""}><span><strong>${esc(o.name)}</strong><small>${esc(o.note ?? "")}</small></span></label>`).join("") || "<p>当前没有符合条件的对象，可迁往其他城池或下月再来。</p>"}</div>`;
    await openDialog({ title, content: body, confirmText: "执行", onConfirm: () => {
      const id = body.querySelector("input:checked")?.value;
      if (!id) { showToast("当前没有可选对象", "error"); return false; }
      return commit(action, { [key]: id });
    } });
  }
  async function requestDuty() {
    const state = getState(), task = currentAssignment(state), config = rules.character.assignment;
    if (task) return openDialog({ title: "议政厅 · 公务复命", content: `<p>${esc(task.title)} · ${esc(state.cities.find(c => c.id === task.cityId)?.name)}</p><div class="result-preview">亲自完成 ${task.progress}/${task.target}${esc(task.unit)}<br>${task.status === "ready" ? "已达目标，可复命领取" : `还余 ${Math.max(0, task.deadlineTurn - state.elapsedMonths)} 个月（含本月），请前往对应地点干活`}<br>赏私金 ${task.reward} · 功勋 ${task.merit} · 历练 ${task.xp}</div><p>只计你领命后在指定城池亲自执行的建设，不计AI或他人政令成果。</p>`,
      confirmText: task.status === "ready" ? "复命领赏" : "继续办事", hideCancel: task.status !== "ready", onConfirm: () => task.status === "ready" ? commit("report", {}) : true });
    return chooseAction("议政厅 · 请领限期公务", "request", Object.entries(DUTIES).map(([id, name]) => {
      const preview = previewPersonalWork(state, id, rules);
      const target = preview.ok ? Math.min(preview.progress * config.workBatches, preview.remaining ?? Infinity) : 0;
      const reward = preview.ok ? Math.ceil(preview.expense * target / preview.progress) + config.rewardBonus : 0;
      return { id, name, disabled: !preview.ok, note: preview.ok ? `${config.durationMonths} 个月内亲自完成 ${target}${preview.unit}；每次自付 ${preview.expense} 私金，复命赏 ${reward}` : preview.message };
    }), "duty", "先立工作目标，再到对应地点花私金与行动力干活。城库预留赏金；达标回本城议政厅复命。逾期未完成则不领奖，已做建设保留。");
  }
  async function showJournal() {
    const state = getState();
    return openDialog({ title: "近日行止", content: `<ol class="personal-journal-entries">${(state.personal?.journal ?? []).map(entry => `<li>${esc(entry)}</li>`).join("") || "<li>初入乱世，尚无记录。</li>"}</ol>`, hideCancel: true, confirmText: "合卷" });
  }
  async function showSkills() {
    const officer = playerOfficer(getState()), body = document.createElement("div");
    body.className = "character-skills";
    body.innerHTML = `<p class="modal-description">${esc(officer.name)} · 48项常规技艺＋2项隐藏技艺。此轮仅建立档案与展示，所有技能效果尚未启用；不会以占位技能解锁兵种。</p><div class="skill-atlas">${rules.character.skillGroups.map(group => `<section><h3>${esc(group.name)}</h3><div>${group.names.map((name, index) => {
      const id = `${group.id}.${index + 1}`;
      return `<button data-skill="${id}" class="${officer.skills.includes(id) ? "learned" : ""}" title="尚未接入效果">${esc(name)}<small>${officer.skills.includes(id) ? "已记录" : "预留"}</small></button>`;
    }).join("")}</div></section>`).join("")}</div><div class="result-preview" data-skill-detail>选择一项技艺查看档案。</div><h3>宝物簿 · 持有即生效</h3><p>接口约定：无需装备，同类修正取最高。当前尚无可获得的宝物，不虚构加成。</p>${(officer.treasures ?? []).map(t => `<p>${esc(t.name ?? t.id)}</p>`).join("") || '<p class="muted">未持有宝物</p>'}<h3>人物档案</h3><p>生年：${officer.birthYear ?? "未考"}　卒年：${officer.deathYear ?? "未考"}　历史死因：${esc(officer.historicalDeathCause ?? "待考")}</p><p>历史卒年不触发死亡。状态：${officer.conditions.length ? officer.conditions.map(c => esc(c.name ?? c.id)).join("、") : "无异常"}。</p>`;
    body.insertBefore(body.querySelector("[data-skill-detail]"), body.querySelector(".skill-atlas"));
    body.querySelectorAll("[data-skill]").forEach(button => button.addEventListener("click", () => {
      body.querySelectorAll("[data-skill]").forEach(b => b.classList.toggle("selected", b === button));
      const intended = rules.character.skillDescriptions?.[button.dataset.skill] ?? "个人技艺，待对应系统确定名称或机制。";
      body.querySelector("[data-skill-detail]").textContent = `${button.firstChild.textContent} · ${intended}（设计预留，尚未生效）`;
    }));
    return openDialog({ title: "人物 · 技艺与宝物", content: body, wide: true, hideCancel: true, confirmText: "阅毕" });
  }
  async function openPlace(place) {
    const state = getState(), officer = playerOfficer(state), city = officerCity(state);
    if (place === "month") return onMonth();
    if (place === "council") return onCouncil();
    if (place === "profile") return onProfile(officer);
    if (place === "skills") return showSkills();
    if (place === "home") return chooseAction("自宅 · 研习修行", "train", Object.entries(ABILITIES).map(([id, name]) => ({ id, name, note: `当前 ${officer[id]} · 历练 ${officer.growth[id]}/100；本次基础历练 +30` })), "ability", "修习即时生效。每积累100历练提升1点能力，最高100。");
    if (place === "visit") return chooseAction("友宅 · 登门访友", "visit", state.officers.filter(o => o.id !== officer.id && city.officerIds.includes(o.id) && !o.battleId && o.status !== "captured").map(o => ({ id: o.id, name: o.name, note: `亲善度 ${officer.relationships[o.id] ?? 0}/100` })), "officerId", "增进亲善并积累魅力历练。关系暂不影响指挥权与技能效果。");
    if (place === "tavern") return chooseAction("酒馆 · 排难解忧", "work", [{ id: "work", name: "为乡民排解纷争", note: "私金 +40 · 魅力历练 +10" }], "choice", "在市井中磨练言辞，并赚取少量私金。");
    const location = rules.character.locations.find(location => location.id === place);
    if (location?.projects) return chooseAction(`${location.name} · 自费助建`, "cityWork", location.projects.map(id => {
      const preview = previewPersonalWork(state, id, rules);
      return { id, name: DUTIES[id], disabled: !preview.ok, note: preview.ok ? `${preview.note}；自付 ${preview.expense} 私金` : preview.message };
    }), "project", "主角亲自出钱干活，收益即刻归本城，不扣官库钱粮，不占用政令与武将公务次数。个人行动力允许时可重复执行；出征请去议政厅。");
    if (place === "travel") {
      if (playerRole(state) === "free" && city.factionId !== "neutral") {
        const choice = await openDialog({ title: "驿站 · 去留", content: "在此城自荐出仕，或继续游历。", confirmText: "自荐出仕", cancelText: "继续游历", onConfirm: () => commit("serve", {}) });
        if (choice) return;
      }
      return chooseAction("驿站 · 迁居赴任", "travel", state.cities.filter(c => c.id !== city.id && (playerRole(state) === "free" ? city.adjacent.includes(c.id) : c.factionId === officer.factionId)).map(c => ({ id: c.id, name: c.name })), "cityId", "在仕只能前往连通的己方城池，在野可前往相邻城市。太守不可擅离治所。");
    }
  }
  return { render, requestDuty, showJournal, showSkills };
}
