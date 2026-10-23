import { addEvent } from "./state.js";
import { NEUTRAL_FACTION_ID } from "./atlas.js";
import { areAllied } from "./campaign.js";
import { applyAnnualHarvest, settleMonthlyEconomy, dailyFoodCost } from "./economy.js";
import { findFriendlyRoute } from "./routes.js";
import { armyLimits, formationOfficerIds, formationCapacity, normalizeFormations } from "./army.js";
import { normalizeCityDefense, applyWallDevelopment } from "./city-defense.js";
import { EQUIPMENT_KEYS, EQUIPMENT_NAMES } from "./equipment.js";
import { advanceResearch } from "./technology.js";
import { validateComposition, sumEquipment, equipmentAvailable, primaryTroopType } from "./troops.js";
import { cityBesieged, officerAtWar, restoreWarLocks } from "./war-state.js";
import { canIssueCommand, consumeCommand } from "./commands.js";
export { canIssueCommand } from "./commands.js";

export const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));

export function getCity(state, cityId) {
  return state.cities.find((city) => city.id === cityId);
}

export function getOfficer(state, officerId) {
  return state.officers.find((officer) => officer.id === officerId);
}

export function getFaction(state, factionId) {
  return state.factions.find((faction) => faction.id === factionId);
}

export function playerCities(state) {
  return state.cities.filter((city) => city.factionId === state.playerFactionId);
}

export function cityOfficers(state, city) {
  return city.officerIds.map((id) => getOfficer(state, id)).filter((officer) => officer && officer.status !== "free" && officer.status !== "captured");
}

export function availableOfficers(state, city) {
  if (cityBesieged(state, city.id)) return [];
  return cityOfficers(state, city).filter((officer) => !officer.acted && !officer.taskId && !officerAtWar(state, officer.id));
}

export function previewDomestic(action, officers, city, rules) {
  const config = rules.development[action];
  if (!config || officers.length === 0) return { gain: 0, expense: 0 };
  const totalStat = officers.reduce((sum, officer) => sum + officer[config.stat], 0);
  const teamwork = Math.max(0, officers.length - 1) * 2;
  const varianceFreeGain = config.base * (config.resource ? officers.length : 1)
    + Math.floor(totalStat / (config.statDivisor ?? 16)) + teamwork;
  if (EQUIPMENT_KEYS.includes(config.resource)) {
    return { gain: varianceFreeGain, expense: config.expense * officers.length, targetKey: config.resource, resource: config.resource };
  }
  if (action === "buildWall") {
    const projected = { ...city, ...normalizeCityDefense(city) };
    const wall = applyWallDevelopment(projected, varianceFreeGain);
    return { gain: wall.defenseGain + wall.progressGain, expense: config.expense * officers.length,
      targetKey: "defense", work: varianceFreeGain, ...wall };
  }
  const targetKey = action === "patrol" ? "popularSupport" : action === "train" ? "training" : action;
  return {
    gain: Math.min(varianceFreeGain, 100 - city[targetKey]),
    moraleGain: action === "train" ? Math.max(1, Math.floor(varianceFreeGain / 3)) : 0,
    expense: config.expense * officers.length,
    targetKey
  };
}

