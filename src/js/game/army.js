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
  return (officers ?? []).reduce((sum, officer) => {
    const capacity = rules.ranks?.[officer?.rank] ?? 2000;
    return sum + (Number.isSafeInteger(capacity) && capacity >= 0 ? capacity : 0);
  }, 0);
}

export function armyLimits(rules) {
  return {
    maxUnits: Number.isSafeInteger(rules.army?.maxUnits) && rules.army.maxUnits > 0 ? rules.army.maxUnits : 5,
    maxOfficersPerUnit: Number.isSafeInteger(rules.army?.maxOfficersPerUnit) && rules.army.maxOfficersPerUnit > 0 ? rules.army.maxOfficersPerUnit : 5
  };
}

/** Automatic groups share troop pools; any troops beyond deployed group capacity remain reserves. */
export function createDefenderFormations(city, officers, rules) {
  const { maxUnits, maxOfficersPerUnit } = armyLimits(rules);
  const cityIds = new Set(city.officerIds ?? []);
  const commanders = (officers ?? []).filter((officer) => cityIds.has(officer.id)
    && !["free", "captured"].includes(officer.status)
    && officer.factionId === city.factionId && (!officer.locationCityId || officer.locationCityId === city.id))
    .sort((first, second) => (second.leadership ?? 0) - (first.leadership ?? 0))
    .slice(0, maxUnits * maxOfficersPerUnit);
  let available = Math.max(0, Math.floor(city.troops ?? 0));
  if (!available) return [];
  if (!commanders.length) {
    return [{ id: `garrison-${city.id}`, name: `${city.name}守军`, officerIds: [], officerId: null,
      unitType: "infantry", troops: Math.min(available, rules.army?.uncommandedCapacity ?? 2000) }];
  }
  const formations = [];
  for (let index = 0; index < commanders.length && available > 0; index += maxOfficersPerUnit) {
    const group = commanders.slice(index, index + maxOfficersPerUnit);
    const troops = Math.min(available, formationCapacity(group, rules));
    if (troops <= 0) continue;
    formations.push({ id: `garrison-${city.id}-${formations.length + 1}`, name: `${group[0].name}军`,
      officerIds: group.map((officer) => officer.id), officerId: group[0].id, troops, unitType: group[0].unitType ?? "infantry" });
    available -= troops;
  }
  return formations;
}
