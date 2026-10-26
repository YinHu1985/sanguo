import { addEvent } from "./state.js";
import { capability } from "./capabilities.js";
import { NEUTRAL_FACTION_ID } from "./atlas.js";
import { advanceHeavenCycle, heavenCycleStatus, recordHeavenOutcome } from "./heaven-cycle.js";

const nonnegativeInteger = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const finiteNonnegative = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;
const technologyFor = (rules, id) => Object.hasOwn(rules.technologies ?? {}, id) ? rules.technologies[id] : undefined;
const knownOwned = (faction, rules) => new Set((Array.isArray(faction?.unlockedTechnologies) ? faction.unlockedTechnologies : [])
  .filter((id) => Object.hasOwn(rules.technologies ?? {}, id)));
const prerequisitesOf = (technology) => [...new Set(Array.isArray(technology?.prerequisites) ? technology.prerequisites : [])];

/** Keep the original save keys; reform is a faction resource, never a city resource. */
export function normalizeFactionResearch(faction, rules) {
  faction.researchPoints = nonnegativeInteger(faction.researchPoints, nonnegativeInteger(rules.research?.initialPoints));
  faction.unlockedTechnologies = [...new Set((Array.isArray(faction.unlockedTechnologies) ? faction.unlockedTechnologies : [])
    .filter((id) => typeof id === "string" && id.length > 0))];
  return faction;
}

function directionCounts(faction, rules) {
  const counts = {};
  for (const id of knownOwned(faction, rules)) {
    const direction = rules.technologies[id].direction;
    if (direction) counts[direction] = (counts[direction] ?? 0) + 1;
  }
  return counts;
}

function directionMultiplier(directionId, counts, rules) {
  const oppositeId = rules.policyDirections?.[directionId]?.opposite;
  if (!oppositeId) return 1;
  const difference = Math.max(0, (counts[oppositeId] ?? 0) - (counts[directionId] ?? 0));
  const increase = finiteNonnegative(rules.research?.oppositionCostPerNode, 0.15);
  const maximum = Math.max(1, finiteNonnegative(rules.research?.maximumCostMultiplier, 3));
  return Math.min(maximum, Math.round((1 + increase * difference) * 1000000) / 1000000);
}

function roundedCost(baseCost, multiplier) {
  if (!Number.isSafeInteger(baseCost) || baseCost < 0) return undefined;
  const value = baseCost * multiplier;
  // Decimal factors such as 1.1 must not turn an exact 220 into a 221-point bill.
  const cost = Math.ceil(value - Number.EPSILON * Math.max(1, value) * 4);
  return Number.isSafeInteger(cost) ? cost : undefined;
}

function groupProgress(faction, rules) {
  const owned = knownOwned(faction, rules);
  return Object.entries(rules.ideaGroups ?? {}).map(([id, config]) => {
    const nodeIds = Object.entries(rules.technologies ?? {}).filter(([, technology]) => technology.group === id).map(([nodeId]) => nodeId);
    const count = nodeIds.filter((nodeId) => owned.has(nodeId)).length;
    const complete = nodeIds.length > 0 && count === nodeIds.length;
    return { id, ...config, nodeIds, owned: count, total: nodeIds.length, complete,
      bonus: nonnegativeInteger(config.completionBonus?.reformFlat) };
  });
}

export function technologyStatus(state, factionId, technologyId, rules) {
  const faction = state.factions?.find((entry) => entry.id === factionId);
  const technology = technologyFor(rules, technologyId);
  const points = nonnegativeInteger(faction?.researchPoints, nonnegativeInteger(rules.research?.initialPoints));
  const baseCost = technology?.cost;
  const costMultiplier = directionMultiplier(technology?.direction, directionCounts(faction, rules), rules);
  const cost = roundedCost(baseCost, costMultiplier);
  const unlocked = faction?.unlockedTechnologies?.includes(technologyId) ?? false;
  const affordable = Number.isSafeInteger(cost) && points >= cost;
  const missingPrerequisites = prerequisitesOf(technology).filter((id) => !faction?.unlockedTechnologies?.includes(id));
  const base = { unlocked, affordable, points, cost, baseCost, costMultiplier, technology,
    direction: technology?.direction, group: technology?.group, missingPrerequisites, prerequisitesMet: missingPrerequisites.length === 0 };
  if (!faction || factionId === NEUTRAL_FACTION_ID) return { ...base, ok: false, message: "势力无效" };
  if (!technology || !Number.isSafeInteger(cost)) return { ...base, ok: false, message: "理念配置无效" };
  if (unlocked) return { ...base, ok: false, message: "此理念已经研习" };
  if (!state.cities?.some((city) => city.factionId === factionId)) return { ...base, ok: false, message: "势力已无据点" };
  if (missingPrerequisites.length) return { ...base, ok: false,
    message: `须先研习：${missingPrerequisites.map((id) => rules.technologies?.[id]?.name ?? id).join("、")}` };
  if (!affordable) return { ...base, ok: false, message: `改革力不足，需要 ${cost}` };
  return { ...base, ok: true, message: "可以研习" };
}

