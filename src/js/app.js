import { saveState, createInitialState, addEvent } from "./game/state.js";
import { canIssueCommand, commandLimitEnabled } from "./game/commands.js";
import {
  availableOfficers,
  cityOfficers,
  getCity,
  getFaction,
  getOfficer,
  playerCities,
  previewDomestic
} from "./game/rules.js";
import { BattleEngine } from "./game/battle.js";
import { settlePlayerBattle } from "./game/battle-result.js";
import { openMarchDialog } from "./ui/march-window.js";
import { renderSiegeView } from "./ui/siege-view.js";
import { fieldGridMetrics, fieldTilesMarkup } from "./ui/field-view.js";
import { battleControlLabel, battleStatusLabels, needsAutomaticBattleAction, runAutomaticBattleStep } from "./ui/battle-automation.js";
import { getStrategyConfig } from "./game/battle-strategies.js";
import { listCampaignSaves, listManualSaveSlots, loadCampaignSlot, persistCampaignSelection, saveManualSlot } from "./game/save-slots.js";
import { createMainMenu } from "./ui/main-menu.js";
import { chooseGameMenu, gameMenuBlockReason } from "./ui/game-menu.js";
import { chooseLoadSlot, saveGameDialog } from "./ui/save-windows.js";
import { createGameAudio } from "./ui/game-audio.js";
import { transitionScene, animatePanel } from "./ui/scene-transitions.js";
import { pendingMonthlySettlement, markMonthlySettlementRead } from "./game/monthly-settlement.js";
import { createInvasionBattle, settleDefensiveBattle } from "./game/invasion-battle.js";
import { queueTask, getReadyBattleTask, finishBattleTask } from "./game/tasks.js";
import { beginTurnResolution, resumeTurnResolution } from "./game/turn-flow.js";
import { findFriendlyRoute, reachableFriendlyCities } from "./game/routes.js";
import { createTaskUI, taskOrderNote, taskCounts } from "./ui/task-windows.js";
import { showStoryDialog, buildTurnOpening } from "./ui/story-dialog.js";
import { applyAtlasToScenario } from "./game/atlas.js";
import { StrategicMap } from "./ui/strategic-map.js";
import { MapColorLayer } from "./ui/map-colors.js";
import { areAllied, getCampaignStatus } from "./game/campaign.js";
import { cityTheme, createCampaignUI } from "./ui/campaign-windows.js";
import { dailyFoodCost, grainExchangeRate, monthlyFoodCost, previewCityEconomy } from "./game/economy.js";
import { cityEconomyMarkup, createEconomyUI } from "./ui/economy-windows.js";
import { createPolicyUI } from "./ui/policy-windows.js";
import { createStratagemUI } from "./ui/stratagem-windows.js";
import { createWarUI } from "./ui/war-windows.js";
import { enableWarCampaigns, activeBattleCampaigns, ensureTaskBattle, ensureInvasionBattle,
  getBattleEngine, checkpointBattle } from "./game/war-campaigns.js";
import { formationComposition } from "./game/troops.js";
import { calculateCombatStats } from "./game/combat-stats.js";
import { EQUIPMENT_LABELS, equipmentStoresMarkup, equipmentSummary } from "./ui/equipment-view.js";
import { confirmDialog, createDataTable, escapeHtml, number, openDialog, showToast } from "./ui/components.js";

let scenario;
let rules;
let battleMap;
let officerBios;
let atlas;
let cityThemes;
let campaignUI;
let economyUI;
let policyUI;
let stratagemUI;
let taskUI;
let warUI;
let mainMenu;
let gameAudio;
let sessionEntered = false;
let menuOpen = true;
let systemMenuOpen = false;
let switchingCampaign = false;
let advancingMonth = false;
let strategicMap;
let mapColors;
let territoryData;
let mapColorConfig;
let state;
let battle = null;
let battleMode = null;
let processingEnemy = false;
let battleResolved = false;
let battleTaskId = null;
let battleCampaignId = null;
let battleCompletion = null;
let showingOpening = false;
let animatedUnitId = null;
let animatedTargetId = null;
let animationClass = null;
let ambushFlash = null;

const monthNames = ["正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月"];
const seasons = ["春", "春", "春", "夏", "夏", "夏", "秋", "秋", "秋", "冬", "冬", "冬"];
const metricLabels = { agriculture: "农业", commerce: "商业", popularSupport: "民心", training: "训练", morale: "士气", defense: "城防" };
const actionLabels = { agriculture: "开发农业", commerce: "发展商业", patrol: "巡视安民", train: "训练士卒", buildWall: "筑墙修城", breedHorses: "挑选良马", craftArmor: "打造甲胄", craftCrossbows: "制作弓弩" };
const avatarColors = ["#3c6651", "#8a4b3b", "#596777", "#806641", "#5e4d6b", "#315c62"];

async function init() {
  try {
    [scenario, rules, battleMap, officerBios, atlas, cityThemes, territoryData, mapColorConfig] = await Promise.all([
      fetch("./data/scenario.json").then(checkResponse).then((response) => response.json()),
      fetch("./data/rules.json").then(checkResponse).then((response) => response.json()),
      fetch("./data/battle-map.json").then(checkResponse).then((response) => response.json()),
      fetch("./data/officer-bios.json").then(checkResponse).then((response) => response.json()),
      fetch("./data/strategic-atlas.json").then(checkResponse).then((response) => response.json()),
      fetch("./data/city-themes.json").then(checkResponse).then((response) => response.json()),
      fetch("./data/strategic-territories.json").then(checkResponse).then((response) => response.json()),
      fetch("./data/map-modes.json").then(checkResponse).then((response) => response.json())
    ]);
    scenario = applyAtlasToScenario(scenario, atlas);
    // Booting to the title screen never resumes monthly work or replaces a save.
    state = createInitialState(scenario, rules);
    enableWarCampaigns(state, battleMap);
    gameAudio = await createGameAudio();
    taskUI = createTaskUI({ getState: () => state, onSelectCity: selectCity });
    warUI = createWarUI({ getState: () => state, onSelectCity: selectCity });
    economyUI = createEconomyUI({ getState: () => state, rules, onChange: completeStrategyAction });
    stratagemUI = createStratagemUI({ getState: () => state, rules, onChange: completeStrategyAction });
    policyUI = createPolicyUI({ getState: () => state, rules, onChange: completeStrategyAction,
      canEdit: () => state.started && !battle && !advancingMonth && !state.turnResolution && !state.pendingInvasions?.some((item) => !item.resolved) });
    campaignUI = createCampaignUI({ getState: () => state, scenario, rules, themes: cityThemes,
      onStart: startCampaign, onChange: completeStrategyAction, onSelectCity: selectCity, onOfficer: showOfficerProfile, onTrade: economyUI.showTrade,
      onManualDefense: runDefensiveBattle });
    strategicMap = new StrategicMap({
      viewport: document.querySelector("#strategic-map"),
      world: document.querySelector("#map-world"),
      projection: atlas.projection,
      onCityClick: (cityId) => selectCity(cityId)
    });
    mapColors = new MapColorLayer({ layer: document.querySelector("#territory-layer"), legend: document.querySelector("#map-color-legend"),
      note: document.querySelector("#map-color-note"), selector: document.querySelector("#map-color-mode"), territories: territoryData, config: mapColorConfig });
    bindStaticEvents();
    bindMapControls();
    renderStrategy();
    mainMenu = createMainMenu({ getSaves: () => listCampaignSaves(scenario.id), rules,
      onNew: () => campaignUI.chooseScenario({ allowCancel: true, hasExistingSave: listCampaignSaves(scenario.id).length > 0 }), onLoad: loadFromMenu,
      onContinue: () => { enterGame(); renderStrategy(); }, onAudio: () => gameAudio.openSettings() });
    showMainMenu();
  } catch (error) {
    document.querySelector("#main-menu").hidden = true;
    document.querySelector(".app-shell").hidden = false;
    document.querySelector("main").innerHTML = `<div class="panel" style="margin:20px;padding:24px"><h2>剧本载入失败</h2><p>${escapeHtml(error.message)}</p><p>请通过本地服务器运行，而不是直接双击 HTML 文件。</p></div>`;
  }
}

function showMainMenu() {
  menuOpen = true;
  document.querySelector(".app-shell").hidden = true;
  mainMenu.show({ resumable: sessionEntered });
  gameAudio.setScene("menu");
  transitionScene("menu");
}

function enterGame() {
  sessionEntered = true;
  menuOpen = false;
  mainMenu.hide();
  document.querySelector(".app-shell").hidden = false;
}

async function loadFromMenu(slotId) {
  if (switchingCampaign) throw new Error("正在切换征程，请稍候。");
  switchingCampaign = true;
  try {
    const loaded = loadCampaignSlot(slotId, scenario, rules);
    enableWarCampaigns(loaded, battleMap);
    persistCampaignSelection(loaded, { archiveCurrent: slotId !== "active" });
    state = loaded;
    enterGame();
    renderStrategy();
    strategicMap.fit();
    if (state.turnResolution) await continueMonthResolution();
    else {
      await processReadyTaskBattles();
      await campaignUI.processPendingInvasions();
      await processUnfinishedCampaignBattles();
      await campaignUI.showOutcome();
      await announceTurnOpening();
    }
  } finally { switchingCampaign = false; }
}

function setMapReading(reading) {
  document.querySelector("#strategy-screen").classList.toggle("map-reading", reading);
  const toggle = document.querySelector("#map-hud-toggle");
  toggle.textContent = reading ? "显示军府" : "收起军府";
  toggle.setAttribute("aria-pressed", String(!reading));
}

