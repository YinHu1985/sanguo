import { addEvent } from "./state.js";
import { isAIManagedCity } from "./capabilities.js";
import { previewDomestic } from "./rules.js";
import { NEUTRAL_FACTION_ID } from "./atlas.js";
import { dailyFoodCost, monthlyFoodCost, monthlySalaryCost, grainExchangeRate } from "./economy.js";
import { armyLimits, formationCapacity, formationOfficerIds, groupOfficersForArmy } from "./army.js";
import { activeBattleCampaigns, cityBesieged, officerAtWar } from "./war-state.js";
import { ensureInvasionBattle, advanceBattleMonths, getBattleEngine, checkpointBattle } from "./war-campaigns.js";
import { simulateBattleMonth } from "./battle-simulation.js";
import { normalizeCityDefense, applyWallDevelopment } from "./city-defense.js";
import { addEquipment, applyFormationLosses, autoComposition, compositionEquipment, EQUIPMENT_KEYS, equipmentAvailable, formationComposition, primaryTroopType, resizeComposition, sumEquipment } from "./troops.js";
import { calculateCombatStats } from "./combat-stats.js";
import { canIssueCommand, consumeCommand } from "./commands.js";
import { transferCityOwnership } from "./heaven-cycle.js";

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const cityById = (state, id) => state.cities.find((city) => city.id === id);
const officerById = (state, id) => state.officers.find((officer) => officer.id === id);
const monthNumber = (state) => state.year * 12 + state.month;
const relationKey = (a, b) => [a, b].sort().join("|");
const activeOfficers = (state, city) => city.officerIds.map((id) => officerById(state, id))
  .filter((officer) => officer && officer.status !== "free" && officer.status !== "captured" && !officerAtWar(state, officer.id));

export function getRelation(state, firstId, secondId) {
  return state.relations?.[relationKey(firstId, secondId)] ?? { friendliness: 20, allianceUntil: 0 };
}

export function areAllied(state, firstId, secondId) {
  return firstId === secondId || getRelation(state, firstId, secondId).allianceUntil > monthNumber(state);
}

function mutableRelation(state, firstId, secondId) {
  state.relations ??= {};
  const key = relationKey(firstId, secondId);
  state.relations[key] ??= { friendliness: 20, allianceUntil: 0 };
  return state.relations[key];
}

function validateExecutor(state, cityId, officerId) {
  if (cityBesieged(state, cityId) || officerAtWar(state, officerId)) return { ok: false, message: "城池或将领正在持续战役中" };
  if (!canIssueCommand(state)) return { ok: false, message: "本月指令已用尽" };
  const city = cityById(state, cityId);
  const officer = officerById(state, officerId);
  if (!city || city.factionId !== state.playerFactionId) return { ok: false, message: "请从我方城池派遣执行武将" };
  if (!officer || !city.officerIds.includes(officerId) || officer.acted || officer.taskId
    || officer.factionId !== city.factionId || (officer.locationCityId && officer.locationCityId !== city.id)
    || officer.status === "captured" || officer.status === "free") {
    return { ok: false, message: "执行武将不可用或本月已经行动" };
  }
  return { ok: true, city, officer };
}

function spendCommand(state, officer, merit = 25) {
  consumeCommand(state);
  officer.acted = true;
  officer.merit = (officer.merit ?? 0) + merit;
}

function removeOfficerFromCities(state, officerId) {
  for (const city of state.cities) {
    city.officerIds = city.officerIds.filter((id) => id !== officerId);
    if (city.governorId === officerId) city.governorId = null;
  }
}

function placeOfficer(state, officer, city) {
  removeOfficerFromCities(state, officer.id);
  Object.assign(officer, { factionId: city.factionId, status: "active", locationCityId: city.id, captorFactionId: null, discovered: true });
  city.officerIds.push(officer.id);
}

function nearestFriendlyCity(state, origin, factionId, excludedId = origin.id) {
  const visited = new Set([origin.id]);
  let frontier = [origin];
  while (frontier.length) {
    const next = [];
    for (const city of frontier) {
      if (city.id !== excludedId && city.factionId === factionId && !cityBesieged(state, city.id)) return city;
      for (const id of city.adjacent ?? []) {
        if (visited.has(id)) continue;
        visited.add(id);
        const neighbor = cityById(state, id);
        if (neighbor) next.push(neighbor);
      }
    }
    frontier = next;
  }
  return state.cities.find((city) => city.id !== excludedId && city.factionId === factionId && !cityBesieged(state, city.id));
}

function mergeGarrison(city, troops, training, morale) {
  const total = city.troops + troops;
  if (total <= 0) return;
  city.training = clamp(Math.round((city.training * city.troops + training * troops) / total));
  city.morale = clamp(Math.round((city.morale * city.troops + morale * troops) / total));
  city.troops = total;
}

