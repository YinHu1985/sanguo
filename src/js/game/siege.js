import { calculateCombatStats } from "./combat-stats.js";

export const ATTACK_ORDERS = { ram: "撞门", assault: "蚁附", tunnel: "地道" };
export const DEFENSE_ORDERS = { rotate: "轮换修整", repair: "修补城墙", sortie: "出城袭扰" };

const DEFAULTS = {
  effectiveTroopCaps: { 1: 20000, 2: 35000, 3: 50000 }, layerHp: 100,
  effectiveTroopCap: 30000, hitPointsByLevel: { 1: 100, 2: 160, 3: 220 },
  baseProgressPerThousand: 3, defenseProgressPenalty: 0.006, minimumProgressMultiplier: 0.25,
  attackerLossRate: 0.018, defenderLossRate: 0.012, encirclementMultiplier: 1.25,
  deceiveChanceBase: 0.35, deceiveIntelligenceScale: 200, deceiveProgress: 25, deceiveDefenseDamage: 10,
  interceptLossRate: 0.07, interceptCounterRate: 0.025, encircledRetreatLossRate: 0.12,
  strategyChanceBase: 0.5, intelligenceChanceScale: 200, minimumStrategyChance: 0.1, maximumStrategyChance: 0.9,
  interceptionAbilityBase: 0.5, interceptionWarWeight: 0.5, interceptionLeadershipWeight: 0.5, interceptionAbilityDivisor: 100,
  minimumCombatRatio: 0.5, maximumCombatRatio: 2,
  qualityBase: 0.6, qualityLeadershipDivisor: 250, qualityTrainingDivisor: 250, qualityMoraleDivisor: 250,
  aiDeceiveIntelligenceAdvantage: 10, aiTunnelDefenseThreshold: 60, aiTunnelIntelligenceThreshold: 75,
  aiAssaultTroopRatio: 1.5, aiRetreatTroopRatio: 0.35, aiRotateMoraleThreshold: 60,
  aiRepairDefenseThreshold: 55, aiSortieTroopRatio: 1.3,
  strategyOutcomes: {
    tunnel: { success: { progress: 1.8, attackerLoss: 0.8, defenderLoss: 1.5 }, failure: { progress: 0.2, attackerLoss: 1.5, defenderLoss: 0.4 } },
    sortie: { success: { progress: 0.4, attackerLoss: 1.6, defenderLoss: 0.6 }, failure: { progress: 1.1, attackerLoss: 0.4, defenderLoss: 1.8 } }
  },
  attackCommands: {
    ram: { progress: 1.1, attackerLoss: 1, defenderLoss: 0.8, defenseDamage: 2, morale: 0 },
    assault: { progress: 1.65, attackerLoss: 1.5, defenderLoss: 1.4, defenseDamage: 1.5, morale: -2 },
    tunnel: { progress: 0.85, attackerLoss: 0.65, defenderLoss: 0.65, defenseDamage: 3, morale: 0 }
  },
  defenseCommands: {
    rotate: { attackerLoss: 1, defenderLoss: 0.8, progress: 0.95, repair: 0, morale: 3 },
    repair: { attackerLoss: 0.75, defenderLoss: 1.1, progress: 1, repair: 3, wallRepair: 5, morale: 0 },
    sortie: { attackerLoss: 1.45, defenderLoss: 1.5, progress: 0.85, repair: 0, morale: -2 }
  }
};

export function getSiegeConfig(rules = {}) {
  const custom = rules.battle?.siege ?? {};
  const mergeCommands = (key) => Object.fromEntries(Object.entries(DEFAULTS[key]).map(([id, command]) =>
    [id, { ...command, ...custom[key]?.[id] }]));
  return { ...DEFAULTS, ...custom,
    effectiveTroopCaps: { ...DEFAULTS.effectiveTroopCaps, ...custom.effectiveTroopCaps },
    hitPointsByLevel: { ...DEFAULTS.hitPointsByLevel, ...custom.hitPointsByLevel },
    attackCommands: mergeCommands("attackCommands"), defenseCommands: mergeCommands("defenseCommands"),
    strategyOutcomes: Object.fromEntries(Object.entries(DEFAULTS.strategyOutcomes).map(([action, outcomes]) => [action,
      Object.fromEntries(Object.entries(outcomes).map(([outcome, modifiers]) => [outcome,
        { ...modifiers, ...custom.strategyOutcomes?.[action]?.[outcome] }]))])) };
}

export function createSiegeState(wallLevel, rules = {}) {
  const level = Math.max(1, Math.min(3, Math.floor(wallLevel || 1)));
  const config = getSiegeConfig(rules);
  const maxHp = config.hitPointsByLevel[level];
  return { hp: maxHp, maxHp, breachedMilestones: [], encirclement: null, orders: { ally: null, enemy: null }, history: [] };
}

export const SIEGE_MILESTONES = [
  { id: "barbican", name: "瓮城", progress: 0.33 },
  { id: "outer", name: "外城", progress: 0.66 },
  { id: "inner", name: "内城", progress: 1 }
];

