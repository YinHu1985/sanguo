import { NEUTRAL_FACTION_ID } from "./atlas.js";

const DEFAULTS = Object.freeze({
  maxStrength: 6,
  monthlyStrengthGain: 1,
  victoryPenaltyPerStrength: 0.1,
  defeatBonusPerStrength: 0.1
});
const integer = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const round = (value) => Math.round(value * 1e6) / 1e6;
const phaseFor = (outcome) => ["win", "victory"].includes(outcome) ? "victory" : ["loss", "defeat"].includes(outcome) ? "defeat" : null;

function configFor(rules = {}) {
  const config = rules?.research?.heavenCycle ?? {};
  const rate = (key) => Number.isFinite(config[key]) && config[key] >= 0 && config[key] <= 1 ? config[key] : DEFAULTS[key];
  return {
    maxStrength: Number.isSafeInteger(config.maxStrength) && config.maxStrength > 0 ? config.maxStrength : DEFAULTS.maxStrength,
    monthlyStrengthGain: integer(config.monthlyStrengthGain, DEFAULTS.monthlyStrengthGain),
    victoryPenaltyPerStrength: rate("victoryPenaltyPerStrength"),
    defeatBonusPerStrength: rate("defeatBonusPerStrength")
  };
}

function cycleData(faction) {
  const saved = faction?.heavenCycle;
  const phase = faction?.id !== NEUTRAL_FACTION_ID && ["victory", "defeat"].includes(saved?.phase) ? saved.phase : "neutral";
  return {
    phase,
    // Store the event counter independently of the configured limit. Changing
    // balance data never requires rewriting saves or ownership transactions.
    strength: phase === "neutral" ? 0 : Math.max(1, integer(saved?.strength, 1)),
    lastReason: faction?.id !== NEUTRAL_FACTION_ID && typeof saved?.lastReason === "string" ? saved.lastReason.slice(0, 240) : ""
  };
}

/** Starting momentum is a scenario default, not a historical victory event. */
export function initializeHeavenCycle(faction) {
  const cycle = { phase: faction?.id === NEUTRAL_FACTION_ID ? "neutral" : "victory",
    strength: faction?.id === NEUTRAL_FACTION_ID ? 0 : 1, lastReason: "" };
  if (faction && typeof faction === "object") faction.heavenCycle = cycle;
  return cycle;
}

/** Normalize existing saves without replacing their phase or progress. */
export function normalizeHeavenCycle(faction) {
  const cycle = cycleData(faction);
  if (faction && typeof faction === "object") faction.heavenCycle = cycle;
  return cycle;
}

/** Pure view used by income calculation and UI; numeric tuning lives in rules. */
export function heavenCycleStatus(faction, rules = {}) {
  const config = configFor(rules), cycle = cycleData(faction);
  const strength = Math.min(config.maxStrength, cycle.strength);
  const progress = strength / config.maxStrength;
  const multiplier = round(cycle.phase === "victory" ? Math.max(0, 1 - strength * config.victoryPenaltyPerStrength)
    : cycle.phase === "defeat" ? 1 + strength * config.defeatBonusPerStrength : 1);
  const label = cycle.phase === "neutral" ? "天意未动" : cycle.phase === "victory"
    ? progress >= 1 ? "骄兵必败" : "胜兵必骄"
    : progress >= 1 ? "哀兵必胜" : "败兵必哀";
  const angle = cycle.phase === "victory" ? 180 + 180 * progress : cycle.phase === "defeat" ? 180 * progress : 180;
  const change = Math.round((multiplier - 1) * 100);
  const description = cycle.phase === "neutral" ? "尚无胜败事件，改革力收入不受天意影响。"
    : `${cycle.phase === "victory" ? "胜势使改革渐难" : "败势激起改革之志"}，改革力收入 ${change >= 0 ? "+" : ""}${change}%。`
      + (strength < config.maxStrength ? "随月份与同类胜败事件逐渐加强；反向事件立即重置。" : "已达当前上限；反向事件立即重置。");
  return { ...cycle, strength, maxStrength: config.maxStrength, progress, multiplier, label, angle, description };
}

/** The caller records actual committed outcomes, not previews or rejected orders. */
export function recordHeavenOutcome(state, factionId, outcome, { reason = "" } = {}) {
  const phase = phaseFor(outcome);
  const faction = state?.factions?.find((entry) => entry.id === factionId);
  if (!phase || !faction || factionId === NEUTRAL_FACTION_ID) return null;
  const current = normalizeHeavenCycle(faction);
  faction.heavenCycle = {
    phase,
    strength: current.phase === phase ? Math.min(Number.MAX_SAFE_INTEGER, current.strength + 1) : 1,
    lastReason: typeof reason === "string" ? reason.slice(0, 240) : ""
  };
  return faction.heavenCycle;
}

/** Run after this month's income: strengthening affects the following month. */
export function advanceHeavenCycle(faction, rules = {}) {
  const current = normalizeHeavenCycle(faction), config = configFor(rules);
  if (current.phase !== "neutral") current.strength = Math.min(config.maxStrength, current.strength + config.monthlyStrengthGain);
  return heavenCycleStatus(faction, rules);
}

/** Shared by occupations and diplomatic annexations, including AI-versus-AI. */
export function transferCityOwnership(state, city, factionId, { reason = "" } = {}) {
  const previousFactionId = city?.factionId;
  if (!city || typeof factionId !== "string" || !factionId || previousFactionId === factionId) {
    return { changed: false, previousFactionId, factionId: previousFactionId };
  }
  city.factionId = factionId;
  recordHeavenOutcome(state, previousFactionId, "defeat", { reason: reason || `失去${city.name ?? city.id}` });
  recordHeavenOutcome(state, factionId, "victory", { reason: reason || `取得${city.name ?? city.id}` });
  return { changed: true, previousFactionId, factionId };
}