/** Army troops were deducted at departure. This transaction moves all officers exactly once. */
export function resolveOccupation(state, { sourceId, targetId, officerIds, troops, training, morale, food = 0, gold = 0, equipment = {} }, rng = Math.random) {
  const source = cityById(state, sourceId);
  const target = cityById(state, targetId);
  const ids = [...new Set(officerIds ?? [])];
  const incoming = ids.map((id) => officerById(state, id));
  if (!source || !target || source.factionId === target.factionId || !Number.isFinite(troops) || troops <= 0 || !incoming.length
    || !Number.isSafeInteger(food) || food < 0 || !Number.isSafeInteger(gold) || gold < 0
    || EQUIPMENT_KEYS.some((key) => !Number.isSafeInteger(equipment[key] ?? 0) || (equipment[key] ?? 0) < 0
      || !Number.isSafeInteger((target?.[key] ?? 0) + (equipment[key] ?? 0)))
    || incoming.some((officer) => !officer || !source.officerIds.includes(officer.id) || officer.status === "captured" || officer.status === "free")) {
    return { ok: false, message: "入城军队或目标城池已失效" };
  }
  const previousFactionId = target.factionId;
  const defenders = target.officerIds.map((id) => officerById(state, id)).filter((officer) => officer && !["free", "captured"].includes(officer.status)
    && (!officerAtWar(state, officer.id) || target.battleId && officer.battleId === target.battleId) && !ids.includes(officer.id));
  const destination = nearestFriendlyCity(state, target, previousFactionId);
  const escapedOfficerIds = [];
  const capturedOfficerIds = [];
  const liberatedOfficerIds = [];
  transferCityOwnership(state, target, source.factionId);
  delete target.ambushPreparation;
  target.officerIds = [];
  target.governorId = null;
  target.troops = Math.floor(troops);
  target.training = clamp(training ?? source.training);
  target.morale = clamp(morale ?? source.morale);
  target.food += food;
  target.gold += gold;
  addEquipment(target, equipment);
  target.popularSupport = clamp(target.popularSupport - 8, 20);

  // The remaining court joins the last city's prisoners if a faction loses its final seat.
  if (!destination && previousFactionId !== NEUTRAL_FACTION_ID) {
    for (const officer of state.officers) {
      if (officer.factionId === previousFactionId && officer.status !== "free" && officer.status !== "captured"
        && (!officerAtWar(state, officer.id) || target.battleId && officer.battleId === target.battleId)
        && !defenders.includes(officer) && !ids.includes(officer.id)) defenders.push(officer);
    }
  }
  for (const officer of defenders) {
    if (destination) {
      placeOfficer(state, officer, destination);
      officer.acted = true;
      escapedOfficerIds.push(officer.id);
      if (!destination.governorId) destination.governorId = officer.id;
    } else {
      removeOfficerFromCities(state, officer.id);
      Object.assign(officer, { factionId: null, status: "captured", captorFactionId: target.factionId, locationCityId: target.id, discovered: true, acted: true });
      capturedOfficerIds.push(officer.id);
    }
  }
  for (const officer of incoming) {
    placeOfficer(state, officer, target);
    officer.acted = true;
    officer.merit = (officer.merit ?? 0) + 100;
  }
  // Prisoners remain at a real location when their prison changes hands.
  for (const officer of state.officers.filter((item) => item.status === "captured" && item.locationCityId === target.id)) {
    if (officer.captorFactionId === target.factionId) continue;
    Object.assign(officer, { status: "free", factionId: null, captorFactionId: null, discovered: true });
    liberatedOfficerIds.push(officer.id);
  }
  target.governorId = incoming.slice().sort((a, b) => (b.politics ?? 0) - (a.politics ?? 0))[0].id;
  const eliminated = previousFactionId !== NEUTRAL_FACTION_ID && !state.cities.some((city) => city.factionId === previousFactionId);
  const message = `${target.name}归于${state.factions.find((faction) => faction.id === target.factionId)?.name ?? "胜军"}。`
    + (escapedOfficerIds.length ? `${escapedOfficerIds.length}名守将退往${destination.name}。` : "")
    + (capturedOfficerIds.length ? `${capturedOfficerIds.length}名守将被俘，可由人事登用。` : "")
    + (eliminated ? "原势力已失去全部城池。" : "");
  addEvent(state, message);
  return { ok: true, message, cityId: target.id, previousFactionId, factionId: target.factionId, escapedOfficerIds, capturedOfficerIds, liberatedOfficerIds, eliminated };
}

export function executeSearch(state, cityId, officerId, rules, rng = Math.random) {
  const checked = validateExecutor(state, cityId, officerId);
  if (!checked.ok) return checked;
  const { city, officer } = checked;
  const cost = rules.personnel?.searchCost ?? 100;
  if (city.gold < cost) return { ok: false, message: `寻访需要金 ${cost}` };
  const candidates = state.officers.filter((target) => target.status === "free" && target.locationCityId === cityId && !target.discovered);
  city.gold -= cost;
  spendCommand(state, officer);
  const found = candidates.length && rng() < Math.min(0.95, 0.6 + officer.intelligence / 300)
    ? candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))] : null;
  if (found) found.discovered = true;
  const message = found ? `${officer.name}在${city.name}寻得${found.name}，可前往登用。` : `${officer.name}走访${city.name}乡里，暂未发现可荐之士。`;
  addEvent(state, message);
  return { ok: true, message, foundOfficerId: found?.id ?? null, expense: cost };
}

function employmentTarget(state, city, target, rules) {
  if (target && (officerAtWar(state, target.id) || cityBesieged(state, target.locationCityId))) return { ok: false, message: "交战城池或参战将领不能登用" };
  if (!city || city.factionId !== state.playerFactionId || !target) return { ok: false, message: "登用对象不存在" };
  const local = target.locationCityId === city.id && target.discovered
    && (target.status === "free" || (target.status === "captured" && target.captorFactionId === state.playerFactionId));
  if (local) return { ok: true, enemyRecruit: false, targetCityId: city.id };
  const enemyCity = cityById(state, target.locationCityId);
  if (!enemyCity || !city.adjacent?.includes(enemyCity.id) || !target.factionId || target.factionId === NEUTRAL_FACTION_ID
    || target.factionId === state.playerFactionId || enemyCity.factionId !== target.factionId
    || !enemyCity.officerIds.includes(target.id) || ["free", "captured"].includes(target.status)) {
    return { ok: false, message: "只能登用本城已发现的在野人物、我方俘虏，或邻接敌城的在职武将" };
  }
  if (target.rank === "君主" || state.factions.some((faction) => faction.id === target.factionId && faction.lord === target.id)) return { ok: false, message: "不能单独招揽敌方君主，请使用劝降" };
  if (areAllied(state, city.factionId, target.factionId)) return { ok: false, message: "盟约期间不能招揽盟友武将" };
  if (target.taskId || (state.tasks ?? []).some((task) => ["running", "awaiting_battle"].includes(task.status) && task.officerIds?.includes(target.id))
    || (state.pendingInvasions ?? []).some((invasion) => !invasion.resolved && invasion.officerIds?.includes(target.id))) {
    return { ok: false, message: "目标武将正在执行任务，暂不能招揽" };
  }
  const loyalty = target.loyalty ?? 100;
  if (!Number.isFinite(loyalty) || loyalty < 0 || loyalty > (rules.personnel?.enemyEmployMaxLoyalty ?? 60)) return { ok: false, message: `目标忠诚高于 ${rules.personnel?.enemyEmployMaxLoyalty ?? 60}，可先离间` };
  return { ok: true, enemyRecruit: true, targetCityId: enemyCity.id };
}

