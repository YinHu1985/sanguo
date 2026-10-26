import { cityMapMetadata } from "./atlas.js";
import { dailyFoodCost } from "./economy.js";
import { formationOfficerIds, normalizeFormations } from "./army.js";
import { normalizeCityDefense } from "./city-defense.js";
import { normalizeCityEquipment, EQUIPMENT_KEYS } from "./equipment.js";
import { normalizeFactionResearch } from "./technology.js";
import { initializeHeavenCycle, normalizeHeavenCycle } from "./heaven-cycle.js";
import { activeAmbushPreparation } from "./stratagems.js";
import { restoreWarLocks } from "./war-state.js";
import { enableOfficerPlay } from "./character-state.js";

const LEGACY_STORAGE_KEY = "hanmo-zhoujun-save-v1";
export const storageKey = (scenarioId) => `hanmo-zhoujun-save-v2:${scenarioId}`;

function normalizeSavedFormations(formations, equipmentCommitted, active = true) {
  return normalizeFormations(formations).map((formation) => {
    // The old cavalry toggle had no horse cost. Never invent transferable horses
    // when reopening those orders under the equipment economy.
    if (active && !equipmentCommitted && !formation.composition && formation.unitType === "cavalry") {
      return { ...formation, unitType: "infantry" };
    }
    return formation;
  });
}

export function createInitialState(scenario, rules) {
  return {
    version: 1,
    economyVersion: 2,
    taskVersion: 1,
    armyVersion: 1,
    equipmentVersion: 1,
    researchVersion: 1,
    policyVersion: 1,
    tasks: [],
    nextTaskId: 1,
    turnResolution: null,
    lastTurnOpening: null,
    scenarioId: scenario.id,
    started: false,
    elapsedMonths: 0,
    relations: structuredClone(scenario.relations ?? {}),
    pendingInvasions: [],
    atlasVersion: scenario.atlasVersion,
    mapProjection: structuredClone(scenario.mapProjection),
    year: scenario.year,
    month: scenario.month,
    playerFactionId: scenario.playerFactionId,
    commandsMax: rules.commandsPerMonth,
    commandsRemaining: rules.commandsPerMonth,
    commandLimitEnabled: rules.commandLimitEnabled !== false,
    selectedCityId: scenario.cities.find((city) => city.factionId === scenario.playerFactionId)?.id,
    factions: structuredClone(scenario.factions).map((faction) => {
      normalizeFactionResearch(faction, rules);
      initializeHeavenCycle(faction);
      return faction;
    }),
    cities: scenario.cities.map((city) => normalizeCityEquipment({ ...structuredClone(city), ...normalizeCityDefense(city) }, rules)),
    officers: scenario.officers.map((officer) => ({ status: "active", ...structuredClone(officer), acted: false })),
    eventLog: [
      {
        id: crypto.randomUUID(),
        year: scenario.year,
        month: scenario.month,
        text: scenario.introduction ?? "群雄并起，请主公审时度势，颁布本月政令。"
      }
    ]
  };
}

export function loadState(scenario, rules) {
  try {
    const raw = localStorage.getItem(storageKey(scenario.id)) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    const saved = JSON.parse(raw);
    if (saved?.version === 1 && saved?.scenarioId === scenario.id) {
      const migrated = migrateState(saved, scenario, rules);
      const cleanupPlaceholders = hasPlaceholderReferences(saved, placeholderIds(saved, scenario));
      const upgradeEconomy = needsEconomyMigration(saved);
      const upgradeTasks = saved.taskVersion !== 1;
      const upgradeArmy = saved.armyVersion !== 1;
      const upgradeEquipment = saved.equipmentVersion !== 1;
      const upgradeResearch = saved.researchVersion !== 1;
      const upgradePolicies = saved.policyVersion !== 1;
      if (cleanupPlaceholders || upgradeEconomy || upgradeTasks || upgradeArmy || upgradeEquipment || upgradeResearch || upgradePolicies) {
        try {
          const backups = [
            ...(cleanupPlaceholders ? ["before-placeholder-cleanup"] : []),
            ...(upgradeEconomy ? ["before-economy-v2"] : []),
            ...(upgradeTasks ? ["before-tasks-v1"] : []),
            ...(upgradeArmy ? ["before-army-v1"] : []),
            ...(upgradeEquipment ? ["before-equipment-v1"] : []),
            ...(upgradeResearch ? ["before-research-v1"] : []),
            ...(upgradePolicies ? ["before-policies-v1"] : [])
          ];
          // All needed snapshots must exist before replacing the active slot.
          // A write failure returns the migrated in-memory campaign unchanged.
          for (const name of backups) {
            const backupKey = `${storageKey(scenario.id)}:${name}`;
            if (localStorage.getItem(backupKey) === null) localStorage.setItem(backupKey, raw);
          }
          saveState(migrated);
        } catch {
          // A full or disabled storage must not discard a valid campaign.
        }
      }
      return migrated;
    }
  } catch {
    // A damaged save should never prevent a fresh campaign.
  }
  return createInitialState(scenario, rules);
}

