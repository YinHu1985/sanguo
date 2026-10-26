import { addEvent } from "./state.js";
import { appointGovernor, commitArmyDeparture, executeDomestic, executeRecruit, executeTransfer,
  getCity, getOfficer, mergeTroops, validateArmy } from "./rules.js";
import { executeDiplomacy, executeEmploy, executeOfficerTransfer, executeSearch } from "./campaign.js";
import { executeGrainTrade, grainExchangeRate } from "./economy.js";
import { formationOfficerIds, normalizeFormations } from "./army.js";
import { EQUIPMENT_KEYS } from "./equipment.js";
import { executeStratagem, getStratagemConfig } from "./stratagems.js";
import { cityBesieged, officerAtWar } from "./war-state.js";
import { canIssueCommand, consumeCommand } from "./commands.js";
import { capability } from "./capabilities.js";
import { emitDomainEvent } from "./domain-events.js";

// Internal authority token: personal request service validates the mandate before submission.
export const DUTY_MANDATE = Symbol("approved-personal-duty");

const KINDS = new Set(["domestic", "recruit", "transfer", "governor", "search", "employ", "officerTransfer", "diplomacy", "trade", "march", "stratagem"]);
const ACTIVE = new Set(["running", "awaiting_battle", "in_battle"]);
const SINGLE_ACTOR = new Set(["recruit", "transfer", "governor", "search", "employ", "diplomacy", "trade", "stratagem"]);
const RESOURCE_KEYS = ["gold", "food", "troops", ...EQUIPMENT_KEYS];
// Older task/city records have no equipment fields; only those new fields default to zero.
const resourceValue = (record, key) => record[key] === undefined && EQUIPMENT_KEYS.includes(key) ? 0 : record[key];
const failure = (message) => ({ ok: false, message });
const isAmount = (value) => Number.isSafeInteger(value) && value >= 0;
const validReservation = (reservation) => reservation && RESOURCE_KEYS.every((key) => isAmount(resourceValue(reservation, key)))
  && (!reservation.troops || [reservation.training, reservation.morale].every((value) => Number.isFinite(value) && value >= 0 && value <= 100));
const currentTurn = (state) => Number.isSafeInteger(state.elapsedMonths) ? state.elapsedMonths : 0;

function taskTiming(kind, rules) {
  const defaults = rules.tasks?.defaultTiming ?? "turn_end";
  const base = typeof defaults === "string" ? { timing: defaults } : defaults;
  const config = { ...base, ...(rules.tasks?.actions?.[kind] ?? {}) };
  if (!["immediate", "turn_end", "multi_turn"].includes(config.timing)) return failure("任务完成时机配置无效");
  const duration = config.timing === "immediate" ? 0 : config.timing === "turn_end" ? 1 : (config.duration ?? 1);
  if (!Number.isSafeInteger(duration) || duration < 0 || (config.timing === "multi_turn" && duration < 1)) return failure("跨回合任务时长须为正整数");
  return { ok: true, timing: config.timing, duration };
}

function taskTitle(kind, payload) {
  if (kind === "domestic") return { agriculture: "开发农业", commerce: "开发商业", patrol: "维护治安", train: "训练部队", buildWall: "修筑城防",
    breedHorses: "挑选良马", craftArmor: "打造甲胄", craftCrossbows: "制作弓弩" }[payload.action] ?? "城务";
  if (kind === "diplomacy") return payload.action === "alliance" ? "缔结同盟" : "亲善使节";
  if (kind === "trade") return payload.direction === "buy" ? "购买粮食" : "出售粮食";
  if (kind === "stratagem") return getStratagemConfig()[payload.action]?.name ?? "计略";
  return { recruit: "征募士兵", transfer: "输送部队物资", governor: "任命太守", search: "寻访人才", employ: "登用人才",
    officerTransfer: "武将迁任", march: "出征" }[kind];
}