export function employCandidates(state, cityId, rules = {}) {
  const city = cityById(state, cityId);
  return state.officers.filter((target) => employmentTarget(state, city, target, rules).ok);
}

export function previewEmploy(state, cityId, officerId, targetId, rules) {
  const checked = validateExecutor(state, cityId, officerId);
  if (!checked.ok) return checked;
  const { city, officer } = checked;
  const target = officerById(state, targetId);
  const eligible = employmentTarget(state, city, target, rules);
  if (!eligible.ok) return eligible;
  const cost = rules.personnel?.employCost ?? 200;
  if (city.gold < cost) return { ok: false, message: `登用礼金需要 ${cost}` };
  const chance = eligible.enemyRecruit
    ? clamp(20 + officer.charm * 0.45 + officer.intelligence * 0.1 - (target.loyalty ?? 100) * 0.6, 5, 90) / 100
    : clamp(45 + officer.charm * 0.35 + officer.intelligence * 0.1 - (target.status === "captured" ? 20 : 0), 25, 95) / 100;
  return { ...eligible, ok: true, message: "可以招揽", chance, cost };
}

export function executeEmploy(state, cityId, officerId, targetId, rules, rng = Math.random) {
  const checked = previewEmploy(state, cityId, officerId, targetId, rules);
  if (!checked.ok) return checked;
  const city = cityById(state, cityId), officer = officerById(state, officerId), target = officerById(state, targetId);
  const { cost, chance } = checked;
  city.gold -= cost;
  spendCommand(state, officer, 35);
  const success = rng() < chance;
  if (success) {
    placeOfficer(state, target, city);
    // A captured former ruler joins the court as a general, never as a second ruler.
    if (target.rank === "君主" && !state.factions.some((faction) => faction.id === city.factionId && faction.lord === target.id)) target.rank = "大将";
    target.acted = true;
    target.loyalty = 75;
    if (!city.governorId) city.governorId = target.id;
  }
  const message = success ? `${officer.name}说服${target.name}出仕，现驻${city.name}。` : `${target.name}婉拒了${officer.name}的招揽，可择月再访。`;
  addEvent(state, message);
  return { ok: true, success, message, targetId, chance, expense: cost, enemyRecruit: checked.enemyRecruit };
}

export function executeOfficerTransfer(state, sourceId, targetId, officerIds, rules) {
  if (cityBesieged(state, sourceId) || cityBesieged(state, targetId)) return { ok: false, message: "交战城池暂不能迁任武将" };
  const ids = [...new Set(officerIds ?? [])];
  if (!ids.length) return { ok: false, message: "请至少选择一名迁任武将" };
  const checked = validateExecutor(state, sourceId, ids[0]);
  if (!checked.ok) return checked;
  const source = checked.city;
  const target = cityById(state, targetId);
  if (!target || target.id === source.id || target.factionId !== state.playerFactionId) return { ok: false, message: "迁任目标必须是另一座我方城池" };
  const reachable = new Set([source.id]);
  const frontier = [source];
  while (frontier.length) {
    for (const id of frontier.shift().adjacent ?? []) {
      const city = cityById(state, id);
      if (!city || city.factionId !== state.playerFactionId || cityBesieged(state, city.id) || reachable.has(id)) continue;
      reachable.add(id);
      frontier.push(city);
    }
  }
  if (!reachable.has(target.id)) return { ok: false, message: "迁任需要我方城池相连，不能穿越敌境" };
  const officers = ids.map((id) => officerById(state, id));
  if (officers.some((officer) => !officer || officer.acted || !source.officerIds.includes(officer.id))) return { ok: false, message: "有武将不可迁任或本月已经行动" };
  const expense = rules.actions?.officerTransfer ?? 30;
  if (source.gold < expense) return { ok: false, message: `迁任需要金 ${expense}` };
  source.gold -= expense;
  for (const officer of officers) {
    placeOfficer(state, officer, target);
    officer.acted = true;
  }
  consumeCommand(state);
  const message = `${officers.map((officer) => officer.name).join("、")}由${source.name}迁任${target.name}，本月不再执行其他政令。`;
  addEvent(state, message);
  return { ok: true, message, officerIds: ids, expense };
}

export function executeDiplomacy(state, sourceCityId, targetFactionId, officerId, action, rules, rng = Math.random) {
  const checked = validateExecutor(state, sourceCityId, officerId);
  if (!checked.ok) return checked;
  if (!["goodwill", "alliance"].includes(action)) return { ok: false, message: "尚无此外交指令" };
  if (action === "alliance" && activeBattleCampaigns(state).some((record) => [record.attackerFactionId, record.defenderFactionId].includes(state.playerFactionId)
    && [record.attackerFactionId, record.defenderFactionId].includes(targetFactionId))) return { ok: false, message: "双方仍有未结束的战役，撤军后方可缔盟" };
  if (!state.factions.some((faction) => faction.id === targetFactionId) || !state.cities.some((city) => city.factionId === targetFactionId)
    || targetFactionId === NEUTRAL_FACTION_ID || targetFactionId === state.playerFactionId) return { ok: false, message: "外交对象必须是仍有城池的其他势力" };
  const { city, officer } = checked;
  const cost = action === "goodwill" ? (rules.diplomacy?.goodwillCost ?? 300) : (rules.diplomacy?.allianceCost ?? 600);
  if (city.gold < cost) return { ok: false, message: `使团需要礼金 ${cost}` };
  const current = getRelation(state, state.playerFactionId, targetFactionId);
  if (action === "alliance" && current.friendliness < 45) return { ok: false, message: "友好需达到 45 才可议盟，请先修好" };
  const relation = mutableRelation(state, state.playerFactionId, targetFactionId);
  city.gold -= cost;
  spendCommand(state, officer, 35);
  relation.lastActionMonth = monthNumber(state);
  const success = action === "goodwill" || rng() < Math.min(0.95, 0.3 + relation.friendliness / 200 + officer.charm / 400);
  if (action === "goodwill") relation.friendliness = clamp(relation.friendliness + 16 + Math.floor(officer.charm / 10));
  if (action === "alliance" && success) {
    relation.allianceUntil = monthNumber(state) + 6;
    relation.friendliness = clamp(relation.friendliness + 10);
  }
  const name = state.factions.find((faction) => faction.id === targetFactionId).name;
  const message = action === "goodwill" ? `${officer.name}出使${name}，友好升至 ${relation.friendliness}。`
    : success ? `与${name}缔结六个月同盟，盟约期间双方不得交战。` : `${name}暂不愿缔盟，使团已归。`;
  addEvent(state, message);
  return { ok: true, success, message, relation: { ...relation }, expense: cost };
}