export function executeDomestic(state, cityId, action, officerIds, rules) {
  if (cityBesieged(state, cityId) || officerIds.some((id) => officerAtWar(state, id))) return { ok: false, message: "城池或将领正在持续战役中" };
  if (!canIssueCommand(state)) return { ok: false, message: "本月指令已用尽" };
  if (!rules.development[action]) return { ok: false, message: "无此内政指令" };
  const city = getCity(state, cityId);
  if (!city || city.factionId !== state.playerFactionId) return { ok: false, message: "只能治理本势力城池" };
  const uniqueIds = [...new Set(officerIds)];
  const officers = uniqueIds.map((id) => getOfficer(state, id)).filter(Boolean);
  const valid = officers.length > 0 && officers.length <= rules.maxDomesticOfficers && officers.every((officer) => city.officerIds.includes(officer.id) && !officer.acted && !officer.taskId
    && officer.factionId === city.factionId && !["free", "captured"].includes(officer.status) && (!officer.locationCityId || officer.locationCityId === city.id));
  if (!valid) return { ok: false, message: "武将选择无效，或有人本月已经行动" };
  const preview = previewDomestic(action, officers, city, rules);
  if (action === "buildWall" && preview.gain === 0) return { ok: false, message: "城墙已达三级且城防完好，无需修筑" };
  if (city.gold < preview.expense) return { ok: false, message: `金不足，至少需要 ${preview.expense}` };
  if (preview.resource && (!Number.isSafeInteger(city[preview.resource] ?? 0) || (city[preview.resource] ?? 0) < 0
    || !Number.isSafeInteger((city[preview.resource] ?? 0) + preview.gain))) return { ok: false, message: "装备库存或生产数量无效" };

  city.gold -= preview.expense;
  if (action === "buildWall") applyWallDevelopment(city, preview.work);
  else if (preview.resource) city[preview.resource] = (city[preview.resource] ?? 0) + preview.gain;
  else city[preview.targetKey] = clamp(city[preview.targetKey] + preview.gain);
  if (action === "train") city.morale = clamp(city.morale + preview.moraleGain);
  officers.forEach((officer) => {
    officer.acted = true;
    officer.merit = (officer.merit ?? 0) + 25 + (preview.resource ? Math.floor(preview.gain / 50) : preview.gain);
  });
  consumeCommand(state);

  const names = officers.map((officer) => officer.name).join("、");
  const labels = { agriculture: "开发农田", commerce: "整顿商市", patrol: "巡视乡里", train: "操练士卒", buildWall: "修筑城防",
    breedHorses: "挑选良马", craftArmor: "打造甲胄", craftCrossbows: "制作弓弩" };
  const result = action === "buildWall" ? (preview.defenseGain ? `城防修复 +${preview.defenseGain}`
    : `筑墙进度 +${preview.progressGain}${preview.levelGain ? `，城墙升至 ${city.wallLevel} 级` : `（${city.wallProgress}/100）`}`)
    : action === "train" ? `训练 +${preview.gain}，士气 +${preview.moraleGain}`
      : `${preview.resource ? EQUIPMENT_NAMES[preview.resource] : labels[action]} +${preview.gain}`;
  addEvent(state, `${city.name}：${names}${labels[action]}，${result}。`);
  return { ok: true, message: result, gain: preview.gain, ...(action === "buildWall" ? normalizeCityDefense(city) : {}) };
}

export function executeRecruit(state, cityId, officerId, amount, rules) {
  if (cityBesieged(state, cityId) || officerAtWar(state, officerId)) return { ok: false, message: "城池或将领正在持续战役中" };
  if (!canIssueCommand(state)) return { ok: false, message: "本月指令已用尽" };
  const city = getCity(state, cityId);
  const officer = getOfficer(state, officerId);
  const roundedAmount = Math.floor(Number(amount) / 100) * 100;
  if (!city || city.factionId !== state.playerFactionId || !officer || !city.officerIds.includes(officerId) || officer.acted) return { ok: false, message: "执行武将不可用" };
  if (!Number.isFinite(roundedAmount) || roundedAmount < 500 || roundedAmount > 5000) return { ok: false, message: "单次可征募 500 至 5,000 人" };

  const hundreds = roundedAmount / 100;
  const goldCost = hundreds * rules.recruit.goldPerHundred;
  const foodCost = hundreds * rules.recruit.foodPerHundred;
  if (city.gold < goldCost || city.food < foodCost) return { ok: false, message: "城中金粮不足" };

  const supportPenalty = Math.ceil(roundedAmount / 1000) * rules.recruit.popularSupportPenaltyPerThousand;
  city.gold -= goldCost;
  city.food -= foodCost;
  city.troops += roundedAmount;
  city.popularSupport = clamp(city.popularSupport - supportPenalty);
  city.training = clamp(Math.round((city.training * (city.troops - roundedAmount) + 25 * roundedAmount) / city.troops));
  officer.acted = true;
  officer.merit += 35;
  consumeCommand(state);
  addEvent(state, `${city.name}：${officer.name}征募新兵 ${roundedAmount.toLocaleString()} 人，民心 -${supportPenalty}。`);
  return { ok: true, message: `征募 ${roundedAmount.toLocaleString()} 人` };
}

