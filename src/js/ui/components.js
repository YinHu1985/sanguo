import { enterWindow, isTopWindow, leaveWindow } from "./scene-transitions.js";

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function showToast(message, type = "success", duration = 2600) {
  const root = document.querySelector("#toast-root");
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  toast.textContent = message;
  root.append(toast);
  window.setTimeout(() => toast.remove(), duration);
}

export function openDialog({ title, content, confirmText = "确定", cancelText = "取消", wide = false, hideCancel = false, dismissible = true, onConfirm }) {
  const root = document.querySelector("#modal-root");
  const previousFocus = document.activeElement;
  const backdrop = document.createElement("div");
  const titleId = `modal-title-${crypto.randomUUID()}`;
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <section class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <header class="modal-header">
        <h2 id="${titleId}">${escapeHtml(title)}</h2>
        <button class="modal-close" type="button" aria-label="关闭" ${dismissible ? "" : "hidden"}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M3 3L13 13M13 3L3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      </header>
      <div class="modal-body"></div>
      <footer class="modal-footer">
        ${hideCancel ? "" : `<button class="btn dialog-cancel" type="button">${escapeHtml(cancelText)}</button>`}
        <button class="btn btn-primary dialog-confirm" type="button">${escapeHtml(confirmText)}</button>
      </footer>
    </section>`;
  const body = backdrop.querySelector(".modal-body");
  if (typeof content === "string") body.innerHTML = content;
  else body.append(content);
  root.append(backdrop);

  return new Promise((resolve) => {
    let closed = false;
    let confirming = false;
    let focusRequest;
    const panel = backdrop.querySelector(".modal");
    const confirmButton = backdrop.querySelector(".dialog-confirm");
    const isTop = () => isTopWindow(root, backdrop);
    const controls = () => Array.from(backdrop.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'))
      .filter((element) => element.getClientRects().length > 0);
    const close = (value = null) => {
      if (closed || confirming) return;
      const wasTop = isTop();
      closed = true;
      window.cancelAnimationFrame(focusRequest);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      leaveWindow(backdrop);
      if (wasTop && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(value);
    };
    const onKeydown = (event) => {
      if (!isTop() || closed || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (dismissible && !event.repeat) close();
      } else if (event.key === "Tab") {
        const items = controls();
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        const next = event.shiftKey ? index <= 0 ? items.length - 1 : index - 1
          : index === items.length - 1 ? 0 : index + 1;
        event.preventDefault();
        event.stopImmediatePropagation();
        items[next].focus();
      }
    };
    const onFocusIn = (event) => {
      if (!closed && isTop() && !panel.contains(event.target)) controls()[0]?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("focusin", onFocusIn, true);
    backdrop.querySelector(".modal-close").addEventListener("click", () => { if (dismissible && isTop()) close(); });
    backdrop.querySelector(".dialog-cancel")?.addEventListener("click", () => { if (isTop()) close(); });
    backdrop.addEventListener("click", (event) => { if (dismissible && isTop() && event.target === backdrop) close(); });
    confirmButton.addEventListener("click", async () => {
      if (closed || confirming || !isTop()) return;
      confirming = true;
      confirmButton.disabled = true;
      panel.setAttribute("aria-busy", "true");
      try {
        const value = onConfirm ? await onConfirm({ body, backdrop }) : true;
        confirming = false;
        if (value !== false) close(value);
      } catch (error) {
        confirming = false;
        showToast(error?.message || "指令未能完成，请重试。", "error");
      } finally {
        if (!closed) {
          confirmButton.disabled = false;
          panel.removeAttribute("aria-busy");
        }
      }
    });
    enterWindow(backdrop);
    focusRequest = window.requestAnimationFrame(() => { if (!closed && isTop()) controls()[0]?.focus({ preventScroll: true }); });
  });
}

export function confirmDialog({ title, message, confirmText = "确定", mark = "令" }) {
  return openDialog({
    title,
    confirmText,
    content: `<div class="confirm-mark">${escapeHtml(mark)}</div><div class="confirm-copy">${message}</div>`
  });
}

export function createDataTable(columns, rows) {
  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead><tr>${columns.map((column) => `<th class="${column.numeric ? "numeric" : ""}">${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${columns.map((column) => {
      const raw = column.render ? column.render(row) : row[column.key];
      return `<td class="${column.numeric ? "numeric" : ""}">${column.html ? raw : escapeHtml(raw ?? "—")}</td>`;
    }).join("")}</tr>`).join("")}</tbody>`;
  return table;
}

export function number(value) {
  return Math.round(Number(value) || 0).toLocaleString("zh-CN");
}
