import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calculateMonthlyIncome, calculateAnnualHarvest, dailyFoodCost, monthlyFoodCost, monthlySalaryCost,
  previewCityEconomy, grainExchangeRate, settleMonthlyEconomy, executeGrainTrade } from "../src/js/game/economy.js";
import { advanceMonth } from "../src/js/game/rules.js";

const rules = JSON.parse(await readFile(new URL("../src/data/rules.json", import.meta.url), "utf8"));

function fixture() {
  const city = (id, factionId, officerIds = []) => ({ id, name: id, factionId, officerIds, governorId: null,
    troops: 1000, food: 5000, gold: 1000, agriculture: 50, commerce: 50, popularSupport: 70, training: 60, morale: 60, adjacent: [] });
  return {
    year: 196, month: 1, elapsedMonths: 0, playerFactionId: "player", commandsRemaining: 6, commandsMax: 6, eventLog: [],
    cities: [city("home", "player", ["lord", "minister"]), city("other", "player"), city("rival", "rival", ["enemy"]), city("empty", "neutral")],
    officers: [
      { id: "lord", name: "君主", rank: "君主", factionId: "player", status: "active", loyalty: 100, acted: false, merit: 0 },
      { id: "minister", name: "谋臣", rank: "军师", factionId: "player", status: "active", loyalty: 90, acted: false, merit: 0 },
      { id: "enemy", name: "敌将", rank: "校尉", factionId: "rival", status: "active", loyalty: 80, acted: false, merit: 0 }
    ]
  };
}

test("local economy preview separates monthly money, annual grain, food and ranked salaries", () => {
  const state = fixture();
  const city = state.cities[0];
  const preview = previewCityEconomy(state, city, rules);
  assert.equal(preview.monthlyGold, Math.floor((170 + 50 * 13) * (0.55 + 70 / 220)));
  assert.equal(preview.annualFood, Math.floor((3200 + 50 * 248) * (0.55 + 70 / 220)));
  assert.equal(preview.monthlyFood, 120);
  assert.equal(preview.monthlySalary, 210);
  assert.equal(preview.netGold, preview.monthlyGold - 210);
  assert.equal(preview.harvestMonth, 7);
  assert.equal(monthlyFoodCost(1250, rules), 150);
  assert.equal(dailyFoodCost(1250, rules), 5);
  assert.equal(dailyFoodCost(1, rules), 1);
  assert.equal(dailyFoodCost(0, rules), 0);
});

test("payroll includes each resident active officer once and excludes free/captured officers", () => {
  const state = fixture();
  const city = state.cities[0];
  state.officers[1].status = "free";
  city.officerIds.push("lord", "enemy", "missing");
  assert.equal(monthlySalaryCost(state, city, rules), 120);
  state.officers[0].status = "captured";
  assert.equal(monthlySalaryCost(state, city, rules), 0);
});

test("all occupied cities settle independently every month, including AI and unstaffed cities", () => {
  const state = fixture();
  const before = structuredClone(state.cities);
  const reports = settleMonthlyEconomy(state, rules);
  assert.equal(reports.length, 3);
  for (let i = 0; i < 3; i += 1) {
    const city = state.cities[i];
    assert.equal(city.gold, before[i].gold + calculateMonthlyIncome(before[i], rules) - monthlySalaryCost(state, city, rules));
    assert.equal(city.food, before[i].food - 120);
    assert.equal(city.troops, 1000);
  }
  assert.deepEqual(state.cities[3], before[3]);
  assert.deepEqual(previewCityEconomy(state, state.cities[3], rules), { monthlyGold: 0, annualFood: 0, monthlyFood: 0, monthlySalary: 0, netGold: 0, harvestMonth: 7 });
});

test("grain is harvested only entering July, once per year, after the June consumption", () => {
  const state = fixture();
  const city = state.cities[0];
  const initialFood = city.food;
  const annual = calculateAnnualHarvest(city, rules);
  const harvestMonths = [];
  for (let i = 0; i < 12; i += 1) {
    const report = advanceMonth(state, rules);
    if (report.harvest.length) harvestMonths.push(state.month);
  }
  assert.deepEqual(harvestMonths, [7]);
  assert.equal(city.food, initialFood + annual - 12 * 120);
  assert.equal(state.year, 197);
  assert.equal(state.month, 1);
  assert.equal(state.cities[3].food, initialFood);
});

test("June shortage is settled before the new July harvest and uses the actual reduced garrison", () => {
  const state = fixture();
  state.month = 6;
  const city = state.cities[0];
  city.food = 0;
  const result = advanceMonth(state, rules);
  assert.equal(result.monthly.find((entry) => entry.cityId === city.id).troopLoss, 120);
  assert.equal(city.troops, 880);
  assert.equal(city.food, calculateAnnualHarvest(city, rules));
  const beforeFood = city.food;
  advanceMonth(state, rules);
  assert.equal(city.food, beforeFood - monthlyFoodCost(880, rules));
});