export function migrateState(saved, scenario, rules) {
  const initial = createInitialState(scenario, rules);
  const mergeEntities = (defaults, previous, refresh = () => ({})) => {
    const previousById = new Map((Array.isArray(previous) ? previous : []).map((entry) => [entry.id, entry]));
    const merged = defaults.map((entry) => {
      const old = previousById.get(entry.id);
      previousById.delete(entry.id);
      return { ...structuredClone(entry), ...structuredClone(old ?? {}), ...refresh(entry) };
    });
    return [...merged, ...structuredClone([...previousById.values()])];
  };
  const state = {
    ...initial,
    ...structuredClone(saved),
    // A gameplay toggle belongs to current rules, not an old save's setting.
    commandLimitEnabled: rules.commandLimitEnabled !== false,
    atlasVersion: scenario.atlasVersion,
    mapProjection: structuredClone(scenario.mapProjection),
    cities: mergeEntities(initial.cities, saved.cities, cityMapMetadata),
    factions: mergeEntities(initial.factions, saved.factions),
    officers: mergeEntities(initial.officers, saved.officers)
  };
  removePlaceholderOfficers(state, scenario);
  migrateEconomy(state, rules);
  state.armyVersion = 1;
  state.equipmentVersion = 1;
  state.researchVersion = 1;
  state.policyVersion = 1;
  for (const city of state.cities) {
    // Entity merging must not give an old campaign the scenario's opening stock.
    const oldCity = saved.cities?.find((entry) => entry.id === city.id);
    if (oldCity) for (const key of EQUIPMENT_KEYS) if (oldCity[key] === undefined) delete city[key];
    Object.assign(city, normalizeCityDefense(city));
    normalizeCityEquipment(city, rules);
    if (city.ambushPreparation && !activeAmbushPreparation(city, state)) delete city.ambushPreparation;
  }
  state.factions.forEach((faction) => {
    normalizeFactionResearch(faction, rules);
    // Old saves predating heaven cycles inherit the opening momentum. Explicit
    // saved phases (including neutral) always win over the new-game default.
    if (faction.heavenCycle === undefined) initializeHeavenCycle(faction);
    normalizeHeavenCycle(faction);
  });
  for (const invasion of state.pendingInvasions ?? []) {
    if (!Array.isArray(invasion.divisions)) continue;
    invasion.divisions = normalizeSavedFormations(invasion.divisions, invasion.equipment, !invasion.resolved);
    invasion.officerIds = invasion.divisions.flatMap(formationOfficerIds);
  }
  state.taskVersion = 1;
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  for (const task of state.tasks) {
    // Preserve the legality of funded pre-policy formations when ideas become reversible.
    if (saved.policyVersion !== 1 && task.kind === "march" && task.status === "running"
      && task.reservation?.status === "reserved" && !Array.isArray(task.formationTechnologies)) {
      task.formationTechnologies = [...(state.factions.find((entry) => entry.id === task.factionId)?.unlockedTechnologies ?? [])];
    }
    const equipmentReserved = EQUIPMENT_KEYS.some((key) => task.reservation?.[key] > 0);
    const active = ["running", "awaiting_battle"].includes(task.status);
    if (task.reservation) for (const key of EQUIPMENT_KEYS) if (task.reservation[key] === undefined) task.reservation[key] = 0;
    if (Array.isArray(task.payload?.divisions)) task.payload.divisions = normalizeSavedFormations(task.payload.divisions, equipmentReserved, active);
    if (Array.isArray(task.battle?.divisions)) {
      task.battle.divisions = normalizeSavedFormations(task.battle.divisions, task.battle.equipment, active);
      task.battle.armyOfficerIds = task.battle.divisions.flatMap(formationOfficerIds);
    }
  }
  state.nextTaskId = Number.isSafeInteger(state.nextTaskId) && state.nextTaskId > 0 ? state.nextTaskId : 1;
  const activeTasks = state.tasks.filter((task) => ["running", "awaiting_battle", "in_battle"].includes(task.status));
  for (const officer of state.officers) {
    const task = activeTasks.find((entry) => entry.officerIds?.includes(officer.id));
    if (task) { officer.taskId = task.id; officer.acted = true; }
    else if (officer.taskId) delete officer.taskId;
  }
  if (!state.cities.some((city) => city.id === state.selectedCityId)) state.selectedCityId = initial.selectedCityId;
  if (state.warCampaignsVersion === 1) {
    state.battles = Array.isArray(state.battles) ? state.battles : [];
    restoreWarLocks(state);
  }
  if (state.playerOfficerId) enableOfficerPlay(state, rules);
  return state;
}