function policyMutationBlock(state, factionId) {
  const permission = capability(state, "policy");
  if (!permission.ok) return permission.reason;
  if (factionId !== state.playerFactionId) return "只能调整本势力理念";
  if (state.turnResolution || (state.tasks ?? []).some((task) => task.status === "awaiting_battle")) return "请先完成当前回合结算或战斗";
  return null;
}

/** A global policy decision is immediate and consumes no city command or actor. */
export function unlockTechnology(state, factionId, technologyId, rules) {
  const blocked = policyMutationBlock(state, factionId);
  if (blocked) return { ok: false, message: blocked };
  const status = technologyStatus(state, factionId, technologyId, rules);
  if (!status.ok) return status;
  const faction = state.factions.find((entry) => entry.id === factionId);
  const beforeGroups = new Set(groupProgress(faction, rules).filter((group) => group.complete).map((group) => group.id));
  normalizeFactionResearch(faction, rules);
  faction.researchPoints -= status.cost;
  faction.unlockedTechnologies.push(technologyId);
  recordHeavenOutcome(state, factionId, "victory", { reason: `研习「${status.technology.name ?? technologyId}」` });
  const completedGroups = groupProgress(faction, rules).filter((group) => group.complete && !beforeGroups.has(group.id)).map((group) => group.id);
  const message = `研习「${status.technology.name ?? technologyId}」，改革力 -${status.cost}`;
  addEvent(state, `${faction.name}：${message}。`);
  for (const groupId of completedGroups) {
    const group = rules.ideaGroups[groupId];
    addEvent(state, `理念组「${group.name ?? groupId}」已完成，每月基础改革力 +${nonnegativeInteger(group.completionBonus?.reformFlat)}。`);
  }
  return { ok: true, message, technologyId, cost: status.cost, points: faction.researchPoints, completedGroups };
}

/** Read-only closure: prerequisites may span groups and even contain malformed cycles. */
export function rollbackTechnologyPreview(state, factionId, technologyId, rules) {
  const faction = state.factions?.find((entry) => entry.id === factionId);
  const technology = technologyFor(rules, technologyId);
  const base = { technologyId, removedIds: [], lostGroups: [], refund: 0 };
  if (!faction || factionId === NEUTRAL_FACTION_ID) return { ...base, ok: false, message: "势力无效" };
  if (!technology) return { ...base, ok: false, message: "理念配置无效" };
  if (!faction.unlockedTechnologies?.includes(technologyId)) return { ...base, ok: false, message: "此理念尚未研习" };
  const removed = new Set([technologyId]);
  const owned = knownOwned(faction, rules);
  let changed = true;
  while (changed) {
    changed = false;
    // Traverse the definition graph, including unowned intermediates. Older
    // saves may own a descendant without its newly introduced prerequisites.
    for (const id of Object.keys(rules.technologies ?? {})) {
      if (removed.has(id) || !prerequisitesOf(rules.technologies[id]).some((dependency) => removed.has(dependency))) continue;
      removed.add(id);
      changed = true;
    }
  }
  const removedIds = [...removed].filter((id) => owned.has(id));
  const lostGroups = groupProgress(faction, rules).filter((group) => group.complete && group.nodeIds.some((id) => removed.has(id))).map((group) => group.id);
  return { ...base, ok: true, removedIds, lostGroups, message: `回退「${technology.name ?? technologyId}」及 ${removedIds.length - 1} 项依赖理念，不返还改革力` };
}

/** Retraction is one defeat event, regardless of how many dependent ideas are removed. */
export function rollbackTechnology(state, factionId, technologyId, rules) {
  const blocked = policyMutationBlock(state, factionId);
  if (blocked) return { ok: false, message: blocked };
  const preview = rollbackTechnologyPreview(state, factionId, technologyId, rules);
  if (!preview.ok) return preview;
  const faction = state.factions.find((entry) => entry.id === factionId);
  const removed = new Set(preview.removedIds);
  normalizeFactionResearch(faction, rules);
  faction.unlockedTechnologies = faction.unlockedTechnologies.filter((id) => !removed.has(id));
  recordHeavenOutcome(state, factionId, "defeat", { reason: `回退「${rules.technologies[technologyId].name ?? technologyId}」` });
  addEvent(state, `${faction.name}：${preview.message}。`);
  for (const groupId of preview.lostGroups) addEvent(state, `理念组「${rules.ideaGroups[groupId].name ?? groupId}」不再完整，整组奖励暂停。`);
  return { ...preview, points: faction.researchPoints };
}

