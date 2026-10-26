/** Pure, deterministic numeric pipeline. Definitions contain data, never callbacks/eval. */
export function calculateModified(base, modifiers = [], context = {}, { min = 0, max = Infinity, round = "none" } = {}) {
  if (!Number.isFinite(base)) throw new TypeError("Invalid base value");
  const unique = new Map();
  for (const effect of modifiers) {
    if (!effect.id || !effect.source || !["flat", "percent", "multiply"].includes(effect.operation) || !Number.isFinite(effect.value)) throw new TypeError("Invalid modifier");
    if (effect.enabled === false || (effect.target && effect.target !== context.target)) continue;
    if (effect.when && !Object.entries(effect.when).every(([key, value]) => Array.isArray(value) ? value.includes(context[key]) : context[key] === value)) continue;
    unique.set(`${effect.source}:${effect.id}`, effect);
  }
  const selected = [], groups = new Map();
  for (const effect of [...unique.values()].sort((a, b) => `${a.source}:${a.id}`.localeCompare(`${b.source}:${b.id}`))) {
    if (!effect.exclusiveGroup) selected.push(effect);
    else {
      const key = `${effect.operation}:${effect.exclusiveGroup}`;
      if (!groups.has(key) || effect.value > groups.get(key).value) groups.set(key, effect);
    }
  }
  selected.push(...groups.values());
  const flat = selected.filter(e => e.operation === "flat").reduce((n, e) => n + e.value, 0);
  const percent = selected.filter(e => e.operation === "percent").reduce((n, e) => n + e.value, 0);
  const multiplier = selected.filter(e => e.operation === "multiply").reduce((n, e) => n * e.value, 1);
  const raw = (base + flat) * Math.max(0, 1 + percent) * Math.max(0, multiplier);
  const rounded = round === "floor" ? Math.floor(raw) : round === "round" ? Math.round(raw) : raw;
  return { value: Math.max(min, Math.min(max, rounded)), base, flat, percent, multiplier, raw, trace: structuredClone(selected) };
}

/** Faction/city effects are gathered once even when several officers participate. */
export function collectModifiers(state, { officerIds = [], cityId, factionId } = {}) {
  const owners = [state.factions?.find(f => f.id === factionId), state.cities?.find(c => c.id === cityId),
    ...[...new Set(officerIds)].map(id => state.officers?.find(o => o.id === id))].filter(Boolean);
  return owners.flatMap(owner => [
    ...(owner.modifiers ?? []).map(e => ({ ...e, source: e.source ?? owner.id })),
    ...(owner.treasures ?? []).flatMap(t => (t.modifiers ?? []).map(e => ({ ...e, source: `treasure:${owner.id}:${t.id}` }))),
    ...(owner.conditions ?? []).flatMap(c => (c.modifiers ?? []).map(e => ({ ...e, source: `condition:${owner.id}:${c.id}` })))
  ]);
}

export function resolveValue(state, target, base, context = {}, options = {}) {
  return calculateModified(base, collectModifiers(state, context), { ...context, target }, options);
}
