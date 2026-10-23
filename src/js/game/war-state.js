export const activeBattleCampaigns = (state) => (state.battles ?? []).filter((battle) => battle.status !== "ended");
export const cityBattle = (state, cityId) => activeBattleCampaigns(state).find((battle) => battle.targetCityId === cityId) ?? null;
export const cityBesieged = (state, cityId) => Boolean(cityBattle(state, cityId));
export const officerAtWar = (state, officerId) => activeBattleCampaigns(state).some((battle) => battle.officerIds?.includes(officerId))
  || (state.warCampaignsVersion === 1 && ((state.pendingInvasions ?? []).some((invasion) => !invasion.resolved && invasion.officerIds?.includes(officerId))
    || (state.tasks ?? []).some((task) => task.status === "awaiting_battle" && task.officerIds?.includes(officerId))));

/** Combatants pay daily battlefield food; never a second full garrison month. */
export function markWarRations(city, turn, troops, { replace = false, days = 30 } = {}) {
  const previous = city.warRationTurn === turn ? city.warRationTroopDays ?? 0 : 0;
  city.warRationTurn = turn;
  city.warRationTroopDays = (replace ? 0 : previous) + troops * Math.max(0, Math.min(30, days));
}

export function ordinaryGarrisonTroops(state, city) {
  if (cityBesieged(state, city.id)) return 0;
  const closingTurn = state.turnResolution?.targetTurn ?? (state.elapsedMonths ?? 0) + 1;
  return Math.max(0, city.troops - (city.warRationTurn === closingTurn ? (city.warRationTroopDays ?? 0) / 30 : 0));
}

/** Between tactical slices the city is the sole writable defender warehouse. */
export function syncCampaignEconomy(state) {
  for (const record of activeBattleCampaigns(state)) {
    const city = state.cities.find((entry) => entry.id === record.targetCityId);
    if (city?.factionId === record.defenderFactionId && record.snapshot?.supplies) {
      record.snapshot.supplies.enemy = { food: city.food, gold: city.gold };
      // A pre-month tactical instance cannot overwrite the newly paid tax or harvest.
      record.revision = (record.revision ?? 0) + 1;
      record.snapshot.campaignRevision = record.revision;
    }
  }
}

export function restoreWarLocks(state) {
  for (const officer of state.officers) delete officer.battleId;
  for (const city of state.cities) delete city.battleId;
  for (const record of activeBattleCampaigns(state)) {
    const city = state.cities.find((entry) => entry.id === record.targetCityId);
    if (city) city.battleId = record.id;
    for (const id of record.officerIds ?? []) {
      const officer = state.officers.find((entry) => entry.id === id);
      if (officer) { officer.battleId = record.id; officer.acted = true; }
    }
  }
}