test("partial food and salary shortages cause proportional losses, without borrowing another city's reserves", () => {
  const state = fixture();
  const city = state.cities[0];
  const zeroIncomeRules = structuredClone(rules);
  zeroIncomeRules.economy.monthlyGoldBase = 0;
  zeroIncomeRules.economy.monthlyGoldPerCommerce = 0;
  city.food = 60;
  city.gold = 105;
  const report = settleMonthlyEconomy(state, zeroIncomeRules).find((entry) => entry.cityId === city.id);
  assert.equal(city.food, 0);
  assert.equal(city.gold, 0);
  assert.equal(city.troops, 940);
  assert.equal(report.foodShortfall, 60);
  assert.equal(report.salaryShortfall, 105);
  assert.equal(report.troopLoss, 60);
  assert.equal(report.loyaltyLoss, 5);
  assert.equal(state.officers[0].loyalty, 95);
  assert.equal(state.officers[1].loyalty, 85);
  assert.equal(state.cities[1].gold, 1000);
});

test("complete shortage caps troop losses at twelve percent and loyalty loss at ten", () => {
  const state = fixture();
  const city = state.cities[0];
  const zeroIncomeRules = structuredClone(rules);
  zeroIncomeRules.economy.monthlyGoldBase = 0;
  zeroIncomeRules.economy.monthlyGoldPerCommerce = 0;
  city.food = 0;
  city.gold = 0;
  state.officers[1].loyalty = 4;
  const report = settleMonthlyEconomy(state, zeroIncomeRules)[0];
  assert.equal(report.troopLoss, 120);
  assert.equal(report.loyaltyLoss, 10);
  assert.equal(city.troops, 880);
  assert.equal(state.officers[0].loyalty, 90);
  assert.equal(state.officers[1].loyalty, 0);
});

test("seasonal prices use six discrete bands, cheapest in July and dearest before harvest", () => {
  assert.deepEqual(Array.from({ length: 12 }, (_, index) => grainExchangeRate(index + 1, rules)), [7, 7, 6, 6, 5, 5, 10, 10, 9, 9, 8, 8]);
  assert.equal(grainExchangeRate(7, rules), 10);
  assert.equal(grainExchangeRate(6, rules), 5);
  assert.equal(grainExchangeRate(19, rules), 10);
});

test("buying grain deducts only its local principal and consumes one officer/command", () => {
  const state = fixture();
  state.month = 7;
  const city = state.cities[0];
  const result = executeGrainTrade(state, city.id, "minister", "buy", 100, rules);
  assert.equal(result.ok, true);
  assert.equal(result.rate, 10);
  assert.equal(city.gold, 900);
  assert.equal(city.food, 6000);
  assert.equal(state.commandsRemaining, 5);
  assert.equal(state.officers[1].acted, true);
  assert.equal(state.cities[1].gold, 1000);
});

test("a penniless city can sell grain at the exact same rate as buying", () => {
  const state = fixture();
  const city = state.cities[0];
  city.gold = 0;
  const result = executeGrainTrade(state, city.id, "minister", "sell", 100, rules);
  assert.equal(result.ok, true);
  assert.equal(city.gold, 100);
  assert.equal(city.food, 4300);
  assert.equal(state.commandsRemaining, 5);
});

test("bad trade orders are atomic and cannot bypass costs, staffing or commands", () => {
  const checks = [
    ["home", "minister", "buy", -100], ["home", "minister", "buy", 0], ["home", "minister", "buy", 11.5],
    ["home", "minister", "buy", NaN], ["home", "minister", "buy", Infinity], ["home", "minister", "buy", 1001],
    ["home", "minister", "sell", 1000], ["home", "minister", "gift", 100], ["other", "minister", "buy", 100],
    ["rival", "enemy", "buy", 100], ["empty", null, "buy", 100]
  ];
  for (const args of checks) {
    const state = fixture();
    const snapshot = structuredClone(state);
    assert.equal(executeGrainTrade(state, ...args, rules).ok, false);
    assert.deepEqual(state, snapshot);
  }
  for (const invalidate of [
    (state) => { state.commandsRemaining = 0; },
    (state) => { state.officers[1].acted = true; },
    (state) => { state.officers[1].status = "captured"; },
    (state) => { state.officers[1].status = "free"; }
  ]) {
    const state = fixture();
    invalidate(state);
    const snapshot = structuredClone(state);
    assert.equal(executeGrainTrade(state, "home", "minister", "buy", 100, rules).ok, false);
    assert.deepEqual(state, snapshot);
  }
});

test("single-gold trades have no minimum fee or spread", () => {
  const state = fixture();
  const city = state.cities[0];
  const before = { gold: city.gold, food: city.food };
  assert.equal(executeGrainTrade(state, city.id, "minister", "buy", 1, rules).ok, true);
  assert.equal(city.gold, before.gold - 1);
  assert.equal(city.food, before.food + grainExchangeRate(state.month, rules));
  assert.equal(executeGrainTrade(state, city.id, "lord", "sell", 1, rules).ok, true);
  assert.deepEqual({ gold: city.gold, food: city.food }, before);
});
