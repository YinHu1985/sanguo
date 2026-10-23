const CONTROL_DEFAULTS = { actionPoints: 2, goldCost: 50, durationActivations: 1, chanceBase: 0.45,
  intelligenceDivisor: 150, minChance: 0.2, maxChance: 0.85 };

/** Field stratagem policy is separate from ranged weapon attacks. */
export function getStrategyConfig(action, rules = {}) {
  const custom = rules.battle?.strategies?.[action] ?? {};
  const config = { ...CONTROL_DEFAULTS, ...custom };
  for (const [key, fallback] of Object.entries(CONTROL_DEFAULTS)) {
    if (!Number.isFinite(config[key])) config[key] = fallback;
  }
  config.actionPoints = Math.max(1, Math.ceil(config.actionPoints));
  config.goldCost = Math.max(0, Math.floor(config.goldCost));
  config.intelligenceDivisor = Math.max(1, config.intelligenceDivisor);
  if (!Number.isSafeInteger(config.durationActivations) || config.durationActivations < 1) config.durationActivations = 1;
  return config;
}

export function strategySuccessChance(action, attacker, defender, rules = {}) {
  const config = getStrategyConfig(action, rules);
  const chance = config.chanceBase + ((attacker.intelligence ?? 0) - (defender.intelligence ?? 0)) / config.intelligenceDivisor;
  return Math.max(0, Math.min(1, Math.max(config.minChance, Math.min(config.maxChance, chance))));
}
