import { heavenCycleStatus } from "../game/heaven-cycle.js";
import { escapeHtml as esc } from "./components.js";

/** Read-only shared view: render the saved cycle without initializing or advancing it. */
export function heavenIndicatorMarkup(faction, rules) {
  const heaven = heavenCycleStatus(faction, rules);
  const change = Math.round((heaven.multiplier - 1) * 100);
  const modifier = change === 0 ? "无修正" : `${change > 0 ? "+" : "−"}${Math.abs(change)}%`;
  const title = `${heaven.label} · 改革力收入${modifier} · 循环 ${heaven.strength}/${heaven.maxStrength}。${heaven.description}${heaven.lastReason ? `最近：${heaven.lastReason}。` : ""}点击查看天意循环。`;
  return `<span class="heaven-indicator ${esc(heaven.phase)}" title="${esc(title)}" data-heaven-phase="${esc(heaven.phase)}" data-heaven-strength="${heaven.strength}">
    <svg class="heaven-mini-dial" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28"/><circle class="heaven-mini-inner" cx="32" cy="32" r="22"/><path class="heaven-mini-ticks" d="M32 2V7 M62 32H57 M32 62V57 M2 32H7"/><g class="heaven-mini-pointer" transform="rotate(${heaven.angle} 32 32)"><path d="M32 5L28 15L32 12L36 15Z"/></g><text x="32" y="40" text-anchor="middle">天</text></svg>
    <span class="heaven-indicator-copy"><strong>${esc(heaven.label)}</strong><small>改革力 <b>${modifier}</b><i>${heaven.strength}/${heaven.maxStrength}</i></small></span>
  </span>`;
}