function checkActors(state, order, completing = false) {
  if (!Array.isArray(order.officerIds) || !order.officerIds.length || order.officerIds.some((id) => typeof id !== "string")
    || new Set(order.officerIds).size !== order.officerIds.length) return failure("执行武将不能为空或重复");
  if (SINGLE_ACTOR.has(order.kind) && order.officerIds.length !== 1) return failure("此任务须且只能指派一名执行武将");
  if (order.kind === "march") {
    const divisions = order.payload?.divisions;
    const ids = Array.isArray(divisions) ? divisions.flatMap(formationOfficerIds) : [];
    if (!Array.isArray(divisions) || ids.length !== order.officerIds.length
      || new Set(ids).size !== order.officerIds.length
      || ids.some((id) => !order.officerIds.includes(id))) return failure("出征将领必须与任务执行者一致");
  }
  const city = getCity(state, order.cityId);
  if (cityBesieged(state, order.cityId) || (order.payload?.targetId && ["transfer", "officerTransfer", "march", "stratagem"].includes(order.kind)
    && cityBesieged(state, order.payload.targetId))) return failure("交战城池暂不能执行或接收主动指令");
  const employerId = completing ? order.factionId : state.playerFactionId;
  if (!city || city.factionId !== employerId || (order.factionId && order.factionId !== city.factionId)) return failure("任务出发城池已不属于我方");
  const locked = busyOfficerIds(state);
  for (const id of order.officerIds) {
    const officer = getOfficer(state, id);
    if (officerAtWar(state, id)) return failure("执行武将正在持续战役中");
    if (!officer || !city.officerIds.includes(id) || officer.factionId !== employerId
      || (officer.locationCityId && officer.locationCityId !== city.id) || ["free", "captured"].includes(officer.status)) return failure("执行武将不在本城任职或已经不可用");
    if (completing) {
      if (officer.taskId && officer.taskId !== order.id) return failure("执行武将正在执行其他任务");
      if ((state.tasks ?? []).some((task) => task.id !== order.id && ACTIVE.has(task.status) && task.officerIds?.includes(id))) return failure("执行武将正在执行其他任务");
    } else if (officer.acted || officer.taskId || locked.has(id)) return failure("执行武将本月已行动或正在执行任务");
  }
  return { ok: true };
}

/** Reuse the established action primitives on a private draft; no UI or timer is involved. */
function executeOrder(state, order, rules, rng, effectiveTurn = currentTurn(state)) {
  const { kind, cityId, officerIds, payload } = order;
  const officerId = officerIds[0];
  switch (kind) {
    case "domestic": return executeDomestic(state, cityId, payload.action, officerIds, rules);
    case "recruit": return executeRecruit(state, cityId, officerId, payload.amount, rules);
    case "transfer": return executeTransfer(state, cityId, payload.targetId, officerId, payload.troops, rules,
      { gold: payload.gold ?? 0, food: payload.food ?? 0,
        ...Object.fromEntries(EQUIPMENT_KEYS.map((key) => [key, payload[key] === undefined ? 0 : payload[key]])) });
    case "governor": return appointGovernor(state, cityId, officerId, rules);
    case "search": return executeSearch(state, cityId, officerId, rules, rng);
    case "employ": {
      const target = getOfficer(state, payload.targetId);
      if (order.targetOfficerSnapshot && Object.entries(order.targetOfficerSnapshot).some(([key, value]) => (target?.[key] ?? null) !== value)) {
        return failure("登用对象的原属势力、身份或驻地已经变化");
      }
      return executeEmploy(state, cityId, officerId, payload.targetId, rules, rng);
    }
    case "stratagem": {
      if (order.targetFactionId !== undefined && getCity(state, payload.targetId)?.factionId !== order.targetFactionId) {
        return failure("计略目标城池已经换主，任务中止");
      }
      return executeStratagem(state, cityId, payload.targetId, officerId, payload.action, rules,
        { targetOfficerId: payload.targetOfficerId, effectiveTurn }, rng);
    }
    case "officerTransfer": return executeOfficerTransfer(state, cityId, payload.targetId, officerIds, rules);
    case "diplomacy": return executeDiplomacy(state, cityId, payload.targetFactionId, officerId, payload.action, rules, rng);
    case "trade": {
      // An accepted quote survives multi-turn execution and calendar changes.
      const tradeRules = structuredClone(rules);
      if (order.tradeRate !== undefined) tradeRules.economy.grainPerGoldByMonth.fill(order.tradeRate);
      return executeGrainTrade(state, cityId, officerId, payload.direction, payload.goldAmount, tradeRules);
    }
    case "march": {
      // An already funded pre-campaign order keeps its original troop/cargo
      // limits. Ownership, executors, equipment and balances are still checked.
      // Reversing an idea restricts new formations, not troops already funded
      // and equipped by an accepted order. Never restore these unlocks globally.
      const validationState = order.id && order.reservation?.status === "reserved" && Array.isArray(order.formationTechnologies)
        ? { ...state, factions: state.factions.map((faction) => faction.id === order.factionId
          ? { ...faction, unlockedTechnologies: order.formationTechnologies } : faction) } : state;
      const army = validateArmy(validationState, cityId, payload.targetId, payload.divisions, rules, payload.supplies,
        { legacyOrder: Boolean(order.id && order.armyOrderVersion !== 2) });
      if (!army.ok) return army;
      const departure = commitArmyDeparture(validationState, army);
      if (!departure.ok) return departure;
      // City/officer ledgers are shared by the validation view; copy only the
      // top-level fields written by departure, never its historical unlocks.
      if (validationState !== state) {
        state.commandsRemaining = validationState.commandsRemaining;
        state.eventLog = validationState.eventLog;
      }
      return { ...departure, battle: { sourceCityId: cityId, targetCityId: payload.targetId, divisions: structuredClone(army.divisions),
        attackerFactionId: getCity(state, cityId).factionId, defenderFactionId: getCity(state, payload.targetId).factionId,
        supplies: { ...army.supplies }, equipment: { ...army.equipment }, training: getCity(state, cityId).training, morale: getCity(state, cityId).morale,
        armyOfficerIds: army.divisions.flatMap(formationOfficerIds) } };
    }
    default: return failure("无此任务类型");
  }
}

