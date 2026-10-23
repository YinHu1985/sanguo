import { NEUTRAL_FACTION_ID } from "./atlas.js";

export const EQUIPMENT_KEYS = ["horses", "crossbows", "armor"];
export const EQUIPMENT_NAMES = { horses: "良马", crossbows: "劲弩", armor: "甲胄" };

/** Only absent fields receive starting stock; depleted stores remain depleted. */
export function normalizeCityEquipment(city, rules) {
  const occupied = city.factionId && city.factionId !== NEUTRAL_FACTION_ID;
  const troops = Number.isSafeInteger(city.troops) && city.troops >= 0 ? city.troops : 0;
  const ratios = { horses: 0.2, crossbows: 0.15, armor: 0.25, ...rules.equipment?.initialRatios };
  for (const key of EQUIPMENT_KEYS) {
    if (city[key] === undefined) city[key] = occupied ? Math.max(0, Math.floor(troops * ratios[key])) : 0;
    else if (!Number.isSafeInteger(city[key]) || city[key] < 0) city[key] = 0;
  }
  return city;
}
