import { addEvent } from "./state.js";
import { NEUTRAL_FACTION_ID } from "./atlas.js";

const nonnegativeInteger = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;

/** Research belongs to a faction, not to a city or the player's UI. */
export function normalizeFactionResearch(faction, rules) {
  faction.researchPoints = nonnegativeInteger(faction.researchPoints, nonnegativeInteger(rules.research?.initialPoints));
  faction.unlockedTechnologies = [...new Set((Array.isArray(faction.unlockedTechnologies) ? faction.unlockedTechnologies : [])
    .filter((id) => typeof id === "string" && id.length > 0))];
  return faction;
}

export function technologyStatus(state, factionId, technologyId, rules) {
  const faction = state.factions?.find((entry) => entry.id === factionId);
  const technology = rules.technologies?.[technologyId];
  const points = nonnegativeInteger(faction?.researchPoints, nonnegativeInteger(rules.research?.initialPoints));
  const cost = technology?.cost;
  const unlocked = faction?.unlockedTechnologies?.includes(technologyId) ?? false;
  const affordable = Number.isSafeInteger(cost) && cost >= 0 && points >= cost;
  const base = { unlocked, affordable, points, cost, technology };
  if (!faction || factionId === NEUTRAL_FACTION_ID) return { ...base, ok: false, message: "势力无效" };
  if (!technology || !Number.isSafeInteger(cost) || cost < 0) return { ...base, ok: false, message: "科技配置无效" };
  if (unlocked) return { ...base, ok: false, message: "此科技已经研习" };
  if (!state.cities?.some((city) => city.factionId === factionId)) return { ...base, ok: false, message: "势力已无据点" };
  if (!affordable) return { ...base, ok: false, message: `研究点不足，需要 ${cost}` };
  return { ...base, ok: true, message: "可以研习" };
}

/** A global policy decision is immediate and consumes no city command or actor. */
export function unlockTechnology(state, factionId, technologyId, rules) {
  if (factionId !== state.playerFactionId) return { ok: false, message: "只能研习本势力科技" };
  if (state.turnResolution || (state.tasks ?? []).some((task) => task.status === "awaiting_battle")) {
    return { ok: false, message: "请先完成当前回合结算或战斗" };
  }
  const status = technologyStatus(state, factionId, technologyId, rules);
  if (!status.ok) return status;
  const faction = state.factions.find((entry) => entry.id === factionId);
  normalizeFactionResearch(faction, rules);
  faction.researchPoints -= status.cost;
  faction.unlockedTechnologies.push(technologyId);
  const message = `研习「${status.technology.name ?? technologyId}」，研究点 -${status.cost}`;
  addEvent(state, `${faction.name}：${message}。`);
  return { ok: true, message, technologyId, cost: status.cost, points: faction.researchPoints };
}

/** Called once by the monthly clock; there is deliberately no gameplay storage cap. */
export function advanceResearch(state, rules) {
  const gain = nonnegativeInteger(rules.research?.monthlyGain, 100);
  const activeFactions = new Set((state.cities ?? []).map((city) => city.factionId));
  const reports = [];
  for (const faction of state.factions ?? []) {
    if (faction.id === NEUTRAL_FACTION_ID || !activeFactions.has(faction.id)) continue;
    normalizeFactionResearch(faction, rules);
    faction.researchPoints += gain;
    reports.push({ factionId: faction.id, gain, points: faction.researchPoints });
    if (faction.id === state.playerFactionId && gain) addEvent(state, `国策研究：研究点 +${gain}，现有 ${faction.researchPoints}。`);
  }
  return reports;
}
