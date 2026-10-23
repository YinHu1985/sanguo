import { number } from "./components.js";
import { EQUIPMENT_NAMES } from "../game/equipment.js";

export const EQUIPMENT_LABELS = EQUIPMENT_NAMES;

/** Shared display only; production, reservation and transfer rules live in game/. */
export function equipmentStoresMarkup(city) {
  return Object.entries(EQUIPMENT_LABELS).map(([key, label]) =>
    `<div><span>${label}</span><strong data-equipment="${key}">${number(city?.[key])}</strong></div>`).join("");
}

export function equipmentSummary(equipment = {}) {
  return Object.entries(EQUIPMENT_LABELS).map(([key, label]) => `${label} ${number(equipment[key])}`).join(" · ");
}
