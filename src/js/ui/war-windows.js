import { escapeHtml as esc, number, openDialog } from "./components.js";

const ongoing = (record) => record.status !== "ended";
const phaseNames = { field: "野战", siege_transition: "攻城部署", siege: "攻城" };
const sideTroops = (snapshot, side) => (snapshot.units ?? []).filter((unit) => unit.side === side && unit.troops > 0)
  .reduce((sum, unit) => sum + unit.troops, side === "enemy" ? snapshot.defenderReserveTroops ?? 0 : 0);

/** A presentation-only projection: opening the ledger never resumes a battle. */
export function warLedgerRows(state) {
  return [...(state.battles ?? [])].reverse().map((record) => {
    const snapshot = record.snapshot ?? {};
    const playerSide = record.attackerFactionId === state.playerFactionId ? "ally"
      : record.defenderFactionId === state.playerFactionId ? "enemy" : null;
    const name = (entries, id, fallback) => entries?.find((entry) => entry.id === id)?.name ?? fallback;
    return { id: record.id, active: ongoing(record), playerSide,
      targetId: record.targetCityId, source: name(state.cities, record.sourceCityId, "原出发城"),
      target: name(state.cities, record.targetCityId, "战场"),
      attacker: name(state.factions, record.attackerFactionId, "攻方"), defender: name(state.factions, record.defenderFactionId, "守方"),
      day: snapshot.day ?? 1, phase: phaseNames[snapshot.phase] ?? "野战",
      status: record.status === "paused" ? "本月休战 · 下月续战" : record.status === "ended" ? "战役结束" : "本月待处理",
      attackerTroops: sideTroops(snapshot, "ally"), defenderTroops: sideTroops(snapshot, "enemy"),
      wallPercent: snapshot.siege?.maxHp > 0 ? Math.round(snapshot.siege.hp / snapshot.siege.maxHp * 100) : null,
      food: playerSide ? snapshot.supplies?.[playerSide]?.food ?? 0 : null,
      gold: playerSide ? snapshot.supplies?.[playerSide]?.gold ?? 0 : null,
      reason: record.result?.message ?? snapshot.outcomeReason ?? "",
      log: (snapshot.log ?? []).filter((entry) => !playerSide || !entry.audience || entry.audience.includes(playerSide)).slice(0, 20)
    };
  });
}

export function warLedgerMarkup(state, filter = "active") {
  const rows = warLedgerRows(state).filter((row) => filter === "all" || (filter === "ours" ? row.playerSide : row.active));
  return rows.map((row) => `<article class="war-record ${row.active ? "ongoing" : "ended"}">
    <header><div><span class="kicker">${row.playerSide ? "我军战役" : "群雄交战 · 后台模拟"}</span><h3>${esc(row.target)}之战</h3></div><span class="war-status">${esc(row.status)}</span></header>
    <div class="war-sides"><span><small>攻方 · ${esc(row.source)}出兵</small><strong>${esc(row.attacker)}</strong><b>${number(row.attackerTroops)} 兵</b></span><i>对阵</i><span><small>守方 · ${esc(row.target)}</small><strong>${esc(row.defender)}</strong><b>${number(row.defenderTroops)} 兵</b></span></div>
    <p class="war-progress">累计第 ${number(row.day)} 日 · ${esc(row.phase)}${row.wallPercent !== null && row.phase !== "野战" ? ` · 城墙剩余 ${row.wallPercent}%` : ""}${row.food !== null ? `<br>我方战场储备：粮 ${number(row.food)} · 金 ${number(row.gold)}` : ""}</p>
    ${row.reason ? `<p class="war-result">${esc(row.reason)}</p>` : ""}
    <footer><button class="btn" type="button" data-war-city="${esc(row.targetId)}">战场城池资料</button><button class="btn" type="button" data-war-report="${esc(row.id)}">查看战报</button></footer>
  </article>`).join("") || '<p class="task-empty">此分类暂无战役。出征与群雄交战后，战场将在此持续追踪。</p>';
}

export function createWarUI({ getState, onSelectCity }) {
  function renderSummary() {
    const button = document.querySelector("#wars-button");
    if (!button) return;
    const count = (getState().battles ?? []).filter(ongoing).length;
    button.innerHTML = `战役簿 <span class="task-count">${count}</span>`;
    button.setAttribute("aria-label", `战役簿 · ${count} 场持续战役`);
  }
  async function showWars() {
    let filter = "active";
    const body = document.createElement("div");
    body.className = "war-ledger";
    const render = () => {
      const rows = warLedgerRows(getState());
      body.innerHTML = `<p class="modal-description">天下现有 ${rows.filter((row) => row.active).length} 场持续战役，其中我军参与 ${rows.filter((row) => row.active && row.playerSide).length} 场。每月各战场最多推进 30 天，月末依次处理；暂停不会恢复兵力、阵位、城墙或异常状态。AI 之间完全在后台模拟。</p><nav class="task-ledger-tabs" aria-label="战役分类">${[["active", "持续战役"], ["ours", "我军战役"], ["all", "全部与往期"]].map(([key, title]) => `<button class="btn ${filter === key ? "btn-primary" : ""}" data-war-filter="${key}" aria-pressed="${filter === key}">${title}</button>`).join("")}</nav><div class="war-ledger-grid">${warLedgerMarkup(getState(), filter)}</div>`;
      body.querySelectorAll("[data-war-filter]").forEach((button) => button.addEventListener("click", () => { filter = button.dataset.warFilter; render(); }));
      body.querySelectorAll("[data-war-city]").forEach((button) => button.addEventListener("click", () => {
        body.closest(".modal")?.querySelector(".modal-close")?.click();
        onSelectCity?.(button.dataset.warCity, true);
      }));
      body.querySelectorAll("[data-war-report]").forEach((button) => button.addEventListener("click", async () => {
        const row = warLedgerRows(getState()).find((entry) => entry.id === button.dataset.warReport);
        if (!row) return;
        await openDialog({ title: `${row.target} · 最近战报`, content: `<p class="modal-description">${esc(row.status)} · 累计第 ${number(row.day)} 日。这里只查阅记录，不推进战斗。</p><div class="campaign-journal">${row.log.map((entry) => `<article><time>第 ${number(entry.day)} 日</time><p>${esc(entry.message)}</p></article>`).join("") || "<p>尚无战报。</p>"}</div>`, confirmText: "阅毕", hideCancel: true });
      }));
    };
    render();
    await openDialog({ title: "天下战役簿", content: body, confirmText: "返回军府", hideCancel: true, wide: true });
  }
  return { renderSummary, showWars };
}