function releaseActors(state, task) {
  for (const id of task.officerIds) {
    const officer = getOfficer(state, id);
    if (officer?.taskId === task.id) {
      delete officer.taskId;
      officer.acted = true;
    }
  }
}

function failTask(state, task, message, targetTurn) {
  if (task.status !== "running") return task;
  const source = getCity(state, task.cityId);
  if (task.reservation?.status === "reserved") {
    if (source?.factionId === task.factionId
      && validReservation(task.reservation) && RESOURCE_KEYS.every((key) => isAmount(resourceValue(source, key) + resourceValue(task.reservation, key)))) {
      source.gold += task.reservation.gold;
      source.food += task.reservation.food;
      for (const key of EQUIPMENT_KEYS) source[key] = resourceValue(source, key) + resourceValue(task.reservation, key);
      if (task.reservation.troops > 0) mergeTroops(source, task.reservation.troops, task.reservation.training, task.reservation.morale);
      task.reservation.status = "returned";
    } else task.reservation.status = "forfeited";
  }
  task.status = "failed";
  task.completedTurn = targetTurn;
  task.result = { ok: false, success: false, message };
  releaseActors(state, task);
  addEvent(state, `${task.title}未能完成：${message}。${task.reservation?.status === "returned" ? "预留钱粮、装备与部队已退回原城。" : ""}`);
  return task;
}

/** Encirclement cancels not-yet-departed work before the defending ledger is frozen. */
export function cancelCityTasks(state, cityId, targetTurn = currentTurn(state) + 1) {
  return (state.tasks ?? []).filter((task) => task.status === "running" && task.cityId === cityId)
    .map((task) => failTask(state, task, "出发城池遭到围攻，原有任务中止", targetTurn));
}

