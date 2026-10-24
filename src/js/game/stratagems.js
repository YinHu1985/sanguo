import { addEvent } from "./state.js";
import { areAllied } from "./campaign.js";
import { NEUTRAL_FACTION_ID } from "./atlas.js";
import { EQUIPMENT_KEYS } from "./equipment.js";
import { activeBattleCampaigns, cityBesieged, officerAtWar } from "./war-state.js";
import { canIssueCommand, consumeCommand } from "./commands.js";
import { transferCityOwnership } from "./heaven-cycle.js";

export const STRATAGEM_ACTIONS = ["rumor", "discord", "surrender", "prepareAmbush"];
const DEFAULTS = {
  rumor: { name: "流言", cost: 150, baseChance: 0.4, intelligenceScale: 0.004, minChance: 0.1, maxChance: 0.95, supportLoss: 12, moraleLoss: 8 },
  discord: { name: "离间", cost: 200, baseChance: 0.35, intelligenceScale: 0.004, minChance: 0.1, maxChance: 0.95, loyaltyLoss: 15 },
  surrender: { name: "劝降", cost: 500, baseChance: 0.15, charmScale: 0.004, minChance: 0.05, maxChance: 0.85, maxCityRatio: 1, maxTroopRatio: 0.65 },
  prepareAmbush: { name: "伏兵准备", cost: 200, bonus: 0.25, durationMonths: 3 }
};
const amount = (value) => Number.isSafeInteger(value) && value >= 0;
const active = (officer) => officer && !["free", "captured"].includes(officer.status);
const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value));
const cityById = (state, id) => state.cities?.find((city) => city.id === id);
const officerById = (state, id) => state.officers?.find((officer) => officer.id === id);
const turn = (state) => amount(state?.elapsedMonths) ? state.elapsedMonths : 0;
const isLord = (state, officer) => officer?.rank === "君主" || state.factions?.some((faction) => faction.id === officer?.factionId && faction.lord === officer?.id);

export function getStratagemConfig(rules = {}) {
  return Object.fromEntries(STRATAGEM_ACTIONS.map((action) => [action, { ...DEFAULTS[action], ...rules.stratagems?.[action] }]));
}

/** Without a campaign clock only structure and current ownership can be checked. */
export function activeAmbushPreparation(city, state) {
  const preparation = city?.ambushPreparation;
  if (!preparation || typeof preparation.id !== "string" || !preparation.id
    || !city.factionId || city.factionId === NEUTRAL_FACTION_ID || preparation.factionId !== city.factionId
    || !amount(preparation.expiresTurn) || !Number.isFinite(preparation.bonus) || preparation.bonus <= 0 || preparation.bonus > 1
    || (state !== undefined && turn(state) >= preparation.expiresTurn)) return null;
  return preparation;
}

function factionArmySize(state, factionId) {
  let troops = state.cities.filter((city) => city.factionId === factionId).reduce((sum, city) => sum + Math.max(0, city.troops ?? 0), 0);
  troops += (state.pendingInvasions ?? []).filter((order) => !order.resolved && order.attackerFactionId === factionId)
    .reduce((sum, order) => sum + Math.max(0, order.troops ?? 0), 0);
  troops += (state.tasks ?? []).filter((task) => task.factionId === factionId && ["running", "awaiting_battle"].includes(task.status))
    .reduce((sum, task) => sum + Math.max(0, task.reservation?.troops ?? 0), 0);
  return troops;
}

