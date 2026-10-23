import { escapeHtml as esc, number } from "./components.js";
import { SIEGE_MILESTONES } from "../game/siege.js";

const OPTIONS = {
  return: ["回城支援", "外部部队尝试返回城内，进攻方可拦截或骗城。"],
  retreat: ["撤往别城", "外军退出本次战斗，不再参加守城，撤往另一座己方城池。"],
  deceive: ["尝试骗城", "比较双方有效智力；成功大幅推进，失败则外军无损入城。"],
  intercept: ["拦截外军", "按兵力、武力和统帅交锋一轮，外军承受损失后回城。"],
  open: ["围三阙一", "留出撤退通道，守方随时可无额外损失撤军。"],
  encircle: ["全面包围", "守方无安全退路，但城墙进度条额外加长。"],
  ram: ["撞门", "承受普通损失，按己方有效兵力推进破城。"],
  assault: ["蚁附", "承受更大损失，换取更快的攻城进度。"],
  tunnel: ["地道", "以双方军中有效智力判定，成败影响推进与损失。"],
  rotate: ["轮换修整", "正常守御，恢复部分士气，承受普通损失。"],
  repair: ["修补城墙", "承受更大损失，恢复一部分城墙耐久。"],
  sortie: ["出城袭扰", "按双方有效智力判定袭扰成败和两军损失。"]
};

export function renderSiegeView(element, battle, { cityName, busy, onDecision, onOrder }) {
  const siege = battle.siege;
  const decision = battle.pendingDecision;
  const mine = battle.getArmyStats(battle.playerSide);
  const theirs = battle.getArmyStats(battle.aiSide);
  const cap = siege?.troopCap ?? battle.rules.battle?.siege?.effectiveTroopCap ?? 30000;
  const armyCard = (army, label, side) => `<article class="siege-army"><small>${label}</small><h3>${number(army.troops)} <small>人</small></h3><p>统 ${army.leadership} · 武 ${army.war} · 智 ${army.intelligence}</p><p>士气 ${Math.round(army.morale)} · 训练 ${Math.round(army.training)}</p><p>粮 ${number(battle.supplies[side].food)} · 金 ${number(battle.supplies[side].gold)}<br>日耗粮 ${number(battle.dailyFoodNeed(side))}</p><small>本轮有效兵力 ${number(Math.min(army.troops, cap))}</small></article>`;
  const wallContent = siege ? `<article class="siege-wall current"><div><strong>城墙耐久</strong><span>${number(siege.hp)} / ${number(siege.maxHp)}</span></div><div class="wall-track"><i style="width:${Math.max(0, Math.min(100, siege.hp / siege.maxHp * 100))}%"></i></div><small>${SIEGE_MILESTONES.map((point) => `${point.progress * 100}% ${point.name}${siege.breachedMilestones?.includes(point.id) ? " · 已突破" : ""}`).join("　／　")}</small></article>` : "";
  const controlsPlayer = decision ? decision.side === battle.playerSide : true;
  const options = decision?.options ?? (battle.playerSide === "ally" ? ["ram", "assault", "tunnel"] : ["rotate", "repair", "sortie"]);
  const title = decision ? { external: "外军何去何从", response: "外军回城 · 攻方应对", encirclement: "决定围城方略" }[decision.kind] : "本日攻防军令";
  element.innerHTML = `<section class="siege-fortress"><header class="siege-scene"><span class="kicker">${decision ? "攻城前的抉择" : "城垣攻防"}</span><h2>${esc(cityName)} · ${battle.wallLevel} 级城墙</h2><p>战役第 ${battle.day} 日${battle.campaignMode ? ` · 本月第 ${(battle.day - 1) % (battle.rules.battleDayLimit ?? 30) + 1} 日` : ` / 共 ${battle.rules.battleDayLimit} 日`} · 城防度 ${Math.round(battle.cityDefense)} / 100</p><small>${siege?.encirclement === "open" ? "围三阙一 · 守方可安全撤退" : siege?.encirclement === "encircle" ? "全面包围 · 城墙额外加固，撤退须突围" : "尚未决定包围方式"}</small></header>
    <div class="siege-walls">${wallContent || '<p>进入城垣攻防后显示城墙耐久。</p>'}</div>
    <details class="siege-rule-note"><summary>查看攻城规则</summary><p>每方最多 ${number(cap)} 人参与本轮攻防计算；超过部分仍需粮。城墙共用一条耐久，等级只影响长度；推进到 33% / 66% 时分别突破瓮城 / 外城。战损取决于对方有效兵力，推进取决于攻方有效兵力与城防度。${battle.campaignMode ? "每月结算30日，月末暂停后可于下月续战；兵力、士气、钱粮与攻城进度延续。" : "野战与攻城共用30日。"}</p></details></section>
    <div class="siege-armies">${armyCard(mine, "我军 · 全军合算", battle.playerSide)}${armyCard(theirs, "敌军 · 全军合算", battle.aiSide)}</div>
    <section class="siege-orders"><h3>${title}</h3>${decision?.kind === "external" ? `<p>尚有 ${number((battle.livingUnits("enemy") ?? []).filter((unit) => !unit.inCity).reduce((sum,unit) => sum+unit.troops,0))} 名外军未回城。</p>` : ""}<div class="siege-order-grid">${options.map((option) => `<button class="siege-order" data-siege-choice="${option}" ${busy || battle.status !== "active" || !controlsPlayer || (!decision && siege?.orders?.[battle.playerSide]) ? "disabled" : ""}><strong>${OPTIONS[option]?.[0] ?? esc(option)}</strong><small>${OPTIONS[option]?.[1] ?? ""}</small></button>`).join("")}</div><p>${battle.status === "paused" ? "本月战事已结算，等待下月续战。" : !controlsPlayer ? "敌方正在决策……" : decision ? "此为转阶段判定，不另增加一天，也不重复扣粮。" : "双方各选一令后同时结算一天；不会提前显示敌方军令。"}</p></section>`;
  element.querySelectorAll("[data-siege-choice]").forEach((button) => button.addEventListener("click", () => decision ? onDecision(button.dataset.siegeChoice) : onOrder(button.dataset.siegeChoice)));
}
