import { ABILITIES, playerOfficer, officerCity, growOfficer, syncPlayerIdentity } from "./character-state.js";
import { capability, playerRole } from "./capabilities.js";
import { resolveValue } from "./modifiers.js";
import { emitDomainEvent } from "./domain-events.js";
import { availableOfficers, previewDomestic, applyDomesticWork, applyRecruitment } from "./rules.js";
import { formationCapacity } from "./army.js";
import { areAllied } from "./campaign.js";
import { dailyFoodCost, grainExchangeRate } from "./economy.js";
import { cityBesieged } from "./war-state.js";
import { findFriendlyRoute } from "./routes.js";
import { acceptAssignment, creditAssignment, reportAssignment } from "./personal-assignments.js";
import { normalizeCityDefense } from "./city-defense.js";

const fail = message => ({ ok: false, message });
export const DUTIES = { agriculture: "开发农业", commerce: "开发商业", patrol: "维护治安", buildWall: "修筑城防", breedHorses: "挑选良马", craftArmor: "打造甲胄", craftCrossbows: "制作弓弩", train: "训练部队", recruit: "招募士卒" };

export function personalActionCost(state, action, rules) {
  const officer = playerOfficer(state), city = officerCity(state);
  return resolveValue(state, "personal.apCost", rules.character?.actions[action]?.cost ?? 20,
    { action, officerIds: [officer?.id], cityId: city?.id, factionId: officer?.factionId }, { round: "floor", min: 0 }).value;
}

/** Pure preview. City work shares government effect formulas, but has its own funding and AP. */
export function previewPersonalWork(state, project, rules) {
  const officer = playerOfficer(state), city = officerCity(state);
  if (!Object.hasOwn(DUTIES, project) || !officer || !city) return fail("请选择有效的建设项目");
  if (playerRole(state) === "free" || city.factionId !== officer.factionId || !city.officerIds.includes(officer.id)) return fail("须在本势力城池任职，才能开展建设或募兵");
  if (project === "recruit") {
    const amount = rules.character.actions.cityWork.recruitAmount;
    const food = amount / 100 * rules.recruit.foodPerHundred;
    const foodGold = Math.ceil(food / grainExchangeRate(state.month, rules));
    return { ok: true, title: DUTIES[project], amount, progress: amount, unit: "人", ability: "leadership",
      expense: amount / 100 * rules.recruit.goldPerHundred + foodGold,
      note: `募兵 ${amount} 人；含初始粮费 ${foodGold} 私金，不扣官粮；新兵会拉低训练并影响民心` };
  }
  const preview = previewDomestic(project, [officer], city, rules, state);
  let progress = preview.gain, remaining = preview.resource ? Infinity : Math.max(0, 100 - city[preview.targetKey]);
  if (project === "train") {
    progress += Math.min(preview.moraleGain, 100 - city.morale);
    remaining += 100 - city.morale;
  }
  if (project === "buildWall") {
    const defense = normalizeCityDefense(city);
    remaining = 100 - defense.defense + (3 - defense.wallLevel) * 100 - defense.wallProgress;
  }
  progress = Math.min(progress, remaining);
  if (!(progress > 0)) return fail("该项目已达到当前上限，无需花钱重复建设");
  if (preview.resource && (!Number.isSafeInteger((city[preview.resource] ?? 0) + preview.gain) || (city[preview.resource] ?? 0) < 0)) return fail("装备库存数量无效");
  return { ...preview, ok: true, title: DUTIES[project], progress, remaining, unit: preview.resource === "horses" ? "匹" : preview.resource ? "件" : "点",
    ability: project === "train" ? "leadership" : "politics",
    note: project === "train" ? `训练 +${preview.gain}，士气 +${Math.min(preview.moraleGain, 100 - city.morale)}`
      : project === "buildWall" ? `修复城防 +${preview.defenseGain}，筑墙进度 +${Math.min(preview.progressGain, remaining)}` : `${DUTIES[project]} +${preview.gain}` };
}

