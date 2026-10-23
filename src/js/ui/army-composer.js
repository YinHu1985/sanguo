import { aggregateAbilities, armyLimits, createDefenderFormations, formationCapacity, formationOfficerIds } from "../game/army.js";
import { escapeHtml as esc, number } from "./components.js";
import { casualtyExposure, compositionEquipment, equipmentAvailable, EQUIPMENT_KEYS, EQUIPMENT_NAMES, formationComposition, primaryTroopType, resizeComposition, sumEquipment, troopTypes, unitTypeAvailability, validateComposition } from "../game/troops.js";
import { calculateCombatStats } from "../game/combat-stats.js";

/** Reused by departure and defense: soldiers belong to formations, never officers. */
export function createArmyComposer({ state, city, officers, rules, formations, defending = false, onChange = () => {} }) {
  const limits = armyLimits(rules);
  const element = document.createElement("section");
  element.className = "army-composer";
  const assignment = new Map();
  const commanders = new Map();
  const groups = Array.from({ length: limits.maxUnits }, (_, index) => ({ id: `formation-${index + 1}`, troops: 0, unitType: "infantry", composition: {} }));
  const context = (members) => ({ state, factionId: city.factionId, officers: members, rules });
  const members = (index) => {
    const chosen = officers.filter((officer) => assignment.get(officer.id) === index);
    const commander = chosen.find((officer) => officer.id === commanders.get(index)) ?? chosen[0];
    return commander ? [commander, ...chosen.filter((officer) => officer.id !== commander.id)] : [];
  };
  function apply(formations) {
    assignment.clear();
    commanders.clear();
    groups.forEach((group) => { group.troops = 0; group.unitType = "infantry"; group.composition = {}; });
    formations.slice(0, limits.maxUnits).forEach((formation, index) => {
      const ids = formationOfficerIds(formation).filter((id) => officers.some((officer) => officer.id === id));
      ids.forEach((id) => assignment.set(id, index));
      if (ids.length) commanders.set(index, ids[0]);
      groups[index].troops = Number(formation.troops) || 0;
      groups[index].unitType = formation.unitType ?? "infantry";
      groups[index].composition = formationComposition(formation, rules);
    });
  }
  const getFormations = () => groups.flatMap((group, index) => {
    const chosen = members(index);
    return chosen.length ? [{ ...group, composition: { ...group.composition }, unitType: primaryTroopType(group.composition), name: `第${index + 1}部队`, officerIds: chosen.map((officer) => officer.id), officerId: chosen[0].id }] : [];
  });
  const totalTroops = () => getFormations().reduce((sum, formation) => sum + formation.troops, 0);
  function validate() {
    const formations = getFormations();
    if (!formations.length) return { ok: false, message: "请至少编成一支有将领的部队" };
    if (formations.some((formation) => formation.officerIds.length > limits.maxOfficersPerUnit)) return { ok: false, message: `每支部队最多 ${limits.maxOfficersPerUnit} 位将领` };
    if (formations.some((formation) => !Number.isSafeInteger(formation.troops) || formation.troops < (defending ? 1 : 500)
      || formation.troops > formationCapacity(formation.officerIds.map((id) => officers.find((officer) => officer.id === id)), rules))) {
      return { ok: false, message: defending ? "各部队兵力须为正整数，且不能超过主将官职兵额" : "各部队至少 500 兵，不能超过主将官职兵额；副将不增加兵额" };
    }
    if (totalTroops() > city.troops) return { ok: false, message: "编成总兵力超过本城驻军" };
    for (const formation of formations) {
      const checked = validateComposition(formation, context(formation.officerIds.map((id) => officers.find((officer) => officer.id === id))));
      if (!checked.ok) return checked;
    }
    if (!equipmentAvailable(city, sumEquipment(formations, rules))) return { ok: false, message: "全军编成所需装备超过本城库存" };
    return { ok: true, formations };
  }
  function setCommander(index, officerId) {
    if (!Number.isInteger(index) || !groups[index] || assignment.get(officerId) !== index) return false;
    commanders.set(index, officerId);
    groups[index].troops = Math.min(groups[index].troops, formationCapacity(members(index), rules));
    groups[index].composition = resizeComposition(groups[index].composition, groups[index].troops);
    render(true);
    return true;
  }
  function autoForm() {
    const pool = defending ? city.troops : Math.floor(city.troops / 100) * 100;
    const formations = createDefenderFormations({ ...city, troops: pool, officerIds: officers.map((officer) => officer.id) }, officers, rules,
      { state, minTroops: defending ? 1 : 500 }).filter((formation) => formation.officerIds.length && (defending || formation.troops >= 500));
    if (!defending) formations.forEach((formation) => {
      formation.troops = Math.floor(formation.troops / 100) * 100;
      formation.composition = resizeComposition(formation.composition, formation.troops);
    });
    return formations;
  }
  function summary() {
    const count = getFormations().length;
    const total = totalTroops();
    const equipment = sumEquipment(getFormations(), rules);
    element.querySelector("[data-formation-summary]").innerHTML = `战场单位 <strong>${count} / ${limits.maxUnits}</strong> · 编入 <strong>${number(total)}</strong> / ${number(city.troops)} 兵 · ${defending ? "城内预备" : "留守"} ${number(Math.max(0, city.troops - total))}<br><small>面板已计入将领、训练和士气修正，与战场使用同一套计算。火力按各兵种人数加总，防护、机动与视野按人数加权；少量射手也可射击，加入步兵不会稀释射手火力。<br>伤亡按「剩余人数 × 暴露系数」分摊；近战偏向步兵，远程偏向较弱，火攻默认按人数分摊。暴露系数不是额外伤害倍率。装备随对应兵种的实际损失消耗，幸存装备随军归库。</small><div class="equipment-budget">${EQUIPMENT_KEYS.map((key) => `<span class="${equipment[key] > (city[key] ?? 0) ? "economy-warning" : ""}">${EQUIPMENT_NAMES[key]} ${number(equipment[key])} / ${number(city[key] ?? 0)}</span>`).join(" · ")}</div>${total > city.troops ? '<strong class="economy-warning">兵力超出本城储备</strong>' : ""}`;
    groups.forEach((group, index) => {
      const node = element.querySelector(`[data-mix-stats="${index}"]`);
      if (!node) return;
      const stats = calculateCombatStats({ ...group, officers: members(index), training: city.training, morale: city.morale }, rules);
      node.innerHTML = `总兵力 ${number(group.troops)} / ${number(formationCapacity(members(index), rules))}<br>肉搏火力 ${number(Math.round(stats.meleeAttack))} · 肉搏防护 ${stats.meleeDefense.toFixed(2)}<br>远程火力 ${number(Math.round(stats.rangedAttack))} · 远程防护 ${stats.rangedDefense.toFixed(2)}<br>行动力 ${stats.actionPoints} · 视野 ${stats.vision} 格${stats.rangedTroops ? ` · 射手 ${number(stats.rangedTroops)} · 射程 ${stats.range}` : " · 无远程能力"}`;
    });
  }
  function render(notify = false) {
    element.innerHTML = `<div class="composer-heading"><p>最多 ${limits.maxUnits} 支部队，每队最多 ${limits.maxOfficersPerUnit} 将。仅主将决定兵额，副将只提供综合能力。自动编组优先选择指挥上限较高的主将。</p><button type="button" class="btn" data-auto-form>自动编组</button></div>
      <div class="composer-officers"><table class="data-table"><thead><tr><th>将领 / 职位</th><th>统 / 武 / 智</th><th>任主将兵额</th><th>编入部队</th></tr></thead><tbody>${officers.map((officer) => `<tr><td>${esc(officer.name)}<small>${esc(officer.rank)}</small></td><td>${officer.leadership} / ${officer.war} / ${officer.intelligence}</td><td>${number(formationCapacity([officer], rules))}</td><td><select aria-label="${esc(officer.name)}编入部队" data-assign="${esc(officer.id)}"><option value="">${defending ? "留守城内" : "不出征"}</option>${groups.map((_, index) => `<option value="${index}" ${assignment.get(officer.id) === index ? "selected" : members(index).length >= limits.maxOfficersPerUnit ? "disabled" : ""}>第${index + 1}部队</option>`).join("")}</select></td></tr>`).join("")}</tbody></table></div>
      <div class="formation-cards">${groups.map((group, index) => {
        const chosen = members(index);
        if (!chosen.length) return "";
        const abilities = aggregateAbilities(chosen);
        const capacity = formationCapacity(chosen, rules);
        return `<article class="formation-card"><header><strong>第${index + 1}部队</strong><span>${chosen.length} / ${limits.maxOfficersPerUnit} 将</span></header><div class="field"><label for="formation-commander-${index}">主将 · 决定本队兵额</label><select id="formation-commander-${index}" data-commander="${index}">${chosen.map((officer) => `<option value="${esc(officer.id)}" ${officer.id === chosen[0].id ? "selected" : ""}>${esc(officer.name)} · ${esc(officer.rank)} · ${number(formationCapacity([officer], rules))} 兵</option>`).join("")}</select></div><p>副将：${chosen.slice(1).map((officer) => esc(officer.name)).join(" · ") || "无"}</p><small>改任兵额较低的主将会缩减编入兵力，多余兵员留在城内。</small><div class="formation-stats">统 ${abilities.leadership}　武 ${abilities.war}　智 ${abilities.intelligence}　政 ${abilities.politics}　魅 ${abilities.charm}</div><div class="formation-derived-stats" data-mix-stats="${index}"></div><table class="data-table troop-mix-table"><thead><tr><th>兵种</th><th>所需装备 / 每兵</th><th>编入人数</th></tr></thead><tbody>${Object.entries(troopTypes(rules)).map(([id, type]) => {
          const unlocked = unitTypeAvailability(id, context(chosen));
          const equipment = compositionEquipment({ [id]: 1 }, rules);
          return `<tr class="${unlocked.available ? "" : "troop-locked"}"><td>${esc(type.name)}${unlocked.available ? (type.range ? '<small>可射击</small>' : "") : '<small>尚未解锁</small>'}<small class="troop-exposure" title="伤亡分摊权重为剩余人数乘以暴露系数，并非额外伤害倍率">暴露：近 ${casualtyExposure(id, rules, "melee")} / 远 ${casualtyExposure(id, rules, "ranged")}</small></td><td>${EQUIPMENT_KEYS.filter((key) => equipment[key]).map((key) => EQUIPMENT_NAMES[key]).join("、") || "无需装备"}</td><td><input type="number" aria-label="第${index + 1}部队${esc(type.name)}人数" data-group-composition="${index}" data-troop-type="${id}" min="0" max="${capacity}" step="1" value="${group.composition[id] ?? 0}" ${unlocked.available ? "" : `disabled title="${esc(unlocked.reason)}"`}></td></tr>`;
        }).join("")}</tbody></table></article>`;
      }).join("")}</div><div class="result-preview" data-formation-summary></div>`;
    element.querySelectorAll("[data-assign]").forEach((select) => select.addEventListener("change", () => {
      const old = assignment.get(select.dataset.assign);
      const next = select.value === "" ? undefined : Number(select.value);
      if (next !== undefined && next !== old && members(next).length >= limits.maxOfficersPerUnit) { render(); return; }
      if (next === undefined) assignment.delete(select.dataset.assign);
      else assignment.set(select.dataset.assign, next);
      for (const index of [old, next].filter((value) => value !== undefined)) {
        const cap = formationCapacity(members(index), rules);
        groups[index].troops = Math.min(cap, groups[index].troops || Math.min(2000, Math.max(0, city.troops - totalTroops())));
        groups[index].composition = resizeComposition(groups[index].composition, groups[index].troops);
      }
      render(true);
    }));
    element.querySelectorAll("[data-commander]").forEach((select) => select.addEventListener("change", () => setCommander(Number(select.dataset.commander), select.value)));
    element.querySelectorAll("[data-group-composition]").forEach((input) => input.addEventListener("input", () => {
      const group = groups[Number(input.dataset.groupComposition)];
      group.composition[input.dataset.troopType] = Number(input.value);
      group.troops = Object.values(group.composition).reduce((sum, value) => sum + value, 0);
      summary(); onChange();
    }));
    element.querySelector("[data-auto-form]").addEventListener("click", () => {
      apply(autoForm());
      render(true);
    });
    summary();
    if (notify) onChange();
  }
  apply(formations ?? autoForm());
  render();
  return { element, getFormations, totalTroops, validate, setCommander };
}
