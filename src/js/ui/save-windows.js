import { escapeHtml as esc, openDialog, confirmDialog } from "./components.js";
import { commandLimitEnabled } from "../game/commands.js";

/** Shared by the title scene and the in-game system menu. */
export function saveCardMarkup(save, checked = false, rules = {}) {
  const content = save.empty
    ? `<strong>${save.invalid ? "存档无法读取" : "空白存档"}</strong><span>${save.invalid ? "原记录不会自动清除，覆盖前会再次确认。" : "可将当前征程保存在此处。"}</span>`
    : `<strong>${save.officerName ? `${esc(save.officerName)} · ` : ""}${esc(save.factionName)}</strong><span>${esc(save.year)} 年 ${esc(save.month)} 月 · ${esc(save.cities)} 城 · ${save.officerName ? `个人行动力 ${esc(save.personalAP)}` : commandLimitEnabled(rules) ? `余 ${esc(save.commands)} 道指令` : "指令不限"}</span>
      <em>${save.pending ? "月结尚未完成 · 读取后继续处理" : "战略进度已保存在本机"}</em>`;
  return `<label class="save-slot"><input type="radio" name="save-slot" value="${esc(save.id)}" ${checked ? "checked" : ""}>
    <span><small>${esc(save.label)}</small>${content}</span></label>`;
}

export async function chooseLoadSlot(saves, { inGame = false, rules = {} } = {}) {
  if (!saves.length) return null;
  const body = document.createElement("div");
  body.className = "save-selection";
  body.innerHTML = `<p class="modal-description">选择要读取的征程。手动存档独立保留，不会被自动存档覆盖。战场按已保存的动作继续，跨月阵地与钱粮均保留，不会重新开战或重复扣出征物资。</p>
    <div class="save-slot-list">${saves.map((save, index) => saveCardMarkup(save, index === 0, rules)).join("")}</div>
    <p class="save-selection-note">读取手动存档或上一局快照时，会先把当前活动存档保留为新的上一局快照。</p>`;
  return openDialog({ title: "读取存档", content: body, confirmText: "读取此档", cancelText: inGame ? "返回菜单" : "返回主菜单",
    onConfirm: async () => {
      const slotId = body.querySelector('input[name="save-slot"]:checked')?.value;
      const selected = saves.find((save) => save.id === slotId);
      if (!selected) return false;
      if (inGame && !await confirmDialog({ title: "确认读取存档", mark: "读", confirmText: "确认读取",
        message: `即将读取<strong>${esc(selected.label)} · ${esc(selected.factionName)}</strong>，${esc(selected.year)} 年 ${esc(selected.month)} 月。<br>当前游戏将切换为该存档的进度，是否继续？` })) return false;
      return slotId;
    }
  });
}

export async function saveGameDialog({ getSlots, onSave, rules = {} }) {
  const slots = getSlots();
  const selectedId = (slots.find((slot) => slot.empty && !slot.invalid) ?? slots[0])?.id;
  const body = document.createElement("div");
  body.className = "save-selection";
  body.innerHTML = `<p class="modal-description">选择一个手动存档位。保存当前月份、钱粮、武将与任务进度；之后的自动存档和新游戏不会覆盖这些记录。</p>
    <div class="save-slot-list">${slots.map((slot) => saveCardMarkup(slot, slot.id === selectedId, rules)).join("")}</div>
    <p class="save-selection-note">自动存档仍然持续更新。手动记录同时保存战略局面与所有跨月战场；月间暂停的战役可以正常存档。</p>`;
  return openDialog({ title: "保存游戏", content: body, confirmText: "保存至此处", cancelText: "返回菜单",
    onConfirm: async () => {
      const slotId = body.querySelector('input[name="save-slot"]:checked')?.value;
      const slot = getSlots().find((entry) => entry.id === slotId);
      if (!slot) return false;
      if ((!slot.empty || slot.invalid) && !await confirmDialog({ title: "覆盖存档", mark: "存", confirmText: "确认覆盖",
        message: `确定覆盖<strong>${esc(slot.label)}</strong>吗？<br>${slot.invalid ? "该槽位中无法读取的原记录将被替换。" : `${esc(slot.factionName)} · ${esc(slot.year)} 年 ${esc(slot.month)} 月的手动记录将被替换。`}其他手动存档不受影响。` })) return false;
      await onSave(slotId);
      return slotId;
    }
  });
}
