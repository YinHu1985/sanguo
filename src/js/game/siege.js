export const ATTACK_ORDERS = { ram: "撞门", assault: "蚁附", tunnel: "地道" };
export const DEFENSE_ORDERS = { rotate: "轮换修整", repair: "修补城墙", sortie: "出城袭扰" };

const DEFAULTS = {
  effectiveTroopCaps: { 1: 20000, 2: 35000, 3: 50000 }, layerHp: 100,
  baseProgressPerThousand: 1.3, defenseProgressPenalty: 0.006, minimumProgressMultiplier: 0.25,
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
    attackCommands: mergeCommands("attackCommands"), defenseCommands: mergeCommands("defenseCommands"),
    strategyOutcomes: Object.fromEntries(Object.entries(DEFAULTS.strategyOutcomes).map(([action, outcomes]) => [action,
      Object.fromEntries(Object.entries(outcomes).map(([outcome, modifiers]) => [outcome,
        { ...modifiers, ...custom.strategyOutcomes?.[action]?.[outcome] }]))])) };
}

export function createSiegeState(wallLevel, rules = {}) {
  const level = Math.max(1, Math.min(3, Math.floor(wallLevel || 1)));
  const config = getSiegeConfig(rules);
  const layers = [
    ...(level >= 3 ? [{ id: "barbican", name: "瓮城" }] : []),
    ...(level >= 2 ? [{ id: "outer", name: "外城" }] : []),
    { id: "inner", name: "内城" }
  ].map((layer) => ({ ...layer, hp: config.layerHp, maxHp: config.layerHp }));
  return { layers, activeLayerIndex: 0, encirclement: null, orders: { ally: null, enemy: null }, history: [] };
}

export function effectiveTroops(troops, wallLevel, rules = {}) {
  const config = getSiegeConfig(rules);
  return Math.min(Math.max(0, troops), config.effectiveTroopCaps[Math.max(1, Math.min(3, wallLevel || 1))]);
}

/** All losses use the opposing effective army; progress uses only attacking strength. */
export function evaluateSiegeDay({ attacker, defender, attackOrder, defenseOrder, wallLevel, cityDefense }, rules = {}, rng = Math.random) {
  const config = getSiegeConfig(rules);
  const attack = config.attackCommands[attackOrder];
  const defense = config.defenseCommands[defenseOrder];
  if (!attack || !defense) return { ok: false, message: "无效的攻守命令" };
  const attackerEffective = effectiveTroops(attacker.troops, wallLevel, rules);
  const defenderEffective = effectiveTroops(defender.troops, wallLevel, rules);
  const quality = (army) => (config.qualityBase + (army.leadership ?? 30) / config.qualityLeadershipDivisor)
    * (config.qualityBase + (army.training ?? 50) / config.qualityTrainingDivisor)
    * (config.qualityBase + (army.morale ?? 50) / config.qualityMoraleDivisor);
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
  const attackerLoss = Math.min(attacker.troops, Math.max(0, Math.round(defenderEffective * config.attackerLossRate
    * quality(defender) * attack.attackerLoss * defense.attackerLoss * modifiers.attackerLoss)));
  const defenderLoss = Math.min(defender.troops, Math.max(0, Math.round(attackerEffective * config.defenderLossRate
    * quality(attacker) * attack.defenderLoss * defense.defenderLoss * modifiers.defenderLoss)));
  const fortification = Math.max(config.minimumProgressMultiplier, 1 - cityDefense * config.defenseProgressPenalty);
  const progress = attackerEffective / 1000 * config.baseProgressPerThousand * quality(attacker)
    * attack.progress * defense.progress * fortification * modifiers.progress;
  return { ok: true, attackerEffective, defenderEffective, attackerLoss, defenderLoss,
    progress: Math.max(0, progress), defenseDamage: Math.max(0, attack.defenseDamage), repair: Math.max(0, defense.repair),
    wallRepair: Math.max(0, defense.wallRepair ?? 0), strategyResults,
    attackerMorale: attack.morale, defenderMorale: defense.morale };
}

export function interceptionLosses(attacker, defender, wallLevel, rules = {}) {
  const config = getSiegeConfig(rules);
  const command = (army) => config.interceptionAbilityBase + ((army.war ?? 30) * config.interceptionWarWeight
    + (army.leadership ?? 30) * config.interceptionLeadershipWeight) / config.interceptionAbilityDivisor;
  const ratio = Math.max(config.minimumCombatRatio, Math.min(config.maximumCombatRatio, command(attacker) / command(defender)));
  return {
    attackerLoss: Math.min(attacker.troops, Math.round(effectiveTroops(defender.troops, wallLevel, rules) * config.interceptCounterRate / ratio)),
    defenderLoss: Math.min(defender.troops, Math.round(effectiveTroops(attacker.troops, wallLevel, rules) * config.interceptLossRate * ratio))
  };
}

/** Carry excess progress forward, so a stronger assault is never discarded at a wall boundary. */
export function damageSiegeLayers(siege, damage) {
  let remaining = Math.max(0, damage);
  const breached = [];
  while (remaining > 0 && siege.activeLayerIndex < siege.layers.length) {
    const layer = siege.layers[siege.activeLayerIndex];
    const applied = Math.min(layer.hp, remaining);
    layer.hp = Math.max(0, layer.hp - applied);
    remaining -= applied;
    if (layer.hp > 0) break;
    breached.push(layer.name);
    siege.activeLayerIndex += 1;
  }
  return { breached, conquered: siege.activeLayerIndex >= siege.layers.length };
}
