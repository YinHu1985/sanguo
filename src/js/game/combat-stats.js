import { aggregateAbilities } from "./army.js";
import { aggregateTroopStats, formationComposition } from "./troops.js";
import { getFieldConfig } from "./field-visibility.js";

const DEFAULTS = {
  attackBase: 0.6, warDivisor: 200, commandAttackBase: 0.6, commandAttackDivisor: 250,
  trainingAttackBase: 0.75, trainingAttackDivisor: 400, moraleAttackBase: 0.75, moraleAttackDivisor: 400,
  defenseBase: 0.8, commandDefenseDivisor: 400, trainingDefenseBase: 0.9, trainingDefenseDivisor: 800,
  moraleDefenseBase: 0.9, moraleDefenseDivisor: 800,
  leadershipMobilityThreshold: 85, trainingMobilityThreshold: 75, lowMoraleThreshold: 40,
  meleeDamageRate: 0.16, rangedDamageRate: 0.16, counterDamageRate: 0.19, counterChance: 1,
  fireBase: 170, fireIntelligenceFactor: 4.2, fireTroopFactor: 0.018, fireArrowDamageRate: 0.12
};

export function getCombatConfig(rules = {}) {
  return { ...DEFAULTS, ...rules.battle?.combatStats };
}

const ability = (value, fallback = 0) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;

/**
 * The only place where commanders, troop composition, drill and morale become
 * combat capabilities. Attacks are total power; defenses are per-soldier
 * protection coefficients. Actual combat applies terrain, randomness and its
 * damage-rate once, and must not multiply total power by troop count again.
 * No shooter-percentage threshold: adding non-shooters cannot dilute firepower.
 */
export function calculateCombatStats(unit = {}, rules = {}) {
  const formation = unit.composition ? unit : { ...unit, composition: formationComposition(unit, rules) };
  const type = aggregateTroopStats(formation.composition, rules);
  const abilities = Array.isArray(unit.officers) ? aggregateAbilities(unit.officers) : unit;
  const war = ability(abilities.war, 35), leadership = ability(abilities.leadership, 30);
  const intelligence = ability(abilities.intelligence, 25);
  const training = ability(unit.training, 50), morale = ability(unit.morale, 50);
  const config = getCombatConfig(rules), field = getFieldConfig(rules);
  const attackQuality = (config.attackBase + war / config.warDivisor)
    * (config.commandAttackBase + leadership / config.commandAttackDivisor)
    * (config.trainingAttackBase + training / config.trainingAttackDivisor)
    * (config.moraleAttackBase + morale / config.moraleAttackDivisor);
  const defenseQuality = (config.defenseBase + leadership / config.commandDefenseDivisor)
    * (config.trainingDefenseBase + training / config.trainingDefenseDivisor)
    * (config.moraleDefenseBase + morale / config.moraleDefenseDivisor);
  const commandBonus = leadership >= config.leadershipMobilityThreshold ? 1 : 0;
  const trainingBonus = training >= config.trainingMobilityThreshold ? 1 : 0;
  const moralePenalty = morale < config.lowMoraleThreshold ? 1 : 0;
  const actionPoints = Math.max(field.minActionPoints, Math.min(field.maxActionPoints,
    Math.ceil((type.actionPoints + commandBonus + trainingBonus - moralePenalty) * field.movementScale)));
  const vision = Math.max(0, Math.ceil(Math.max(actionPoints + field.visionBonus,
    (type.vision || actionPoints + field.visionBonus) + commandBonus)));
  const meleeAttack = (type.meleeAttackTotal ?? type.attack * type.totalTroops) * attackQuality;
  const rangedAttack = (type.rangedAttackTotal ?? type.rangedAttack * type.totalTroops) * attackQuality;
  const meleeDefense = Math.max(0.1, type.defense * defenseQuality);
  const rangedDefense = Math.max(0.1, (type.rangedDefense ?? type.defense) * defenseQuality);
  return { meleeAttack, meleeDefense, rangedAttack, rangedDefense,
    meleePowerPerTroop: type.attack * attackQuality,
    rangedPowerPerTroop: type.rangedAttack * attackQuality,
    actionPoints, movement: actionPoints, vision, range: type.range,
    rangedTroops: type.rangedTroops, totalTroops: type.totalTroops,
    initiative: Math.round(leadership * 0.55 + training * 0.25 + morale * 0.2 + (type.initiative ?? 0)),
    attackCost: Math.max(1, Math.ceil((type.attackCost ?? 3) * field.attackCostScale)),
    firePower: type.totalTroops > 0 ? config.fireBase + intelligence * config.fireIntelligenceFactor + type.totalTroops * config.fireTroopFactor : 0,
    rangedFirePower: rangedAttack * config.fireArrowDamageRate };
}