export function previewStratagem(state, sourceCityId, targetCityId, officerId, action, rules, { targetOfficerId } = {}) {
  const config = getStratagemConfig(rules)[action];
  const base = { action, cost: config?.cost ?? 0, chance: 0, effect: "" };
  const fail = (message) => ({ ...base, ok: false, message });
  if (!config || !amount(config.cost)) return fail("无此计略，或费用配置无效");
  const source = cityById(state, sourceCityId), target = cityById(state, targetCityId), officer = officerById(state, officerId);
  if (cityBesieged(state, sourceCityId) || cityBesieged(state, targetCityId) || officerAtWar(state, officerId)
    || (targetOfficerId && officerAtWar(state, targetOfficerId))) return fail("交战城池与参战将领暂不能执行战略计略");
  if (!source || source.factionId !== state.playerFactionId) return fail("请选择我方出发城池");
  if (!canIssueCommand(state)) return fail("本月指令已用尽");
  if (!active(officer) || officer.factionId !== source.factionId || !source.officerIds?.includes(officer.id)
    || (officer.locationCityId && officer.locationCityId !== source.id) || officer.acted || officer.taskId) return fail("请选择本城尚未行动的执行武将");
  if (!amount(source.gold) || source.gold < config.cost) return fail(`计略需要金 ${config.cost}`);
  if (!target) return fail("请选择计略目标城池");
  base.targetFactionId = target.factionId;
  if (action === "prepareAmbush") {
    if (target.id !== source.id || target.factionId !== state.playerFactionId) return fail("伏兵准备须由本城武将为本城布置");
    if (!amount(config.durationMonths) || config.durationMonths < 1 || !amount(turn(state) + config.durationMonths)
      || !Number.isFinite(config.bonus) || config.bonus <= 0 || config.bonus > 1) return fail("伏兵准备配置无效");
    return { ...base, ok: true, message: "可布置伏兵", chance: 1,
      effect: `有效 ${config.durationMonths} 个月；下次守方野战首次成功伏击伤害 +${Math.round(config.bonus * 100)}%，只生效一次，重复准备仅重置。` };
  }
  if (!target.factionId || target.factionId === NEUTRAL_FACTION_ID || target.factionId === state.playerFactionId
    || !state.factions?.some((faction) => faction.id === target.factionId)) return fail("计略对象须为其他仍存续的势力");
  if (areAllied(state, source.factionId, target.factionId)) return fail("盟约期间不能对盟友执行敌对计略");
  const stat = action === "surrender" ? officer.charm : officer.intelligence;
  const scale = action === "surrender" ? config.charmScale : config.intelligenceScale;
  base.chance = clamp(config.baseChance + clamp(stat ?? 0) * scale, config.minChance, config.maxChance);
  if (!Number.isFinite(base.chance) || base.chance < 0 || base.chance > 1) return fail("计略成功率配置无效");
  if (action === "rumor") {
    if (![config.supportLoss, config.moraleLoss].every(amount)) return fail("流言损失配置无效");
    base.effect = `成功使${target.name}民心 -${config.supportLoss}、士气 -${config.moraleLoss}。`;
  } else if (action === "discord") {
    const victim = officerById(state, targetOfficerId);
    if (!active(victim) || victim.factionId !== target.factionId || !target.officerIds?.includes(victim.id)
      || (victim.locationCityId && victim.locationCityId !== target.id) || isLord(state, victim)) return fail("离间目标须为敌城在职的非君主武将");
    if (!amount(config.loyaltyLoss)) return fail("离间损失配置无效");
    base.targetOfficerId = victim.id;
    base.effect = `成功使${victim.name}忠诚 -${config.loyaltyLoss}。`;
  } else {
    if (activeBattleCampaigns(state).some((battle) => [battle.attackerFactionId, battle.defenderFactionId].includes(target.factionId))) {
      return fail("对方正参与持续战役，须待战役结束后劝降");
    }
    const ownCities = state.cities.filter((city) => city.factionId === source.factionId);
    const enemyCities = state.cities.filter((city) => city.factionId === target.factionId);
    const ownTroops = factionArmySize(state, source.factionId), enemyTroops = factionArmySize(state, target.factionId);
    if (![config.maxCityRatio, config.maxTroopRatio].every((value) => Number.isFinite(value) && value > 0)) return fail("劝降弱势条件配置无效");
    if (!ownTroops || enemyCities.length > ownCities.length * config.maxCityRatio || enemyTroops > ownTroops * config.maxTroopRatio) {
      return fail(`对方尚未明显弱于我方：城池须不超过我方 ${Math.round(config.maxCityRatio * 100)}%，兵力须不超过 ${Math.round(config.maxTroopRatio * 100)}%`);
    }
    base.ownTroops = ownTroops;
    base.enemyTroops = enemyTroops;
    base.affectedCityIds = enemyCities.map((city) => city.id);
    base.effect = `成功后对方 ${enemyCities.length} 座城池及全部在职将领归附；钱粮、兵员与军备原地保留，原君主改任大将。`;
  }
  return { ...base, ok: true, message: "可以下达计略" };
}

function mergeReturningArmy(city, order) {
  const troops = order.troops, food = order.supplies?.food ?? 0, gold = order.supplies?.gold ?? 0;
  if (![troops, food, gold, city.troops + troops, city.food + food, city.gold + gold].every(amount)
    || ![city.training, city.morale, order.training ?? city.training, order.morale ?? city.morale]
      .every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    || EQUIPMENT_KEYS.some((key) => !amount(order.equipment?.[key] ?? 0) || !amount((city[key] ?? 0) + (order.equipment?.[key] ?? 0)))) return false;
  const total = city.troops + troops;
  if (total) {
    city.training = clamp(Math.round((city.training * city.troops + (order.training ?? city.training) * troops) / total));
    city.morale = clamp(Math.round((city.morale * city.troops + (order.morale ?? city.morale) * troops) / total));
  }
  city.troops = total;
  city.food += food;
  city.gold += gold;
  for (const key of EQUIPMENT_KEYS) city[key] = (city[key] ?? 0) + (order.equipment?.[key] ?? 0);
  return true;
}

