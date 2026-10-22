import { addEvent } from "./state.js";
import { appointGovernor, commitArmyDeparture, executeDomestic, executeRecruit, executeTransfer,
  getCity, getOfficer, mergeTroops, validateArmy } from "./rules.js";
import { executeDiplomacy, executeEmploy, executeOfficerTransfer, executeSearch } from "./campaign.js";
import { executeGrainTrade, grainExchangeRate } from "./economy.js";
import { formationOfficerIds, normalizeFormations } from "./army.js";

const KINDS = new Set(["domestic", "recruit", "transfer", "governor", "search", "employ", "officerTransfer", "diplomacy", "trade", "march"]);
const ACTIVE = new Set(["running", "awaiting_battle"]);
const SINGLE_ACTOR = new Set(["recruit", "transfer", "governor", "search", "employ", "diplomacy", "trade"]);
const RESOURCE_KEYS = ["gold", "food", "troops"];
const failure = (message) => ({ ok: false, message });
const isAmount = (value) => Number.isSafeInteger(value) && value >= 0;
const validReservation = (reservation) => reservation && RESOURCE_KEYS.every((key) => isAmount(reservation[key]))
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
  if (kind === "domestic") return { agriculture: "开发农业", commerce: "开发商业", patrol: "维护治安", train: "训练部队", buildWall: "修筑城防" }[payload.action] ?? "城务";
  if (kind === "diplomacy") return payload.action === "alliance" ? "缔结同盟" : "亲善使节";
  if (kind === "trade") return payload.direction === "buy" ? "购买粮食" : "出售粮食";
  return { recruit: "征募士兵", transfer: "输送部队钱粮", governor: "任命太守", search: "寻访人才", employ: "登用人才",
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
  if (!city || city.factionId !== state.playerFactionId || (order.factionId && order.factionId !== city.factionId)) return failure("任务出发城池已不属于我方");
  const locked = busyOfficerIds(state);
  for (const id of order.officerIds) {
    const officer = getOfficer(state, id);
    if (!officer || !city.officerIds.includes(id) || officer.factionId !== state.playerFactionId
      || (officer.locationCityId && officer.locationCityId !== city.id) || ["free", "captured"].includes(officer.status)) return failure("执行武将不在本城任职或已经不可用");
    if (completing) {
      if (officer.taskId && officer.taskId !== order.id) return failure("执行武将正在执行其他任务");
      if ((state.tasks ?? []).some((task) => task.id !== order.id && ACTIVE.has(task.status) && task.officerIds?.includes(id))) return failure("执行武将正在执行其他任务");
    } else if (officer.acted || officer.taskId || locked.has(id)) return failure("执行武将本月已行动或正在执行任务");
  }
  return { ok: true };
}

/** Reuse the established action primitives on a private draft; no UI or timer is involved. */
function executeOrder(state, order, rules, rng) {
  const { kind, cityId, officerIds, payload } = order;
  const officerId = officerIds[0];
  switch (kind) {
    case "domestic": return executeDomestic(state, cityId, payload.action, officerIds, rules);
    case "recruit": return executeRecruit(state, cityId, officerId, payload.amount, rules);
    case "transfer": return executeTransfer(state, cityId, payload.targetId, officerId, payload.troops, rules, { gold: payload.gold ?? 0, food: payload.food ?? 0 });
    case "governor": return appointGovernor(state, cityId, officerId, rules);
    case "search": return executeSearch(state, cityId, officerId, rules, rng);
    case "employ": return executeEmploy(state, cityId, officerId, payload.targetId, rules, rng);
    case "officerTransfer": return executeOfficerTransfer(state, cityId, payload.targetId, officerIds, rules);
    case "diplomacy": return executeDiplomacy(state, cityId, payload.targetFactionId, officerId, payload.action, rules, rng);
    case "trade": {
      // An accepted quote survives multi-turn execution and calendar changes.
      const tradeRules = structuredClone(rules);
      if (order.tradeRate !== undefined) tradeRules.economy.grainPerGoldByMonth.fill(order.tradeRate);
      return executeGrainTrade(state, cityId, officerId, payload.direction, payload.goldAmount, tradeRules);
    }
    case "march": {
      const army = validateArmy(state, cityId, payload.targetId, payload.divisions, rules, payload.supplies);
      if (!army.ok) return army;
      const departure = commitArmyDeparture(state, army);
      if (!departure.ok) return departure;
      return { ...departure, battle: { sourceCityId: cityId, targetCityId: payload.targetId, divisions: structuredClone(army.divisions),
        supplies: { ...army.supplies }, training: getCity(state, cityId).training, morale: getCity(state, cityId).morale,
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
    if (source?.factionId === task.factionId && source.factionId === state.playerFactionId
      && validReservation(task.reservation) && RESOURCE_KEYS.every((key) => isAmount(source[key] + task.reservation[key]))) {
      source.gold += task.reservation.gold;
      source.food += task.reservation.food;
      if (task.reservation.troops > 0) mergeTroops(source, task.reservation.troops, task.reservation.training, task.reservation.morale);
      task.reservation.status = "returned";
    } else task.reservation.status = "forfeited";
  }
  task.status = "failed";
  task.completedTurn = targetTurn;
  task.result = { ok: false, success: false, message };
  releaseActors(state, task);
  addEvent(state, `${task.title}未能完成：${message}。${task.reservation?.status === "returned" ? "预留钱粮与部队已退回原城。" : ""}`);
  return task;
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
  if (RESOURCE_KEYS.some((key) => !isAmount(source[key]) || !isAmount(source[key] + task.reservation[key]))) {
    return failTask(state, original, "任务出发城池的资源数据无效", targetTurn);
  }
  for (const key of RESOURCE_KEYS) source[key] += task.reservation[key];
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
  let result;
  try { result = executeOrder(draft, task, rules, rng); }
  catch { return failTask(state, original, "任务执行条件无效", targetTurn); }
  if (!result.ok) return failTask(state, original, result.message, targetTurn);
  if (RESOURCE_KEYS.some((key) => !isAmount(source[key]))) return failTask(state, original, "任务结算资源无效", targetTurn);
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
  Object.assign(state, draft);
  return state.tasks.find((entry) => entry.id === id);
}

/** Submit orders now; default effects are deferred until the closing turn is resolved. */
export function queueTask(state, input, rules) {
  if (state.turnResolution) return failure("正在结算回合，暂不能下达新任务");
  if (getReadyBattleTask(state)) return failure("请先处理正在进行的战斗");
  if (!input || !KINDS.has(input.kind)) return failure("无此任务类型");
  if (state.commandsRemaining <= 0) return failure("本月指令已用尽");
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
  const timing = taskTiming(order.kind, rules);
  if (!timing.ok) return timing;
  const actors = checkActors(state, order);
  if (!actors.ok) return actors;
  if (order.kind === "trade") order.tradeRate = grainExchangeRate(state.month, rules);
  const source = getCity(state, order.cityId);
  if (RESOURCE_KEYS.some((key) => !isAmount(source[key]))) return failure("城池资源数据无效");
  const trial = structuredClone(state);
  let preview;
  try { preview = executeOrder(trial, order, rules, () => 0.5); }
  catch { return failure("任务参数无效"); }
  if (!preview.ok) return preview;
  const after = getCity(trial, order.cityId);
  const reservation = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(0, source[key] - after[key])]));
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
  for (const key of RESOURCE_KEYS) source[key] -= reservation[key];
  state.commandsRemaining -= 1;
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