function bindMapControls() {
  document.querySelector("#city-search-options").innerHTML = state.cities.flatMap((city) => [city.name, ...(city.aliases ?? [])].map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(city.province)} · ${escapeHtml(city.name)}</option>`)).join("");
  const regionSelect = document.querySelector("#map-region");
  regionSelect.innerHTML = '<option value="">九州分览</option>' + [...new Set(state.cities.map((city) => city.region))].map((region) => `<option value="${escapeHtml(region)}">${escapeHtml(region)}</option>`).join("");
  regionSelect.addEventListener("change", () => {
    if (!regionSelect.value) return;
    setMapReading(true);
    strategicMap.focusCities(state.cities.filter((city) => city.region === regionSelect.value));
  });
  document.querySelector("#map-zoom-in").addEventListener("click", () => strategicMap.zoom(1.3));
  document.querySelector("#map-zoom-out").addEventListener("click", () => strategicMap.zoom(1 / 1.3));
  document.querySelector("#map-fit").addEventListener("click", () => { setMapReading(true); regionSelect.value = ""; strategicMap.fit(); });
  document.querySelector("#map-home").addEventListener("click", () => { setMapReading(true); strategicMap.focusCities(playerCities(state)); });
  document.querySelector("#map-hud-toggle").addEventListener("click", () => setMapReading(!document.querySelector("#strategy-screen").classList.contains("map-reading")));
  document.querySelector("#city-panel-close").addEventListener("click", () => setMapReading(true));
  document.querySelector("#map-routes-toggle").addEventListener("change", (event) => { strategicMap.showRoutes = event.target.checked; strategicMap.applyRouteVisibility(); });
  document.querySelector("#map-labels-toggle").addEventListener("change", (event) => { strategicMap.showLabels = event.target.checked; strategicMap.layoutLabels(); });
  document.querySelector("#atlas-directory").addEventListener("click", showAtlasDirectory);
  document.querySelector("#city-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = document.querySelector("#city-search").value.trim().toLowerCase();
    if (!query) return;
    const matches = (city) => [city.name, city.id, ...(city.aliases ?? [])].map((name) => name.toLowerCase());
    const city = state.cities.find((item) => matches(item).includes(query)) ?? state.cities.find((item) => matches(item).some((name) => name.includes(query)));
    if (!city) return showToast("未找到该城池，可打开城池图录查阅", "error");
    selectCity(city.id, true);
  });
}

async function showAtlasDirectory() {
  const body = document.createElement("div");
  body.innerHTML = `<p class="modal-description">${state.cities.length} 座城池 · 选择城名可在地图上定位，点击城市主题画可查看城池全览。</p><input class="atlas-directory-search" type="search" placeholder="筛选城名、势力、州郡、地区或别名" aria-label="筛选城池图录" /><div class="atlas-directory-table"></div>`;
  const render = () => {
    const query = body.querySelector("input").value.trim();
    const rows = state.cities.filter((city) => [city.name, city.province, city.region, getFaction(state, city.factionId).name, ...(city.aliases ?? [])].some((value) => value.includes(query)));
    const table = createDataTable([
      { label: "城池", html: true, render: (city) => `<button class="text-button" data-locate-city="${city.id}">${escapeHtml(city.name)}</button>` },
      { key: "province", label: "州郡" }, { key: "region", label: "区域" },
      { label: "别名", render: (city) => city.aliases?.join(" / ") || "—" },
      { label: "归属", render: (city) => getFaction(state, city.factionId)?.name ?? "空城" }
    ], rows);
    body.querySelector(".atlas-directory-table").replaceChildren(table);
    table.querySelectorAll("[data-locate-city]").forEach((button) => button.addEventListener("click", () => {
      body.closest(".modal").querySelector(".modal-close").click();
      selectCity(button.dataset.locateCity, true);
    }));
  };
  body.querySelector("input").addEventListener("input", render);
  render();
  await openDialog({ title: "天下城池图录", content: body, confirmText: "返回地图", hideCancel: true, wide: true });
}

function checkResponse(response) {
  if (!response.ok) throw new Error(`无法读取 ${response.url}`);
  return response;
}

function bindStaticEvents() {
  document.querySelector("#end-turn-button").addEventListener("click", endMonth);
  document.querySelector("#tasks-button").addEventListener("click", () => taskUI.showTasks());
  document.querySelector("#wars-button").addEventListener("click", () => { if (!battle) warUI.showWars(); });
  document.querySelector("#policies-button").addEventListener("click", () => {
    if (!battle && state.started) policyUI.showPolicies();
  });
  document.querySelector("#game-menu-button").addEventListener("click", openGameMenu);
  document.querySelector("#audio-button").addEventListener("click", () => gameAudio.openSettings());
  document.querySelector("#help-button").addEventListener("click", showHelp);
  document.querySelector("#factions-button").addEventListener("click", () => { if (!battle) campaignUI.showFactions(); });
  document.querySelector("#reports-button").addEventListener("click", () => { if (!battle) campaignUI.showJournal(); });
  document.querySelector("#city-overview-button").addEventListener("click", () => campaignUI.showCity(selectedCity().id));
  document.querySelector("#city-trade-button").addEventListener("click", () => economyUI.showTrade(selectedCity().id));
  document.querySelector("#officer-detail-button").addEventListener("click", showOfficerRoster);
  document.querySelector("#retreat-button").addEventListener("click", retreatBattle);
  document.querySelector("#battle-hud-toggle").addEventListener("click", () => {
    const hidden = document.querySelector("#battle-screen").classList.toggle("hud-collapsed");
    document.querySelector("#battle-hud-toggle").textContent = hidden ? "展开浮窗" : "收起浮窗";
    document.querySelector("#battle-hud-toggle").setAttribute("aria-pressed", String(hidden));
  });
  document.querySelector("#command-actions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (button && !button.disabled) openCommandGroup(button.dataset.category);
  });
  document.querySelector("#battle-actions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (!button || button.disabled || processingEnemy || battle?.hasForcedAction()) return;
    if (button.dataset.mode === "wait") performBattleAction(() => battle.wait());
    else if (button.dataset.mode === "return") performBattleAction(() => battle.retreatToCity());
    else if (button.dataset.mode === "ambush") performBattleAction(() => battle.ambush(), { kind: "is-concealing" });
    else {
      battleMode = button.dataset.mode;
      renderBattle();
    }
  });
}

function selectedCity() {
  return getCity(state, state.selectedCityId) ?? playerCities(state)[0] ?? state.cities[0];
}

function eraLabel() {
  const eraYear = Math.max(1, state.year - 195);
  const numerals = ["元", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  return `建安${numerals[eraYear - 1] ?? eraYear}年`;
}

function renderStrategy() {
  if (sessionEntered && !menuOpen) { transitionScene("strategy"); gameAudio.setScene("strategy"); }
  ["factions-button", "reports-button"].forEach((id) => { document.getElementById(id).disabled = Boolean(state.turnResolution); });
  document.querySelector("#tasks-button").disabled = false;
  document.querySelector("#strategy-screen").classList.remove("is-hidden");
  document.querySelector("#battle-screen").classList.add("is-hidden");
  renderTurnRibbon();
  renderCityList();
  renderStrategicMap();
  renderCityDetail();
  renderEvents();
  renderCommandAvailability();
  taskUI.renderSummary();
  warUI.renderSummary();
  document.querySelector("#wars-button").disabled = false;
}

function renderTurnRibbon() {
  const status = getCampaignStatus(state);
  document.querySelector("#research-points-label").textContent = number(getFaction(state, state.playerFactionId).researchPoints);
  document.querySelector("#policies-button").disabled = !state.started || status.status !== "active";
  document.querySelector("#player-faction-label").textContent = `${getFaction(state, state.playerFactionId).name} · ${status.ownedCities} 城`;
  const endTurn = document.querySelector("#end-turn-button");
  endTurn.disabled = !state.started || status.status !== "active" || advancingMonth || Boolean(battle);
  endTurn.textContent = state.pendingInvasions?.some((item) => !item.resolved) ? "继续处理军情" : state.turnResolution ? "继续回合结算" : "结束本月";
  document.querySelector("#season-mark").textContent = seasons[state.month - 1];
  document.querySelector("#date-label").textContent = `${eraLabel()} · ${monthNames[state.month - 1]}`;
  const distance = (rules.economy.harvestMonth - state.month + 12) % 12 || 12;
  document.querySelector("#income-hint").textContent = `每月收金 · 距下次收粮 ${distance} 月 · 粮价 1:${grainExchangeRate(state.month, rules)}`;
  const limitedCommands = commandLimitEnabled(state);
  document.querySelector("#command-label").textContent = limitedCommands ? `${state.commandsRemaining} / ${state.commandsMax}` : "不限";
  document.querySelector("#command-label").title = limitedCommands ? "君主本月可用指令" : "测试期间关闭令牌限制；武将行动与行动费用不变";
  const commandPips = document.querySelector("#command-pips");
  commandPips.hidden = !limitedCommands;
  commandPips.innerHTML = limitedCommands ? Array.from({ length: state.commandsMax }, (_, index) => `<i class="command-pip ${index >= state.commandsRemaining ? "spent" : ""}"></i>`).join("") : "";
}

function renderCityList() {
  const cities = playerCities(state);
  document.querySelector("#city-count").textContent = cities.length;
  document.querySelector("#city-list").innerHTML = cities.map((city) => `
    <button type="button" class="city-list-item ${city.id === state.selectedCityId ? "active" : ""}" data-city-id="${city.id}">
      <span class="city-monogram">${escapeHtml(city.name[0])}</span>
      <span class="city-list-copy"><strong>${escapeHtml(city.name)}</strong><small>${city.governorId ? `${escapeHtml(getOfficer(state, city.governorId)?.name ?? "")}治理` : "君主直辖"}</small></span>
      <span class="city-list-stat">兵<strong>${number(city.troops)}</strong></span>
    </button>`).join("");
  document.querySelectorAll(".city-list-item").forEach((button) => button.addEventListener("click", () => selectCity(button.dataset.cityId, true)));
}

function renderStrategicMap() {
  mapColors.render(state);

  const renderedRoutes = new Set();
  const routes = [];
  for (const city of state.cities) {
    for (const adjacentId of city.adjacent) {
      const adjacent = getCity(state, adjacentId);
      const key = [city.id, adjacentId].sort().join("-");
      if (!adjacent || renderedRoutes.has(key)) continue;
      renderedRoutes.add(key);
      routes.push(`<line class="route-line" data-from="${city.id}" data-to="${adjacent.id}" x1="${city.x}" y1="${city.y}" x2="${adjacent.x}" y2="${adjacent.y}" />`);
    }
  }
  document.querySelector("#route-layer").innerHTML = routes.join("");
  const layer = document.querySelector("#city-node-layer");
  layer.innerHTML = state.cities.map((city) => {
    const faction = getFaction(state, city.factionId);
    const neutral = city.factionId === "neutral";
    const owned = city.factionId === state.playerFactionId;
    const atWar = activeBattleCampaigns(state).some((record) => record.targetCityId === city.id);
    return `<button type="button" class="city-node ${neutral ? "neutral" : owned ? "owned" : "enemy"} ${atWar ? "at-war" : ""} ${city.id === state.selectedCityId ? "active" : ""} ${city.labelSide === "left" ? "label-left" : ""}" data-city-id="${city.id}" style="left:${city.x}px;top:${city.y}px;--faction:${faction.color};--label-dy:${city.labelDy ?? 0}px" aria-label="${escapeHtml(city.name)}${atWar ? " · 交战中" : ""}" title="${escapeHtml(city.name)} · ${escapeHtml(city.province)} · ${escapeHtml(faction.name)}${atWar ? " · 交战中" : ""}">
      <span class="pin"></span><span class="node-label">${escapeHtml(city.name)}${atWar ? '<b class="war-city-mark">战</b>' : ""}</span>
    </button>`;
  }).join("");
  strategicMap.setCities(state.cities, state.selectedCityId);
}

function selectCity(cityId, focus = false) {
  if (battle) return;
  state.selectedCityId = cityId;
  saveState(state);
  renderStrategy();
  setMapReading(false);
  animatePanel(document.querySelector(".city-detail-panel"), cityId);
  animatePanel(document.querySelector(".command-deck"), cityId);
  if (focus) strategicMap.focusCities([selectedCity()], { detail: true });
}

function renderCityDetail() {
  const city = selectedCity();
  const theme = cityTheme(city, cityThemes);
  document.querySelector("#city-theme-image").src = theme.image;
  document.querySelector("#city-theme-image").alt = `${theme.name}区域城景`;
  document.querySelector("#city-theme-name").textContent = theme.name;
  document.querySelector("#city-scene-title").textContent = city.name;
  const isOwn = city.factionId === state.playerFactionId;
  const neutral = city.factionId === "neutral";
  document.querySelector("#command-context-label").textContent = isOwn ? `选择${city.name}的事务类别` : neutral ? `${city.name} · 无主城池` : `选择针对${city.name}的行动`;
  document.querySelector(".city-detail-panel").classList.toggle("enemy-city", !isOwn);
  document.querySelector("#selected-province").textContent = city.province;
  document.querySelector("#selected-city-name").textContent = city.name;
  document.querySelector("#city-location").textContent = `${city.region} · ${city.aliases?.length ? `亦称${city.aliases.join("、")} · ` : ""}${neutral ? "暂无势力与驻军" : `相邻 ${city.adjacent.length} 城`}`;
  document.querySelector("#city-location").textContent += ` · 城墙 ${city.wallLevel} 级 · 扩筑 ${city.wallProgress}/100`;
  if (activeBattleCampaigns(state).some((record) => record.targetCityId === city.id)) document.querySelector("#city-location").textContent += " · 交战封锁中（战役簿可追踪）";
  document.querySelector("#city-gold").textContent = number(city.gold);
  document.querySelector("#city-food").textContent = number(city.food);
  document.querySelector("#city-troops").textContent = number(city.troops);
  document.querySelector("#city-equipment").innerHTML = equipmentStoresMarkup(city);
  document.querySelector("#city-economy").innerHTML = cityEconomyMarkup(state, city, rules);
  const tradeButton = document.querySelector("#city-trade-button");
  tradeButton.hidden = !isOwn;
  tradeButton.disabled = !state.started || Boolean(state.turnResolution) || getCampaignStatus(state).status !== "active" || !canIssueCommand(state) || !availableOfficers(state, city).length || state.pendingInvasions?.some((item) => !item.resolved);
  if (activeBattleCampaigns(state).some((record) => record.targetCityId === city.id)) {
    tradeButton.disabled = true;
    tradeButton.title = "城池交战中，军需由战场统一管理";
  } else tradeButton.title = "";
  tradeButton.textContent = `商人 · 金粮 1:${grainExchangeRate(state.month, rules)}`;
  const governor = city.governorId ? getOfficer(state, city.governorId) : null;
  document.querySelector("#governor-chip").textContent = isOwn ? (governor ? `太守 · ${governor.name}` : "君主直辖") : getFaction(state, city.factionId).name;
  document.querySelector("#city-metrics").innerHTML = ["agriculture", "commerce", "popularSupport", "training", "morale", "defense"].map((key) => `
    <div class="metric" data-kind="${key}"><div class="metric-label"><span>${metricLabels[key]}</span><strong>${city[key]}</strong></div><div class="meter"><div class="meter-fill" style="width:${city[key]}%"></div></div></div>`).join("");
  document.querySelector("#officer-strip").innerHTML = cityOfficers(state, city).map((officer, index) => `
    <div class="officer-token ${officer.acted ? "busy" : ""}" data-officer-id="${officer.id}" title="查看${escapeHtml(officer.name)}资料">
      <div class="officer-avatar" style="--avatar:${avatarColors[index % avatarColors.length]}">${escapeHtml(officer.name.slice(-1))}</div><small>${escapeHtml(officer.name)}</small>
    </div>`).join("") || "<small>城中暂无武将</small>";
  document.querySelectorAll(".officer-token[data-officer-id]").forEach((token) => token.addEventListener("click", () => showOfficerProfile(getOfficer(state, token.dataset.officerId))));
}

function renderEvents() {
  document.querySelector("#event-log").innerHTML = state.eventLog.map((event) => `
    <article class="event-item"><time>${event.month}月</time><p>${escapeHtml(event.text)}</p></article>`).join("");
}

function renderCommandAvailability() {
  const city = selectedCity();
  document.querySelectorAll(".command-button").forEach((button) => {
    const isOwn = city.factionId === state.playerFactionId;
    const neutral = city.factionId === "neutral";
    const category = button.dataset.category;
    const needsOwn = ["domestic", "personnel", "military"].includes(category);
    const needsForeign = category === "diplomacy";
    button.disabled = !state.started || Boolean(state.turnResolution) || getCampaignStatus(state).status !== "active" || state.pendingInvasions?.some((item) => !item.resolved) || (needsOwn && !isOwn) || (needsForeign && (isOwn || neutral)) || (category === "strategy" && neutral);
    button.title = neutral ? "空城暂无势力，可由相邻的我方城池出兵进驻" : needsForeign && isOwn ? "请先选择其他势力的城池" : needsOwn && !isOwn ? "请先选择本势力城池" : "";
    if (isOwn && activeBattleCampaigns(state).some((record) => record.targetCityId === city.id)) {
      button.disabled = true;
      button.title = "本城正在交战，城务与军需由战场统一管理；可在战役簿追踪";
    }
  });
}

const commandSpendingActions = new Set(["agriculture", "commerce", "patrol", "buildWall", "breedHorses", "craftArmor", "craftCrossbows", "governor", "recruit", "train", "transfer", "march", "search", "employ", "officerTransfer", "goodwill", "alliance", "trade", "rumor", "discord", "surrender", "prepareAmbush"]);

const commandGroups = {
  domestic: {
    title: "内政",
    mark: "政",
    description: "以当前城池为单位安排开发、治安与民生事务。每项执行命令都会另开专用窗口。",
    commands: [
      { id: "agriculture", glyph: "田", name: "开发农业", detail: "提高每年七月收获" },
      { id: "commerce", glyph: "市", name: "发展商业", detail: "提高每月金收入" },
      { id: "patrol", glyph: "巡", name: "整顿治安", detail: "巡视乡里，提高民心" },
      { id: "buildWall", glyph: "城", name: "筑墙修城", detail: "修复城防，完好后扩筑城墙等级" },
      { id: "breedHorses", glyph: "马", name: "挑选良马", detail: "花费金钱，补充骑兵所需良马" },
      { id: "craftArmor", glyph: "甲", name: "打造甲胄", detail: "花费金钱，增加重装兵种装备" },
      { id: "craftCrossbows", glyph: "弩", name: "制作弓弩", detail: "花费金钱，增加劲弩库存" },
      { id: "trade", glyph: "贸", name: "商人粮市", detail: "按当月粮价买入或卖出粮食" }
    ]
  },
  personnel: {
    title: "人事",
    mark: "人",
    description: "管理城内武将、人才寻访、登用与地方官任命。",
    commands: [
      { id: "roster", glyph: "册", name: "武将名册", detail: "查看武将资料与五维能力" },
      { id: "search", glyph: "访", name: "寻访人才", detail: "派遣武将在本地寻访" },
      { id: "employ", glyph: "登", name: "登用人才", detail: "登用在野、俘虏或邻城低忠诚敌将" },
      { id: "officerTransfer", glyph: "迁", name: "武将迁任", detail: "迁往连通的我方城池任职" },
      { id: "governor", glyph: "印", name: "任命太守", detail: "委托城池每月自治" }
    ]
  },
  military: {
    title: "军事",
    mark: "军",
    description: "整备城中军势，或从当前城池发起调动与出征。",
    commands: [
      { id: "recruit", glyph: "募", name: "征募兵士", detail: "消耗金粮补充兵力" },
      { id: "train", glyph: "练", name: "训练士卒", detail: "提高训练与士气" },
      { id: "transfer", glyph: "运", name: "输送部队物资", detail: "部队、钱粮与军备，一回合送达连通城池" },
      { id: "march", glyph: "战", name: "出征", detail: "编成军势进攻敌城" }
    ]
  },
  diplomacy: {
    title: "外交",
    mark: "交",
    description: "对当前所选的其他势力城池采取外交行动。必须先在地图上选择敌方城池。",
    commands: [
      { id: "goodwill", glyph: "礼", name: "亲善", detail: "赠送财物，改善关系" },
      { id: "alliance", glyph: "盟", name: "结盟", detail: "缔结期限同盟" },
      { id: "surrender", glyph: "劝", name: "劝降", detail: "派遣使者，劝说弱势敌对势力归顺" }
    ]
  },
  strategy: {
    title: "策略",
    mark: "策",
    description: "派将对敌施计，或在己方城池筹备伏兵。任务在月底执行，施计失败仍消耗费用。",
    commands: [
      { id: "rumor", glyph: "言", name: "流言", detail: "降低敌城民心与驻军士气" },
      { id: "discord", glyph: "间", name: "离间", detail: "动摇目标武将忠诚" },
      { id: "prepareAmbush", glyph: "伏", name: "伏兵准备", detail: "本城下次防守伏击增伤，三个月内有效" }
    ]
  }
};

async function openCommandGroup(categoryId) {
  const group = commandGroups[categoryId];
  const city = selectedCity();
  if (!group) return;
  const body = document.createElement("div");
  body.innerHTML = `<p class="modal-description">${escapeHtml(city.name)} · ${escapeHtml(group.description)}</p>
    <div class="command-group-grid">${group.commands.map((command) => `<button type="button" class="command-entry" data-command="${command.id}"><span>${command.glyph}</span><div><strong>${command.name}</strong><small>${command.detail}</small></div></button>`).join("")}</div>
    <div class="command-window-note">这里仅负责选择命令类别；每项命令会打开自己的执行窗口，不在本面板内直接结算。</div>`;

  const isOwn = city.factionId === state.playerFactionId;
  body.querySelectorAll("[data-command]").forEach((button) => {
    const id = button.dataset.command;
    if (!canIssueCommand(state) && commandSpendingActions.has(id)) {
      button.disabled = true;
      button.title = "本月直辖指令已经用尽";
    }
    if (categoryId === "military" && id === "march" && !city.adjacent.some((targetId) => getCity(state, targetId)?.factionId !== state.playerFactionId)) button.disabled = true;
    if (categoryId === "military" && id === "transfer" && !reachableFriendlyCities(state, city.id).length) button.disabled = true;
    if (["domestic", "personnel", "military"].includes(categoryId) && (!isOwn || availableOfficers(state, city).length === 0) && id !== "roster") {
      button.disabled = true;
      button.title = !isOwn ? "请先选择本势力城池" : cityOfficers(state, city).length === 0 ? "城中无将领，请先从其他城池迁任武将" : "本月暂无可用武将";
    }
    if (id === "prepareAmbush" && (!isOwn || !availableOfficers(state, city).length)) {
      button.disabled = true;
      button.title = isOwn ? "本城暂无可用武将" : "请选择己方城池准备伏兵";
    }
    if (["rumor", "discord", "surrender"].includes(id) && (isOwn || city.factionId === "neutral" || areAllied(state, state.playerFactionId, city.factionId))) {
      button.disabled = true;
      button.title = "请选择非同盟的敌对势力城池";
    }
    button.addEventListener("click", () => {
      body.closest(".modal")?.querySelector(".modal-close")?.click();
      window.setTimeout(() => handleCommand(id), 0);
    });
  });
  await openDialog({ title: `${group.mark} · ${group.title}指令`, content: body, confirmText: "返回地图", hideCancel: true, wide: true });
}

async function handleCommand(action) {
  if (state.turnResolution || battle) return;
  if (["agriculture", "commerce", "patrol", "train", "buildWall", "breedHorses", "craftArmor", "craftCrossbows"].includes(action)) return domesticDialog(action);
  if (action === "recruit") return recruitDialog();
  if (action === "transfer") return transferDialog();
  if (action === "governor") return governorDialog();
  if (action === "march") return marchDialog();
  if (action === "trade") return economyUI.showTrade(selectedCity().id);
  if (action === "roster") return showOfficerRoster();
  if (action === "search") return campaignUI.showSearch(selectedCity().id);
  if (action === "employ") return campaignUI.showEmploy(selectedCity().id);
  if (action === "officerTransfer") return campaignUI.showOfficerTransfer(selectedCity().id);
  if (["goodwill", "alliance"].includes(action)) return campaignUI.showDiplomacy(selectedCity().factionId, action);
  if (["surrender", "rumor", "discord", "prepareAmbush"].includes(action)) return stratagemUI.showStratagem(action, selectedCity().id);
}

async function domesticDialog(action) {
  const city = selectedCity();
  const resource = rules.development[action]?.resource;
  const officers = availableOfficers(state, city);
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="modal-description">在${escapeHtml(city.name)}选择最多 ${rules.maxDomesticOfficers} 名武将共同执行。多人协作效果更高，但每人本月只能行动一次。</p>${action === "buildWall" ? `<div class="result-preview">${city.wallLevel} 级城墙 · 城防 ${city.defense}/100 · 扩筑 ${city.wallProgress}/100。<br>城防受损时优先修复；完好时累计扩筑进度，每满 100 提升一级，最高 3 级。</div>` : ""}
    ${resource ? `<div class="result-preview">本城${EQUIPMENT_LABELS[resource]}库存：<strong>${number(city[resource])}</strong>。每件装备供应一名对应兵种；产出在任务完成时入库，可通过运输调往友方据点。</div>` : ""}
    <div class="selection-counter"><span>执行武将</span><strong><span data-selected-count>0</span> / ${rules.maxDomesticOfficers}</strong></div>
    <div class="selection-list">${officers.map((officer) => `
      <label class="selection-card"><input type="checkbox" name="officer" value="${officer.id}"><span><strong>${escapeHtml(officer.name)}</strong><small>${escapeHtml(officer.rank)} · ${action === "patrol" ? "魅力" : action === "train" ? "统帅" : "内政"} ${officer[action === "patrol" ? "charm" : action === "train" ? "leadership" : "politics"]}</small></span><span class="selection-stat">功 ${number(officer.merit)}</span></label>`).join("")}</div>
    <div class="result-preview" data-preview>请选择执行武将。</div>${taskOrderNote(rules, "domestic")}`;
  const checkboxes = [...body.querySelectorAll("input[name=officer]")];
  const refresh = () => {
    const selected = checkboxes.filter((input) => input.checked);
    body.querySelector("[data-selected-count]").textContent = selected.length;
    checkboxes.forEach((input) => { input.disabled = !input.checked && selected.length >= rules.maxDomesticOfficers; });
    const chosen = selected.map((input) => getOfficer(state, input.value));
    const preview = previewDomestic(action, chosen, city, rules);
    body.querySelector("[data-preview]").innerHTML = selected.length
      ? `预计效果：${resource ? EQUIPMENT_LABELS[resource] : ""}<strong>+${preview.gain}</strong>${action === "buildWall" ? city.defense < 100 ? " 城防度" : city.wallLevel < 3 ? " 扩筑进度" : "（城墙已完好）" : ""}${action === "train" ? `，士气 +${preview.moraleGain}` : ""} · 消耗金 <strong>${preview.expense}</strong>${resource ? `<br>完成后预计库存 ${number((city[resource] ?? 0) + preview.gain)}` : ""}`
      : "请选择执行武将。";
  };
  checkboxes.forEach((input) => input.addEventListener("change", refresh));
  const result = await openDialog({
    title: `${city.name} · ${actionLabels[action]}`,
    content: body,
    confirmText: "颁布政令",
    onConfirm: () => {
      const ids = checkboxes.filter((input) => input.checked).map((input) => input.value);
      if (!ids.length) { showToast("请至少选择一名武将", "error"); return false; }
      const outcome = queueTask(state, { kind: "domestic", cityId: city.id, officerIds: ids, payload: { action } }, rules);
      if (!outcome.ok) { showToast(outcome.message, "error"); return false; }
      return outcome;
    }
  });
  if (result) await completeStrategyAction(result.message);
}

