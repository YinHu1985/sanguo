import { EQUIPMENT_KEYS } from "./equipment.js";
export { EQUIPMENT_KEYS, EQUIPMENT_NAMES } from "./equipment.js";

/** Troop counts and equipment are integers; one item outfits one matching soldier. */
export const troopTypes = (rules = {}) => rules.troopTypes ?? {
  infantry: { name: "步兵", unlocked: true, attack: 1, defense: 1, actionPoints: 6, initiative: 0, attackCost: 3, range: 0, rangedAttack: 0, rangedDefense: 1, vision: 4, equipment: {} }
};
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

/** Largest remainder allocation keeps every soldier accounted for after casualties. */
export function resizeComposition(composition, total) {
  const entries = Object.entries(composition).filter(([, count]) => integer(count) && count > 0);
  const before = entries.reduce((sum, [, count]) => sum + count, 0);
  total = integer(total) ? total : 0;
  if (!before || !total) return total ? { infantry: total } : {};
  const allocated = entries.map(([id, count], index) => ({ id, index, value: Math.floor(count * total / before), remainder: count * total % before }));
  let rest = total - allocated.reduce((sum, entry) => sum + entry.value, 0);
  for (const entry of [...allocated].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (!rest) break;
    entry.value += 1;
    rest -= 1;
  }
  return Object.fromEntries(allocated.filter((entry) => entry.value).map((entry) => [entry.id, entry.value]));
}

/** Read old single-type formations without mutating the save. */
export function formationComposition(formation, rules = {}) {
  if (formation?.composition && typeof formation.composition === "object" && !Array.isArray(formation.composition)) {
    return Object.fromEntries(Object.entries(formation.composition).filter(([, count]) => integer(count) && count > 0));
  }
  const count = integer(formation?.troops) ? formation.troops : 0;
  const type = formation?.unitType ?? "infantry";
  return count ? { [type]: count } : {};
}

export function primaryTroopType(composition) {
  return Object.entries(composition).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "infantry";
}

/** Reserved context hook for future officer traits, affinity and policies. */
export function unitTypeAvailability(typeId, { state, factionId, officers = [], rules = {}, unlockByOfficer } = {}) {
  const type = troopTypes(rules)[typeId];
  if (!type) return { available: false, reason: "未知兵种" };
  if (type.unlocked) return { available: true, reason: "初始兵种" };
  const faction = state?.factions?.find((entry) => entry.id === factionId);
  if (faction?.unlockedTechnologies?.includes(type.technology ?? typeId)) return { available: true, reason: "科技已解锁" };
  if (typeof unlockByOfficer === "function" && unlockByOfficer(typeId, officers, { state, factionId, rules })) {
    return { available: true, reason: "将领能力解锁" };
  }
  return { available: false, reason: "需在全局政策中研究兵种科技" };
}

export function compositionEquipment(composition, rules = {}) {
  const result = Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, 0]));
  for (const [id, count] of Object.entries(composition ?? {})) {
    for (const key of EQUIPMENT_KEYS) result[key] += Math.max(0, count) * (troopTypes(rules)[id]?.equipment?.[key] ?? 0);
  }
  return result;
}

export function sumEquipment(formations, rules = {}) {
  return (formations ?? []).reduce((sum, unit) => {
    const items = compositionEquipment(formationComposition(unit, rules), rules);
    for (const key of EQUIPMENT_KEYS) sum[key] += items[key];
    return sum;
  }, Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, 0])));
}

/** Passing either a composition or a formation is supported for engine callers. */
export function aggregateTroopStats(compositionOrUnit, rules = {}) {
  const composition = compositionOrUnit?.composition || compositionOrUnit?.troops !== undefined
    ? formationComposition(compositionOrUnit, rules) : compositionOrUnit ?? {};
  const types = troopTypes(rules);
  const totalTroops = Object.values(composition).reduce((sum, count) => sum + count, 0);
  const defaults = types.infantry;
  const average = (key, fallback = 0) => totalTroops ? Object.entries(composition).reduce((sum, [id, count]) => sum + count * (types[id]?.[key] ?? fallback), 0) / totalTroops : defaults?.[key] ?? fallback;
  const rangedTroops = Object.entries(composition).reduce((sum, [id, count]) => sum + ((types[id]?.range ?? 0) > 0 ? count : 0), 0);
  const meleeAttackTotal = Object.entries(composition).reduce((sum, [id, count]) => sum + count * (types[id]?.attack ?? 1), 0);
  const rangedAttackTotal = Object.entries(composition).reduce((sum, [id, count]) => sum + ((types[id]?.range ?? 0) > 0 ? count * (types[id]?.rangedAttack ?? 0) : 0), 0);
  return { totalTroops, attack: average("attack", 1), defense: average("defense", 1), actionPoints: average("actionPoints", 6),
    movement: average("actionPoints", 6), initiative: average("initiative"), attackCost: average("attackCost", 3),
    meleeAttackTotal, rangedAttackTotal, rangedDefense: average("rangedDefense", 1), vision: average("vision", 4),
    rangedAttack: totalTroops ? rangedAttackTotal / totalTroops : 0, rangedTroops,
    range: Math.max(0, ...Object.entries(composition).filter(([, count]) => count > 0).map(([id]) => types[id]?.range ?? 0)) };
}