/**
 * Income is a derived value, never an unlock-time award. Future systems can pass
 * named flat/multiplier modifiers without making UI or monthly clocks own rules.
 */
export function reformIncome(state, factionId, rules, { modifiers = [] } = {}) {
  const faction = state.factions?.find((entry) => entry.id === factionId);
  const active = Boolean(faction && factionId !== NEUTRAL_FACTION_ID && state.cities?.some((city) => city.factionId === factionId));
  const baseGain = active ? nonnegativeInteger(rules.research?.monthlyGain, 100) : 0;
  const completedGroups = groupProgress(faction, rules).filter((group) => group.complete);
  const groupBonus = active ? completedGroups.reduce((sum, group) => sum + group.bonus, 0) : 0;
  const extras = (Array.isArray(modifiers) ? modifiers : []).filter((modifier) => modifier && typeof modifier === "object");
  const flatBonus = active ? extras.reduce((sum, modifier) => sum + (Number.isFinite(modifier.amount) ? modifier.amount : 0), 0) : 0;
  const subtotal = Math.max(0, baseGain + groupBonus + flatBonus);
  const fate = heavenCycleStatus(faction, rules);
  const multiplier = extras.reduce((product, modifier) => product * finiteNonnegative(modifier.multiplier, 1), fate.multiplier);
  const gain = Math.max(0, Math.floor(subtotal * multiplier + Number.EPSILON * subtotal * 4));
  const breakdown = [{ id: "base", label: "势力基础", amount: baseGain },
    ...completedGroups.map((group) => ({ id: `group:${group.id}`, label: `${group.name} · 整组奖励`, amount: active ? group.bonus : 0 })),
    ...extras.map((modifier, index) => ({ id: modifier.id ?? `extra:${index}`, label: modifier.label ?? "其他修正",
      ...(Number.isFinite(modifier.amount) ? { amount: active ? modifier.amount : 0 } : {}),
      ...(Number.isFinite(modifier.multiplier) ? { multiplier: Math.max(0, modifier.multiplier) } : {}) })),
    { id: "heaven", label: `天意 · ${fate.label}`, multiplier: fate.multiplier }];
  return { baseGain, groupBonus, flatBonus, subtotal, multiplier, gain, breakdown };
}

export function getPolicyOverview(state, factionId, rules) {
  const faction = state.factions?.find((entry) => entry.id === factionId);
  const counts = directionCounts(faction, rules);
  const groups = groupProgress(faction, rules).map((group) => ({ ...group,
    nodes: group.nodeIds.map((id) => ({ id, ...rules.technologies[id], status: technologyStatus(state, factionId, id, rules) })) }));
  const directions = Object.entries(rules.policyDirections ?? {}).map(([id, config]) => ({ id, ...config,
    owned: counts[id] ?? 0,
    total: Object.values(rules.technologies ?? {}).filter((technology) => technology.direction === id).length,
    oppositionOwned: counts[config.opposite] ?? 0,
    costMultiplier: directionMultiplier(id, counts, rules), groups: groups.filter((group) => group.direction === id) }));
  return { points: nonnegativeInteger(faction?.researchPoints, nonnegativeInteger(rules.research?.initialPoints)),
    directions, groups, income: reformIncome(state, factionId, rules) };
}

/** Called once by the monthly clock; there is deliberately no gameplay storage cap. */
export function advanceResearch(state, rules) {
  const activeFactions = new Set((state.cities ?? []).map((city) => city.factionId));
  const reports = [];
  for (const faction of state.factions ?? []) {
    if (faction.id === NEUTRAL_FACTION_ID || !activeFactions.has(faction.id)) continue;
    normalizeFactionResearch(faction, rules);
    const income = reformIncome(state, faction.id, rules);
    faction.researchPoints += income.gain;
    reports.push({ factionId: faction.id, ...income, points: faction.researchPoints });
    if (faction.id === state.playerFactionId && income.gain) addEvent(state, `国策改革：改革力 +${income.gain}，现有 ${faction.researchPoints}。`);
    advanceHeavenCycle(faction, rules);
  }
  return reports;
}