export function expeditionOptions(state, rules) {
  const city = officerCity(state), officer = playerOfficer(state);
  if (!city || !officer || playerRole(state) === "free") return [];
  return (city.adjacent ?? []).map(id => state.cities.find(c => c.id === id))
    .filter(c => c && !areAllied(state, city.factionId, c.factionId) && !cityBesieged(state, c.id));
}

/** The superior approves a limited, funded expedition. No general-purpose permission bypass is exposed to UI. */
export function buildPersonalExpedition(state, targetId, rules) {
  const city = officerCity(state), officer = playerOfficer(state);
  if (!expeditionOptions(state, rules).some(c => c.id === targetId)) return fail("本城没有通向该目标的敌对边境");
  const available = availableOfficers(state, city);
  if (!available.some(o => o.id === officer.id)) return fail("本月已有公务，无法再随军出征");
  const superior = available.filter(o => o.id !== officer.id).sort((a, b) => b.leadership - a.leadership)[0];
  // Rulers lead their own army; ordinary officers receive a separate unit under the appointed commander.
  const leaders = playerRole(state) === "ruler" || !superior ? [officer] : [superior, officer];
  let budget = Math.floor(city.troops * 0.7 / 100) * 100;
  if (budget < leaders.length * 500) return fail("城中至少须有足够兵力编成每队500人，并保留守军");
  const divisions = leaders.map((leader, index) => {
    const troops = Math.min(formationCapacity([leader], rules), Math.floor(budget / (leaders.length - index) / 100) * 100);
    budget -= troops;
    return { officerIds: [leader.id], officerId: leader.id, troops, composition: { infantry: troops }, unitType: "infantry" };
  });
  const troops = divisions.reduce((sum, d) => sum + d.troops, 0);
  const food = Math.min(dailyFoodCost(troops, rules) * 60, Math.floor(city.food * 0.75));
  if (food < dailyFoodCost(troops, rules) * 10) return fail("太守驳回：军粮不足十日，请先筹措粮草");
  if (city.gold < rules.actions.march) return fail("太守驳回：城中无法支付出征费用");
  return { ok: true, commander: leaders[0], troops, food, order: { kind: "march", cityId: city.id, officerIds: leaders.map(o => o.id),
    payload: { targetId, divisions, supplies: { food, gold: Math.min(100, city.gold - rules.actions.march) } } } };
}