/** Execute one already-funded task atomically, charging neither resources nor commands twice. */
function completeTask(state, id, rules, targetTurn, rng) {
  const original = state.tasks.find((task) => task.id === id);
  if (!original || original.status !== "running") return original;
  const actors = checkActors(state, original, true);
  if (!actors.ok) return failTask(state, original, actors.message, targetTurn);
  if (original.reservation?.status !== "reserved" || !validReservation(original.reservation)) {
    return failTask(state, original, "任务预留资源记录无效", targetTurn);
  }
  const draft = structuredClone(state);
  const task = draft.tasks.find((entry) => entry.id === id);
  const source = getCity(draft, task.cityId);
  if (RESOURCE_KEYS.some((key) => !isAmount(resourceValue(source, key)) || !isAmount(resourceValue(source, key) + resourceValue(task.reservation, key)))) {
    return failTask(state, original, "任务出发城池的资源数据无效", targetTurn);
  }
  for (const key of RESOURCE_KEYS) source[key] = resourceValue(source, key) + resourceValue(task.reservation, key);
  const savedQuality = { training: source.training, morale: source.morale };
  const frozenArmy = ["transfer", "march"].includes(task.kind);
  if (frozenArmy) Object.assign(source, { training: task.reservation.training, morale: task.reservation.morale });
  for (const officerId of task.officerIds) {
    const officer = getOfficer(draft, officerId);
    officer.acted = false;
    delete officer.taskId;
  }
  const commandsRemaining = state.commandsRemaining;
  draft.commandsRemaining = 1;
  // Accepted public work belongs to its employer, not to the protagonist's later career.
  // Legacy primitives receive an employer-scoped private draft; the live player identity never changes.
  const playerFactionId = draft.playerFactionId;
  draft.playerFactionId = task.factionId;
  let result;
  try { result = executeOrder(draft, task, rules, rng, targetTurn); }
  catch { return failTask(state, original, "任务执行条件无效", targetTurn); }
  draft.playerFactionId = playerFactionId;
  if (!result.ok) return failTask(state, original, result.message, targetTurn);
  if (RESOURCE_KEYS.some((key) => !isAmount(resourceValue(source, key)))) return failTask(state, original, "任务结算资源无效", targetTurn);
  if (frozenArmy) Object.assign(source, savedQuality);
  draft.commandsRemaining = commandsRemaining;
  task.reservation.status = "consumed";
  if (result.battle) {
    task.status = "awaiting_battle";
    task.battle = result.battle;
    task.result = { ok: true, message: "部队已抵达，等待战斗结果" };
    for (const officerId of task.officerIds) getOfficer(draft, officerId).taskId = task.id;
  } else {
    task.status = "completed";
    task.completedTurn = targetTurn;
    task.result = structuredClone(result);
    // Primitives have already marked the actual actors as having acted.
    for (const officerId of task.officerIds) {
      const officer = getOfficer(draft, officerId);
      if (officer.taskId === task.id) delete officer.taskId;
      officer.acted = true;
    }
  }
  if (task.status === "completed") emitDomainEvent(draft, { id: `task:${task.id}:completed`, type: "task.completed",
    officerIds: task.officerIds, title: task.title, ability: task.payload.action === "train" ? "leadership" : "politics" });
  Object.assign(state, draft);
  return state.tasks.find((entry) => entry.id === id);
}