export function getCampaignStatus(state) {
  const owned = state.cities.filter((city) => city.factionId === state.playerFactionId);
  const occupied = state.cities.filter((city) => city.factionId !== NEUTRAL_FACTION_ID);
  const rivalFactions = [...new Set(occupied.filter((city) => city.factionId !== state.playerFactionId).map((city) => city.factionId))];
  const fieldFactions = new Set(activeBattleCampaigns(state).flatMap((battle) => [battle.attackerFactionId, battle.defenderFactionId]));
  if (state.warCampaignsVersion === 1) for (const invasion of state.pendingInvasions ?? []) if (!invasion.resolved) fieldFactions.add(invasion.attackerFactionId);
  return { status: state.playerOfficerId ? "active" : !owned.length && !fieldFactions.has(state.playerFactionId) ? "defeat" : !rivalFactions.length && ![...fieldFactions].some((id) => id !== state.playerFactionId) ? "victory" : "active", ownedCities: owned.length,
    totalCities: state.cities.length, occupiedCities: occupied.length, rivalFactions: rivalFactions.length };
}

function armyPanel(troops, officers, training, morale, rules, composition = { infantry: troops }) {
  return calculateCombatStats({ troops, composition: resizeComposition(composition, troops), training, morale,
    ...(officers.length ? { officers } : { war: 35, leadership: 30, intelligence: 25 }) }, rules);
}

function armyStrength(troops, officers, training, morale, defending, rules, composition) {
  const panel = armyPanel(troops, officers, training, morale, rules, composition);
  // Macro AI compares offensive power and protection, then applies a tactical
  // advantage for defending a city. All officer/training/morale quality is
  // already included in the shared panel and must not be multiplied again.
  return (panel.meleeAttack + panel.rangedAttack * 0.5) * Math.sqrt(panel.meleeDefense * panel.rangedDefense) * (defending ? 1.18 : 1);
}

function cityComposition(state, city, troops, rules) {
  const equipment = Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, city[key] ?? 0]));
  return autoComposition(troops, equipment, { state, factionId: city.factionId, officers: activeOfficers(state, city), rules });
}

function combineCompositions(divisions, rules) {
  return divisions.reduce((sum, division) => {
    for (const [id, count] of Object.entries(formationComposition(division, rules))) sum[id] = (sum[id] ?? 0) + count;
    return sum;
  }, {});
}

function compositionLosses(before, after) {
  return Object.fromEntries(Object.entries(before).map(([id, count]) => [id, count - (after[id] ?? 0)]).filter(([, loss]) => loss > 0));
}

/** Keep the existing integer casualty total; only choose which soldiers suffer it. */
function applyCampaignCasualties(army, loss, contribution, rules) {
  const before = { ...army.composition };
  const power = contribution.melee + contribution.ranged;
  const ranged = power > 0 ? Math.min(loss, Math.round(loss * contribution.ranged / power)) : 0;
  const byDamageType = { melee: loss - ranged, ranged };
  // Both totals and their proportions were fixed from the pre-round panels.
  // Sequential allocation changes exposure, never either side's damage roll.
  applyFormationLosses(army, byDamageType.melee, rules, "melee");
  applyFormationLosses(army, byDamageType.ranged, rules, "ranged");
  return { byDamageType, byTroopType: compositionLosses(before, army.composition) };
}

function createArmy(state, source, rules) {
  if (cityBesieged(state, source.id)) return { divisions: [], composition: {}, troops: 0 };
  const commanders = activeOfficers(state, source).filter((officer) => !officer.acted && !officer.taskId && officer.id !== state.playerOfficerId)
    .sort((a, b) => (b.leadership + b.war * 0.25) - (a.leadership + a.war * 0.25));
  const availableTroops = source.assemblyReady ? source.troops - 3000 : Math.min(source.troops * 0.65, source.troops - 1500);
  let budget = Math.floor(availableTroops / 100) * 100;
  const divisions = [];
  const equipment = Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, source[key] ?? 0]));
  for (const officers of groupOfficersForArmy(commanders, rules, { troops: budget, minTroops: 500 })) {
    const troops = Math.min(formationCapacity(officers, rules), budget);
    if (troops < 500) break;
    const composition = autoComposition(troops, equipment, { state, factionId: source.factionId, officers, rules });
    divisions.push({ id: `army-${source.id}-${divisions.length + 1}`, name: `${officers[0].name}军`,
      officerIds: officers.map((officer) => officer.id), officerId: officers[0].id, troops, unitType: primaryTroopType(composition), composition });
    budget -= troops;
  }
  return { divisions, composition: combineCompositions(divisions, rules), troops: divisions.reduce((sum, division) => sum + division.troops, 0) };
}

function invasionSupplies(source, army, rules) {
  const expense = rules.actions?.march ?? 100;
  const food = Math.min(dailyFoodCost(army.troops, rules) * armyLimits(rules).maxSupplyDays,
    Math.max(0, source.food - monthlyFoodCost(source.troops - army.troops, rules)));
  return { food, gold: Math.min(150, Math.max(0, source.gold - expense)), expense };
}

function prepareInvasion(state, source, target, army, rules) {
  const { food, gold, expense } = invasionSupplies(source, army, rules);
  const equipment = sumEquipment(army.divisions, rules);
  if (source.gold < expense || !equipmentAvailable(source, equipment) || (target.troops > 0 && food < dailyFoodCost(army.troops, rules))) return null;
  source.troops -= army.troops;
  source.food -= food;
  source.gold -= gold + expense;
  for (const key of EQUIPMENT_KEYS) source[key] = (source[key] ?? 0) - equipment[key];
  source.assemblyReady = false;
  for (const id of army.divisions.flatMap(formationOfficerIds)) officerById(state, id).acted = true;
  return { id: `invasion-${monthNumber(state)}-${source.id}-${target.id}`, sourceId: source.id, targetId: target.id,
    attackerFactionId: source.factionId, defenderFactionId: target.factionId, officerIds: army.divisions.flatMap(formationOfficerIds),
    divisions: army.divisions, troops: army.troops, equipment, training: source.training, morale: source.morale,
    supplies: { food, gold }, year: state.year, month: state.month, resolved: false };
}

