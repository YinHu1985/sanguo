import { autoComposition, EQUIPMENT_KEYS, primaryTroopType } from "./troops.js";

const ABILITIES = ["war", "intelligence", "leadership", "politics", "charm"];

/** officerIds is authoritative; the singular field remains readable for old saves. */
export function formationOfficerIds(formation) {
  return Array.isArray(formation?.officerIds) ? [...formation.officerIds]
    : typeof formation?.officerId === "string" ? [formation.officerId] : [];
}

export function normalizeFormations(formations) {
  if (!Array.isArray(formations)) return [];
  return formations.map((formation) => {
    const officerIds = formationOfficerIds(formation);
    return { ...formation, officerIds, officerId: officerIds[0] ?? null, unitType: formation?.unitType ?? "infantry" };
  });
}

/** Ability aggregation is centralized so terrain, traits and weather can be added here later. */
export function aggregateAbilities(officers, context = {}) {
  void context;
  return Object.fromEntries(ABILITIES.map((key) => [key,
    Math.max(0, ...(officers ?? []).map((officer) => Number.isFinite(officer?.[key]) ? officer[key] : 0))]));
}

export function formationCapacity(officers, rules) {
  const commander = officers?.[0];
  if (!commander) return 0;
  const capacity = rules.ranks?.[commander.rank] ?? 2000;
  return Number.isSafeInteger(capacity) && capacity >= 0 ? capacity : 0;
}

export function armyLimits(rules) {
  return {
    maxUnits: Number.isSafeInteger(rules.army?.maxUnits) && rules.army.maxUnits > 0 ? rules.army.maxUnits : 8,
    maxOfficersPerUnit: Number.isSafeInteger(rules.army?.maxOfficersPerUnit) && rules.army.maxOfficersPerUnit > 0 ? rules.army.maxOfficersPerUnit : 3,
    maxSupplyDays: Number.isSafeInteger(rules.army?.maxSupplyDays) && rules.army.maxSupplyDays > 0 ? rules.army.maxSupplyDays : 60
  };
}

/** Shared player/AI policy: choose enough capable leaders, then attach up to two advisers per formation. */
export function groupOfficersForArmy(officers, rules, { troops = Infinity, minTroops = 1 } = {}) {
  const { maxUnits, maxOfficersPerUnit } = armyLimits(rules);
  const minimum = Number.isSafeInteger(minTroops) && minTroops > 0 ? minTroops : 1;
  const pool = [...new Map((officers ?? []).filter((officer) => officer && typeof officer.id === "string")
    .map((officer) => [officer.id, officer])).values()]
    .sort((first, second) => formationCapacity([second], rules) - formationCapacity([first], rules)
      || (second.leadership ?? 0) - (first.leadership ?? 0) || first.id.localeCompare(second.id));
  let remaining = troops === Infinity ? Infinity : Math.max(0, Math.floor(Number(troops) || 0));
  const groups = [], leaders = new Set();
  for (const officer of pool) {
    if (groups.length >= maxUnits || remaining < minimum) break;
    const deployed = Math.min(remaining, formationCapacity([officer], rules));
    if (deployed < minimum) continue;
    groups.push([officer]); leaders.add(officer.id); remaining -= deployed;
  }
  const advisers = pool.filter((officer) => !leaders.has(officer.id)).sort((first, second) =>
    ABILITIES.reduce((sum, key) => sum + (Number(second[key]) || 0) - (Number(first[key]) || 0), 0)
    || first.id.localeCompare(second.id));
  let next = 0;
  for (const adviser of advisers) {
    if (!groups.length || groups.every((group) => group.length >= maxOfficersPerUnit)) break;
    while (groups[next % groups.length].length >= maxOfficersPerUnit) next += 1;
    groups[next % groups.length].push(adviser); next += 1;
  }
  return groups;
}

/** Automatic groups share troop pools; any troops beyond deployed group capacity remain reserves. */
export function createDefenderFormations(city, officers, rules, context = {}) {
  const cityIds = new Set(city.officerIds ?? []);
  const commanders = (officers ?? []).filter((officer) => cityIds.has(officer.id)
    && !["free", "captured"].includes(officer.status)
    && officer.factionId === city.factionId && (!officer.locationCityId || officer.locationCityId === city.id));
  let available = Math.max(0, Math.floor(city.troops ?? 0));
  const equipment = Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, Math.max(0, city[key] ?? 0)]));
  const compositionFor = (troops, members) => autoComposition(troops, equipment, { ...context, factionId: city.factionId, officers: members, rules });
  if (!available) return [];
  if (!commanders.length) {
    const troops = Math.min(available, rules.army?.uncommandedCapacity ?? 2000);
    const composition = compositionFor(troops, []);
    return [{ id: `garrison-${city.id}`, name: `${city.name}守军`, officerIds: [], officerId: null,
      unitType: primaryTroopType(composition), troops, composition }];
  }
  const formations = [];
  for (const group of groupOfficersForArmy(commanders, rules, { troops: available, minTroops: context.minTroops })) {
    const troops = Math.min(available, formationCapacity(group, rules));
    if (troops <= 0) continue;
    const composition = compositionFor(troops, group);
    formations.push({ id: `garrison-${city.id}-${formations.length + 1}`, name: `${group[0].name}军`,
      officerIds: group.map((officer) => officer.id), officerId: group[0].id, troops, unitType: primaryTroopType(composition), composition });
    available -= troops;
  }
  return formations;
}