export function executeTransfer(state, sourceId, targetId, officerId, amount, rules, supplies = { gold: 0, food: 0 }) {
  if (cityBesieged(state, sourceId) || cityBesieged(state, targetId) || officerAtWar(state, officerId)) return { ok: false, message: "不能向交战城池调拨或动用参战将领" };
  if (!canIssueCommand(state)) return { ok: false, message: "本月指令已用尽" };
  const source = getCity(state, sourceId);
  const target = getCity(state, targetId);
  const officer = getOfficer(state, officerId);
  if (!source || !target || sourceId === targetId || source.factionId !== state.playerFactionId) {
    return { ok: false, message: "请从我方城池输送至另一座相连的己方或盟友城池" };
  }
  const path = findFriendlyRoute(state, sourceId, targetId, source.factionId);
  if (!path) return { ok: false, message: "运输路线不连通：只能经过己方或盟友城池，不能穿越敌境或中立城池" };
  if (!officer || officer.acted || officer.factionId !== source.factionId || !source.officerIds.includes(officerId)
    || officer.status === "free" || officer.status === "captured"
    || (officer.locationCityId && officer.locationCityId !== sourceId)) return { ok: false, message: "执行武将不可用" };
  // Accept form-input strings, but never silently round quantities or coerce
  // null, booleans or objects into cargo.
  const quantity = (value) => typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  const troops = quantity(amount);
  const gold = quantity(supplies?.gold === undefined ? 0 : supplies.gold);
  const food = quantity(supplies?.food === undefined ? 0 : supplies.food);
  const equipment = Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, quantity(supplies?.[key] === undefined ? 0 : supplies[key])]));
  const cargo = { troops, gold, food };
  if (!supplies || typeof supplies !== "object" || Array.isArray(supplies)
    || ![...Object.values(cargo), ...Object.values(equipment)].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return { ok: false, message: "运输兵力、钱粮和装备必须为非负整数" };
  }
  if (troops !== 0 && (troops < 500 || troops % 100 !== 0)) return { ok: false, message: "运输兵力须为 0，或至少 500 人且为 100 的整数倍" };
  if ([...Object.values(cargo), ...Object.values(equipment)].every((value) => value === 0)) return { ok: false, message: "请至少选择一种要输送的兵力、钱粮或装备" };
  const expense = rules.actions.transfer;
  if (!Number.isSafeInteger(expense) || expense < 0 || !Number.isSafeInteger(gold + expense)
    || ![source.troops, source.gold, source.food, target.troops, target.gold, target.food].every((value) => Number.isSafeInteger(value) && value >= 0)
    || ![target.troops + troops, target.gold + gold, target.food + food].every(Number.isSafeInteger)) {
    return { ok: false, message: "城池资源或运输数量无效" };
  }
  for (const key of EQUIPMENT_KEYS) {
    const from = source[key] ?? 0;
    const to = target[key] ?? 0;
    if (![from, to, to + equipment[key]].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      return { ok: false, message: `${EQUIPMENT_NAMES[key]}库存或运输数量无效` };
    }
    if (equipment[key] > from) return { ok: false, message: `${EQUIPMENT_NAMES[key]}不足` };
  }
  if (troops > source.troops || food > source.food || gold + expense > source.gold) {
    return { ok: false, message: `城中兵力或钱粮不足（另需运输费用金 ${expense}）` };
  }
  if (troops > 0 && ![source.training, source.morale, target.training, target.morale].every(Number.isFinite)) {
    return { ok: false, message: "城池部队训练或士气无效" };
  }

  const incomingTraining = source.training;
  const incomingMorale = source.morale;
  source.troops -= troops;
  source.gold -= gold + expense;
  source.food -= food;
  target.gold += gold;
  target.food += food;
  for (const key of EQUIPMENT_KEYS) {
    if (equipment[key] || supplies[key] !== undefined) {
      source[key] = (source[key] ?? 0) - equipment[key];
      target[key] = (target[key] ?? 0) + equipment[key];
      cargo[key] = equipment[key];
    }
  }
  if (troops > 0) mergeTroops(target, troops, incomingTraining, incomingMorale);
  officer.acted = true;
  officer.merit = (officer.merit ?? 0) + 30;
  consumeCommand(state);
  const cargoLabel = [troops && `${troops.toLocaleString()} 兵力`, gold && `金 ${gold.toLocaleString()}`, food && `粮 ${food.toLocaleString()}`,
    ...EQUIPMENT_KEYS.map((key) => equipment[key] && `${EQUIPMENT_NAMES[key]} ${equipment[key].toLocaleString()}`)].filter(Boolean).join("、");
  const message = `${cargoLabel}已抵达${target.name}`;
  addEvent(state, `${source.name}：${officer.name}输送${cargoLabel}至${target.name}${troops ? "，训练与士气按兵力合并" : ""}。`);
  return { ok: true, message, path, cargo, expense };
}