/** Run on a draft: failure never partly annexes cities or partly returns cargo. */
function absorbFaction(state, previousFactionId, nextFactionId) {
  const cities = state.cities.filter((city) => city.factionId === previousFactionId);
  const cityIds = new Set(cities.map((city) => city.id));
  const officers = state.officers.filter((officer) => active(officer) && officer.factionId === previousFactionId);
  if (!cities.length || officers.some((officer) => !cityIds.has(officer.locationCityId)
    || !cityById(state, officer.locationCityId).officerIds.includes(officer.id))) return { ok: false, message: "对方在职将领驻地记录无效，劝降未执行" };
  const formerLord = state.factions.find((faction) => faction.id === previousFactionId)?.lord;
  for (const city of cities) {
    transferCityOwnership(state, city, nextFactionId);
    delete city.ambushPreparation;
  }
  for (const officer of officers) {
    officer.factionId = nextFactionId;
    officer.loyalty = 75;
    officer.acted = true;
    if (officer.id === formerLord || officer.rank === "君主") officer.rank = "大将";
  }
  for (const officer of state.officers) {
    if (officer.status === "captured" && officer.captorFactionId === previousFactionId && cityIds.has(officer.locationCityId)) {
      officer.captorFactionId = nextFactionId;
      officer.factionId = null;
      officer.discovered = true;
    }
  }
  const cancelledInvasionIds = [];
  for (const order of state.pendingInvasions ?? []) {
    if (order.resolved || (order.attackerFactionId !== previousFactionId && order.defenderFactionId !== previousFactionId && !cityIds.has(order.targetId))) continue;
    const factionId = order.attackerFactionId === previousFactionId ? nextFactionId : order.attackerFactionId;
    const source = cityById(state, order.sourceId);
    const home = source?.factionId === factionId ? source : state.cities.find((city) => city.factionId === factionId);
    if (!home || !mergeReturningArmy(home, order)) return { ok: false, message: "在途军队记录无效，无法安全办理归附" };
    order.resolved = true;
    order.supplies = { food: 0, gold: 0 };
    order.equipment = { horses: 0, crossbows: 0, armor: 0 };
    cancelledInvasionIds.push(order.id);
  }
  state.pendingInvasions = (state.pendingInvasions ?? []).filter((order) => !order.resolved);
  return { ok: true, affectedCityIds: [...cityIds], joinedOfficerIds: officers.map((officer) => officer.id), cancelledInvasionIds };
}

function commitDraft(state, draft) {
  // Task settlement retains its current task reference while a primitive runs.
  for (const collection of ["cities", "officers", "factions", "tasks"]) {
    if (!Array.isArray(draft[collection])) continue;
    draft[collection] = draft[collection].map((next) => {
      const previous = state[collection]?.find((entry) => entry.id === next.id);
      if (!previous) return next;
      for (const key of Object.keys(previous)) if (!(key in next)) delete previous[key];
      return Object.assign(previous, next);
    });
  }
  Object.assign(state, draft);
}

export function executeStratagem(state, sourceCityId, targetCityId, officerId, action, rules, options = {}, rng = Math.random) {
  const preview = previewStratagem(state, sourceCityId, targetCityId, officerId, action, rules, options);
  if (!preview.ok) return preview;
  const config = getStratagemConfig(rules)[action];
  const effectiveTurn = options.effectiveTurn === undefined ? turn(state) : options.effectiveTurn;
  if (action === "prepareAmbush" && (!amount(effectiveTurn) || !amount(effectiveTurn + config.durationMonths))) {
    return { ok: false, message: "伏兵准备的生效或到期回合无效" };
  }
  const draft = structuredClone(state);
  const source = cityById(draft, sourceCityId), target = cityById(draft, targetCityId), officer = officerById(draft, officerId);
  const success = action === "prepareAmbush" || rng() < preview.chance;
  let outcome = {};
  if (success && action === "surrender") {
    outcome = absorbFaction(draft, target.factionId, source.factionId);
    if (!outcome.ok) return outcome;
  }
  source.gold -= config.cost;
  consumeCommand(draft);
  officer.acted = true;
  officer.merit = (officer.merit ?? 0) + 30;
  if (success && action === "rumor") {
    target.popularSupport = clamp(target.popularSupport - config.supportLoss);
    target.morale = clamp(target.morale - config.moraleLoss);
  }
  if (success && action === "discord") {
    const victim = officerById(draft, options.targetOfficerId);
    victim.loyalty = clamp((victim.loyalty ?? 100) - config.loyaltyLoss);
  }
  if (success && action === "prepareAmbush") {
    target.ambushPreparation = { id: crypto.randomUUID(), factionId: target.factionId, expiresTurn: effectiveTurn + config.durationMonths, bonus: config.bonus };
    outcome.preparation = { ...target.ambushPreparation };
  }
  const message = success ? `${officer.name}执行${config.name}成功。${preview.effect}` : `${officer.name}执行${config.name}未能成功，所费金 ${config.cost} 已支出。`;
  addEvent(draft, message);
  commitDraft(state, draft);
  return { ...outcome, ok: true, success, message, chance: preview.chance, expense: config.cost, action, targetId: targetCityId };
}