async function recruitDialog() {
  const city = selectedCity();
  const officers = availableOfficers(state, city);
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="modal-description">征募新兵会消耗金粮，并略微降低民心。新兵将按比例拉低城中训练度。</p>
    <div class="form-grid">
      <div class="field"><label for="recruit-officer">执行武将</label><select id="recruit-officer">${officers.map((officer) => `<option value="${officer.id}">${escapeHtml(officer.name)} · 魅力 ${officer.charm}</option>`).join("")}</select></div>
      <div class="field"><label for="recruit-amount">征募人数</label><input id="recruit-amount" type="number" min="500" max="5000" step="100" value="2000"></div>
    </div>
    <div class="cost-preview">城中现有：金 ${number(city.gold)} · 粮 ${number(city.food)}<span data-recruit-cost></span></div>${taskOrderNote(rules, "recruit")}`;
  const amountInput = body.querySelector("#recruit-amount");
  const refresh = () => {
    const amount = Math.max(0, Number(amountInput.value));
    const hundreds = amount / 100;
    body.querySelector("[data-recruit-cost]").textContent = `预计消耗：金 ${number(hundreds * rules.recruit.goldPerHundred)} · 粮 ${number(hundreds * rules.recruit.foodPerHundred)}`;
  };
  amountInput.addEventListener("input", refresh); refresh();
  const result = await openDialog({
    title: `${city.name} · 征募兵士`, content: body, confirmText: "开始征募",
    onConfirm: () => {
      const outcome = queueTask(state, { kind: "recruit", cityId: city.id, officerIds: [body.querySelector("#recruit-officer").value], payload: { amount: amountInput.value } }, rules);
      if (!outcome.ok) { showToast(outcome.message, "error"); return false; }
      return outcome;
    }
  });
  if (result) await completeStrategyAction(result.message);
}

async function governorDialog() {
  const city = selectedCity();
  const officers = availableOfficers(state, city);
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="modal-description">太守会在每月结束时，自动改善城中最低的一项事务并支付费用。若太守本月已行动，则当月无法自治。任命费用：金 ${rules.actions.appointGovernor}。</p>
    <div class="selection-list">${officers.map((officer, index) => `
      <label class="selection-card"><input type="radio" name="governor" value="${officer.id}" ${index === 0 ? "checked" : ""}><span><strong>${escapeHtml(officer.name)}</strong><small>${escapeHtml(officer.rank)} · 内政 ${officer.politics} · 统帅 ${officer.leadership}</small></span><span class="selection-stat">魅 ${officer.charm}</span></label>`).join("")}</div>${taskOrderNote(rules, "governor")}`;
  const result = await openDialog({
    title: `${city.name} · 任命太守`, content: body, confirmText: "授予印绶",
    onConfirm: () => {
      const officerId = body.querySelector("input[name=governor]:checked")?.value;
      const outcome = queueTask(state, { kind: "governor", cityId: city.id, officerIds: [officerId], payload: {} }, rules);
      if (!outcome.ok) { showToast(outcome.message, "error"); return false; }
      return outcome;
    }
  });
  if (result) await completeStrategyAction(result.message);
}