export function appointGovernor(state, cityId, officerId, rules) {
  if (cityBesieged(state, cityId) || officerAtWar(state, officerId)) return { ok: false, message: "交战城池或参战将领暂不能任命太守" };
  if (!canIssueCommand(state)) return { ok: false, message: "本月指令已用尽" };
  const city = getCity(state, cityId);
  const officer = getOfficer(state, officerId);
  if (!city || city.factionId !== state.playerFactionId || !officer || !city.officerIds.includes(officerId) || officer.acted) return { ok: false, message: "任命对象不可用" };
  const expense = rules.actions.appointGovernor;
  if (city.gold < expense) return { ok: false, message: `任命金不足，需要 ${expense}` };
  city.gold -= expense;
  city.governorId = officerId;
  officer.acted = true;
  consumeCommand(state);
  addEvent(state, `${city.name}：任命${officer.name}为太守，自下月起主持城务。`);
  return { ok: true, message: `${officer.name}已就任太守` };
}

export function runGovernorAutomation(state, rules) {
  const reports = [];
  for (const city of playerCities(state)) {
    if (cityBesieged(state, city.id)) continue;
    if (!city.governorId) continue;
    const governor = getOfficer(state, city.governorId);
    if (!governor || governor.acted || governor.taskId || !city.officerIds.includes(governor.id)) {
      reports.push({ cityId: city.id, skipped: true });
      continue;
    }
    const choices = [
      { action: "agriculture", value: city.agriculture },
      { action: "commerce", value: city.commerce },
      { action: "patrol", value: city.popularSupport },
      { action: "train", value: city.training },
      ...(rules.development.buildWall && normalizeCityDefense(city).defense < 85 ? [{ action: "buildWall", value: normalizeCityDefense(city).defense }] : [])
    ].sort((a, b) => a.value - b.value);
    let action = choices[0].action;
    let preview = previewDomestic(action, [governor], city, rules);
    if (city.gold < preview.expense) {
      reports.push({ cityId: city.id, skipped: true });
      continue;
    }
    city.gold -= preview.expense;
    if (action === "buildWall") applyWallDevelopment(city, preview.work);
    else city[preview.targetKey] = clamp(city[preview.targetKey] + preview.gain);
    if (action === "train") city.morale = clamp(city.morale + preview.moraleGain);
    governor.acted = true;
    governor.merit += 18;
    const labels = { agriculture: "农业", commerce: "商业", patrol: "民心", train: "训练", buildWall: "城防修复" };
    addEvent(state, `${city.name}太守${governor.name}自治：${labels[action]} +${preview.gain}。`);
    reports.push({ cityId: city.id, action, gain: preview.gain });
  }
  return reports;
}

export function runEnemyAdministration(state, rules) {
  for (const city of state.cities.filter((item) => item.factionId !== state.playerFactionId && item.factionId !== NEUTRAL_FACTION_ID)) {
    const [officer] = availableOfficers(state, city);
    if (!officer) continue;
    const pick = city.agriculture <= city.commerce ? "agriculture" : "commerce";
    const expense = rules.development[pick].expense;
    if (city.gold < expense) continue;
    city[pick] = clamp(city[pick] + 2);
    city.gold -= expense;
    officer.acted = true;
  }
}

