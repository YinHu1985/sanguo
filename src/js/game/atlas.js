export const NEUTRAL_FACTION_ID = "neutral";

// These fields belong to the map, not to the player's campaign progress.
export const CITY_MAP_FIELDS = [
  "name", "province", "region", "longitude", "latitude", "x", "y", "mapX", "mapY",
  "aliases", "labelSide", "labelDy", "adjacent"
];

export function projectCity(city, projection) {
  return {
    x: (city.longitude - projection.west) / (projection.east - projection.west) * projection.width,
    y: (projection.north - city.latitude) / (projection.north - projection.south) * projection.height
  };
}

export function cityMapMetadata(city) {
  return Object.fromEntries(CITY_MAP_FIELDS.filter((field) => field in city).map((field) => [field, structuredClone(city[field])]));
}

export function applyAtlasToScenario(scenario, atlas) {
  const enriched = structuredClone(scenario);
  const existingCities = new Map(enriched.cities.map((city) => [city.id, city]));
  const atlasIds = new Set(atlas.cities.map((city) => city.id));
  enriched.cities = atlas.cities.map((entry) => {
    const existing = existingCities.get(entry.id);
    const position = projectCity(entry, atlas.projection);
    const aliases = [...new Set([...(entry.aliases ?? []), ...(existing && existing.name !== entry.name ? [existing.name] : [])])];
    return {
      agriculture: 35,
      commerce: 30,
      popularSupport: 55,
      gold: 500,
      food: 3000,
      troops: 0,
      training: 0,
      morale: 50,
      factionId: NEUTRAL_FACTION_ID,
      officerIds: [],
      governorId: null,
      ...existing,
      ...structuredClone(entry),
      aliases,
      ...position,
      mapX: position.x,
      mapY: position.y
    };
  });
  // A later custom scenario may contain a city not yet present in the common atlas.
  enriched.cities.push(...[...existingCities.values()].filter((city) => !atlasIds.has(city.id)));
  if (!enriched.factions.some((faction) => faction.id === NEUTRAL_FACTION_ID)) {
    enriched.factions.push({ id: NEUTRAL_FACTION_ID, name: "空城", lord: null, color: "#8b8778", accent: "#ddd3b8" });
  }
  enriched.atlasVersion = atlas.version;
  enriched.mapProjection = structuredClone(atlas.projection);
  return enriched;
}