/** All immediate actions and approvals transact on a draft; failed actions spend nothing. */
export function performPersonalAction(state, action, payload = {}, rules) {
  if (!state.playerOfficerId || !rules.character?.actions[action]) return fail("未知个人行动");
  const allowed = capability(state, "personal");
  if (!allowed.ok) return allowed;
  const cost = personalActionCost(state, action, rules);
  if (state.personal.ap < cost) return fail(`个人行动力不足，需要 ${cost}，请结束本月`);
  const draft = structuredClone(state), officer = playerOfficer(draft), city = officerCity(draft);
  if (!city || cityBesieged(draft, city.id)) return fail("当前身处战区，暂不能进行城内活动");
  let message, task;
  const config = rules.character.actions[action];
  if (action === "train") {
    if (!(payload.ability in ABILITIES)) return fail("请选择修习的能力");
    const xp = resolveValue(draft, "personal.growth", config.xp, { action, officerIds: [officer.id], cityId: city.id, factionId: officer.factionId }, { round: "floor" }).value;
    const gain = growOfficer(officer, payload.ability, xp);
    message = `${ABILITIES[payload.ability]}历练 +${xp}${gain ? `，能力 +${gain}` : "（每100历练提升1点）"}。`;
  } else if (action === "visit") {
    const target = draft.officers.find(o => o.id === payload.officerId);
    if (!target || target.id === officer.id || target.status === "captured" || target.battleId || !city.officerIds.includes(target.id)) return fail("拜访对象不在本城");
    officer.relationships[target.id] = Math.min(100, (officer.relationships[target.id] ?? 0) + config.relationship);
    target.relationships ??= {}; target.relationships[officer.id] = officer.relationships[target.id];
    growOfficer(officer, "charm", 10);
    message = `与${target.name}叙谈，亲善度 ${officer.relationships[target.id]}/100，魅力历练 +10。`;
  } else if (action === "work") {
    draft.personal.gold += config.gold; growOfficer(officer, "charm", 10);
    message = `在酒馆为乡民排难，获得私金 ${config.gold}，魅力历练 +10。`;
  } else if (action === "cityWork") {
    const preview = previewPersonalWork(draft, payload.project, rules);
    if (!preview.ok) return preview;
    if (draft.personal.gold < preview.expense) return fail(`私金不足，需要 ${preview.expense}，现有 ${draft.personal.gold}；可去酒馆赚钱或等待月俸`);
    draft.personal.gold -= preview.expense;
    if (payload.project === "recruit") applyRecruitment(city, preview.amount, rules);
    else applyDomesticWork(city, payload.project, preview);
    const xp = resolveValue(draft, "personal.growth", config.xp, { action, project: payload.project, officerIds: [officer.id], cityId: city.id, factionId: officer.factionId }, { round: "floor" }).value;
    growOfficer(officer, preview.ability, xp);
    creditAssignment(draft, payload.project, preview.progress);
    message = `${city.name}：${preview.note}。自付私金 ${preview.expense}，历练 +${xp}，成果即时生效。`;
  } else if (action === "report") {
    const result = reportAssignment(draft);
    if (!result.ok) return result;
    message = result.message; task = result.task;
  } else if (action === "request") {
    if (playerRole(draft) === "free" || city.factionId !== officer.factionId) return fail("须先在本城出仕，才能请领公务");
    const preview = previewPersonalWork(draft, payload.duty, rules);
    if (!preview.ok) return preview;
    const accepted = acceptAssignment(draft, payload.duty, preview, rules);
    if (!accepted.ok) return accepted;
    message = accepted.message; task = accepted.task;
  } else if (action === "travel") {
    const target = draft.cities.find(c => c.id === payload.cityId);
    if (!target || target.id === city.id || cityBesieged(draft, target.id)) return fail("无法前往该城");
    if (officer.acted) return fail("本月已有公务记录，下月再迁居");
    if (playerRole(draft) !== "free" && (target.factionId !== officer.factionId || !findFriendlyRoute(draft, city.id, target.id))) return fail("在仕时只能迁往连通的己方城池");
    if (playerRole(draft) === "free" && !city.adjacent.includes(target.id)) return fail("在野时每次前往一座相邻城池");
    if (city.governorId === officer.id) return fail("太守需先卸任，不能自行离开治所");
    city.officerIds = city.officerIds.filter(id => id !== officer.id);
    target.officerIds.push(officer.id); officer.locationCityId = target.id; draft.selectedCityId = target.id;
    message = `抵达${target.name}，可在此开展个人活动。`;
  } else if (action === "serve") {
    if (playerRole(draft) !== "free" || city.factionId === "neutral") return fail("仅在野武将可在有主城池自荐");
    officer.factionId = city.factionId; officer.status = "active"; officer.rank = "校尉"; officer.loyalty = 80;
    if (!city.officerIds.includes(officer.id)) city.officerIds.push(officer.id);
    syncPlayerIdentity(draft); message = `蒙${city.name}府署接纳，自今日起在此效力。`;
  } else return fail("尚未实现该个人行动");
  draft.personal.ap -= cost;
  draft.personal.journal.unshift(message); draft.personal.journal = draft.personal.journal.slice(0, 60);
  emitDomainEvent(draft, { id: `personal:${(draft.domainEvents?.sequence ?? 0) + 1}`, type: "personal.action", action, officerIds: [officer.id], cost });
  Object.assign(state, draft);
  return { ok: true, message, task };
}
