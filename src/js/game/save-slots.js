import { migrateState, storageKey } from "./state.js";

const sourceSaves = new WeakMap();
const journalKey = (scenarioId) => `${storageKey(scenarioId)}:menu-write-journal`;
const backupKey = (scenarioId) => `${storageKey(scenarioId)}:before-menu-upgrade`;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const recordsWithIds = (entries) => Array.isArray(entries) && entries.every((entry) => isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0);

const manualSlots = (scenarioId) => [1, 2, 3].map((number) => ({
  id: `manual-${number}`, key: `${storageKey(scenarioId)}:manual-${number}`, label: `手动存档 ${number}`
}));

const slots = (scenarioId) => [
  { id: "active", key: storageKey(scenarioId), label: "自动存档" },
  { id: "previous", key: `${storageKey(scenarioId)}:previous`, label: "上一局快照" },
  { id: "legacy", key: "hanmo-zhoujun-save-v1", label: "兼容旧存档" },
  ...manualSlots(scenarioId)
];

export function isPlayableSave(saved, scenarioId) {
  return saved?.version === 1 && saved.scenarioId === scenarioId && saved.started === true
    && Number.isSafeInteger(saved.year) && saved.year > 0 && Number.isSafeInteger(saved.month) && saved.month >= 1 && saved.month <= 12
    && recordsWithIds(saved.cities) && saved.cities.length > 0 && saved.cities.every((city) => Array.isArray(city.officerIds))
    && recordsWithIds(saved.officers) && recordsWithIds(saved.factions)
    && (saved.tasks == null || Array.isArray(saved.tasks) && saved.tasks.every(isRecord))
    && (saved.pendingInvasions == null || Array.isArray(saved.pendingInvasions) && saved.pendingInvasions.every(isRecord))
    && saved.factions.some((faction) => faction.id === saved.playerFactionId);
}

function parsePlayable(raw, scenarioId) {
  try {
    const saved = JSON.parse(raw);
    return isPlayableSave(saved, scenarioId) ? saved : null;
  } catch { return null; }
}

function readJournal(scenarioId, storage) {
  const raw = storage.getItem(journalKey(scenarioId));
  if (raw === null) return null;
  let journal;
  try { journal = JSON.parse(raw); } catch { /* Preserve an unreadable recovery file. */ }
  if (!isRecord(journal) || journal.version !== 1 || journal.scenarioId !== scenarioId
    || ![journal.activeRaw, journal.previousRaw].every((value) => value === null || typeof value === "string")) {
    throw new Error("存档恢复记录无法读取，已保留原始记录，请先备份浏览器存档再恢复。");
  }
  return journal;
}

function readSlotRaw(slot, scenarioId, storage) {
  // Manual slots are independent snapshots, not part of the active/previous swap.
  if (slot.id.startsWith("manual-")) return storage.getItem(slot.key);
  const journal = readJournal(scenarioId, storage);
  if (journal && slot.id === "active") return journal.activeRaw;
  if (journal && slot.id === "previous") return journal.previousRaw;
  return storage.getItem(slot.key);
}

function readSlot(slot, scenarioId, storage) {
  try { return parsePlayable(readSlotRaw(slot, scenarioId, storage), scenarioId); }
  catch { return null; }
}

function hasPendingResolution(saved) {
  return Boolean(saved.turnResolution || saved.tasks?.some((task) => task.status === "awaiting_battle")
    || saved.pendingInvasions?.some((order) => !order.resolved));
}

function summarizeSlot(slot, saved) {
  const faction = saved.factions.find((entry) => entry.id === saved.playerFactionId);
  return { id: slot.id, label: slot.label, factionName: faction.name, year: saved.year, month: saved.month,
    cities: saved.cities.filter((city) => city.factionId === saved.playerFactionId).length,
    commands: saved.commandsRemaining ?? 0, pending: hasPendingResolution(saved) };
}

/** Empty and damaged slots remain selectable for a confirmed manual overwrite. */
export function listManualSaveSlots(scenarioId, storage = globalThis.localStorage) {
  return manualSlots(scenarioId).map((slot) => {
    let raw;
    try { raw = storage.getItem(slot.key); }
    catch { return { id: slot.id, label: slot.label, empty: true, invalid: true }; }
    const saved = parsePlayable(raw, scenarioId);
    return saved ? { ...summarizeSlot(slot, saved), empty: false, invalid: false }
      : { id: slot.id, label: slot.label, empty: true, invalid: raw !== null };
  });
}

/**
 * Save only a settled campaign checkpoint. The caller confirms any overwrite.
 * One Web Storage setItem is atomic, so failure leaves the original slot intact.
 * No metadata, active save, previous snapshot or caller state is changed here.
 */
export function saveManualSlot(slotId, state, storage = globalThis.localStorage) {
  const scenarioId = state?.scenarioId;
  const slot = manualSlots(scenarioId).find((entry) => entry.id === slotId);
  if (!slot) throw new Error("无效的手动存档位置，请重新选择存档槽。");
  if (typeof scenarioId !== "string" || !scenarioId || !isPlayableSave(state, scenarioId)) {
    throw new Error("当前征程数据无效，无法手动存档；原有存档未改动。");
  }
  if (hasPendingResolution(state)) {
    throw new Error("当前仍有回合结算或待处理战斗，请处理完毕后再手动存档。");
  }
  let raw;
  try { raw = JSON.stringify(state); }
  catch (error) { throw new Error("当前征程无法序列化，原有手动存档未改动。", { cause: error }); }
  const serialized = parsePlayable(raw, scenarioId);
  if (!serialized || hasPendingResolution(serialized)) {
    throw new Error("当前征程数据无法安全保存，原有手动存档未改动。");
  }
  try { storage.setItem(slot.key, raw); }
  catch (error) {
    throw new Error("手动存档写入失败，原有存档未改动；请检查浏览器存储空间后重试。", { cause: error });
  }
  return { ok: true, slotId };
}

