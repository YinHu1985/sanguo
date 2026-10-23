import test from "node:test";
import assert from "node:assert/strict";
import {
  BATTLE_STATUS_DEFINITIONS, initializeBattleStatuses, getBattleStatus, applyBattleStatus,
  removeBattleStatus, getControllingStatus, consumeActivationStatuses, clearBattleStatuses, normalizeStatusDuration
} from "../src/js/game/battle-statuses.js";
import { battleControlLabel, battleStatusLabels } from "../src/js/ui/battle-automation.js";

test("status records hold serializable durations and expire one completed activation at a time", () => {
  const unit = initializeBattleStatuses({});
  assert.equal(applyBattleStatus(unit, "doubt", { remainingActivations: 3, sourceId: "caster" }).ok, true);
  for (const count of [3, 2, 1]) {
    assert.equal(getBattleStatus(unit, "doubt").remainingActivations, count);
    assert.equal(getControllingStatus(unit).type, "doubt");
    const before = JSON.stringify(unit);
    battleStatusLabels(unit); battleControlLabel(unit); getControllingStatus(unit);
    assert.equal(JSON.stringify(unit), before, "reads and rendering never consume duration");
    consumeActivationStatuses(unit);
  }
  assert.equal(getBattleStatus(unit, "doubt"), null);
  assert.equal(getControllingStatus(unit), null);
});

test("one-activation legacy fields migrate without duplicate JSON state and aliases remain writable", () => {
  const unit = initializeBattleStatuses({ doubt: { sourceId: "a" }, provocation: { sourceId: "b", active: false } });
  assert.equal(unit.doubt.remainingActivations, 1);
  assert.equal(unit.provocation.remainingActivations, 1);
  assert.deepEqual(Object.keys(unit), ["statuses"]);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(unit))), ["statuses"]);
  unit.doubt = { sourceId: "c", remainingActivations: 4 };
  assert.equal(unit.statuses.doubt.remainingActivations, 4);
  unit.provocation = null;
  assert.equal(getBattleStatus(unit, "provocation"), null);
  initializeBattleStatuses(unit);
  assert.equal(unit.doubt.sourceId, "c");
});

test("serialized and structured-cloned multi-round state retains source, memory and remaining durations", () => {
  const original = initializeBattleStatuses({});
  applyBattleStatus(original, "provocation", { remainingActivations: 4, sourceId: "enemy", active: true, lastKnownPosition: { x: 3, y: 2 } });
  consumeActivationStatuses(original);
  for (const unit of [JSON.parse(JSON.stringify(original)), structuredClone(original)]) {
    assert.equal(getBattleStatus(unit, "provocation").remainingActivations, 3);
    assert.match(battleControlLabel(unit), /3 次行动/);
    initializeBattleStatuses(unit);
    assert.equal(unit.provocation.active, false);
    assert.equal(unit.provocation.sourceId, "enemy");
    assert.deepEqual(unit.provocation.lastKnownPosition, { x: 3, y: 2 });
    consumeActivationStatuses(unit);
    assert.equal(unit.provocation.remainingActivations, 2);
  }
  assert.equal(original.provocation.remainingActivations, 3, "cloned state is independent");
});

test("priority, independent durations and labels handle simultaneous control effects", () => {
  const unit = initializeBattleStatuses({});
  applyBattleStatus(unit, "doubt", { remainingActivations: 2 });
  applyBattleStatus(unit, "provocation", { remainingActivations: 4, active: true });
  assert.equal(getControllingStatus(unit).type, "doubt");
  assert.deepEqual(battleStatusLabels(unit), ["疑兵 · 跳过接下来 2 次行动", "中计追击 · 强制行动中（含本次剩 4 次）"]);
  consumeActivationStatuses(unit);
  assert.equal(unit.doubt.remainingActivations, 1);
  assert.equal(unit.provocation.remainingActivations, 3);
  assert.equal(unit.provocation.active, false);
  consumeActivationStatuses(unit);
  assert.equal(getControllingStatus(unit).type, "provocation");
  assert.equal(unit.provocation.remainingActivations, 2);
});