/** Old saves stored independent wall layers. Preserve their total remaining work. */
export function normalizeSiegeState(value, wallLevel = 1, rules = {}) {
  const state = { ...createSiegeState(wallLevel, rules), ...value };
  if (!Number.isFinite(value?.hp) && Array.isArray(value?.layers) && value.layers.length) {
    state.maxHp = value.layers.reduce((sum, layer) => sum + Math.max(0, Number(layer.maxHp) || 0), 0);
    state.hp = value.layers.reduce((sum, layer, index) => sum + (index < (value.activeLayerIndex ?? 0) ? 0
      : Math.max(0, Math.min(Number(layer.hp) || 0, Number(layer.maxHp) || 0))), 0);
  }
  if (!Number.isFinite(state.maxHp) || state.maxHp <= 0) state.maxHp = createSiegeState(wallLevel, rules).maxHp;
  state.hp = Math.max(0, Math.min(state.maxHp, Number.isFinite(state.hp) ? state.hp : state.maxHp));
  const progress = 1 - state.hp / state.maxHp;
  state.breachedMilestones = [...new Set([...(Array.isArray(state.breachedMilestones) ? state.breachedMilestones : []),
    ...SIEGE_MILESTONES.filter((entry) => progress + 1e-9 >= entry.progress).map((entry) => entry.id)])];
  delete state.layers;
  delete state.activeLayerIndex;
  return state;
}

export function effectiveTroops(troops, wallLevel, rules = {}) {
  const config = getSiegeConfig(rules);
  return Math.min(Math.max(0, troops), config.effectiveTroopCap);
}

function combatPanel(army, rules) {
  return army.combatStats ?? calculateCombatStats(army, rules);
}

function cappedPower(panel, effective) {
  // Use the same per-soldier finalized power at the wall's manpower limit. This
  // does not reapply leadership, morale or training after panel calculation.
  return panel.meleePowerPerTroop * effective;
}

/** All losses use the opposing effective army; progress uses only attacking strength. */
export function evaluateSiegeDay({ attacker, defender, attackOrder, defenseOrder, wallLevel, cityDefense }, rules = {}, rng = Math.random) {
  const config = getSiegeConfig(rules);
  const attack = config.attackCommands[attackOrder];
  const defense = config.defenseCommands[defenseOrder];
  if (!attack || !defense) return { ok: false, message: "无效的攻守命令" };
  const attackerEffective = effectiveTroops(attacker.troops, wallLevel, rules);
  const defenderEffective = effectiveTroops(defender.troops, wallLevel, rules);
  const attacking = combatPanel(attacker, rules), defending = combatPanel(defender, rules);
  const attackerPower = cappedPower(attacking, attackerEffective), defenderPower = cappedPower(defending, defenderEffective);
  const strategyResults = [];
  const modifiers = { progress: 1, attackerLoss: 1, defenderLoss: 1 };
  const strategy = (side, action, own, opposing) => {
    const chance = Math.max(config.minimumStrategyChance, Math.min(config.maximumStrategyChance,
      config.strategyChanceBase + (own.intelligence - opposing.intelligence) / config.intelligenceChanceScale));
    const success = rng() < chance;
    const outcome = config.strategyOutcomes[action][success ? "success" : "failure"];
    for (const key of Object.keys(modifiers)) modifiers[key] *= outcome[key];
    strategyResults.push({ side, action, success, chance });
  };
  if (attackOrder === "tunnel") strategy("ally", "tunnel", attacker, defender);
  if (defenseOrder === "sortie") strategy("enemy", "sortie", defender, attacker);
  const attackerLoss = Math.min(attacker.troops, Math.max(0, Math.round(defenderPower * config.attackerLossRate
    / attacking.meleeDefense * attack.attackerLoss * defense.attackerLoss * modifiers.attackerLoss)));
  const defenderLoss = Math.min(defender.troops, Math.max(0, Math.round(attackerPower * config.defenderLossRate
    / defending.meleeDefense * attack.defenderLoss * defense.defenderLoss * modifiers.defenderLoss)));
  const fortification = Math.max(config.minimumProgressMultiplier, 1 - cityDefense * config.defenseProgressPenalty);
  const progress = attackerPower / 1000 * config.baseProgressPerThousand
    * attack.progress * defense.progress * fortification * modifiers.progress;
  return { ok: true, attackerEffective, defenderEffective, attackerLoss, defenderLoss,
    progress: Math.max(0, progress), defenseDamage: Math.max(0, attack.defenseDamage), repair: Math.max(0, defense.repair),
    wallRepair: Math.max(0, defense.wallRepair ?? 0), strategyResults,
    attackerMorale: attack.morale, defenderMorale: defense.morale };
}

export function interceptionLosses(attacker, defender, wallLevel, rules = {}) {
  const config = getSiegeConfig(rules);
  const attacking = combatPanel(attacker, rules), defending = combatPanel(defender, rules);
  const attackerPower = cappedPower(attacking, effectiveTroops(attacker.troops, wallLevel, rules));
  const defenderPower = cappedPower(defending, effectiveTroops(defender.troops, wallLevel, rules));
  return {
    attackerLoss: Math.min(attacker.troops, Math.round(defenderPower * config.interceptCounterRate / attacking.meleeDefense)),
    defenderLoss: Math.min(defender.troops, Math.round(attackerPower * config.interceptLossRate / defending.meleeDefense))
  };
}

/** One HP pool; milestones are announcements, never extra walls or discarded progress. */
export function damageSiegeLayers(siege, damage) {
  Object.assign(siege, normalizeSiegeState(siege));
  delete siege.layers;
  delete siege.activeLayerIndex;
  siege.hp = Math.max(0, siege.hp - (Number.isFinite(damage) ? Math.max(0, damage) : 0));
  const progress = 1 - siege.hp / siege.maxHp;
  const breached = [];
  for (const entry of SIEGE_MILESTONES) {
    if (progress + 1e-9 >= entry.progress && !siege.breachedMilestones.includes(entry.id)) {
      siege.breachedMilestones.push(entry.id);
      breached.push(entry.name);
    }
  }
  return { breached, conquered: siege.hp <= 0 };
}