/** Reading the title screen must not migrate, overwrite or resume a campaign. */
export function listCampaignSaves(scenarioId, storage = globalThis.localStorage) {
  return slots(scenarioId).flatMap((slot) => {
    const saved = readSlot(slot, scenarioId, storage);
    if (!saved) return [];
    return [summarizeSlot(slot, saved)];
  });
}

export function loadCampaignSlot(slotId, scenario, rules, storage = globalThis.localStorage) {
  const slot = slots(scenario.id).find((entry) => entry.id === slotId);
  let raw;
  try { raw = slot && readSlotRaw(slot, scenario.id, storage); } catch { /* Show the standard unavailable-save message. */ }
  const saved = parsePlayable(raw, scenario.id);
  if (!saved) throw new Error("该存档不可读取，请重新选择存档或开始新游戏。");
  const migrated = migrateState(saved, scenario, rules);
  sourceSaves.set(migrated, { raw });
  return migrated;
}

// JSON key ordering is not a migration; only changed values need a backup.
function equalData(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((entry, index) => equalData(entry, right[index]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalData(left[key], right[key]));
}

function sameSave(raw, next) {
  try { return raw !== null && equalData(JSON.parse(raw), next); }
  catch { return false; }
}

/** Restore only changed slots, so an unchanged full slot needs no extra quota. */
function restoreJournal(scenarioId, journal, storage) {
  const activeKey = storageKey(scenarioId);
  const failures = [];
  for (const [key, raw] of [[activeKey, journal.activeRaw], [`${activeKey}:previous`, journal.previousRaw]]) {
    try {
      if (storage.getItem(key) === raw) continue;
      if (raw === null) storage.removeItem(key);
      else storage.setItem(key, raw);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new Error("原始存档尚未完全恢复；恢复记录仍保留在本机，勿清除浏览器数据，释放存储空间后可再次读取。");
  storage.removeItem(journalKey(scenarioId));
}

/**
 * Commit a menu selection before swapping the caller's in-memory campaign.
 * A durable journal protects both slots, including a previous-slot swap. The
 * title screen reads original records from a surviving journal without writes.
 */
export function persistCampaignSelection(nextState, { archiveCurrent = false } = {}, storage = globalThis.localStorage) {
  const scenarioId = nextState?.scenarioId;
  if (typeof scenarioId !== "string" || !scenarioId || !isPlayableSave(nextState, scenarioId)) {
    throw new Error("新存档数据无效，未替换现有征程。");
  }
  let nextRaw;
  let next;
  try { nextRaw = JSON.stringify(nextState); next = JSON.parse(nextRaw); }
  catch { throw new Error("新存档无法序列化，未替换现有征程。"); }
  const activeKey = storageKey(scenarioId);
  const previousKey = `${activeKey}:previous`;
  let activeRaw;
  let previousRaw;
  let archiveRaw = null;
  let upgradeRaw = null;
  try {
    const interrupted = readJournal(scenarioId, storage);
    if (interrupted) restoreJournal(scenarioId, interrupted, storage);
    activeRaw = storage.getItem(activeKey);
    previousRaw = storage.getItem(previousKey);
    if (archiveCurrent) {
      archiveRaw = parsePlayable(activeRaw, scenarioId) ? activeRaw : null;
      if (archiveRaw === null) {
        const legacyRaw = storage.getItem("hanmo-zhoujun-save-v1");
        if (parsePlayable(legacyRaw, scenarioId)) archiveRaw = legacyRaw;
      }
    }
    const sourceRaw = sourceSaves.get(nextState)?.raw;
    if (sourceRaw !== undefined && !sameSave(sourceRaw, next)) upgradeRaw = sourceRaw;
    else if (!archiveCurrent && parsePlayable(activeRaw, scenarioId) && !sameSave(activeRaw, next)) upgradeRaw = activeRaw;
    if (storage.getItem(backupKey(scenarioId)) !== null) upgradeRaw = null;
  } catch (error) {
    throw new Error(`无法准备存档写入，原始存档或恢复记录已保留：${error.message}`, { cause: error });
  }
  const changesActive = !sameSave(activeRaw, next);
  const changesPrevious = archiveRaw !== null && archiveRaw !== previousRaw;
  if (!changesActive && !changesPrevious && upgradeRaw === null) return { ok: true, changed: false, archived: false, backupCreated: false };
  const journal = { version: 1, scenarioId, activeRaw, previousRaw };
  try { storage.setItem(journalKey(scenarioId), JSON.stringify(journal)); }
  catch (error) { throw new Error("无法建立存档恢复记录，未改动现有存档；请检查浏览器存储空间。", { cause: error }); }
  try {
    if (upgradeRaw !== null) storage.setItem(backupKey(scenarioId), upgradeRaw);
    if (changesPrevious) storage.setItem(previousKey, archiveRaw);
    if (changesActive) storage.setItem(activeKey, nextRaw);
    storage.removeItem(journalKey(scenarioId));
  } catch (error) {
    try { restoreJournal(scenarioId, journal, storage); }
    catch (recoveryError) {
      throw new Error(`存档写入失败，恢复记录已保留，勿清除浏览器数据：${recoveryError.message}`, { cause: error });
    }
    throw new Error("存档写入失败，原有存档与快照已恢复，请检查存储空间后重试。", { cause: error });
  }
  return { ok: true, changed: changesActive || changesPrevious, archived: changesPrevious, backupCreated: upgradeRaw !== null };
}
