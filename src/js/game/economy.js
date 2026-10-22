import { addEvent } from "./state.js";
import { NEUTRAL_FACTION_ID } from "./atlas.js";

const localOfficers = (state, city) => [...new Set(city.officerIds ?? [])]
  .map((id) => state.officers.find((officer) => officer.id === id))
  .filter((officer) => officer && officer.factionId === city.factionId && officer.status !== "free" && officer.status !== "captured");
const supportFactor = (city, rules) => rules.economy.supportBase + city.popularSupport / rules.economy.supportDivisor;
const occupiedCities = (state) => state.cities.filter((city) => city.factionId && city.factionId !== NEUTRAL_FACTION_ID);

export function calculateMonthlyIncome(city, rules) {
  return Math.floor((rules.economy.monthlyGoldBase + city.commerce * rules.economy.monthlyGoldPerCommerce) * supportFactor(city, rules));
}

export function calculateAnnualHarvest(city, rules) {
  return Math.floor((rules.economy.annualFoodBase + city.agriculture * rules.economy.annualFoodPerAgriculture) * supportFactor(city, rules));
}

export function monthlyFoodCost(troops, rules) {
  return Math.ceil(Math.max(0, troops) * rules.economy.foodPerThousandPerMonth / 1000);
}

export function dailyFoodCost(troops, rules) {
  return Math.ceil(Math.max(0, troops) * rules.economy.foodPerThousandPerDay / 1000);
}

export function monthlySalaryCost(state, city, rules) {
  return localOfficers(state, city).reduce((sum, officer) => sum + (rules.economy.salaryByRank[officer.rank] ?? rules.economy.salaryByRank["从事"]), 0);
}

/** Fixed seasonal prices: one gold buys/sells this many units of grain. */
export function grainExchangeRate(month, rules) {
  return rules.economy.grainPerGoldByMonth[((Math.trunc(month) - 1) % 12 + 12) % 12];
}

export function previewCityEconomy(state, city, rules) {
  if (!city.factionId || city.factionId === NEUTRAL_FACTION_ID) {
    return { monthlyGold: 0, annualFood: 0, monthlyFood: 0, monthlySalary: 0, netGold: 0, harvestMonth: rules.economy.harvestMonth };
  }
  const monthlyGold = calculateMonthlyIncome(city, rules);
  const monthlySalary = monthlySalaryCost(state, city, rules);
  return {
    monthlyGold,
    annualFood: calculateAnnualHarvest(city, rules),
    monthlyFood: monthlyFoodCost(city.troops, rules),
    monthlySalary,
    netGold: monthlyGold - monthlySalary,
    harvestMonth: rules.economy.harvestMonth
  };
}

/** Settle the closing month for every occupied city, never from a shared treasury. */
export function settleMonthlyEconomy(state, rules) {
  const reports = [];
  for (const city of occupiedCities(state)) {
    const preview = previewCityEconomy(state, city, rules);
    city.gold += preview.monthlyGold;
    const foodSpent = Math.min(city.food, preview.monthlyFood);
    const foodShortfall = preview.monthlyFood - foodSpent;
    const salaryPaid = Math.min(city.gold, preview.monthlySalary);
    const salaryShortfall = preview.monthlySalary - salaryPaid;
    city.food -= foodSpent;
    city.gold -= salaryPaid;
    const troopLoss = foodShortfall > 0
      ? Math.floor(city.troops * rules.economy.maxStarvationLossRate * foodShortfall / preview.monthlyFood) : 0;
    const loyaltyLoss = salaryShortfall > 0
      ? Math.ceil(rules.economy.maxUnpaidLoyaltyLoss * salaryShortfall / preview.monthlySalary) : 0;
    city.troops -= troopLoss;
    if (loyaltyLoss) {
      for (const officer of localOfficers(state, city)) officer.loyalty = Math.max(0, (officer.loyalty ?? 100) - loyaltyLoss);
    }
    reports.push({
      cityId: city.id, goldIncome: preview.monthlyGold, foodCost: preview.monthlyFood, foodSpent, foodShortfall,
      salaryCost: preview.monthlySalary, salaryPaid, salaryShortfall, troopLoss, loyaltyLoss
    });
    if (city.factionId === state.playerFactionId) {
      addEvent(state, `${city.name}月结：金收入 ${preview.monthlyGold.toLocaleString()}，发俸 ${salaryPaid.toLocaleString()}，军粮支出 ${foodSpent.toLocaleString()}。`
        + (foodShortfall ? `缺粮 ${foodShortfall.toLocaleString()}，损失兵力 ${troopLoss.toLocaleString()}。` : "")
        + (salaryShortfall ? `欠俸 ${salaryShortfall.toLocaleString()}，城内将领忠诚 -${loyaltyLoss}。` : ""));
    }
  }
  return reports;
}

/** Called only after the date advances, before the July command phase opens. */
export function applyAnnualHarvest(state, rules) {
  if (state.month !== rules.economy.harvestMonth) return [];
  const reports = [];
  for (const city of occupiedCities(state)) {
    const food = calculateAnnualHarvest(city, rules);
    city.food += food;
    reports.push({ cityId: city.id, food });
    if (city.factionId === state.playerFactionId) addEvent(state, `${city.name}七月收获：粮 +${food.toLocaleString()}。`);
  }
  return reports;
}

export function executeGrainTrade(state, cityId, officerId, direction, goldAmount, rules) {
  if (state.commandsRemaining <= 0) return { ok: false, message: "本月指令已用尽" };
  const city = state.cities.find((entry) => entry.id === cityId);
  const officer = state.officers.find((entry) => entry.id === officerId);
  if (!city || city.factionId !== state.playerFactionId) return { ok: false, message: "只能在本势力城池买卖粮食" };
  if (!officer || !localOfficers(state, city).includes(officer) || officer.acted) return { ok: false, message: "执行武将不可用或本月已经行动" };
  if (!["buy", "sell"].includes(direction)) return { ok: false, message: "交易方向无效" };
  const gold = Number(goldAmount);
  if (!Number.isSafeInteger(gold) || gold < 1) return { ok: false, message: "交易金额须为至少 1 金的整数" };
  const rate = grainExchangeRate(state.month, rules);
  const food = gold * rate;
  if (!Number.isSafeInteger(food)) return { ok: false, message: "交易数量过大" };
  if (direction === "buy" && city.gold < gold) return { ok: false, message: `金不足，买粮需要 ${gold}` };
  if (direction === "sell" && city.food < food) return { ok: false, message: `粮不足，出售需要 ${food}` };
  const goldDelta = direction === "buy" ? -gold : gold;
  const foodDelta = direction === "buy" ? food : -food;
  city.gold += goldDelta;
  city.food += foodDelta;
  officer.acted = true;
  officer.merit = (officer.merit ?? 0) + 15;
  state.commandsRemaining -= 1;
  const message = `${direction === "buy" ? "买入" : "卖出"}粮 ${food.toLocaleString()}，金 ${goldDelta > 0 ? "+" : ""}${goldDelta.toLocaleString()}`;
  addEvent(state, `${city.name}：${officer.name}${message}。`);
  return { ok: true, message, rate, goldDelta, foodDelta };
}