const positiveFinite = (value) => Number.isFinite(value) && value > 0;
const validLoss = (loss) => Number.isFinite(loss) && loss >= 0;
const validCounts = (composition) => composition && typeof composition === "object" && !Array.isArray(composition)
  && Object.values(composition).every(integer) && integer(Object.values(composition).reduce((sum, count) => sum + count, 0));

/** Exposure affects who takes an already-calculated loss, never total damage. */
export function casualtyExposure(typeId, rules = {}, damageType = "attrition") {
  const profile = rules.battle?.casualties?.profiles?.[damageType];
  const configured = profile?.[typeId];
  return positiveFinite(configured) ? configured : positiveFinite(profile?.default) ? profile.default : 1;
}

// Exact decimal weights avoid overflow/underflow even with finite custom
// coefficients such as 1e308 or 5e-324. Counts and returned losses remain Numbers.
function decimalWeight(value) {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  return { digits: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
}

/** Capped weighted largest-remainder allocation, stable in source entry order. */
function allocateWeightedCounts(entries, loss) {
  const allocated = Array(entries.length).fill(0);
  let active = entries.map((entry, index) => ({ ...entry, index, decimal: decimalWeight(entry.coefficient) })).filter((entry) => entry.count > 0);
  let remaining = Math.min(Math.floor(loss), active.reduce((sum, entry) => sum + entry.count, 0));
  while (remaining > 0 && active.length) {
    const exponent = Math.min(...active.map((entry) => entry.decimal.exponent));
    const weighted = active.map((entry) => ({ ...entry,
      weight: BigInt(entry.count) * entry.decimal.digits * 10n ** BigInt(entry.decimal.exponent - exponent) }));
    const denominator = weighted.reduce((sum, entry) => sum + entry.weight, 0n);
    const shares = weighted.map((entry) => ({ ...entry, numerator: BigInt(remaining) * entry.weight }));
    const saturated = shares.filter((entry) => entry.numerator >= BigInt(entry.count) * denominator);
    if (saturated.length) {
      const saturatedIndices = new Set(saturated.map((entry) => entry.index));
      for (const entry of saturated) { allocated[entry.index] = entry.count; remaining -= entry.count; }
      active = active.filter((entry) => !saturatedIndices.has(entry.index));
      continue;
    }
    for (const entry of shares) {
      allocated[entry.index] = Number(entry.numerator / denominator);
      entry.remainder = entry.numerator % denominator;
      remaining -= allocated[entry.index];
    }
    shares.sort((first, second) => first.remainder === second.remainder ? first.index - second.index
      : first.remainder > second.remainder ? -1 : 1);
    for (const entry of shares) {
      if (!remaining) break;
      allocated[entry.index] += 1;
      remaining -= 1;
    }
    break;
  }
  return allocated;
}

/** Pure type-to-loss map. Missing, malformed or negative input is a safe no-op. */
export function allocateTroopLosses(composition, loss, rules = {}, damageType = "attrition") {
  if (!validCounts(composition) || !validLoss(loss)) return {};
  const entries = Object.entries(composition).filter(([, count]) => count > 0);
  const allocated = allocateWeightedCounts(entries.map(([id, count]) => ({ count, coefficient: casualtyExposure(id, rules, damageType) })), loss);
  return Object.fromEntries(entries.flatMap(([id], index) => allocated[index] ? [[id, allocated[index]]] : []));
}

/**
 * Allocate one army-wide loss by troop type first, then distribute each type's
 * casualties across its formations by headcount. Splitting a formation cannot
 * dilute exposure or evade losses. No combat-stat dependency or saved state.
 */
export function applyArmyLosses(formations, loss, rules = {}, damageType = "attrition") {
  if (!Array.isArray(formations) || new Set(formations).size !== formations.length || !validLoss(loss)
    || formations.some((unit) => !unit || typeof unit !== "object" || !integer(unit.troops)
      || (unit.composition !== undefined && !validCounts(unit.composition)))) return 0;
  const compositions = formations.map((unit) => {
    const composition = formationComposition(unit, rules);
    return Object.values(composition).reduce((sum, count) => sum + count, 0) === unit.troops
      ? composition : resizeComposition(composition, unit.troops);
  });
  const combined = new Map();
  for (const composition of compositions) {
    for (const [id, count] of Object.entries(composition)) combined.set(id, (combined.get(id) ?? 0) + count);
  }
  const allTroops = Object.fromEntries(combined);
  if (!validCounts(allTroops)) return 0;
  const casualties = allocateTroopLosses(allTroops, loss, rules, damageType);
  for (const [id, count] of Object.entries(casualties)) {
    const assigned = allocateWeightedCounts(compositions.map((composition) => ({ count: composition[id] ?? 0, coefficient: 1 })), count);
    compositions.forEach((composition, index) => {
      if (!assigned[index]) return;
      composition[id] -= assigned[index];
      if (!composition[id]) delete composition[id];
    });
  }
  formations.forEach((unit, index) => {
    unit.composition = compositions[index];
    unit.troops = Object.values(unit.composition).reduce((sum, count) => sum + count, 0);
    unit.unitType = primaryTroopType(unit.composition);
  });
  return Object.values(casualties).reduce((sum, count) => sum + count, 0);
}

export function applyFormationLosses(unit, loss, rules = {}, damageType = "attrition") {
  return applyArmyLosses([unit], loss, rules, damageType);
}

export function validateComposition(formation, context = {}) {
  const { rules = {} } = context;
  const raw = formation?.composition;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.values(raw).some((count) => !integer(count)))) return { ok: false, message: "各兵种人数须为非负整数" };
  const composition = formationComposition(formation, rules);
  const total = Object.values(composition).reduce((sum, count) => sum + count, 0);
  if (!integer(formation?.troops) || total !== formation.troops) return { ok: false, message: "各兵种人数合计必须等于部队兵力" };
  for (const id of Object.keys(raw ?? composition)) {
    if (!troopTypes(rules)[id]) return { ok: false, message: "编组包含未知兵种" };
    if ((composition[id] ?? 0) === 0) continue;
    const unlocked = unitTypeAvailability(id, context);
    if (!unlocked.available) return { ok: false, message: `${troopTypes(rules)[id].name}尚未解锁` };
  }
  return { ok: true, composition, equipment: compositionEquipment(composition, rules) };
}