export function advanceMonth(state, rules) {
  runGovernorAutomation(state, rules);
  const monthly = settleMonthlyEconomy(state, rules);
  const busyIds = new Set((state.tasks ?? []).filter((task) => ["running", "awaiting_battle", "in_battle"].includes(task.status)).flatMap((task) => task.officerIds));
  state.officers.forEach((officer) => { officer.acted = busyIds.has(officer.id); });
  if (state.warCampaignsVersion === 1) restoreWarLocks(state);
  state.elapsedMonths = (state.elapsedMonths ?? 0) + 1;
  state.month += 1;
  if (state.month > 12) {
    state.month = 1;
    state.year += 1;
  }
  const harvest = applyAnnualHarvest(state, rules);
  const research = advanceResearch(state, rules);
  state.commandsRemaining = state.commandsMax;
  addEvent(state, `进入${state.year}年${state.month}月，新的政令周期开始。`);
  return { monthly, harvest, research };
}

export function mergeTroops(city, incomingTroops, incomingTraining, incomingMorale) {
  const total = city.troops + incomingTroops;
  if (total <= 0) return;
  city.training = clamp(Math.round((city.training * city.troops + incomingTraining * incomingTroops) / total));
  city.morale = clamp(Math.round((city.morale * city.troops + incomingMorale * incomingTroops) / total));
  city.troops = total;
}

export function validateArmy(state, cityId, targetId, divisions, rules, supplies = { food: 0, gold: 0 }, { legacyOrder = false } = {}) {
  if (cityBesieged(state, cityId) || cityBesieged(state, targetId)) return { ok: false, message: "交战城池不能重复出征或建立另一战场" };
  if (!canIssueCommand(state)) return { ok: false, message: "本月指令已用尽" };
  const city = getCity(state, cityId);
  const target = getCity(state, targetId);
  if (!city || city.factionId !== state.playerFactionId || !target || !city.adjacent?.includes(targetId) || target.factionId === state.playerFactionId) return { ok: false, message: "目标城池无效" };
  if (areAllied(state, city.factionId, target.factionId)) return { ok: false, message: "双方有同盟，盟约期间不能出征" };
  const { maxUnits, maxOfficersPerUnit: currentOfficerLimit } = armyLimits(rules);
  const maxOfficersPerUnit = legacyOrder ? Math.max(5, currentOfficerLimit) : currentOfficerLimit;
  if (!Array.isArray(divisions) || divisions.length < 1 || divisions.length > maxUnits) return { ok: false, message: `一军需由 1 至 ${maxUnits} 支部队编组` };
  const formations = normalizeFormations(divisions);
  const formationIds = formations.filter((formation) => formation.id !== undefined).map((formation) => formation.id);
  if (formationIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(formationIds).size !== formationIds.length) {
    return { ok: false, message: "部队标识无效或重复" };
  }
  const officerIds = formations.flatMap(formationOfficerIds);
  if (new Set(officerIds).size !== officerIds.length) return { ok: false, message: "同一将领不可重复编入多支部队" };
  let total = 0;
  for (const division of formations) {
    const ids = formationOfficerIds(division);
    if (ids.length < 1 || ids.length > maxOfficersPerUnit || ids.some((id) => typeof id !== "string")) {
      return { ok: false, message: `每支部队须由 1 至 ${maxOfficersPerUnit} 名将领组成` };
    }
    const officers = ids.map((id) => getOfficer(state, id));
    const troops = division.composition === undefined ? Math.floor(Number(division.troops) / 100) * 100 : division.troops;
    if (officers.some((officer) => !officer || officer.acted || officer.taskId || officerAtWar(state, officer.id) || !city.officerIds.includes(officer.id)
      || officer.factionId !== city.factionId || ["free", "captured"].includes(officer.status)
      || (officer.locationCityId && officer.locationCityId !== city.id))) return { ok: false, message: "有将领不在本城任职或本月无法行动" };
    const capacity = legacyOrder ? officers.reduce((sum, officer) => sum + formationCapacity([officer], rules), 0) : formationCapacity(officers, rules);
    if (!Number.isSafeInteger(troops) || troops < 500 || troops > capacity) return { ok: false, message: `${division.name ?? "该部队"}的兵力须在 500 至 ${capacity} 之间（主将官职兵额）` };
    const composition = validateComposition({ ...division, troops }, { state, factionId: city.factionId, officers, rules });
    if (!composition.ok) return composition;
    Object.assign(division, { troops, composition: composition.composition, unitType: primaryTroopType(composition.composition) });
    total += troops;
  }
  if (!Number.isSafeInteger(total) || total > city.troops) return { ok: false, message: "出征兵力超过城中现有兵力" };
  const equipment = sumEquipment(formations, rules);
  if (!equipmentAvailable(city, equipment)) return { ok: false, message: "编组所需良马、劲弩或甲胄超过本城库存" };
  const food = Number(supplies?.food);
  const gold = Number(supplies?.gold);
  if (!Number.isSafeInteger(food) || food < 0 || !Number.isSafeInteger(gold) || gold < 0) return { ok: false, message: "携带钱粮须为非负整数" };
  if (!legacyOrder && state.warCampaignsVersion === 1 && food > dailyFoodCost(total, rules) * armyLimits(rules).maxSupplyDays) return { ok: false, message: `新出征最多携带 ${armyLimits(rules).maxSupplyDays} 日军粮` };
  const expense = rules.actions.march;
  if (![city.troops, city.food, city.gold, expense, gold + expense].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return { ok: false, message: "出发城池资源或出征费用无效" };
  }
  if (city.food < food) return { ok: false, message: "携带军粮超过城中储备" };
  if (city.gold < gold + expense) return { ok: false, message: `城中金不足，须支付出征费 ${expense} 并携带军费 ${gold}` };
  return {
    ok: true, city, target, total, equipment, supplies: { food, gold }, expense, validationRules: rules, legacyOrder,
    divisions: formations
  };
}