async function transferDialog() {
  const city = selectedCity();
  const destinations = reachableFriendlyCities(state, city.id);
  if (!destinations.length) return showToast("没有经己方或盟友领土联通的目的地；敌方与中立城池会阻断运输", "error");
  const officers = availableOfficers(state, city);
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="modal-description">部队、钱粮与军备可一起输送，也可只运装备。只要沿途均为己方或有效盟友城池，不论距离都在一个回合抵达。运输费用：金 ${rules.actions.transfer}；执行武将留在原城。</p>
    <div class="form-grid">
      <div class="field"><label for="transfer-target">目标城池</label><select id="transfer-target">${destinations.map((target) => `<option value="${target.id}">${escapeHtml(target.name)} · ${target.factionId === state.playerFactionId ? "己方" : `盟友 ${escapeHtml(getFaction(state, target.factionId).name)}`} · ${number(target.troops)} 兵</option>`).join("")}</select></div>
      <div class="field"><label for="transfer-officer">执行武将</label><select id="transfer-officer">${officers.map((officer) => `<option value="${officer.id}">${escapeHtml(officer.name)} · ${escapeHtml(officer.rank)}</option>`).join("")}</select></div>
      <div class="field"><label for="transfer-amount">输送兵力 · 可用 ${number(city.troops)}</label><input id="transfer-amount" type="number" min="0" max="${city.troops}" step="100" value="${city.troops >= 500 ? Math.min(2000, Math.floor(city.troops / 100) * 100) : 0}"></div>
      <div class="field"><label for="transfer-gold">输送金钱 · 可用 ${number(city.gold)}</label><input id="transfer-gold" type="number" min="0" max="${Math.max(0, city.gold - rules.actions.transfer)}" step="1" value="0"></div>
      <div class="field"><label for="transfer-food">输送粮食 · 可用 ${number(city.food)}</label><input id="transfer-food" type="number" min="0" max="${city.food}" step="1" value="0"></div>
      ${Object.entries(EQUIPMENT_LABELS).map(([key, label]) => `<div class="field"><label for="transfer-${key}">输送${label} · 可用 ${number(city[key])}</label><input id="transfer-${key}" type="number" min="0" max="${city[key] ?? 0}" step="1" value="0"></div>`).join("")}
    </div>
    <p class="transport-route" data-transfer-route></p>
    <div class="result-preview" data-transfer-preview aria-live="polite"></div>${taskOrderNote(rules, "transfer")}`;
  const refresh = () => {
    const target = getCity(state, body.querySelector("#transfer-target").value);
    const amount = Math.max(0, Number(body.querySelector("#transfer-amount").value));
    const gold = Math.max(0, Number(body.querySelector("#transfer-gold").value));
    const food = Math.max(0, Number(body.querySelector("#transfer-food").value));
    const equipment = Object.fromEntries(Object.keys(EQUIPMENT_LABELS).map((key) => [key, Math.max(0, Number(body.querySelector(`#transfer-${key}`).value))]));
    const remainingEquipment = Object.fromEntries(Object.keys(EQUIPMENT_LABELS).map((key) => [key, (city[key] ?? 0) - equipment[key]]));
    const total = target.troops + amount;
    const training = total ? Math.round((target.training * target.troops + city.training * amount) / total) : target.training;
    const morale = total ? Math.round((target.morale * target.troops + city.morale * amount) / total) : target.morale;
    const route = findFriendlyRoute(state, city.id, target.id) ?? [];
    body.querySelector("[data-transfer-route]").textContent = `联通路线：${route.map((id) => getCity(state, id).name).join(" → ")} · 一个回合抵达`;
    body.querySelector("[data-transfer-preview]").innerHTML = `签发后本城可用：兵 ${number(city.troops - amount)} · 金 ${number(city.gold - gold - rules.actions.transfer)} · 粮 ${number(city.food - food)}<br>剩余军备：${equipmentSummary(remainingEquipment)}<br>抵达后${escapeHtml(target.name)}预计：${number(total)} 兵 · 训练 ${training} · 士气 ${morale}<br>送达物资：金 ${number(gold)} · 粮 ${number(food)}<br>送达军备：${equipmentSummary(equipment)}${target.factionId !== state.playerFactionId ? '<br><strong class="economy-warning">送给盟友的部队、钱粮和军备将归盟友使用。</strong>' : ""}<br><small>兵力可为 0；运兵时至少 500 人，以百人为单位。抵达时按兵力融合训练和士气。</small>`;
  };
  body.querySelector("#transfer-target").addEventListener("change", refresh);
  body.querySelectorAll("input").forEach((input) => input.addEventListener("input", refresh));
  refresh();
  const result = await openDialog({
    title: `${city.name} · 输送部队物资`, content: body, confirmText: "签发运输令",
    onConfirm: () => {
      const outcome = queueTask(state, { kind: "transfer", cityId: city.id, officerIds: [body.querySelector("#transfer-officer").value],
        payload: { targetId: body.querySelector("#transfer-target").value, troops: body.querySelector("#transfer-amount").value,
          gold: body.querySelector("#transfer-gold").value, food: body.querySelector("#transfer-food").value,
          ...Object.fromEntries(Object.keys(EQUIPMENT_LABELS).map((key) => [key, body.querySelector(`#transfer-${key}`).value])) } }, rules);
      if (!outcome.ok) { showToast(outcome.message, "error"); return false; }
      return outcome;
    }
  });
  if (result) await completeStrategyAction(result.message);
}

async function marchDialog() {
  const result = await openMarchDialog({ state, city: selectedCity(), rules });
  if (result) await completeStrategyAction(result.message);
}

async function runTaskBattle(task) {
  const result = ensureTaskBattle(state, task, rules, battleMap, { targetTurn: currentBattleTurn() });
  if (!result.ok) throw new Error(result.message);
  return runCampaignBattle(result.record);
}

async function runDefensiveBattle(invasion) {
  const result = ensureInvasionBattle(state, invasion, rules, battleMap, { targetTurn: currentBattleTurn(),
    mode: invasion.resolutionMode === "siege" ? "siege" : "field", defenderDivisions: invasion.defenderDivisions });
  if (!result.ok) {
    showToast(result.message, "error");
    return false;
  }
  return runCampaignBattle(result.record);
}

const currentBattleTurn = () => state.turnResolution?.targetTurn ?? state.elapsedMonths ?? 0;

async function runCampaignBattle(record) {
  if (record.status === "ended") { showToast(record.result?.message ?? "战役已结算"); return record.result ?? { ok: true }; }
  const opened = getBattleEngine(state, record.id, rules, { targetTurn: currentBattleTurn() });
  if (!opened.ok) throw new Error(opened.message);
  battle = opened.battle;
  battleCampaignId = record.id;
  battleTaskId = record.taskId ?? null;
  battleResolved = false;
  battleMode = null;
  const completion = new Promise((resolve) => { battleCompletion = resolve; });
  try {
    saveBattleState();
    await showBattle();
    return await completion;
  } catch (error) {
    battle = null;
    battleCampaignId = null;
    battleCompletion = null;
    battleMode = null;
    processingEnemy = false;
    animatedUnitId = animatedTargetId = animationClass = null;
    renderStrategy();
    throw error;
  }
}

function checkpointCurrentBattle() {
  if (!battle || !battleCampaignId) return null;
  const result = checkpointBattle(state, battleCampaignId, battle, { targetTurn: currentBattleTurn() });
  if (!result.ok) throw new Error(result.message ?? "战役保存失败，当前战场已保留");
  saveBattleState();
  return result;
}

let battleSaveWarning = false;

function saveBattleState() {
  try {
    saveState(state);
    battleSaveWarning = false;
  } catch (error) {
    // The atomic action is already committed in memory. Never replay it or
    // leave the input lock held merely because browser storage is unavailable.
    if (!battleSaveWarning) showToast("自动存档写入失败，当前战场仍在内存。请勿刷新或关闭页面；恢复浏览器存储后，下一次行动会重试保存。", "error");
    battleSaveWarning = true;
  }
}

function clearBattleAnimation() {
  processingEnemy = false;
  animatedUnitId = animatedTargetId = animationClass = null;
  ambushFlash = null;
  if (battle) renderBattle();
}

async function processUnfinishedCampaignBattles() {
  for (const record of activeBattleCampaigns(state).filter((item) => item.status === "active"
    && [item.attackerFactionId, item.defenderFactionId].includes(state.playerFactionId))) {
    await runCampaignBattle(record);
  }
}

async function processReadyTaskBattles() {
  let task;
  while ((task = getReadyBattleTask(state))) await runTaskBattle(task);
}

async function completeStrategyAction(message) {
  saveState(state);
  renderStrategy();
  showToast(message);
  if (!state.turnResolution && getReadyBattleTask(state)) {
    await processReadyTaskBattles();
    await campaignUI.showOutcome();
  }
}

async function announceTurnOpening() {
  if (showingOpening || !state.started || battle
    || state.pendingInvasions?.some((item) => !item.resolved)
    || (state.turnResolution && state.turnResolution.stage !== "opening")) return;
  const stamp = `${state.year}-${state.month}`;
  showingOpening = true;
  try {
    if (state.lastTurnOpening !== stamp && getCampaignStatus(state).status === "active") {
      await showStoryDialog(buildTurnOpening(state));
      state.lastTurnOpening = stamp;
      saveState(state);
    }
    const report = pendingMonthlySettlement(state);
    if (report) {
      markMonthlySettlementRead(state, report);
      saveState(state);
      await taskUI.showSettlement(report);
    }
  } finally { showingOpening = false; }
}