function needsEconomyMigration(state) {
  return state.economyVersion !== 2 || (state.pendingInvasions ?? []).some((order) => !order.resolved && !order.supplies);
}

function migrateEconomy(state, rules) {
  for (const order of state.pendingInvasions ?? []) {
    if (order.resolved || order.supplies) continue;
    order.supplies = { food: 0, gold: 0 };
    const source = state.cities.find((city) => city.id === order.sourceId);
    if (!source || !order.attackerFactionId || source.factionId !== order.attackerFactionId) continue;
    const troopCount = Number.isFinite(order.troops) ? order.troops
      : (order.divisions ?? []).reduce((sum, division) => sum + (Number.isFinite(division.troops) ? Math.max(0, division.troops) : 0), 0);
    const food = Math.min(Math.max(0, source.food ?? 0), dailyFoodCost(troopCount, rules) * 30);
    const gold = Math.min(Math.max(0, source.gold ?? 0), 150);
    // Pre-economy armies are already deployed. Provision from their own city's
    // real stores once; never invent cargo, backdate income or charge a new fee.
    order.supplies = { food, gold };
    source.food = (source.food ?? 0) - food;
    source.gold = (source.gold ?? 0) - gold;
  }
  state.economyVersion = 2;
}

function placeholderIds(state, scenario) {
  return new Set([
    ...(scenario.removedPlaceholderOfficerIds ?? []),
    ...(state.officers ?? []).filter((officer) => officer.fictional === true).map((officer) => officer.id)
  ]);
}

function hasPlaceholderReferences(state, removedIds) {
  return (state.officers ?? []).some((officer) => removedIds.has(officer.id))
    || (state.cities ?? []).some((city) => removedIds.has(city.governorId) || city.officerIds?.some((id) => removedIds.has(id)))
    || (state.pendingInvasions ?? []).some((order) => order.officerIds?.some((id) => removedIds.has(id))
      || order.divisions?.some((division) => formationOfficerIds(division).some((id) => removedIds.has(id))));
}

function removePlaceholderOfficers(state, scenario) {
  const removedIds = placeholderIds(state, scenario);
  state.officers = state.officers.filter((officer) => !removedIds.has(officer.id));
  for (const city of state.cities) {
    city.officerIds = city.officerIds.filter((id) => !removedIds.has(id));
    if (removedIds.has(city.governorId)) city.governorId = null;
  }
  // Orders involving removed commanders are withdrawn, never reassigned to a
  // fabricated replacement. Return their troops without resetting the campaign.
  state.pendingInvasions = (state.pendingInvasions ?? []).filter((order) => {
    if (!order.officerIds?.some((id) => removedIds.has(id))
      && !order.divisions?.some((division) => formationOfficerIds(division).some((id) => removedIds.has(id)))) return true;
    if (!order.resolved) {
      const source = state.cities.find((city) => city.id === order.sourceId);
      const destination = source?.factionId === order.attackerFactionId ? source
        : state.cities.find((city) => city.factionId === order.attackerFactionId);
      if (destination) {
        if (order.troops > 0) {
          const total = destination.troops + order.troops;
          destination.training = Math.round((destination.training * destination.troops + (order.training ?? destination.training) * order.troops) / total);
          destination.morale = Math.round((destination.morale * destination.troops + (order.morale ?? destination.morale) * order.troops) / total);
          destination.troops = total;
        }
        destination.food += Math.max(0, order.supplies?.food ?? 0);
        destination.gold += Math.max(0, order.supplies?.gold ?? 0);
      }
    }
    return false;
  });
}

export function saveState(state) {
  localStorage.setItem(storageKey(state.scenarioId), JSON.stringify(state));
}

export function clearState(scenarioId) {
  localStorage.removeItem(storageKey(scenarioId));
}

export function archiveState(state) {
  if (state.started) localStorage.setItem(`${storageKey(state.scenarioId)}:previous`, JSON.stringify(state));
}

export function addEvent(state, text) {
  state.eventLog.unshift({
    id: crypto.randomUUID(),
    year: state.year,
    month: state.month,
    text
  });
  state.eventLog = state.eventLog.slice(0, 120);
}
