import { availableOfficers, getCity, getFaction } from "../game/rules.js";
import { areAllied } from "../game/campaign.js";
import { dailyFoodCost, monthlyFoodCost } from "../game/economy.js";
import { armyLimits, formationOfficerIds } from "../game/army.js";
import { queueTask } from "../game/tasks.js";
import { createArmyComposer } from "./army-composer.js";
import { taskOrderNote } from "./task-windows.js";
import { escapeHtml as esc, number, openDialog, showToast } from "./components.js";

export function marchSupplyLimits(troops, cityFood, rules) {
  const daily = Number.isSafeInteger(troops) && troops >= 0 ? dailyFoodCost(troops, rules) : 0;
  const maxDays = armyLimits(rules).maxSupplyDays;
  const stock = Number.isSafeInteger(cityFood) && cityFood >= 0 ? cityFood : 0;
  return { daily, maxDays, maximum: Math.min(stock, daily * maxDays) };
}

export async function openMarchDialog({ state, city, rules }) {
  const targets = city.adjacent.map((id) => getCity(state, id)).filter((target) => target && target.factionId !== state.playerFactionId && !areAllied(state, state.playerFactionId, target.factionId));
  if (!targets.length) { showToast("相邻城池均为本势力或盟友，当前不能出征", "error"); return null; }
  const { maxSupplyDays } = armyLimits(rules);
  const body = document.createElement("div");
  body.innerHTML = `<p class="modal-description">每队由主将统兵，兵力上限仅取主将官职兵额；副将只提供综合能力，不单独持有兵员。可在部队卡片内改任主将。各部队继承${esc(city.name)}训练 ${city.training}、士气 ${city.morale}。敌方当前默认先出城野战。</p>
    <div class="field"><label for="march-target">进攻目标</label><select id="march-target">${targets.map((target) => `<option value="${target.id}">${esc(target.name)} · ${esc(getFaction(state,target.factionId).name)} · ${number(target.troops)} 兵 · 城墙 ${target.wallLevel} 级</option>`).join("")}</select></div><div data-composer></div>
    <section class="march-supplies"><h3>全军共用钱粮</h3><div class="form-grid"><div class="field"><label for="march-food">携带军粮 · 城中 ${number(city.food)} · 最多 ${maxSupplyDays} 日粮</label><input id="march-food" type="number" min="0" max="0" step="1" value="0"></div><div class="field"><label for="march-gold">携带金钱 · 城中 ${number(city.gold)}</label><input id="march-gold" type="number" min="0" max="${Math.max(0,city.gold-rules.actions.march)}" step="1" value="${Math.max(0,Math.min(150,city.gold-rules.actions.march))}"></div></div><button type="button" class="btn" data-full-provisions>备足 ${maxSupplyDays} 日粮</button><p class="economy-note">默认尽量备足 ${maxSupplyDays} 日粮，可自行调低；另付出征费用金 ${rules.actions.march}。战役每月推进 ${rules.battleDayLimit} 日，野战与攻城连续累计，未决则下月续战；每日按实际存活兵力耗粮，多余军粮战后归库。火攻消耗随军金 ${rules.battle.strategyGoldCosts.fire}。</p><div class="result-preview" data-supply-preview></div></section>${taskOrderNote(rules,"march")}`;
  const foodInput = body.querySelector("#march-food");
  const goldInput = body.querySelector("#march-gold");
  let foodEdited = false;
  const composer = createArmyComposer({ state, city, officers: availableOfficers(state,city), rules, onChange: () => refresh() });
  body.querySelector("[data-composer]").append(composer.element);
  function refresh() {
    const troops = composer.totalTroops();
    const { daily, maximum } = marchSupplyLimits(troops, city.food, rules);
    foodInput.max = String(maximum);
    if (!foodEdited) foodInput.value = maximum;
    const food = Number(foodInput.value), gold = Number(goldInput.value);
    body.querySelector("[data-supply-preview]").innerHTML = `全军每日耗粮 ${number(daily)}，约供 ${daily ? Math.floor(food/daily) : 0} 日（战损会改变消耗）；当前最多携粮 ${number(maximum)}。<br>出征后城中：金 ${number(city.gold-gold-rules.actions.march)} · 粮 ${number(city.food-food)} · 留守月耗粮 ${number(monthlyFoodCost(Math.max(0,city.troops-troops),rules))}${daily && food < daily*rules.battleDayLimit ? `<br><strong class="economy-warning">军粮不足 ${rules.battleDayLimit} 日，可能因断粮提前退兵。</strong>` : ""}${food > maximum ? `<br><strong class="economy-warning">携粮超过当前兵力 ${maxSupplyDays} 日上限或城内库存，请调整军粮。</strong>` : ""}`;
  }
  foodInput.addEventListener("input", () => { foodEdited=true; refresh(); });
  goldInput.addEventListener("input", refresh);
  body.querySelector("[data-full-provisions]").addEventListener("click", () => { foodEdited=true; foodInput.value=marchSupplyLimits(composer.totalTroops(),city.food,rules).maximum; refresh(); });
  refresh();
  return await openDialog({ title:`${city.name} · 编组出征`,content:body,confirmText:"签发出征令",wide:true,onConfirm:()=> {
    const checked = composer.validate();
    if (!checked.ok) { showToast(checked.message,"error"); return false; }
    const divisions = checked.formations;
    const outcome=queueTask(state,{kind:"march",cityId:city.id,officerIds:divisions.flatMap(formationOfficerIds),payload:{targetId:body.querySelector("#march-target").value,divisions,supplies:{food:foodInput.value,gold:goldInput.value}}},rules);
    if (!outcome.ok) { showToast(outcome.message,"error"); return false; }
    return outcome;
  }});
}