function returnInvasionArmy(state, invasion, troops, supplies, morale = invasion.morale, equipment = {}) {
  const source = cityById(state, invasion.sourceId);
  const home = source?.factionId === invasion.attackerFactionId ? source : state.cities.find((city) => city.factionId === invasion.attackerFactionId);
  if (!home) return null;
  mergeGarrison(home, troops, invasion.training, morale);
  home.food += supplies.food;
  home.gold += supplies.gold;
  addEquipment(home, equipment);
  return home;
}

function settleInvasion(state, invasion, rules, stance, rng) {
  const source = cityById(state, invasion.sourceId);
  const target = cityById(state, invasion.targetId);
  // Old orders with no cargo have no free supplies. Save migration can provision them from their source.
  const supplies = { food: Math.max(0, Math.floor(invasion.supplies?.food ?? 0)), gold: Math.max(0, Math.floor(invasion.supplies?.gold ?? 0)) };
  const initialFood = supplies.food;
  const initialComposition = combineCompositions(invasion.divisions ?? [{ troops: invasion.troops, unitType: "infantry" }], rules);
  const attackingArmy = { troops: invasion.troops, composition: resizeComposition(initialComposition, invasion.troops) };
  const survivingEquipment = () => invasion.equipment ? compositionEquipment(attackingArmy.composition, rules) : {};
  const releaseCargo = () => { invasion.supplies = { food: 0, gold: 0 }; invasion.equipment = { horses: 0, crossbows: 0, armor: 0 }; };
  if (!source || !target || source.factionId !== invasion.attackerFactionId || target.factionId !== invasion.defenderFactionId) {
    // A stale order must not create an army in the wrong faction's city.
    returnInvasionArmy(state, invasion, invasion.troops, supplies, invasion.morale, survivingEquipment());
    releaseCargo();
    return { ok: true, cancelled: true, message: "战局已经变化，入侵军撤回本境。" };
  }
  if (areAllied(state, source.factionId, target.factionId)) {
    returnInvasionArmy(state, invasion, invasion.troops, supplies, invasion.morale, survivingEquipment());
    releaseCargo();
    return { ok: true, cancelled: true, message: "双方现有盟约，入侵军撤回出发城。" };
  }
  const commanders = invasion.officerIds.map((id) => officerById(state, id)).filter(Boolean);
  const defenders = activeOfficers(state, target);
  const defendingTroops = target.troops;
  const defenderComposition = cityComposition(state, target, defendingTroops, rules);
  const defendingArmy = { troops: defendingTroops, composition: { ...defenderComposition } };
  const defenderEquipment = compositionEquipment(defenderComposition, rules);
  const defenderInitialFood = target.food;
  let attackerSurvivors = invasion.troops;
  let defenderSurvivors = defendingTroops;
  let attackerWon = defendingTroops === 0;
  let days = 0;
  let endReason = attackerWon ? "unopposed" : "day-limit";
  const dailyLog = [];
  // Every day's grain demand uses that day's living soldiers, never a departure-time duration.
  for (let day = 1; !attackerWon && day <= rules.battleDayLimit; day += 1) {
    const attackerFood = dailyFoodCost(attackerSurvivors, rules);
    const defenderFood = dailyFoodCost(defenderSurvivors, rules);
    // Match tactical resolution: an unfed attacker withdraws first; partial daily rations are exhausted.
    if (supplies.food < attackerFood) { supplies.food = 0; endReason = "attacker-food"; break; }
    supplies.food -= attackerFood;
    if (target.food < defenderFood) { target.food = 0; attackerWon = true; endReason = "defender-food"; break; }
    target.food -= defenderFood;
    days = day;
    const attackPanel = armyPanel(attackerSurvivors, commanders, invasion.training, invasion.morale, rules, attackingArmy.composition);
    const defensePanel = armyPanel(defenderSurvivors, defenders, target.training, target.morale, rules, defendingArmy.composition);
    const attackContribution = { melee: attackPanel.meleeAttack / defensePanel.meleeDefense,
      ranged: attackPanel.rangedAttack * 0.5 / defensePanel.rangedDefense };
    const defenseContribution = { melee: defensePanel.meleeAttack / attackPanel.meleeDefense,
      ranged: defensePanel.rangedAttack * 0.5 / attackPanel.rangedDefense };
    const attack = (attackContribution.melee + attackContribution.ranged) * (0.88 + rng() * 0.24);
    const defense = (defenseContribution.melee + defenseContribution.ranged) * (stance !== "sally" ? 1.18 : 1) * (0.88 + rng() * 0.24);
    const attackerLoss = Math.min(attackerSurvivors, Math.max(1, Math.floor(defense * 0.065)));
    const defenderLoss = Math.min(defenderSurvivors, Math.max(1, Math.floor(attack * (stance === "sally" ? 0.075 : 0.065))));
    const attackerCasualties = applyCampaignCasualties(attackingArmy, attackerLoss, defenseContribution, rules);
    const defenderCasualties = applyCampaignCasualties(defendingArmy, defenderLoss, attackContribution, rules);
    attackerSurvivors = attackingArmy.troops;
    defenderSurvivors = defendingArmy.troops;
    dailyLog.push({ day, attackerFood, defenderFood, attackerLoss, defenderLoss, attackerSurvivors, defenderSurvivors,
      attackerLossByDamageType: attackerCasualties.byDamageType, defenderLossByDamageType: defenderCasualties.byDamageType,
      attackerLossByTroopType: attackerCasualties.byTroopType, defenderLossByTroopType: defenderCasualties.byTroopType,
      attackerComposition: { ...attackingArmy.composition }, defenderComposition: { ...defendingArmy.composition } });
    if (attackerSurvivors === 0) { endReason = "attacker-routed"; break; }
    if (defenderSurvivors === 0) { attackerWon = true; endReason = "defender-routed"; break; }
  }
  let occupation = null;
  const remainingDefenderEquipment = compositionEquipment(defendingArmy.composition, rules);
  for (const key of EQUIPMENT_KEYS) target[key] = (target[key] ?? 0) - defenderEquipment[key] + remainingDefenderEquipment[key];
  if (attackerWon) {
    occupation = resolveOccupation(state, { ...invasion, ...supplies, troops: attackerSurvivors,
      equipment: survivingEquipment(),
      morale: endReason === "unopposed" ? invasion.morale : Math.max(35, invasion.morale - 8) }, rng);
    if (!occupation.ok) {
      target.troops = defenderSurvivors;
      returnInvasionArmy(state, invasion, attackerSurvivors, supplies, invasion.morale, survivingEquipment());
      releaseCargo();
      return { ok: true, cancelled: true, message: "军令已失效，出征军返回驻地。" };
    }
    defenderSurvivors = 0;
  } else {
    target.troops = defenderSurvivors;
    target.morale = clamp(target.morale - (stance === "sally" ? 10 : 4));
    returnInvasionArmy(state, invasion, attackerSurvivors, supplies, Math.max(20, invasion.morale - 15), survivingEquipment());
  }
  releaseCargo();
  defenders.forEach((officer) => { officer.acted = true; });
  const reasonText = endReason === "attacker-food" ? "进攻军粮不足，" : endReason === "defender-food" ? "守军断粮，" : endReason === "day-limit" ? "三十日期满，" : "";
  const message = attackerWon ? `${source.name}军攻占${target.name}，攻方余兵 ${attackerSurvivors}。`
    : `${target.name}${stance === "sally" ? "出城迎敌" : "坚守城垣"}成功，守军余 ${defenderSurvivors}，来军退回${source.name}。`;
  addEvent(state, reasonText + message);
  return { ok: true, message: reasonText + message, attackerWon, days, endReason, dailyLog,
    // Combat survivors are recorded before surrender/disbanding at occupation.
    combatSurvivors: { attacker: { troops: attackingArmy.troops, composition: { ...attackingArmy.composition } },
      defender: { troops: defendingArmy.troops, composition: { ...defendingArmy.composition } } },
    remainingSupplies: { ...supplies }, foodConsumed: { attacker: initialFood - supplies.food, defender: defenderInitialFood - (attackerWon ? target.food - supplies.food : target.food) },
    winnerFactionId: attackerWon ? invasion.attackerFactionId : invasion.defenderFactionId,
    attackerSurvivors, defenderSurvivors, attackerLosses: invasion.troops - attackerSurvivors, defenderLosses: defendingTroops - defenderSurvivors, occupation };
}