export function commitArmyDeparture(state, validatedArmy) {
  if (!validatedArmy?.ok || validatedArmy.committed) return { ok: false, message: "出征指令无效或已经执行" };
  const { city, target, total, divisions, supplies, expense } = validatedArmy;
  const refreshed = validatedArmy.validationRules ? validateArmy(state, city?.id, target?.id, divisions, validatedArmy.validationRules, supplies, { legacyOrder: validatedArmy.legacyOrder === true }) : null;
  if (!canIssueCommand(state) || !state.cities.includes(city) || !state.cities.includes(target)
    || !refreshed?.ok || refreshed.total !== total || refreshed.expense !== expense
    || city.factionId !== state.playerFactionId || target.factionId === city.factionId || !city.adjacent.includes(target.id)
    || areAllied(state, city.factionId, target.factionId) || city.troops < total || city.food < supplies.food || city.gold < supplies.gold + expense
    || divisions.flatMap(formationOfficerIds).some((id) => !city.officerIds.includes(id) || !getOfficer(state, id) || getOfficer(state, id).acted)) {
    return { ok: false, message: "出征条件已经变化，请重新编组" };
  }
  city.troops -= total;
  city.food -= supplies.food;
  city.gold -= supplies.gold + expense;
  for (const key of EQUIPMENT_KEYS) city[key] = (city[key] ?? 0) - refreshed.equipment[key];
  validatedArmy.equipment = { ...refreshed.equipment };
  validatedArmy.divisions = refreshed.divisions;
  divisions.flatMap(formationOfficerIds).forEach((id) => { getOfficer(state, id).acted = true; });
  consumeCommand(state);
  validatedArmy.committed = true;
  addEvent(state, `${city.name}出兵 ${total.toLocaleString()}，携粮 ${supplies.food.toLocaleString()}、金 ${supplies.gold.toLocaleString()}，进攻${target.name}（出征费 ${expense}）。`);
  return { ok: true, message: "大军已出发" };
}
