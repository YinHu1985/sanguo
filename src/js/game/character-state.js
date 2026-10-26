export const ABILITIES = { war: "武力", intelligence: "智力", leadership: "统帅", politics: "内政", charm: "魅力" };
export const playerOfficer = state => state.playerOfficerId ? state.officers?.find(o => o.id === state.playerOfficerId) : undefined;
export const officerCity = (state, officer = playerOfficer(state)) => state.cities.find(c => c.id === officer?.locationCityId)
  ?? state.cities.find(c => c.officerIds.includes(officer?.id));

export function normalizeCharacter(officer) {
  officer.birthYear ??= null;
  officer.deathYear ??= null;
  officer.historicalDeathCause ??= null;
  officer.conditions ??= [];
  officer.fame ??= 0;
  officer.skills ??= [];
  officer.treasures ??= [];
  officer.growth ??= Object.fromEntries(Object.keys(ABILITIES).map(key => [key, 0]));
  officer.relationships ??= {};
}

export function enableOfficerPlay(state, rules, id = state.playerOfficerId) {
  const faction = state.factions.find(f => f.id === state.playerFactionId);
  const officer = state.officers.find(o => o.id === id) ?? state.officers.find(o => o.factionId === faction?.id && (o.rank === "君主" || o.id === faction.lord || o.name === faction.lord))
    ?? state.officers.find(o => o.factionId === state.playerFactionId);
  if (!officer) throw new Error("存档没有可接续的主角");
  state.playerOfficerId = officer.id;
  state.characterVersion = 1;
  state.officers.forEach(normalizeCharacter);
  state.personal ??= { ap: rules.character?.monthlyAP ?? 100, gold: rules.character?.startingGold ?? 200, journal: [], rewardReceipts: [], monthlyTurn: state.elapsedMonths ?? 0 };
  state.personal.gold ??= rules.character?.startingGold ?? 200;
  state.personal.assignments ??= [];
  state.personal.assignmentSequence ??= 0;
  state.personal.rewardReceipts ??= [];
  state.personal.journal ??= [];
  state.commandLimitEnabled = false;
  syncPlayerIdentity(state);
  return state;
}

export function syncPlayerIdentity(state) {
  if (!state.playerOfficerId) return;
  const officer = playerOfficer(state);
  if (!officer) return;
  const factionExists = state.cities.some(c => c.factionId === officer.factionId)
    || state.battles?.some(b => b.status !== "ended" && b.attackerFactionId === officer.factionId);
  // Personal careers survive a faction's defeat. Captivity is released into free service in this POC.
  if (officer.status === "captured" || (!factionExists && officer.factionId !== "neutral" && !officer.battleId)) {
    officer.status = "free"; officer.factionId = "neutral"; delete officer.captorFactionId;
  }
  state.playerFactionId = officer.status === "free" ? "neutral" : officer.factionId;
}

export function growOfficer(officer, ability, xp) {
  normalizeCharacter(officer);
  if (!(ability in ABILITIES)) return 0;
  officer.growth[ability] = (officer.growth[ability] ?? 0) + xp;
  let gained = 0;
  while (officer.growth[ability] >= 100 && officer[ability] < 100) {
    officer.growth[ability] -= 100; officer[ability] += 1; gained += 1;
  }
  if (officer[ability] >= 100) officer.growth[ability] = Math.min(99, officer.growth[ability]);
  return gained;
}

export function refreshPersonalMonth(state, rules) {
  if (!state.playerOfficerId) return;
  syncPlayerIdentity(state);
  if (state.personal.monthlyTurn === state.elapsedMonths) return;
  state.personal.monthlyTurn = state.elapsedMonths;
  state.personal.ap = rules.character?.monthlyAP ?? 100;
}
