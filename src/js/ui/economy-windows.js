import { grainExchangeRate, previewCityEconomy } from "../game/economy.js";
import { queueTask } from "../game/tasks.js";
import { taskOrderNote } from "./task-windows.js";
import { availableOfficers, getCity } from "../game/rules.js";
import { canIssueCommand, commandLimitEnabled } from "../game/commands.js";
import { escapeHtml as esc, number, openDialog, showToast } from "./components.js";

export function cityEconomyMarkup(state, city, rules) {
  if (city.factionId === "neutral") return '<p class="economy-note">无主城池，暂不结算赋税与俸禄。</p>';
  const budget = previewCityEconomy(state, city, rules);
  const warnings = [];
  if (city.food < budget.monthlyFood) warnings.push("存粮不足本月军需，月底将损失兵力");
  if (city.gold + budget.monthlyGold < budget.monthlySalary) warnings.push("预计税收仍不足发放俸禄，月底将降低忠诚");
  return `<div class="economy-grid">${[["每月税收", `+${number(budget.monthlyGold)} 金`], ["每月俸禄", `−${number(budget.monthlySalary)} 金`],
    ["每月军粮", `−${number(budget.monthlyFood)} 粮`], ["七月收获", `+${number(budget.annualFood)} 粮`]]
    .map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join("")}</div>
    ${warnings.map((warning) => `<p class="economy-warning">${warning}</p>`).join("")}`;
}

// All merchant entry points open the same window and call the same rule function.
export function createEconomyUI({ getState, rules, onChange }) {
  async function showTrade(cityId) {
    const state = getState();
    const city = getCity(state, cityId);
    if (!city || city.factionId !== state.playerFactionId) return showToast("请在本势力城池与商人交易", "error");
    const officers = availableOfficers(state, city);
    if (!officers.length || !canIssueCommand(state)) return showToast(commandLimitEnabled(state)
      ? "交易需要一名未行动武将与一道指令" : "交易需要一名未行动武将", "error");
    const rate = grainExchangeRate(state.month, rules);
    const body = document.createElement("div");
    body.className = "merchant-window";
    body.innerHTML = `<div class="merchant-quote"><div><span>${state.month} 月粮价 · 买卖同价</span><strong>1 金 <i>兑</i> ${rate} 粮</strong></div><small>七月收获价最低<br>每两个月调整一档</small></div>
      <p class="modal-description">仅使用${esc(city.name)}的钱粮，买卖同价，不收手续费。签发时锁定本月兑换比例，成交所得在任务完成时入库。</p>
      <div class="resource-row"><div><span>城中金</span><strong>${number(city.gold)}</strong></div><div><span>城中粮</span><strong>${number(city.food)}</strong></div></div>
      <div class="form-grid"><div class="field"><label for="trade-direction">交易方向</label><select id="trade-direction"><option value="buy">买入粮食</option><option value="sell">卖出粮食</option></select></div>
      <div class="field"><label for="trade-officer">经办武将</label><select id="trade-officer">${officers.map((officer) => `<option value="${officer.id}">${esc(officer.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="trade-amount">交易金额（金）</label><input id="trade-amount" type="number" min="1" step="1" value="100"></div>
      <div class="field trade-maximum"><button type="button" class="btn" data-trade-max>填入可交易上限</button><small>以整数金交易，粮食按当月比例换算</small></div></div>
      <div class="result-preview" data-trade-preview aria-live="polite"></div>
      <details class="scenario-notes"><summary>年度粮价与城池收支</summary><p>七、八月 1:10；九、十月 1:9；十一、十二月 1:8；一、二月 1:7；三、四月 1:6；五、六月 1:5。${rules.economy.harvestMonth} 月回合开始前收粮，金收入每月结算。</p>${cityEconomyMarkup(state, city, rules)}</details>`;
    const direction = body.querySelector("#trade-direction");
    const amount = body.querySelector("#trade-amount");
    const maximum = () => direction.value === "buy" ? Math.max(0, Math.floor(city.gold)) : Math.floor(city.food / rate);
    const refresh = () => {
      const gold = Number(amount.value);
      const valid = Number.isSafeInteger(gold) && gold >= 1 && gold <= maximum();
      amount.max = maximum();
      const buying = direction.value === "buy";
      const goldAfter = city.gold + (buying ? -gold : gold);
      const foodAfter = city.food + (buying ? gold * rate : -gold * rate);
      body.querySelector("[data-trade-preview]").innerHTML = `${buying ? "买入" : "卖出"}粮 ${number(gold * rate)}，${buying ? "支付" : "获得"}金 ${number(gold)}。<br>交易后：金 ${number(goldAfter)} · 粮 ${number(foodAfter)}${valid ? "" : '<br><strong class="economy-warning">请输入范围内的整数金额；不能透支钱粮。</strong>'}`;
    };
    if (city.gold < 1 && city.food >= rate) direction.value = "sell";
    amount.value = Math.max(1, Math.min(100, maximum()));
    direction.addEventListener("change", refresh);
    amount.addEventListener("input", refresh);
    body.querySelector("[data-trade-max]").addEventListener("click", () => { amount.value = maximum(); refresh(); });
    refresh();
    body.insertAdjacentHTML("beforeend", taskOrderNote(rules, "trade"));
    const result = await openDialog({ title: `${city.name} · 商人粮市`, content: body, confirmText: "签发交易", onConfirm: () => {
      const outcome = queueTask(getState(), { kind: "trade", cityId, officerIds: [body.querySelector("#trade-officer").value], payload: { direction: direction.value, goldAmount: amount.value } }, rules);
      if (!outcome.ok) { showToast(outcome.message, "error"); return false; }
      return outcome;
    } });
    if (result) await onChange(result.message);
  }
  return { showTrade };
}