/** Submit orders now; default effects are deferred until the closing turn is resolved. */
export function queueTask(state, input, rules, authority) {
  if (state.turnResolution) return failure("正在结算回合，暂不能下达新任务");
  if (getReadyBattleTask(state)) return failure("请先处理正在进行的战斗");
  if (!input || !KINDS.has(input.kind)) return failure("无此任务类型");
  const permission = capability(state, "government", { cityId: input.cityId, kind: input.kind });
  if (!permission.ok && authority !== DUTY_MANDATE) return failure(permission.reason);
  if (!canIssueCommand(state)) return failure("本月指令已用尽");
  let order;
  try {
    order = JSON.parse(JSON.stringify({ kind: input.kind, cityId: input.cityId, officerIds: input.officerIds, payload: input.payload ?? {} }, (_, value) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-finite task value");
      return value;
    }));
  }
  catch { return failure("任务参数无效"); }
  if (!order.payload || typeof order.payload !== "object" || Array.isArray(order.payload)) return failure("任务参数无效");
  if (order.kind === "march" && Array.isArray(order.payload.divisions)) order.payload.divisions = normalizeFormations(order.payload.divisions);
  if (order.kind === "march") order.armyOrderVersion = 2;
  const timing = taskTiming(order.kind, rules);
  if (!timing.ok) return timing;
  const actors = checkActors(state, order);
  if (!actors.ok) return actors;
  if (order.kind === "stratagem") order.targetFactionId = getCity(state, order.payload.targetId)?.factionId;
  if (order.kind === "employ") {
    const target = getOfficer(state, order.payload.targetId);
    if (target) order.targetOfficerSnapshot = Object.fromEntries(["factionId", "status", "locationCityId", "captorFactionId"].map((key) => [key, target[key] ?? null]));
  }
  if (order.kind === "trade") order.tradeRate = grainExchangeRate(state.month, rules);
  const source = getCity(state, order.cityId);
  if (RESOURCE_KEYS.some((key) => !isAmount(resourceValue(source, key)))) return failure("城池资源数据无效");
  const trial = structuredClone(state);
  let preview;
  // A hypothetical surrender must not let returned enemy-army cargo mask the
  // true fee that needs to be reserved now. Randomized effects happen at completion.
  try { preview = executeOrder(trial, order, rules, () => order.kind === "stratagem" ? 1 : 0.5); }
  catch { return failure("任务参数无效"); }
  if (!preview.ok) return preview;
  if (order.kind === "march") {
    order.formationTechnologies = [...(state.factions.find((faction) => faction.id === state.playerFactionId)?.unlockedTechnologies ?? [])];
  }
  const after = getCity(trial, order.cityId);
  const reservation = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(0, resourceValue(source, key) - resourceValue(after, key))]));
  if (RESOURCE_KEYS.some((key) => !isAmount(reservation[key]))) return failure("任务资源需求无效");
  Object.assign(reservation, { training: source.training, morale: source.morale, status: "reserved" });
  const submittedTurn = currentTurn(state);
  const ids = new Set((state.tasks ?? []).map((task) => task.id));
  let number = Number.isSafeInteger(state.nextTaskId) && state.nextTaskId > 0 ? state.nextTaskId : 1;
  while (ids.has(`task-${number}`)) number += 1;
  const task = { ...order, id: `task-${number}`, title: taskTitle(order.kind, order.payload), factionId: state.playerFactionId,
    targetId: order.payload.targetId ?? order.payload.targetFactionId ?? null, status: "running", timing: timing.timing,
    duration: timing.duration, submittedTurn, dueTurn: submittedTurn + timing.duration,
    createdYearMonth: { year: state.year, month: state.month }, reservation, result: null };
  state.tasks ??= [];
  state.taskVersion = 1;
  state.nextTaskId = number + 1;
  state.tasks.push(task);
  for (const key of RESOURCE_KEYS) source[key] = resourceValue(source, key) - reservation[key];
  consumeCommand(state);
  for (const id of order.officerIds) Object.assign(getOfficer(state, id), { acted: true, taskId: task.id });
  addEvent(state, `${source.name}下达${task.title}任务，${timing.duration ? `${timing.duration}回合后完成` : "立即执行"}。`);
  const resultTask = timing.timing === "immediate" ? completeTask(state, task.id, rules, submittedTurn, Math.random) : task;
  return { ok: true, message: resultTask.status === "running" ? `${task.title}已下达，${timing.duration}回合后完成` : resultTask.result.message,
    task: resultTask, taskId: resultTask.id, status: resultTask.status };
}

/** Idempotent replay resumes after manual battles, preserving submission order. */
export function settleTasks(state, rules, { targetTurn = currentTurn(state) + 1, rng = Math.random } = {}) {
  if (!Number.isSafeInteger(targetTurn) || targetTurn < 0) return { ...failure("回合编号无效"), completed: [], failed: [], battleTask: null };
  const report = { ok: true, completed: [], failed: [], battleTask: getReadyBattleTask(state) };
  if (report.battleTask) return report;
  const readyIds = (state.tasks ?? []).filter((task) => task.status === "running" && task.dueTurn <= targetTurn).map((task) => task.id);
  for (const id of readyIds) {
    const task = completeTask(state, id, rules, targetTurn, rng);
    if (task.status === "awaiting_battle") {
      report.battleTask = task;
      break;
    }
    (task.status === "completed" ? report.completed : report.failed).push(task);
  }
  return report;
}

export function getReadyBattleTask(state) {
  return (state.tasks ?? []).find((task) => task.status === "awaiting_battle") ?? null;
}

/** Battle settlement owns troop/cargo changes; this function only closes its strategic task. */
export function finishBattleTask(state, id, result = {}, targetTurn = currentTurn(state) + 1) {
  const task = (state.tasks ?? []).find((entry) => entry.id === id);
  if (!task || task.status !== "awaiting_battle") return failure("该出征任务没有待结算战斗，或已完成");
  if (!Number.isSafeInteger(targetTurn) || targetTurn < 0) return failure("回合编号无效");
  task.status = "completed";
  task.completedTurn = targetTurn;
  task.result = { ok: true, ...structuredClone(result), message: result.message ?? "出征已结束" };
  releaseActors(state, task);
  return { ok: true, message: task.result.message, task };
}

export function busyOfficerIds(state) {
  return new Set((state.tasks ?? []).filter((task) => ACTIVE.has(task.status)).flatMap((task) => task.officerIds ?? []));
}