async function continueMonthResolution() {
  advancingMonth = true;
  renderStrategy();
  try {
    const result = await resumeTurnResolution(state, rules, {
      save: () => saveState(state),
      onBattle: runTaskBattle,
      battleMap,
      onCampaignBattle: runCampaignBattle,
      onInvasions: () => campaignUI.processPendingInvasions(),
      onOpening: async () => {
        renderStrategy();
        await campaignUI.showOutcome();
        await announceTurnOpening();
      }
    });
    if (!result.ok) showToast(result.message, "error");
  } finally { advancingMonth = false; renderStrategy(); }
}

async function endMonth() {
  if (advancingMonth || battle || !state.started || getCampaignStatus(state).status !== "active") return;
  if (state.turnResolution) return continueMonthResolution();
  if (state.pendingInvasions?.some((entry) => !entry.resolved)) return campaignUI.processPendingInvasions();
  advancingMonth = true;
  renderTurnRibbon();
  try {
  const activeGovernors = playerCities(state).filter((city) => city.governorId && !getOfficer(state, city.governorId)?.acted).length;
  const harvest = state.month % 12 + 1 === rules.economy.harvestMonth;
  const budgets = playerCities(state).map((city) => ({ city, budget: previewCityEconomy(state, city, rules) }));
  const warnings = budgets.flatMap(({ city, budget }) => [
    ...(city.food < budget.monthlyFood ? [`${escapeHtml(city.name)}军粮不足，月底将损失兵力`] : []),
    ...(city.gold + budget.monthlyGold < budget.monthlySalary ? [`${escapeHtml(city.name)}俸禄不足，月底将降低忠诚`] : [])
  ]);
  const confirmed = await confirmDialog({
    title: "结束本月",
    mark: "月",
    confirmText: "进入下月",
    message: `${commandLimitEnabled(state) ? `尚余 <strong>${state.commandsRemaining}</strong> 道指令` : "测试期间本月指令不限"}；当前 <strong>${taskCounts(state).active}</strong> 项任务正在执行。<br>先完成到期任务，再分别推进本月所有战场，随后结算城市收入、俸禄与非参战驻军耗粮。持续战役满30日后暂停，下月继续。${activeGovernors ? `<br>${activeGovernors} 名空闲太守将自治并支付行动费用。` : ""}${harvest ? "<br>随后进入七月，新回合开始前收获全年粮食。" : ""}${warnings.length ? `<p class="economy-warning">按当前可用库存预警（待到货物资尚未计入）：<br>${warnings.join("<br>")}</p>` : ""}<br>确定结束本月吗？`
  });
  if (!confirmed) return;
  const begun = beginTurnResolution(state);
  if (!begun.ok) return showToast(begun.message, "error");
  saveState(state);
  await continueMonthResolution();
  } finally { advancingMonth = false; renderTurnRibbon(); }
}

function radarPoint(index, radius) {
  const angle = (-90 + index * 72) * Math.PI / 180;
  return `${(110 + Math.cos(angle) * radius).toFixed(1)},${(110 + Math.sin(angle) * radius).toFixed(1)}`;
}

