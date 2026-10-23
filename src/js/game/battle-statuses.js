/**
 * Serializable unit status records. Duration counts the affected unit's completed
 * activations, not movements, battle days, or strategic months. Add new kinds to
 * this registry and implement their behavior in the engine; lifecycle stays here.
 */
export const BATTLE_STATUS_DEFINITIONS = Object.freeze({
  doubt: Object.freeze({ name: "疑兵", control: "skipActivation", priority: 100,
    durationUnit: "activation", stacking: "reject", sourceRequired: false,
    clearOn: ["siege", "battleEnd", "removed"], resetAfterActivation: [] }),
  provocation: Object.freeze({ name: "挑衅", control: "pursueSource", priority: 50,
    durationUnit: "activation", stacking: "reject", sourceRequired: true,
    clearOn: ["siege", "battleEnd", "removed"], resetAfterActivation: ["active"] })
});

const legacyTypes = ["doubt", "provocation"];
const validType = (type) => typeof type === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(type);
const positiveDuration = (value) => Number.isSafeInteger(value) && value > 0;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizeStatusDuration(value, fallback = 1) {
  return positiveDuration(value) ? value : positiveDuration(fallback) ? fallback : 1;
}

function normalizeStatus(type, value) {
  if (!validType(type) || !isRecord(value)) return null;
  const remainingActivations = value.remainingActivations === undefined ? 1 : value.remainingActivations;
  if (!positiveDuration(remainingActivations)) return null;
  return { ...value, type, remainingActivations };
}

/** Pure reads also understand a pre-registry record; no turn can advance from a UI read. */
export function getBattleStatus(unit, type) {
  if (!unit || !validType(type)) return null;
  if (isRecord(unit.statuses) && Object.hasOwn(unit.statuses, type)) {
    const status = unit.statuses[type];
    return isRecord(status) && status.type === type && positiveDuration(status.remainingActivations) ? status : null;
  }
  const legacy = Object.getOwnPropertyDescriptor(unit, type);
  return legacyTypes.includes(type) && legacy && "value" in legacy ? normalizeStatus(type, legacy.value) : null;
}

/**
 * Only `statuses` is stored. Non-enumerable legacy aliases keep existing callers
 * compatible without duplicating state in JSON/structuredClone snapshots.
 * Rehydrate snapshots through this function to restore those optional aliases.
 */
export function initializeBattleStatuses(unit) {
  const previous = isRecord(unit.statuses) ? unit.statuses : {};
  const statuses = {};
  for (const [type, value] of Object.entries(previous)) {
    const normalized = normalizeStatus(type, value);
    if (normalized) statuses[type] = normalized;
  }
  for (const type of legacyTypes) {
    const descriptor = Object.getOwnPropertyDescriptor(unit, type);
    if (!Object.hasOwn(previous, type) && descriptor && "value" in descriptor) {
      const normalized = normalizeStatus(type, descriptor.value);
      if (normalized) statuses[type] = normalized;
    }
  }
  unit.statuses = statuses;
  for (const type of legacyTypes) Object.defineProperty(unit, type, {
    configurable: true, enumerable: false,
    get() { return getBattleStatus(this, type); },
    set(value) {
      const normalized = normalizeStatus(type, value);
      if (normalized) this.statuses[type] = normalized;
      else delete this.statuses[type];
    }
  });
  return unit;
}

export function applyBattleStatus(unit, type, payload = {}, definitions = BATTLE_STATUS_DEFINITIONS) {
  const definition = Object.hasOwn(definitions, type) ? definitions[type] : null;
  if (!unit || !definition || !validType(type) || !isRecord(payload)) return { ok: false, message: "未知或无效的战斗状态" };
  if (getBattleStatus(unit, type)) return { ok: false, message: `${definition.name ?? type}已经生效，不能重复叠加` };
  const status = normalizeStatus(type, payload);
  if (!status) return { ok: false, message: "状态持续次数须为正整数" };
  initializeBattleStatuses(unit);
  unit.statuses[type] = status;
  return { ok: true, status };
}

export function removeBattleStatus(unit, type) {
  if (!unit || !validType(type)) return;
  if (!isRecord(unit.statuses)) initializeBattleStatuses(unit);
  delete unit.statuses[type];
  const legacy = Object.getOwnPropertyDescriptor(unit, type);
  if (legacyTypes.includes(type) && legacy && "value" in legacy) unit[type] = null;
}

export function getControllingStatus(unit, definitions = BATTLE_STATUS_DEFINITIONS) {
  return Object.entries(definitions).filter(([, definition]) => definition.control)
    .sort(([a, first], [b, second]) => (second.priority ?? 0) - (first.priority ?? 0) || a.localeCompare(b))
    .map(([type]) => getBattleStatus(unit, type)).find(Boolean) ?? null;
}

/** Call once, and only once, when this unit's activation actually ends. */
export function consumeActivationStatuses(unit, definitions = BATTLE_STATUS_DEFINITIONS) {
  if (!unit) return { expired: [], remaining: [] };
  initializeBattleStatuses(unit);
  const expired = [], remaining = [];
  for (const [type, status] of Object.entries(unit.statuses)) {
    const definition = Object.hasOwn(definitions, type) ? definitions[type] : null;
    if (definition?.durationUnit !== "activation") continue;
    status.remainingActivations -= 1;
    if (status.remainingActivations === 0) { delete unit.statuses[type]; expired.push(type); }
    else {
      for (const key of definition.resetAfterActivation ?? []) status[key] = false;
      remaining.push(type);
    }
  }
  return { expired, remaining };
}

/** Unknown future kinds survive normalization but never gain unimplemented behavior. */
export function clearBattleStatuses(unit, reason = "battleEnd", definitions = BATTLE_STATUS_DEFINITIONS) {
  if (!unit) return;
  initializeBattleStatuses(unit);
  for (const type of Object.keys(unit.statuses)) {
    const definition = Object.hasOwn(definitions, type) ? definitions[type] : null;
    if (reason === "removed" || reason === "battleEnd" || definition?.clearOn?.includes(reason)) delete unit.statuses[type];
  }
}
