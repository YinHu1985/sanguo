import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { marchSupplyLimits } from "../src/js/ui/march-window.js";
import { dailyFoodCost } from "../src/js/game/economy.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));

test("march provisions allow sixty starting-strength days independently of the thirty-day monthly slice", () => {
  const { daily, maxDays, maximum } = marchSupplyLimits(12345, 100000, rules);
  assert.equal(daily, dailyFoodCost(12345, rules));
  assert.equal(maxDays, 60);
  assert.equal(maximum, daily * 60);
  assert.equal(rules.battleDayLimit, 30);
});

test("provisions recompute for changed composition and are always capped by the city warehouse", () => {
  assert.equal(marchSupplyLimits(10000, 125, rules).maximum, 125);
  assert.equal(marchSupplyLimits(0, 100000, rules).maximum, 0);
  assert.equal(marchSupplyLimits(5000, 100000, rules).maximum, dailyFoodCost(5000, rules) * 60);
  assert.equal(marchSupplyLimits(NaN, 100000, rules).maximum, 0);
  const legacyRules = structuredClone(rules);
  delete legacyRules.army.maxSupplyDays;
  assert.equal(marchSupplyLimits(5000, 100000, legacyRules).maxDays, 60);
});

test("march UI uses the independent provision cap for input, defaults and full-provision shortcut", async () => {
  const source = await readFile(new URL("../src/js/ui/march-window.js", import.meta.url), "utf8");
  assert.match(source, /foodInput\.max = String\(maximum\)/);
  assert.match(source, /if \(!foodEdited\) foodInput\.value = maximum/);
  assert.match(source, /备足 \$\{maxSupplyDays\} 日粮/);
  assert.match(source, /战役每月推进/);
  assert.match(source, /未决则下月续战/);
  assert.match(source, /多余军粮战后归库/);
});
