import test from "node:test";
import assert from "node:assert/strict";
import { createCampaignUI } from "../src/js/ui/campaign-windows.js";

test("restoring a manual defense resumes the battlefield without asking or auto resolving", async () => {
  const pending = { id: "first", resolutionMode: "manual", resolved: false };
  const state = { pendingInvasions: [pending] };
  let entered = 0;
  const ui = createCampaignUI({
    getState: () => state,
    onChange: () => assert.fail("restoring an already saved manual choice must not save another choice"),
    onManualDefense: async (invasion) => {
      assert.equal(invasion, pending);
      entered += 1;
      state.pendingInvasions = [];
      return { ok: true, message: "守城成功" };
    }
  });
  assert.equal(await ui.processPendingInvasions(), true);
  assert.equal(entered, 1);
  assert.equal(await ui.processPendingInvasions(), true);
  assert.equal(entered, 1, "settled invasions must never be re-entered");
});

test("invasion handling waits for battle completion and re-reads the current queue", async () => {
  let state = { pendingInvasions: [{ id: "first", resolutionMode: "manual", resolved: false }] };
  let finishFirst;
  const entered = [];
  const ui = createCampaignUI({
    getState: () => state,
    onManualDefense: async (invasion) => {
      entered.push(invasion.id);
      if (invasion.id === "first") {
        await new Promise((resolve) => { finishFirst = resolve; });
        state = { pendingInvasions: [{ id: "second", resolutionMode: "manual", resolved: false }] };
      } else {
        state.pendingInvasions = [];
      }
      return { ok: true };
    }
  });
  let completed = false;
  const processing = ui.processPendingInvasions().then((result) => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(entered, ["first"]);
  finishFirst();
  assert.equal(await processing, true);
  assert.deepEqual(entered, ["first", "second"]);
});