export function autoResolveInvasion(state, invasion, rules, stance = "defend", rng = Math.random) {
  if (!["defend", "sally"].includes(stance)) return { ok: false, message: "请选择坚守或出击" };
  const pending = state.pendingInvasions?.find((item) => item.id === invasion?.id);
  if (!pending || pending.resolved) return { ok: false, message: "这场入侵已经处理或不再存在" };
  const target = cityById(state, pending.targetId);
  if (stance === "sally" && target && activeOfficers(state, target).length === 0) {
    return { ok: false, message: "城中没有将领，守军只能坚守，不能出城迎敌" };
  }
  if (state.warCampaignsVersion === 1) {
    const targetTurn = state.turnResolution?.targetTurn ?? (state.elapsedMonths ?? 0) + 1;
    const created = ensureInvasionBattle(state, pending.id, rules, state.warBattleMap, { targetTurn, mode: stance === "sally" ? "field" : "siege" });
    if (!created.ok || created.record.status === "ended") return created.ok ? { ...created.record.result, record: created.record } : created;
    const opened = getBattleEngine(state, created.record.id, rules, { targetTurn });
    if (!opened.ok) return opened;
    const simulated = simulateBattleMonth(opened.battle);
    return simulated.ok ? checkpointBattle(state, created.record.id, opened.battle, { targetTurn }) : simulated;
  }
  const report = settleInvasion(state, pending, rules, stance, rng);
  if (report.ok) {
    pending.resolved = true;
    pending.report = report;
    state.pendingInvasions = state.pendingInvasions.filter((item) => !item.resolved);
  }
  return report;
}

function administerAICity(state, city, rules) {
  const officers = activeOfficers(state, city).filter((officer) => !officer.acted && !officer.taskId && officer.id !== state.playerOfficerId);
  const [officer] = officers.sort((a, b) => b.politics - a.politics);
  if (!officer) return;
  const hasHostileBorder = city.adjacent.some((id) => {
    const other = cityById(state, id);
    return other && other.factionId !== NEUTRAL_FACTION_ID && !areAllied(state, city.factionId, other.factionId);
  });
  const desiredTroops = hasHostileBorder ? (city.assemblyReady ? 18000 : 11000) : 6000;
  const foodReserve = monthlyFoodCost(city.troops, rules) * 3;
  if (city.troops < desiredTroops && city.gold > 500 && city.food > foodReserve + 600 && city.popularSupport >= 45) {
    const amount = Math.floor(Math.min(1200, desiredTroops - city.troops, (city.gold - 300) / rules.recruit.goldPerHundred * 100,
      (city.food - foodReserve) / rules.recruit.foodPerHundred * 100) / 100) * 100;
    if (amount >= 500) {
      city.gold -= amount / 100 * rules.recruit.goldPerHundred;
      city.food -= amount / 100 * rules.recruit.foodPerHundred;
      mergeGarrison(city, amount, 25, 55);
      city.popularSupport = clamp(city.popularSupport - Math.ceil(amount / 1000));
      officer.acted = true;
      return;
    }
  }
  const choices = [{ key: "agriculture", action: "agriculture", value: city.agriculture }, { key: "commerce", action: "commerce", value: city.commerce },
    { key: "popularSupport", action: "patrol", value: city.popularSupport }, { key: "training", action: "train", value: city.training },
    ...(rules.development.buildWall && normalizeCityDefense(city).defense < 85 ? [{ key: "defense", action: "buildWall", value: normalizeCityDefense(city).defense }] : [])]
    .filter((choice) => choice.value < 100 && city.gold >= rules.development[choice.action].expense)
    .sort((a, b) => a.value - b.value);
  if (!choices.length) return;
  const choice = choices[0];
  const config = rules.development[choice.action];
  city.gold -= config.expense;
  const preview = previewDomestic(choice.action, [officer], city, rules, state);
  const gain = preview.work ?? preview.gain;
  if (choice.action === "buildWall") applyWallDevelopment(city, gain);
  else city[choice.key] = clamp(city[choice.key] + gain);
  if (choice.key === "training") city.morale = clamp(city.morale + 3);
  officer.acted = true;
}

