import { aggregateAbilities, armyLimits, createDefenderFormations, formationCapacity, formationOfficerIds } from "../game/army.js";
import { escapeHtml as esc, number } from "./components.js";

/** Reused by departure and defense: soldiers belong to formations, never officers. */
export function createArmyComposer({ city, officers, rules, formations = [], defending = false, onChange = () => {} }) {
  const limits = armyLimits(rules);
  const element = document.createElement("section");
  element.className = "army-composer";
  const assignment = new Map();
  const groups = Array.from({ length: limits.maxUnits }, (_, index) => ({ id: `formation-${index + 1}`, troops: 0, unitType: "infantry" }));
  const members = (index) => officers.filter((officer) => assignment.get(officer.id) === index);
  function apply(formations) {
    assignment.clear();
    groups.forEach((group) => { group.troops = 0; group.unitType = "infantry"; });
    formations.slice(0, limits.maxUnits).forEach((formation, index) => {
      formationOfficerIds(formation).forEach((id) => { if (officers.some((officer) => officer.id === id)) assignment.set(id, index); });
      groups[index].troops = Number(formation.troops) || 0;
      groups[index].unitType = formation.unitType ?? "infantry";
    });
  }
  const getFormations = () => groups.flatMap((group, index) => {
    const chosen = members(index);
    return chosen.length ? [{ ...group, name: `第${index + 1}部队`, officerIds: chosen.map((officer) => officer.id) }] : [];
  });
  const totalTroops = () => getFormations().reduce((sum, formation) => sum + formation.troops, 0);
  function validate() {
    const formations = getFormations();
    if (!formations.length) return { ok: false, message: "请至少编成一支有将领的部队" };
    if (formations.some((formation) => formation.officerIds.length > limits.maxOfficersPerUnit)) return { ok: false, message: `每支部队最多 ${limits.maxOfficersPerUnit} 位将领` };
    if (formations.some((formation) => !Number.isSafeInteger(formation.troops) || formation.troops < (defending ? 1 : 500)
      || (!defending && formation.troops % 100 !== 0)
      || formation.troops > formationCapacity(officers.filter((officer) => formation.officerIds.includes(officer.id)), rules))) {
      return { ok: false, message: defending ? "各部队兵力须为正整数，且不能超过所属将领合计上限" : "各部队至少 500 兵，以百人为单位，不能超过将领合计上限" };
    }
    if (totalTroops() > city.troops) return { ok: false, message: "编成总兵力超过本城驻军" };
    return { ok: true, formations };
  }
  function summary() {
    const count = getFormations().length;
    const total = totalTroops();
    element.querySelector("[data-formation-summary]").innerHTML = `战场单位 <strong>${count} / ${limits.maxUnits}</strong> · 编入 <strong>${number(total)}</strong> / ${number(city.troops)} 兵 · ${defending ? "城内预备" : "留守"} ${number(Math.max(0, city.troops - total))}<br><small>每队独立兵力；能力分别取所属将领最高值，带兵上限为职位兵额之和。</small>${total > city.troops ? '<strong class="economy-warning">兵力超出本城储备</strong>' : ""}`;
  }
  function render(notify = false) {
    element.innerHTML = `<div class="composer-heading"><p>最多 ${limits.maxUnits} 支部队，每队最多 ${limits.maxOfficersPerUnit} 将。把多名将领编入同一队，即在地图上显示为一个单位。</p><button type="button" class="btn" data-auto-form>自动编组</button></div>
      <div class="composer-officers"><table class="data-table"><thead><tr><th>将领 / 职位</th><th>统 / 武 / 智</th><th>贡献兵额</th><th>编入部队</th></tr></thead><tbody>${officers.map((officer) => `<tr><td>${esc(officer.name)}<small>${esc(officer.rank)}</small></td><td>${officer.leadership} / ${officer.war} / ${officer.intelligence}</td><td>${number(formationCapacity([officer], rules))}</td><td><select aria-label="${esc(officer.name)}编入部队" data-assign="${esc(officer.id)}"><option value="">${defending ? "留守城内" : "不出征"}</option>${groups.map((_, index) => `<option value="${index}" ${assignment.get(officer.id) === index ? "selected" : ""}>第${index + 1}部队</option>`).join("")}</select></td></tr>`).join("")}</tbody></table></div>
      <div class="formation-cards">${groups.map((group, index) => {
        const chosen = members(index);
        if (!chosen.length) return "";
        const abilities = aggregateAbilities(chosen);
        const capacity = formationCapacity(chosen, rules);
        return `<article class="formation-card"><header><strong>第${index + 1}部队</strong><span>${chosen.length} / ${limits.maxOfficersPerUnit} 将</span></header><p>${chosen.map((officer) => esc(officer.name)).join(" · ")}</p><div class="formation-stats">统 ${abilities.leadership}　武 ${abilities.war}　智 ${abilities.intelligence}　政 ${abilities.politics}　魅 ${abilities.charm}</div><div class="form-grid"><div class="field"><label>整队兵力 / 上限 ${number(capacity)}</label><input type="number" aria-label="第${index + 1}部队兵力" data-group-troops="${index}" min="${defending ? 1 : 500}" max="${capacity}" step="${defending ? 1 : 100}" value="${group.troops}"></div><div class="field"><label>部队兵种</label><select aria-label="第${index + 1}部队兵种" data-group-type="${index}">${[["infantry","步兵"],["cavalry","骑兵"],["archer","弓兵"]].map(([id,name])=>`<option value="${id}" ${group.unitType === id ? "selected" : ""}>${name}</option>`).join("")}</select></div></div></article>`;
      }).join("")}</div><div class="result-preview" data-formation-summary></div>`;
    element.querySelectorAll("[data-assign]").forEach((select) => select.addEventListener("change", () => {
      const old = assignment.get(select.dataset.assign);
      const next = select.value === "" ? undefined : Number(select.value);
      if (next === undefined) assignment.delete(select.dataset.assign);
      else assignment.set(select.dataset.assign, next);
      for (const index of [old, next].filter((value) => value !== undefined)) {
        const cap = formationCapacity(members(index), rules);
        groups[index].troops = Math.min(cap, groups[index].troops || Math.min(2000, Math.max(0, city.troops - totalTroops())));
      }
      render(true);
    }));
    element.querySelectorAll("[data-group-troops]").forEach((input) => input.addEventListener("input", () => { groups[Number(input.dataset.groupTroops)].troops = Number(input.value); summary(); onChange(); }));
    element.querySelectorAll("[data-group-type]").forEach((select) => select.addEventListener("change", () => { groups[Number(select.dataset.groupType)].unitType = select.value; onChange(); }));
    element.querySelector("[data-auto-form]").addEventListener("click", () => {
      const pool = defending ? city.troops : Math.floor(city.troops / 100) * 100;
      apply(createDefenderFormations({ ...city, troops: pool, officerIds: officers.map((officer) => officer.id) }, officers, rules)
        .filter((formation) => defending || formation.troops >= 500));
      if (!defending) groups.forEach((group) => { group.troops = Math.floor(group.troops / 100) * 100; });
      render(true);
    });
    summary();
    if (notify) onChange();
  }
  apply(formations);
  render();
  return { element, getFormations, totalTroops, validate };
}