/** Auto-composition consumes only a local budget, never the real warehouse. */
export function autoComposition(troops, equipmentBudget, context = {}) {
  const result = {};
  const desired = Math.floor(troops / 5);
  let remaining = troops;
  for (const id of ["dragoon", "heavyCavalry", "guard", "raiderCavalry", "heavyInfantry", "crossbowman", "cavalry"]) {
    if (!unitTypeAvailability(id, context).available || !remaining) continue;
    const cost = troopTypes(context.rules)[id]?.equipment ?? {};
    const capacity = Math.min(remaining, desired, ...Object.entries(cost).map(([key, per]) => Math.floor((equipmentBudget[key] ?? 0) / per)));
    if (capacity <= 0) continue;
    result[id] = capacity;
    remaining -= capacity;
    for (const [key, per] of Object.entries(cost)) equipmentBudget[key] -= capacity * per;
  }
  if (remaining > 0) {
    const archers = Math.min(remaining, Math.floor(troops / 4));
    if (archers) result.archer = archers;
    if (remaining > archers) result.infantry = remaining - archers;
  }
  return result;
}

export function addEquipment(city, equipment) {
  for (const key of EQUIPMENT_KEYS) city[key] = (city[key] ?? 0) + (equipment?.[key] ?? 0);
}

export function equipmentAvailable(city, equipment) {
  return EQUIPMENT_KEYS.every((key) => integer(city[key] ?? 0) && integer(equipment[key] ?? 0) && (city[key] ?? 0) >= (equipment[key] ?? 0));
}