/** AI uses the same seasonal exchange and acted executor rules as the player, not free relief grain. */
function tradeAIReserves(state, city, rules) {
  const officer = activeOfficers(state, city).filter((person) => !person.acted && !person.taskId && person.id !== state.playerOfficerId).sort((a, b) => a.leadership - b.leadership)[0];
  if (!officer) return false;
  const rate = grainExchangeRate(state.month, rules);
  const foodReserve = monthlyFoodCost(city.troops, rules) * 3;
  const goldReserve = monthlySalaryCost(state, city, rules) + 300;
  let principal = 0;
  let buying = false;
  if (city.food < foodReserve && city.gold > goldReserve) {
    principal = Math.min(Math.ceil((foodReserve - city.food) / rate), city.gold - goldReserve);
    buying = true;
  } else if (city.gold < goldReserve && city.food > foodReserve) {
    principal = Math.min(Math.ceil(goldReserve - city.gold), Math.floor((city.food - foodReserve) / rate));
  }
  if (principal <= 0) return false;
  city.gold += buying ? -principal : principal;
  city.food += buying ? principal * rate : -principal * rate;
  officer.acted = true;
  officer.merit = (officer.merit ?? 0) + 15;
  return true;
}

function staffVacantAICities(state, rules) {
  const movedByFaction = new Map();
  let moved = 0;
  const vacancies = state.cities.filter((city) => isAIManagedCity(state, city)
    && !cityBesieged(state, city.id) && activeOfficers(state, city).length === 0);
  for (const target of vacancies) {
    if ((movedByFaction.get(target.factionId) ?? 0) >= 2) continue;
    const visited = new Set([target.id]);
    const frontier = [target];
    let replacement = null;
    while (frontier.length && !replacement) {
      const city = frontier.shift();
      const staff = activeOfficers(state, city);
      if (city.id !== target.id && isAIManagedCity(state, city) && staff.length > 1 && city.gold >= (rules.actions?.officerTransfer ?? 30)) {
        replacement = staff.filter((officer) => !officer.acted && !officer.taskId && officer.id !== state.playerOfficerId).sort((a, b) => {
          const priority = (officer) => (officer.rank === "君主" ? 1000 : 0) + (officer.id === city.governorId ? 100 : 0) - officer.politics;
          return priority(a) - priority(b);
        })[0];
      }
      for (const id of city.adjacent ?? []) {
        const next = cityById(state, id);
        if (!next || next.factionId !== target.factionId || cityBesieged(state, next.id) || visited.has(id)) continue;
        visited.add(id);
        frontier.push(next);
      }
    }
    if (!replacement) continue;
    const source = cityById(state, replacement.locationCityId);
    source.gold -= rules.actions?.officerTransfer ?? 30;
    placeOfficer(state, replacement, target);
    replacement.acted = true;
    target.governorId = replacement.id;
    movedByFaction.set(target.factionId, (movedByFaction.get(target.factionId) ?? 0) + 1);
    moved += 1;
  }
  return moved;
}

function assembleBorderArmies(state, rules, rng) {
  const aiFactionIds = [...new Set(state.cities.filter((city) => isAIManagedCity(state, city)).map((city) => city.factionId))];
  const hostileNeighbors = (city) => (city.adjacent ?? []).map((id) => cityById(state, id)).filter((other) =>
    other && other.factionId !== NEUTRAL_FACTION_ID && !areAllied(state, city.factionId, other.factionId));
  const commandCapacity = (city) => {
    return groupOfficersForArmy(activeOfficers(state, city), rules).reduce((sum, officers) => sum + formationCapacity(officers, rules), 0);
  };
  // A full garrison can still lack the commanders needed to lead its assembled
  // troops. Officer migration must not depend on room for another troop convoy.
  const needsOfficerOnly = (city) => city.troops > 17500
    && commandCapacity(city) < Math.min(15000, city.troops - 3000);
  let assemblies = 0;
  for (const factionId of aiFactionIds) {
    const fronts = state.cities.filter((city) => city.factionId === factionId && isAIManagedCity(state, city) && !cityBesieged(state, city.id) && (city.troops < 18000 || needsOfficerOnly(city))
      && city.food >= 3000 && hostileNeighbors(city).length > 0)
      .map((city) => {
        const staff = activeOfficers(state, city);
        const commandLimit = commandCapacity(city);
        const potentialTroops = Math.min(15000, commandLimit);
        const potential = armyStrength(potentialTroops, staff, city.training, city.morale, false, rules, cityComposition(state, city, potentialTroops, rules));
        const defense = Math.min(...hostileNeighbors(city).map((other) => armyStrength(other.troops, activeOfficers(state, other), other.training, other.morale, true, rules, cityComposition(state, other, other.troops, rules))));
        return { city, priority: potential / Math.max(500, defense) * (0.9 + rng() * 0.2) };
      }).sort((a, b) => b.priority - a.priority);
    for (const { city: target } of fronts) {
      const officerOnly = needsOfficerOnly(target);
      const visited = new Set([target.id]);
      const frontier = [target];
      let donor = null;
      let executor = null;
      while (frontier.length && !donor) {
        const city = frontier.shift();
        const staff = activeOfficers(state, city);
        const canSupply = officerOnly ? staff.length > 1 && city.gold >= (rules.actions?.officerTransfer ?? 30)
          : city.troops >= 4000 && city.food >= 1500 && city.gold >= (rules.actions?.transfer ?? 40);
        if (city.id !== target.id && isAIManagedCity(state, city) && canSupply && hostileNeighbors(city).length === 0) {
          const officer = staff.filter((person) => !person.acted && !person.taskId && person.id !== state.playerOfficerId && (!officerOnly || person.rank !== "君主"))
            .sort((a, b) => b.leadership - a.leadership)[0];
          if (officer) { donor = city; executor = officer; }
        }
        for (const id of city.adjacent ?? []) {
          const next = cityById(state, id);
          if (!next || next.factionId !== factionId || cityBesieged(state, next.id) || visited.has(id)) continue;
          visited.add(id);
          frontier.push(next);
        }
      }
      if (!donor) continue;
      if (officerOnly) {
        donor.gold -= rules.actions?.officerTransfer ?? 30;
        placeOfficer(state, executor, target);
        executor.acted = true;
        target.assemblyReady = true;
        assemblies += 1;
        break;
      }
      const incoming = Math.floor(Math.min(donor.troops - 3000, 18000 - target.troops) / 100) * 100;
      if (incoming < 500) continue;
      const targetCommanders = activeOfficers(state, target);
      const moveOfficer = activeOfficers(state, donor).length > 1 && targetCommanders.length < 3 && executor.rank !== "君主"
        && donor.gold >= (rules.actions?.transfer ?? 40) + (rules.actions?.officerTransfer ?? 30);
      donor.gold -= (rules.actions?.transfer ?? 40) + (moveOfficer ? (rules.actions?.officerTransfer ?? 30) : 0);
      donor.troops -= incoming;
      mergeGarrison(target, incoming, donor.training, donor.morale);
      if (moveOfficer) placeOfficer(state, executor, target);
      executor.acted = true;
      target.assemblyReady = true;
      assemblies += 1;
      break;
    }
  }
  return assemblies;
}