test("duplicate application does not refresh, extend or replace an existing source", () => {
  const unit = initializeBattleStatuses({});
  applyBattleStatus(unit, "doubt", { remainingActivations: 3, sourceId: "original" });
  const before = structuredClone(unit);
  assert.equal(applyBattleStatus(unit, "doubt", { remainingActivations: 9, sourceId: "new" }).ok, false);
  assert.deepEqual(structuredClone(unit), before);
});

test("invalid durations cannot become infinite or revive expired records", () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3", null]) {
    const unit = initializeBattleStatuses({});
    assert.equal(applyBattleStatus(unit, "doubt", { remainingActivations: invalid }).ok, false);
    assert.equal(normalizeStatusDuration(invalid), 1);
    initializeBattleStatuses(Object.assign(unit, { statuses: { doubt: { remainingActivations: invalid } } }));
    assert.equal(getBattleStatus(unit, "doubt"), null);
  }
  const unit = initializeBattleStatuses({ doubt: { remainingActivations: 4 }, statuses: { doubt: { remainingActivations: 0 } } });
  assert.equal(unit.doubt, null, "canonical expired state must not revive from a legacy alias");
  assert.equal(normalizeStatusDuration(1000), 1000);
});

test("uninitialized canonical records with missing or mismatched type never control a unit until repaired", () => {
  for (const type of [undefined, "provocation", "futureStatus"]) {
    const unit = { statuses: { doubt: { ...(type === undefined ? {} : { type }), remainingActivations: 2, sourceId: "caster" } } };
    const before = structuredClone(unit);
    assert.doesNotThrow(() => {
      assert.equal(getBattleStatus(unit, "doubt"), null);
      assert.equal(getControllingStatus(unit), null);
      assert.equal(battleControlLabel(unit), "");
      assert.deepEqual(battleStatusLabels(unit), []);
    });
    assert.deepEqual(unit, before, "reads must reject malformed records without mutating them");
    initializeBattleStatuses(unit);
    assert.equal(getBattleStatus(unit, "doubt").type, "doubt");
    assert.equal(getControllingStatus(unit).type, "doubt");
    assert.equal(unit.doubt.remainingActivations, 2);
    assert.equal(unit.doubt.sourceId, "caster");
    assert.match(battleControlLabel(unit), /接下来 2 次行动/);
  }
});

test("phase cleanup and removal clear multi-round controls and do not rely on UI aliases", () => {
  for (const reason of ["siege", "battleEnd", "removed"]) {
    const unit = { statuses: { doubt: { type: "doubt", remainingActivations: 10 }, provocation: { type: "provocation", remainingActivations: 10 } } };
    clearBattleStatuses(unit, reason);
    assert.deepEqual(unit.statuses, {});
  }
  const unit = { doubt: { sourceId: "a" } };
  removeBattleStatus(unit, "doubt");
  assert.equal(getBattleStatus(unit, "doubt"), null);
});

test("future registered non-control statuses reuse duration, reset and cleanup without controlling the unit", () => {
  const definitions = { ...BATTLE_STATUS_DEFINITIONS, inspired: { name: "振奋", durationUnit: "activation", control: null,
    clearOn: ["battleEnd"], resetAfterActivation: [], stacking: "reject" } };
  const unit = initializeBattleStatuses({});
  assert.equal(applyBattleStatus(unit, "inspired", { remainingActivations: 3, magnitude: 10 }, definitions).ok, true);
  assert.equal(getControllingStatus(unit, definitions), null);
  consumeActivationStatuses(unit, definitions);
  assert.equal(getBattleStatus(unit, "inspired").remainingActivations, 2);
  clearBattleStatuses(unit, "siege", definitions);
  assert.equal(getBattleStatus(unit, "inspired").magnitude, 10);
  clearBattleStatuses(unit, "battleEnd", definitions);
  assert.equal(getBattleStatus(unit, "inspired"), null);
});

test("unknown records are retained for forward compatibility but cannot control or be applied", () => {
  const unit = initializeBattleStatuses({ statuses: { futureStatus: { remainingActivations: 2, data: "kept" } } });
  assert.equal(getControllingStatus(unit), null);
  consumeActivationStatuses(unit);
  assert.equal(unit.statuses.futureStatus.remainingActivations, 2);
  assert.equal(applyBattleStatus(unit, "notImplemented", {}).ok, false);
  clearBattleStatuses(unit, "removed");
  assert.deepEqual(unit.statuses, {});
});