function buildRadar(officer) {
  const stats = [
    ["统帅", officer.leadership], ["武力", officer.war], ["智力", officer.intelligence], ["内政", officer.politics], ["魅力", officer.charm]
  ];
  const grids = [20, 40, 60, 80, 100].map((level) => `<polygon class="radar-grid" points="${stats.map((_, index) => radarPoint(index, level * .78)).join(" ")}" />`).join("");
  const axes = stats.map((_, index) => `<line class="radar-axis" x1="110" y1="110" x2="${radarPoint(index, 78).split(",")[0]}" y2="${radarPoint(index, 78).split(",")[1]}" />`).join("");
  const shape = stats.map(([, value], index) => radarPoint(index, value * .78)).join(" ");
  const labels = stats.map(([label], index) => {
    const [x, y] = radarPoint(index, 94).split(",").map(Number);
    return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${label}</text>`;
  }).join("");
  return `<svg class="radar-chart" viewBox="0 0 220 220" role="img" aria-label="${escapeHtml(officer.name)}五维能力雷达图">${grids}${axes}<polygon class="radar-shape" points="${shape}" />${labels}</svg>
    <div class="radar-stat-list">${stats.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>`;
}

async function showOfficerProfile(officer) {
  if (!officer) return;
  const body = document.createElement("div");
  body.className = "officer-profile";
  body.innerHTML = `
    <div class="portrait-frame"><img src="./assets/portraits/general-placeholder.svg" alt="${escapeHtml(officer.name)}头像位置"><div class="portrait-nameplate"><strong>${escapeHtml(officer.name)}</strong><small>${officer.courtesy ? `字 ${escapeHtml(officer.courtesy)} · ` : ""}${escapeHtml(officer.rank)}</small></div></div>
    <section class="officer-biography"><span class="kicker">人物列传</span><h3>${escapeHtml(officer.name)}${officer.courtesy ? ` · ${escapeHtml(officer.courtesy)}` : ""}</h3><p>${escapeHtml(officerBios[officer.id] ?? "此人事迹尚待补录。")}</p>
      <div class="officer-meta-grid"><div><span>所属势力</span><strong>${escapeHtml(officer.status === "free" ? "在野" : officer.status === "captured" ? "俘虏" : getFaction(state, officer.factionId)?.name ?? "在野")}</strong></div><div><span>当前职位</span><strong>${escapeHtml(officer.rank)}</strong></div><div><span>累计功勋</span><strong>${number(officer.merit)}</strong></div><div><span>本月状态</span><strong>${officer.battleId ? "跨月作战中" : officer.taskId ? "执行任务中" : officer.acted ? "已行动" : "待命"}</strong></div><div><span>所在城池</span><strong>${escapeHtml(getCity(state, officer.locationCityId)?.name ?? state.cities.find((city) => city.officerIds.includes(officer.id))?.name ?? "未详")}</strong></div><div><span>忠诚</span><strong>${officer.status === "active" ? officer.loyalty ?? "—" : "—"}</strong></div></div>
    </section>
    <aside class="radar-panel"><h3>五维能力</h3>${buildRadar(officer)}</aside>`;
  await openDialog({ title: `武将资料 · ${officer.name}`, content: body, confirmText: "返回", hideCancel: true, wide: true });
}

async function showOfficerRoster() {
  const city = selectedCity();
  const table = createDataTable([
    { key: "name", label: "武将", html: true, render: (row) => `<button type="button" class="text-button officer-detail-link" data-officer-id="${row.id}">${escapeHtml(row.name)}</button>` }, { key: "rank", label: "职位" },
    { key: "war", label: "武", numeric: true }, { key: "intelligence", label: "智", numeric: true },
    { key: "leadership", label: "统", numeric: true }, { key: "politics", label: "政", numeric: true },
    { key: "charm", label: "魅", numeric: true }, { key: "merit", label: "功勋", numeric: true, render: (row) => number(row.merit) },
    { key: "loyalty", label: "忠诚", numeric: true }, { label: "月俸", numeric: true, render: (row) => rules.economy.salaryByRank[row.rank] ?? 40 },
    { label: "状态", render: (row) => row.taskId ? "执行任务中" : row.acted ? "已行动" : "待命" }
  ], cityOfficers(state, city));
  const rosterDialog = openDialog({ title: `${city.name} · 武将名册`, content: table, confirmText: "收起名册", hideCancel: true, wide: true });
  table.querySelectorAll(".officer-detail-link").forEach((button) => button.addEventListener("click", () => showOfficerProfile(getOfficer(state, button.dataset.officerId))));
  await rosterDialog;
}

async function showEnemyIntel(city) {
  const faction = getFaction(state, city.factionId);
  const officers = cityOfficers(state, city);
  const content = document.createElement("div");
  content.innerHTML = `<p class="modal-description">${escapeHtml(city.province)}重镇，目前由 <strong>${escapeHtml(faction.name)}</strong> 控制。可从相邻的我方城池发起出征。</p>
    <div class="resource-row"><div><span>金</span><strong>${number(city.gold)}</strong></div><div><span>粮</span><strong>${number(city.food)}</strong></div><div><span>兵</span><strong>${number(city.troops)}</strong></div></div>
    <div class="result-preview">农业 ${city.agriculture} · 商业 ${city.commerce} · 民心 ${city.popularSupport} · 训练 ${city.training} · 士气 ${city.morale}</div>`;
  content.append(createDataTable([{ key: "name", label: "守将" }, { key: "rank", label: "职位" }, { key: "war", label: "武", numeric: true }, { key: "intelligence", label: "智", numeric: true }, { key: "leadership", label: "统", numeric: true }], officers));
  await openDialog({ title: `${city.name} · 敌情`, content, confirmText: "知晓", hideCancel: true });
}

async function showHelp() {
  const content = `
    <p class="modal-description">建安元年末，选择任一势力经营领土、延揽人才、结交盟友，最终统一天下。天下 ${state.cities.length} 座城池均可争夺。</p>
    <div class="result-preview"><strong>任务与运输</strong><br>城市命令在过月时完成。签发时占用${commandLimitEnabled(state) ? "指令、" : ""}执行武将及所需兵员钱粮，成果尚不生效；顶部「任务簿」追踪执行中及本回合刚完成的任务。先结算到期任务，再处理月底收支及群雄行动。运输允许混合兵员、钱粮、良马、劲弩与甲胄，也可只运装备；沿己方或有效盟友城池组成的路线，一个回合送达任意联通城池，敌方与中立城池阻断路线。送往盟友的物资归盟友使用，执行武将不随运输迁任。</div>
    <div class="result-preview"><strong>军备与科技</strong><br>各城独立储存良马、劲弩、甲胄，内政中的挑选良马、制作弓弩、打造甲胄花费金钱并派将执行。每件装备供应一名对应士兵；混编时合计全军需求，签发出征令即预扣。装备随战损减少，幸存装备随退军或入城归库。<br>左上「全局政策」管理本势力研究点，每月 +${rules.research?.monthlyGain ?? 100}，没有积累上限。科技立即扣点并永久解锁，不耗城市指令或武将行动；初始开放步兵、弓兵、重步兵、劲弩兵、骑兵，其余六种通过科技解锁。</div>
    <div class="result-preview"><strong>混编能力与射击</strong><br>每队可自由填写不同兵种人数，合计不超过主将的官职兵额，副将不增加兵额。将领能力、训练、士气与兵种共同生成统一的肉搏火力／防护、远程火力／防护、移动力和视野面板，战损及增援后重算。火力按对应士兵人数累加；移动和视野取决于编成比例，而不会随总人数减半。<br>攻击为邻接肉搏；编入一名射手也可射击，但仅贡献该射手的微小火力。射击无反击，受视野和射程限制。火矢消耗 ${rules.battle.ranged?.fireArrowActionPoints ?? 3} 行动力及金 ${rules.battle.ranged?.fireArrowGoldCost ?? 30}，射击后有 ${Math.round((rules.battle.ranged?.fireArrowChance ?? .3) * 100)}% 概率追加一次引燃效果。</div>
    <div class="result-preview"><strong>兵种伤亡倾向</strong><br>编成比例不会锁定。每次伤亡按「当前人数 × 该攻击类型的暴露系数」分摊，随后按剩余兵种重算战力与装备。暴露系数只改变谁承担伤亡，不额外放大总伤害。<br>近战（包括反击、伏击、攻城与拦截）更容易损失步兵，射击的偏向较弱，火攻默认按人数分摊。火矢先结算箭伤，再单独结算引燃。随着步兵减少，其分担能力自然下降；不额外设置前后排或掩护不足惩罚。攻城按全军兵种统一分摊，城内预备兵按步兵计入。各兵种系数可在编成表中查看。</div>
    <div class="result-preview"><strong>战略层</strong><br>${commandLimitEnabled(state) ? `每月有 ${rules.commandsPerMonth} 道君主指令` : "测试期间君主指令数不限"}；每名武将通常只能行动一次。每城独立保存钱粮，商业决定每月金收入，农业决定每年七月回合开始前的收粮，民心影响两种收入。每月按兵力耗粮、按将领职位付俸禄：缺粮损兵，欠饷降低忠诚。任命太守后，空闲太守会在月底支付费用并自动改善最薄弱的事务。</div>
    <div class="result-preview"><strong>商人粮市</strong><br>内政菜单、城池面板和城池全览都可进入商人窗口。按当月比例买卖粮食，不收手续费，买卖同价。七月最便宜（1金换10粮），之后逐档涨价，收获前为1金换5粮。交易仍需一名未行动武将${commandLimitEnabled(state) ? "和一道指令" : "，不受指令数限制"}。钱粮不会跨城共享。</div>
    <div class="result-preview"><strong>跨月战役与钱粮</strong><br>出征可携带当前编成最多 ${rules.army.maxSupplyDays ?? 60} 日军粮及金钱，另付出征费用。每日开始按实际存活兵力扣粮，守方连同预备兵共用城中粮储；断粮立即判负。火攻消耗行动力及金 ${rules.battle.strategyGoldCosts.fire}，失败也付费。<br>每个战略月，每场战役推进最多 ${rules.battleDayLimit} 日，期满暂停而非判败。所有战场分别保存、月末依次续战，阵位、钱粮、城墙和状态不会重置。城池交战期间暂停主动城务、运输与迁将；税收、俸禄及七月收获仍结算，守军不会再被月底重复扣粮。</div>
    <div class="result-preview"><strong>野战侦察与伏击</strong><br>基础步兵约 3 点行动力，精兵与骑兵略高。视野比本队标准行动力多一格，同方共享；树林、山地中的敌军必须邻接才能发现，且地形会遮挡后方视线。全部地形始终可见；视野外覆盖半透明迷雾，不显示敌军位置和动向。<br>「埋伏」仅限树林或山地，立即结束本队行动并持续待机；下一支正常进入邻格的敌军会遭受无反击攻击、结束本次行动，多支伏兵依次发动。移动、攻击、火攻或回城会解除自身埋伏，结束行动则可继续潜伏。<br>「警戒移动」以约三倍地形消耗推进，满行动力时至少可走一格，免触发伏击但不会解除伏兵。敌军邻接六格为控制区（ZOC），不能从控制区直接走到另一格控制区；警戒也不能绕过。请先退出控制区，再换角度进入。</div>
    <div class="result-preview"><strong>部队编组与攻城</strong><br>一次最多 ${rules.army.maxUnits} 支部队，每队最多 ${rules.army.maxOfficersPerUnit} 将，只有主将的官职指挥上限决定整队兵额；五维仍各取队内最高值。野战攻军进入守方据点即转攻城；守军攻占进攻方大本营则劫毁粮草，立即击败攻军。<br>攻城每天双方各下一令，全军合算。城墙使用一条总耐久，等级决定长度；推进 33% 与 66% 分别提示突破瓮城、外城，不重置城防。撞门稳定推进，蚁附以较大损失换更快推进，地道按智力冒险；守方可轮换、抢修或出击。城防度越低越容易推进，单纯轮换不能无限死守。</div>
    <div class="result-preview"><strong>群雄与多战场</strong><br>月底各势力经营并择机出兵，前两月不会主动进攻玩家。玩家守城仍可选择野战或直接攻城战；AI 之间使用同一战斗引擎在后台模拟，不弹战斗界面。顶部「战役簿」追踪所有战场、累计日数和最近战报；地图上交战城市标「战」。<br>围三阙一保证守军可向其他己方城无损撤离，全面包围增加总耐久，守军突围会受追击。一城同时只处理一场战役，参战将领跨月持续占用，不可重复出征或承担内政。</div>
    <div class="result-preview"><strong>人才、外交与战略计略</strong><br>寻访发现本城在野人才，登用可招纳在野、俘虏，或相邻敌城忠诚不高于 ${rules.personnel.enemyEmployMaxLoyalty} 的非君主武将（盟友与任务中的武将除外）。离间降低指定敌将忠诚，为登用创造机会；流言降低敌城民心与士气。迁任可把武将调往相连领地。亲善提高友好，友好达到 45 后可议订六个月盟约。劝降仅对城池、兵力均满足弱势条件的敌方势力开放，成功后其城池和在任武将整体归顺。上述任务均在过月时结算，施计或招揽失败仍收费。<br>在己方城市「策略」中安排伏兵准备，三个月内本城下次防守野战的首次有效伏击伤害 +25%，实际发动后才消耗准备；仍需部队在树林或山地执行埋伏，准备不叠加。</div>
    <div class="result-preview"><strong>邻接计略与持续状态</strong><br>火攻、疑兵、挑衅只能对邻接且已发现的敌军施放，消耗行动力和随军金，成功率取决于双方智力，失败也消耗费用。火矢仍按远程射程执行。疑兵令目标跳过接下来 ${getStrategyConfig("doubt", rules).durationActivations} 次完整行动；挑衅令目标接下来 ${getStrategyConfig("provoke", rules).durationActivations} 次行动强制逐格追向施计者，到达邻接位置且行动力足够时攻击，途中正常受地形、控制区与伏击影响。<br>持续时间按受影响部队完成的行动次数计算，不是移动格数或大地图月份。一次行动中多次移动、攻击不会多扣持续次数。遭伏击会结束本次追击并消耗一次；若尚有持续次数，下次仍会追击。同种状态不叠加；疑兵与挑衅共存时疑兵优先，该次结束后两者各扣一次，剩余状态继续保留。施计者溃散或回城会永久解除挑衅，进入攻城时清除野战控制。状态栏会显示剩余次数。</div>
    <div class="result-preview"><strong>存档与月初汇报</strong><br>右上「菜单」提供存档、读档和返回主菜单，三个手动槽独立保留。战斗每个动作后自动保存，刷新后从已保存的阵位、队列与状态继续，不重新开战；月结检查点避免重复收入、扣粮和 AI 行动。<br>战斗操作及月结期间暂禁切换征程；月间回到大地图后，所有暂停战役可随手动存档保存。月初仍用通用对话窗汇报，有任务结果时自动弹出结算窗。</div>
    <div class="result-preview"><strong>画面与声音</strong><br>场景、城市和窗口使用统一开合与渐隐动效；系统开启“减少动态效果”时自动简化。主菜单／大地图与战斗各有一首本地循环音乐，所有按钮和城池点击有短音效。首次点击后启奏；“声音”可调整音乐、音效音量与静音，切到后台自动暂停。<br>字体随本地资源加载：正文思源黑体 © Adobe；标题阿里妈妈刀隶体 © 淘宝（中国）软件有限公司。当前为个人内部版本，字体声明保留在资源目录中。</div>`;
  await openDialog({ title: "玩法概要", content, confirmText: "开始理政", hideCancel: true });
}

function systemMenuBlockReason() {
  return gameMenuBlockReason({ state, battle, processingEnemy, advancingMonth, showingOpening, switchingCampaign });
}

function requireSafeCampaignSwitch() {
  const reason = systemMenuBlockReason();
  if (reason) throw new Error(reason);
}

async function openGameMenu() {
  if (systemMenuOpen || menuOpen || !sessionEntered) return;
  systemMenuOpen = true;
  const button = document.querySelector("#game-menu-button");
  button.setAttribute("aria-expanded", "true");
  let nextAction = null;
  try {
    while (true) {
      const action = await chooseGameMenu({
        summary: `${getFaction(state, state.playerFactionId).name} · ${state.year} 年 ${state.month} 月`,
        blockedReason: systemMenuBlockReason(), canLoad: listCampaignSaves(scenario.id).length > 0
      });
      if (!action) break;
      requireSafeCampaignSwitch();
      if (action === "save") {
        const saved = await saveGameDialog({
          rules,
          getSlots: () => listManualSaveSlots(scenario.id),
          onSave: (slotId) => { requireSafeCampaignSwitch(); saveManualSlot(slotId, state); }
        });
        if (saved) showToast(`${listManualSaveSlots(scenario.id).find((slot) => slot.id === saved).label} · 保存成功`);
      } else if (action === "load") {
        const slotId = await chooseLoadSlot(listCampaignSaves(scenario.id), { inGame: true, rules });
        if (slotId) {
          requireSafeCampaignSwitch();
          nextAction = () => loadFromMenu(slotId);
          break;
        }
      } else if (action === "title") {
        const confirmed = await confirmDialog({ title: "返回主菜单", mark: "返", confirmText: "确认返回",
          message: "返回前会自动保存当前战略进度，独立的手动存档不会改变。<br>确定返回主菜单吗？" });
        if (confirmed) {
          requireSafeCampaignSwitch();
          saveState(state);
          nextAction = showMainMenu;
          break;
        }
      }
    }
  } catch (error) { showToast(error.message, "error"); }
  finally {
    systemMenuOpen = false;
    button.setAttribute("aria-expanded", "false");
  }
  // Loading may resume a whole battle/month; release menu ownership first.
  if (nextAction) {
    try { await nextAction(); }
    catch (error) { showToast(error.message, "error"); }
  }
}

async function startCampaign(factionId) {
  if (switchingCampaign) throw new Error("正在切换征程，请稍候。");
  switchingCampaign = true;
  try {
    const nextState = createInitialState(scenario, rules);
    enableWarCampaigns(nextState, battleMap);
    nextState.playerFactionId = factionId;
    nextState.started = true;
    const faction = getFaction(nextState, factionId);
    nextState.selectedCityId = getCity(nextState, faction.capitalId)?.factionId === factionId ? faction.capitalId : playerCities(nextState)[0].id;
    addEvent(nextState, `${faction.name}举旗于${getCity(nextState, nextState.selectedCityId).name}。经营领土、延揽人才，待时逐鹿天下。`);
    persistCampaignSelection(nextState, { archiveCurrent: true });
    state = nextState;
    enterGame();
    renderStrategy();
    strategicMap.focusCities(playerCities(state));
    setMapReading(false);
    showToast(`${faction.name} · 新的征程开始`);
    await announceTurnOpening();
  } finally { switchingCampaign = false; }
}

async function showBattle() {
  warUI?.renderSummary();
  ["factions-button", "reports-button", "tasks-button", "wars-button"].forEach((id) => { document.getElementById(id).disabled = true; });
  document.querySelector("#strategy-screen").classList.add("is-hidden");
  document.querySelector("#battle-screen").classList.remove("is-hidden");
  document.querySelector("#battle-screen").classList.remove("hud-collapsed");
  document.querySelector("#battle-hud-toggle").textContent = "收起浮窗";
  document.querySelector("#battle-hud-toggle").setAttribute("aria-pressed", "false");
  renderBattle();
  if (battle.status === "paused") await resolveCampaignCheckpoint();
  else if (battle.status === "ended") await resolveBattle(battle.winner);
  else await processEnemyTurns();
}

function renderBattle() {
  if (!battle) return;
  document.querySelector("#policies-button").disabled = true;
  const inSiege = battle.phase !== "field";
  transitionScene(inSiege ? "siege" : "field");
  gameAudio.setScene("battle");
  if (inSiege && !document.querySelector("#battle-screen").classList.contains("is-siege")) {
    document.querySelector("#battle-screen").classList.remove("hud-collapsed");
    document.querySelector("#battle-hud-toggle").textContent = "收起浮窗";
    document.querySelector("#battle-hud-toggle").setAttribute("aria-pressed", "false");
  }
  document.querySelector("#battle-screen").classList.toggle("is-siege", inSiege);
  document.querySelector(".battle-layout").classList.toggle("is-hidden", inSiege);
  document.querySelector("#siege-view").classList.toggle("is-hidden", !inSiege);
  document.querySelector("#siege-log-window").classList.toggle("is-hidden", !inSiege);
  document.querySelector("#battle-phase-label").textContent = inSiege ? "攻城 · 全军合算" : "野战 · 部队行动";
  document.querySelector("#retreat-button").disabled = processingEnemy || battleResolved;
  const source = getCity(state, battle.sourceCityId);
  const target = getCity(state, battle.targetCityId);
  const defending = battle.playerSide === "enemy";
  const campaign = state.battles?.find((record) => record.id === battleCampaignId);
  document.querySelector("#battle-title").textContent = defending ? `${target.name}迎击战 · 抵御${getFaction(state, campaign?.attackerFactionId ?? source.factionId).name}` : `${source.name}军 · ${target.name}攻略战`;
  if (inSiege) document.querySelector("#battle-title").textContent = `${target.name}${defending ? "守城" : "攻城"}战`;
  document.querySelector("#battle-limit-label").textContent = "本月战斗余日";
  document.querySelector("#retreat-button").textContent = defending ? "弃城撤退" : "撤军";
  document.querySelector("#battle-day").textContent = battle.day;
  document.querySelector("#battle-days-left").textContent = battle.status === "paused" ? 0 : rules.battleDayLimit - (battle.day - 1) % rules.battleDayLimit;
  const troopLabel = (side) => number(battle.livingUnits(side).reduce((sum, unit) => sum + unit.troops, 0)) + (side === "enemy" && battle.defenderReserveTroops ? `（城内 ${number(battle.defenderReserveTroops)}）` : "");
  document.querySelector("#ally-troops").textContent = troopLabel(battle.playerSide);
  document.querySelector("#enemy-troops").textContent = inSiege ? troopLabel(battle.aiSide)
    : `已发现 ${number(battle.visibleUnits(battle.playerSide).filter((unit) => unit.side === battle.aiSide).reduce((sum, unit) => sum + unit.troops, 0))}`;
  if (inSiege) {
    renderSiegeView(document.querySelector("#siege-view"), battle, { cityName: target.name, busy: processingEnemy || battleResolved,
      onDecision: (action) => performSiegeAction(() => battle.chooseTransition(action)),
      onOrder: (action) => performSiegeAction(() => battle.siegeOrder(battle.playerSide, action)) });
    document.querySelector("#siege-log").innerHTML = battle.getVisibleLog(battle.playerSide).map((entry) => `<p><strong>${entry.day}日</strong> · ${escapeHtml(entry.message)}</p>`).join("");
    return;
  }
  document.querySelector("#battle-supplies").innerHTML = `<span class="kicker">战场钱粮 · 今日军粮已结算</span>${[battle.playerSide, battle.aiSide].map((side) => {
    if (side !== battle.playerSide) return '<div class="supply-line fog-intelligence"><strong>敌军情报 · 受战争迷雾遮蔽</strong><small>敌军钱粮与未发现兵力不详</small></div>';
    const stores = battle.supplies[side];
    const days = battle.estimateSupplyDays(side);
    const label = side === battle.playerSide ? (defending ? "我城储备" : "我军随军") : (defending ? "敌军随军" : "敌城储备");
    return `<div class="supply-line ${days < 3 ? "low-supply" : ""}"><strong>${label}　粮 ${number(stores.food)} · 金 ${number(stores.gold)}</strong><small>现兵力日耗 ${number(battle.dailyFoodNeed(side))} 粮 · 约可再供 ${Number.isFinite(days) ? days : "—"} 日</small></div>`;
  }).join("")}`;
  const active = battle.activeUnit;
  document.querySelector("#active-side-label").textContent = !active ? "战斗结束" : `${active.side === battle.playerSide ? "我军行动" : "敌军行动"}${battle.hasForcedAction() && battle.isUnitVisibleTo(active, battle.playerSide) ? " · 中计" : ""}`;
  renderInitiative();
  renderBattlefield();
  renderActiveUnit();
  renderBattleLog();
}

function renderInitiative() {
  const activeId = battle.activeUnit?.id;
  const visibleIds = new Set(battle.visibleUnits(battle.playerSide).map((unit) => unit.id));
  document.querySelector("#initiative-list").innerHTML = battle.queue.map((id) => battle.getUnit(id))
    .filter((unit) => unit && visibleIds.has(unit.id)).map((unit, index) => {
    return `<div class="initiative-item ${unit.side !== battle.playerSide ? "enemy" : ""} ${unit.id === activeId ? "active" : ""}"><span class="initiative-index">${index + 1}</span><span><strong>${escapeHtml(unit.name)}</strong><small>${unit.unitTypeName} · ${number(unit.troops)} · ${unit.officerIds?.length ?? 0} 将</small>${battleControlLabel(unit) ? `<small class="control-status">${escapeHtml(battleControlLabel(unit))}</small>` : ""}</span><em>力 ${unit.actionPoints}</em></div>`;
  }).join("");
}

function renderBattlefield() {
  const active = battle.activeUnit;
  const field = document.querySelector("#battlefield");
  field.style.setProperty("--field-ratio", fieldGridMetrics(battle.map).aspectRatio);
  field.innerHTML = fieldTilesMarkup(battle, { mode: battle.hasForcedAction() ? null : battleMode, animatedUnitId, animatedTargetId, animationClass, ambushFlash });
  field.querySelectorAll(".battle-tile").forEach((tile) => tile.addEventListener("click", () => handleBattleTile(Number(tile.dataset.x), Number(tile.dataset.y))));
  const tips = { move: "逐格行军；可能触发伏击。敌军控制区内不能横穿", cautious: "警戒行军：每格高消耗，免触发伏击；仍受控制区限制",
    attack: "近战：选择邻接的已发现敌军攻击", fire: "火攻：仅可对邻接的已发现敌军施计",
    doubt: `疑兵：邻接施计，成功后令敌军跳过接下来 ${getStrategyConfig("doubt", rules).durationActivations} 次行动`,
    provoke: `挑衅：邻接施计，成功后令敌军接下来 ${getStrategyConfig("provoke", rules).durationActivations} 次行动强制追击你，途中可以触发伏击`,
    shoot: "射击：仅按远程兵火力结算，无反击；选择高亮敌军", fireArrow: "火矢：消耗随军金，射击后有概率引燃敌军" };
  document.querySelector("#battle-tip").textContent = active?.side === battle.aiSide
    ? "敌军行动中 · 仅显示我军视野内的动向"
    : battle.hasForcedAction() ? "我军中计 · 正在自动处理强制行动，无法另行下令"
      : `${tips[battleMode] ?? "攻军进入主据点转攻城；树林、山地可设伏"} · 剩余 ${active?.actionPoints ?? 0}`;
}

function renderActiveUnit() {
  const unit = battle.activeUnit;
  const card = document.querySelector("#active-unit-card");
  if (!unit) {
    card.textContent = battle.outcomeReason ?? "战斗结束";
    document.querySelectorAll(".battle-action").forEach((button) => { button.disabled = true; });
    return;
  }
  if (!battle.isUnitVisibleTo(unit, battle.playerSide)) {
    card.innerHTML = '<div class="active-unit-title"><h3>敌军行动中</h3></div><p class="fog-intelligence">敌军位于我军视野之外，无法获悉其位置、兵力或军令。</p>';
    document.querySelectorAll(".battle-action").forEach((button) => { button.disabled = true; });
    return;
  }
  card.innerHTML = `<div class="active-unit-title"><div><span>${unit.side === battle.playerSide ? "我军" : "敌军"} · ${unit.unitTypeName}</span><h3>${escapeHtml(unit.name)}</h3></div><span>${unit.officerIds?.length ?? 0} 将</span></div><div class="unit-commanders">${(unit.officerIds ?? []).map((id) => escapeHtml(getOfficer(state, id)?.name ?? id)).join(" · ") || "无将驻军"}</div>
    <div class="unit-force"><small>当前兵力 / 初始兵力</small><strong>${number(unit.troops)} <small>/ ${number(unit.maxTroops)}</small></strong></div>
    <div class="unit-stat-grid"><div><span>武力</span><strong>${unit.war}</strong></div><div><span>智力</span><strong>${unit.intelligence}</strong></div><div><span>统帅</span><strong>${unit.leadership}</strong></div><div><span>训练</span><strong>${unit.training}</strong></div><div><span>士气</span><strong>${unit.morale}</strong></div><div><span>先攻</span><strong>${battle.initiative(unit)}</strong></div></div>
    <div class="action-point-row"><div class="action-point-head"><span>行动力${unit.ambushing ? " · 埋伏中" : ""}</span><strong>${unit.actionPoints} / ${unit.maxActionPoints}</strong></div><div class="ap-pips">${Array.from({ length: unit.maxActionPoints }, (_, index) => `<i class="ap-pip ${index < unit.actionPoints ? "filled" : ""}"></i>`).join("")}</div></div>`;
  const composition = formationComposition(unit, rules);
  const statusLabels = battleStatusLabels(unit);
  if (statusLabels.length) card.insertAdjacentHTML("beforeend", `<p class="unit-control-status" role="status">${statusLabels.map(escapeHtml).join("<br>")}</p>`);
  const combat = unit.combatStats ?? calculateCombatStats(unit, rules);
  card.insertAdjacentHTML("beforeend", `<div class="unit-composition" aria-label="当前兵种组成">${Object.entries(composition).filter(([, count]) => count > 0).map(([id, count]) => `<span>${escapeHtml(rules.troopTypes?.[id]?.name ?? id)} <b>${number(count)}</b></span>`).join("")}</div><div class="unit-combat-grid" aria-label="部队最终能力">${[["肉搏火力", number(combat.meleeAttack)], ["肉搏防护", `${Math.round(combat.meleeDefense * 100)}%`], ["远程火力", number(combat.rangedAttack)], ["远程防护", `${Math.round(combat.rangedDefense * 100)}%`], ["移动力", number(combat.movement)], ["视野", `${combat.vision} 格`]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>`);
  document.querySelectorAll(".battle-action").forEach((button) => {
    const mode = button.dataset.mode;
    button.hidden = mode === "return" && battle.playerSide !== "enemy";
    const ranged = mode === "shoot" || mode === "fireArrow";
    const lacksRanged = ranged && unit.rangedTroops <= 0;
    const strategy = ["fire", "doubt", "provoke"].includes(mode);
    const lacksPoints = ["attack", "fire", "doubt", "provoke", "shoot", "fireArrow"].includes(mode) ? unit.actionPoints < battle.actionCost(mode, unit)
      : mode === "move" || mode === "cautious" ? battle.reachableTiles(unit, { cautious: mode === "cautious" }).length === 0
        : mode === "ambush" ? !battle.canAmbush(unit) : false;
    const lacksGold = (strategy || mode === "fireArrow") && battle.supplies[unit.side].gold < battle.strategyGoldCost(mode);
    button.disabled = unit.side !== battle.playerSide || processingEnemy || battle.hasForcedAction() || battle.status !== "active" || lacksPoints || lacksGold || lacksRanged;
    button.title = battle.hasForcedAction() ? "中计部队的本次行动由计略控制" : lacksRanged ? "本部队没有具备射击能力的兵种" : lacksGold ? "随军金不足" : mode === "ambush" && !battle.canAmbush(unit) ? "只能在树林、山地设伏，且会结束本次行动" : "";
    button.classList.toggle("active", button.dataset.mode === battleMode);
    if (mode === "attack") button.querySelector("small").textContent = `消耗 ${battle.actionCost("attack", unit)} 行动力`;
    if (strategy) button.querySelector("small").textContent = `邻接 · 力 ${battle.actionCost(mode, unit)} · 金 ${battle.strategyGoldCost(mode)}`;
    if (ranged) button.querySelector("small").textContent = lacksRanged ? "未编入远程兵种" : `力 ${battle.actionCost(mode, unit)} · 射程 ${unit.rangedRange}${mode === "fireArrow" ? ` · 金 ${battle.strategyGoldCost(mode)}` : ""}`;
  });
}

function renderBattleLog() {
  document.querySelector("#battle-log").innerHTML = battle.getVisibleLog(battle.playerSide).map((entry) => `<p><strong>${entry.day}日</strong> · ${escapeHtml(entry.message)}</p>`).join("");
}

async function handleBattleTile(x, y) {
  if (!battleMode || processingEnemy || battle.hasForcedAction() || battle.activeUnit?.side !== battle.playerSide) return;
  if (battleMode === "move" || battleMode === "cautious") return animateMoveTo(x, y);
  const unit = battle.visibleUnitAt(x, y, battle.playerSide);
  if (!unit) return showToast("这里没有可选目标", "error");
  if (battleMode === "attack") return performBattleAction(() => battle.attack(unit.id), { kind: "is-striking", targetId: unit.id });
  if (battleMode === "fire") return performBattleAction(() => battle.fire(unit.id), { kind: "is-casting", targetId: unit.id });
  if (battleMode === "doubt") return performBattleAction(() => battle.doubt(unit.id), { kind: "is-casting", targetId: unit.id });
  if (battleMode === "provoke") return performBattleAction(() => battle.provoke(unit.id), { kind: "is-casting", targetId: unit.id });
  if (battleMode === "shoot") return performBattleAction(() => battle.shoot(unit.id), { kind: "is-shooting", targetId: unit.id });
  if (battleMode === "fireArrow") return performBattleAction(() => battle.fireArrow(unit.id), { kind: "is-fire-arrow", targetId: unit.id });
}

async function animateMoveTo(x, y) {
  const movingUnit = battle.activeUnit;
  const movementMode = battleMode;
  const movementOptions = { cautious: movementMode === "cautious" };
  const startingDay = battle.day;
  const path = battle.findPath({ x, y }, movingUnit, movementOptions);
  if (!path.length) return showToast("无法抵达该地块", "error");
  processingEnemy = true;
  let finalResult = null;
  try {
  for (const step of path) {
    finalResult = battle.moveStep(step.x, step.y, movementOptions);
    if (!finalResult.ok) break;
    checkpointCurrentBattle();
    animatedUnitId = movingUnit.id;
    animationClass = "unit-step";
    renderBattle();
    await delay(230);
    animatedUnitId = null;
    animationClass = null;
    await animateAmbushes(finalResult);
    if (finalResult.interrupted || finalResult.battleEnded || battle.status !== "active" || battle.phase !== "field" || battle.activeUnit?.id !== movingUnit.id || battle.day !== startingDay) break;
  }
  } catch (error) {
    showToast(`战场操作中断：${error.message}。当前局面已保留，请勿重复执行已完成动作。`, "error");
    return;
  } finally { clearBattleAnimation(); }
  if (battle.status === "paused") return resolveCampaignCheckpoint();
  if (finalResult?.battleEnded) return resolveBattle(finalResult.winner);
  battleMode = finalResult?.ok && !finalResult.interrupted && battle.day === startingDay && battle.activeUnit?.id === movingUnit.id ? movementMode : null;
  renderBattle();
  if (!finalResult?.ok || finalResult.interrupted) showToast(finalResult?.message ?? "移动中断", finalResult?.ok ? "info" : "error");
  await processEnemyTurns();
}

async function animateAmbushes(result) {
  for (const strike of result.ambushes ?? []) {
    const target = battle.getUnit(strike.targetId);
    animatedUnitId = strike.actorId;
    animatedTargetId = strike.targetId;
    animationClass = "is-ambush-striking";
    ambushFlash = target ? { ...target.position, damage: strike.damage } : null;
    renderBattle();
    await delay(420);
    animatedUnitId = null;
    animatedTargetId = null;
    animationClass = null;
    ambushFlash = null;
  }
}

async function performBattleAction(action, animation = null) {
  if (processingEnemy || !battle || battle.hasForcedAction() || battle.status !== "active" || battle.activeUnit?.side !== battle.playerSide) return;
  processingEnemy = true;
  let result;
  try {
  const actorId = battle.activeUnit?.id;
  if (animation) {
    animatedUnitId = actorId;
    animatedTargetId = animation.targetId;
    animationClass = animation.kind;
    renderBattle();
    await delay(["is-shooting", "is-fire-arrow"].includes(animation.kind) ? 380 : 180);
  }
  result = action();
  if (result.ok) checkpointCurrentBattle();
  animatedUnitId = null;
  animationClass = null;
  if (animation) {
    animatedTargetId = animation.targetId;
    if (result.fireTriggered) { animatedUnitId = animation.targetId; animationClass = "is-burning"; }
    renderBattle();
    await delay(result.fireTriggered ? 350 : 170);
  }
  animatedUnitId = null;
  animationClass = null;
  animatedTargetId = null;
  } catch (error) {
    showToast(`战场操作中断：${error.message}。当前局面已保留，请勿重复执行已完成动作。`, "error");
    return;
  } finally { clearBattleAnimation(); }
  if (!result.ok) { renderBattle(); showToast(result.message, "error"); return; }
  battleMode = null;
  renderBattle();
  if (result.battleEnded) return resolveBattle(result.winner);
  if (battle.status === "paused") return resolveCampaignCheckpoint();
  await processEnemyTurns();
}

async function performSiegeAction(action) {
  if (!battle || processingEnemy || battleResolved || battle.status !== "active") return;
  if (battle.pendingDecision && battle.pendingDecision.side !== battle.playerSide) return;
  processingEnemy = true;
  let result;
  try {
  result = action();
  if (result.ok) checkpointCurrentBattle();
  battleMode = null;
  renderBattle();
  await delay(350);
  } catch (error) {
    showToast(`攻城操作中断：${error.message}。当前局面已保留，请勿重复下达已确认军令。`, "error");
    return;
  } finally { clearBattleAnimation(); }
  if (!result.ok) { renderBattle(); showToast(result.message, "error"); return; }
  if (battle.status === "ended") return resolveBattle(battle.winner, battle.defenderRetreated);
  if (battle.status === "paused") return resolveCampaignCheckpoint();
  await processEnemyTurns();
}

async function processEnemyTurns() {
  if (processingEnemy || !battle || battle.status !== "active") return;
  processingEnemy = true;
  try {
  while (needsAutomaticBattleAction(battle)) {
    renderBattle();
    await delay(260);
    const result = runAutomaticBattleStep(battle);
    if (!result.ok) { showToast(result.message, "error"); break; }
    checkpointCurrentBattle();
    animatedUnitId = result.actorId ?? null;
    animatedTargetId = result.targetId ?? null;
    animationClass = result.step ? "unit-step" : ["fire", "doubt", "provoke"].includes(result.action) ? "is-casting" : result.action === "doubt-skip" ? "is-confused" : result.action === "attack" ? "is-striking" : result.action === "shoot" ? "is-shooting" : result.action === "fireArrow" ? "is-fire-arrow" : null;
    renderBattle();
    await delay(result.step ? 230 : ["shoot", "fireArrow"].includes(result.action) ? 380 : 260);
    if (result.fireTriggered) {
      animatedUnitId = result.targetId;
      animationClass = "is-burning";
      renderBattle();
      await delay(350);
    }
    animatedUnitId = null;
    animatedTargetId = null;
    animationClass = null;
    await animateAmbushes(result);
    if (result.battleEnded) break;
  }
  } catch (error) {
    showToast(`自动行动中断：${error.message}。当前战场已保留。`, "error");
    return;
  } finally { clearBattleAnimation(); }
  if (battle.status === "ended") await resolveBattle(battle.winner, battle.defenderRetreated);
  else if (battle.status === "paused") await resolveCampaignCheckpoint();
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function retreatBattle() {
  if (!battle || processingEnemy) return;
  const defending = battle.playerSide === "enemy";
  const confirmed = await confirmDialog(defending
    ? { title: "弃城撤退", mark: "退", confirmText: "放弃城池", message: `本城与剩余钱粮将归进攻方，守军撤往另一己方城池。<br>${battle.siege?.encirclement === "encircle" ? "敌军全面包围：突围会承受追击损失。" : "当前仍有撤离通道，撤退不额外损兵。"}<br>若已无其他己方城池，则无法撤退。确定弃城吗？` }
    : { title: "撤出战场", mark: "退", confirmText: "鸣金收兵", message: `幸存部队和剩余随军钱粮会退回出发城，已消耗的军需、费用${commandLimitEnabled(state) ? "与本月指令" : ""}不会返还。<br>确定撤军吗？` });
  if (confirmed) {
    const outcome = battle.retreatArmy();
    if (!outcome.ok) { showToast(outcome.message, "error"); return; }
    await resolveBattle(battle.winner, true);
  }
}

async function resolveBattle(winner, retreated = false) {
  if (battleResolved || !battle) return;
  if (battleCampaignId) return resolveCampaignCheckpoint();
  if (battle.invasionId) return resolveDefensiveBattle(winner, retreated);
  const result = settlePlayerBattle(state, battle, winner);
  if (!result.ok) { showToast(result.message, "error"); return; }
  battleResolved = true;
  const { source, target, allyTroops, supplies } = result;

  if (winner === "ally") {
    state.selectedCityId = target.id;
    addEvent(state, `${target.name}攻略战告捷！我军以 ${number(allyTroops)} 兵力入城。`);
  } else {
    addEvent(state, retreated ? `${target.name}攻略军主动撤回${source.name}，幸存 ${number(allyTroops)} 人。` : `${target.name}攻略失利，残军 ${number(allyTroops)} 人退回${source.name}。`);
  }
  if (battle.outcomeReason) addEvent(state, `${target.name}战报：${battle.outcomeReason}。`);
  if (battleTaskId) finishBattleTask(state, battleTaskId, {
    success: winner === "ally",
    message: `${target.name}攻略${winner === "ally" ? "告捷" : retreated ? "撤军" : "失利"}，幸存 ${number(allyTroops)} 人。${battle.outcomeReason ?? ""}`
  }, state.turnResolution?.targetTurn ?? state.elapsedMonths ?? 0);
  saveState(state);
  const title = winner === "ally" ? "攻城告捷" : retreated ? "全军撤退" : "攻略失败";
  const message = winner === "ally"
    ? `敌军阵势瓦解，<strong>${escapeHtml(target.name)}</strong>已归我军。<br>幸存兵力 ${number(allyTroops)}，并由${escapeHtml(getOfficer(state, target.governorId)?.name ?? "主将")}暂领太守。`
    : `我军未能攻克<strong>${escapeHtml(target.name)}</strong>。<br>幸存兵力 ${number(allyTroops)} 已与${escapeHtml(source.name)}守军按比例合并训练和士气。`;
  await openDialog({ title, content: `<div class="confirm-mark">${winner === "ally" ? "胜" : "退"}</div><div class="confirm-copy">${battle.outcomeReason ? `<strong>${escapeHtml(battle.outcomeReason)}</strong><br>` : ""}${message}<br>随军剩余：金 ${number(supplies.gold)} · 粮 ${number(supplies.food)}，已${winner === "ally" ? "带入占领城池" : "退回出发城"}。</div>`, confirmText: "返回军府", hideCancel: true });
  await leaveBattle(result);
}

async function resolveDefensiveBattle(winner, retreated) {
  const result = settleDefensiveBattle(state, battle, winner, { retreated });
  if (!result.ok) { showToast(result.message, "error"); return; }
  battleResolved = true;
  const { target, playerWon, attackerSurvivors, defenderSurvivors, supplies } = result;
  state.selectedCityId = playerWon ? target.id : result.retreatCityId ?? playerCities(state)[0]?.id ?? target.id;
  saveState(state);
  const title = playerWon ? "迎战告捷" : retreated ? "弃城撤退" : "守城失利";
  const escapeText = result.escapedTroops > 0
    ? `幸存 ${number(result.escapedTroops)} 人已随守将转移至${escapeHtml(getCity(state, result.retreatCityId)?.name ?? "己方城池")}。`
    : "守将按退路撤离或被俘；未能撤出的残兵已解散。";
  const message = playerWon
    ? `已击退入侵，<strong>${escapeHtml(target.name)}</strong>仍归我军。<br>守军幸存 ${number(defenderSurvivors)} 人；敌军残部 ${number(attackerSurvivors)} 人撤离。<br>城内剩余：金 ${number(supplies.defender.gold)} · 粮 ${number(supplies.defender.food)}。`
    : `<strong>${escapeHtml(target.name)}</strong>已被敌军占领。<br>${escapeText}<br>城内剩余钱粮已归占领军。`;
  await openDialog({ title, content: `<div class="confirm-mark">${playerWon ? "胜" : "退"}</div><div class="confirm-copy">${battle.outcomeReason ? `<strong>${escapeHtml(battle.outcomeReason)}</strong><br>` : ""}${message}</div>`, confirmText: "返回军府", hideCancel: true });
  await leaveBattle(result);
}

async function leaveBattle(result) {
  battle = null;
  battleMode = null;
  battleTaskId = null;
  battleCampaignId = null;
  const completed = battleCompletion;
  battleCompletion = null;
  renderStrategy();
  if (completed) completed(result);
  else await campaignUI.showOutcome();
}

async function resolveCampaignCheckpoint() {
  if (!battle || battleResolved || !battleCampaignId) return;
  const checked = checkpointCurrentBattle();
  const paused = battle.status === "paused";
  if (!paused && battle.status !== "ended") return;
  battleResolved = true;
  const target = getCity(state, battle.targetCityId);
  const title = paused ? "本月战事暂歇" : battle.winner === battle.playerSide ? "战役告捷" : "战役结束";
  const message = paused
    ? `${escapeHtml(target?.name ?? "本战场")}已完成本月 30 日战事，累计第 ${battle.day} 日。<br>阵地、兵力、钱粮、城墙进度与持续状态均已保存，下个月从第 ${battle.day + 1} 日继续。<br>参战兵将继续驻守战场，不可重复派遣；其他城池可正常下令。天下各战场可在「战役簿」追踪。`
    : `${escapeHtml(checked?.record?.result?.message ?? checked?.result?.message ?? battle.outcomeReason ?? "本场战役已完成结算。")}<br>兵力、钱粮、城池归属与武将已按战果结算，详见战役簿。`;
  if (!paused && battle.winner === battle.playerSide && target?.factionId === state.playerFactionId) state.selectedCityId = target.id;
  saveBattleState();
  await openDialog({ title, content: `<div class="confirm-mark">${paused ? "歇" : battle.winner === battle.playerSide ? "胜" : "退"}</div><div class="confirm-copy">${message}</div>`, confirmText: "返回军府", hideCancel: true, dismissible: false });
  await leaveBattle({ ok: true, paused, record: checked.record, ...checked.result });
}

init();