/** Run once after advanceMonth. World wars never consume player command points. */
export function runWorldTurn(state, rules, rng = Math.random) {
  state.pendingInvasions ??= [];
  if (state.lastWorldTurnMonth === monthNumber(state)) return { battles: state.pendingInvasions.filter((item) => !item.resolved), summary: [] };
  // Do not advance an unresolved battle to another month through a repeated call.
  if (!state.warCampaignsVersion && state.pendingInvasions.some((item) => !item.resolved)) return { battles: state.pendingInvasions.filter((item) => !item.resolved), summary: [] };
  state.lastWorldTurnMonth = monthNumber(state);
  const summary = [];
  const aiCities = state.cities.filter((city) => isAIManagedCity(state, city) && !cityBesieged(state, city.id));
  // Month-end taxes, salary, grain consumption and July harvest are settled once by advanceMonth.
  for (const city of aiCities) tradeAIReserves(state, city, rules);
  const reassigned = staffVacantAICities(state, rules);
  if (reassigned) summary.push(`诸势力迁调 ${reassigned} 名属官补充空缺城务。`);
  const assemblies = assembleBorderArmies(state, rules, rng);
  if (assemblies) summary.push(`诸势力于 ${assemblies} 处边境集结军队，内地城保留守军。`);
  const candidates = [];
  for (const source of aiCities) {
    const army = createArmy(state, source, rules);
    if (army.troops < 1500 || source.gold < (rules.actions?.march ?? 100) || source.morale < 40) continue;
    for (const targetId of source.adjacent ?? []) {
      const target = cityById(state, targetId);
      if (!target || cityBesieged(state, target.id) || areAllied(state, source.factionId, target.factionId)) continue;
      if (target.troops > 0 && invasionSupplies(source, army, rules).food < dailyFoodCost(army.troops, rules)) continue;
      if (target.factionId === state.playerFactionId && (state.elapsedMonths ?? 0) <= 2) continue;
      const commanders = army.divisions.flatMap(formationOfficerIds).map((id) => officerById(state, id));
      const attack = armyStrength(army.troops, commanders, source.training, source.morale, false, rules, army.composition);
      const defense = armyStrength(target.troops, activeOfficers(state, target), target.training, target.morale, true, rules, cityComposition(state, target, target.troops, rules));
      const ratio = attack / Math.max(500, defense);
      if (ratio < 1.12) continue;
      candidates.push({ source, target, army, score: ratio * (0.8 + rng() * 0.4) });
    }
  }
  const activeFactions = new Set();
  const attackedCities = new Set();
  const marchingCities = new Set();
  const battleLimit = rules.campaign?.warsPerMonth ?? 4;
  let wars = 0;
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (wars >= battleLimit) break;
    const { source, target, army } = candidate;
    if (activeFactions.has(source.factionId) || attackedCities.has(target.id) || attackedCities.has(source.id) || marchingCities.has(target.id)
      || areAllied(state, source.factionId, target.factionId) || army.divisions.flatMap(formationOfficerIds).some((id) => officerById(state, id).acted)) continue;
    // Campaign choices are deliberately intermittent, not an obligatory invasion every border/month.
    if (rng() > 0.65) continue;
    const invasion = prepareInvasion(state, source, target, army, rules);
    if (!invasion) continue;
    activeFactions.add(source.factionId);
    marchingCities.add(source.id);
    attackedCities.add(target.id);
    wars += 1;
    if (target.factionId === state.playerFactionId) {
      state.pendingInvasions.push(invasion);
      const message = `${source.name}军 ${invasion.troops} 人逼近${target.name}，请决断守城方略。`;
      addEvent(state, message);
      summary.push(message);
    } else if (state.warCampaignsVersion === 1) {
      state.pendingInvasions.push(invasion);
      const created = ensureInvasionBattle(state, invasion, rules, state.warBattleMap, { targetTurn: state.turnResolution?.targetTurn ?? state.elapsedMonths });
      if (created.ok) {
        const advanced = advanceBattleMonths(state, rules, { targetTurn: state.turnResolution?.targetTurn ?? state.elapsedMonths });
        summary.push(advanced.ok ? `${target.name}战役本月战况已结算。` : advanced.message);
      } else summary.push(created.message);
    } else {
      const result = settleInvasion(state, invasion, rules, "defend", rng);
      summary.push(result.message);
    }
  }
  for (const city of state.cities.filter((item) => isAIManagedCity(state, item))) administerAICity(state, city, rules);
  return { battles: [...state.pendingInvasions], summary };
}
