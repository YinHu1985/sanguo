import { animatePanel, enterWindow, isTopWindow, leaveWindow } from "./scene-transitions.js";

/**
 * Reusable narrative window. Content is always plain text; its caller owns
 * campaign timing, persistence, and any effects caused by the conversation.
 */

/** Only bundled image assets are accepted, never a remote portrait URL. */
export function localStoryPortrait(value) {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!/^(?:\.\/|\/)?assets\/[\p{L}\p{N}_./-]+\.(?:svg|png|jpe?g|webp|gif)$/iu.test(path)) return null;
  if (path.split("/").includes("..")) return null;
  return path;
}

/** Text arrays are paragraphs; `pages` describes a sequence of separate panels. */
export function normalizeStoryPages(options = {}) {
  const defaults = {
    speaker: options.speaker ?? null,
    portrait: options.portrait ?? null,
    caption: options.caption ?? ""
  };
  const inputs = Array.isArray(options.pages) && options.pages.length ? options.pages : [options.text ?? ""];
  return inputs.map((entry) => {
    const page = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : { text: entry };
    const speaker = Object.hasOwn(page, "speaker") ? page.speaker : defaults.speaker;
    const name = typeof speaker === "string" ? speaker : speaker?.name;
    const portrait = Object.hasOwn(page, "portrait") ? page.portrait
      : page.speaker?.portrait ?? (Object.hasOwn(page, "speaker") ? null : defaults.portrait ?? speaker?.portrait);
    const rawText = page.text ?? "";
    return {
      speaker: typeof name === "string" && name.trim() ? name.trim() : null,
      portrait: localStoryPortrait(portrait),
      caption: String(page.caption ?? defaults.caption),
      paragraphs: (Array.isArray(rawText) ? rawText : [rawText]).map((paragraph) => String(paragraph ?? ""))
    };
  });
}

/** Build a report using an actual ruler only; never create a substitute officer. */
export function buildTurnOpening(state) {
  const faction = (state.factions ?? []).find((entry) => entry.id === state.playerFactionId);
  const lord = faction && (state.officers ?? []).find((officer) => officer.id === faction.lord
    && officer.factionId === faction.id && (!officer.status || officer.status === "active"));
  const commands = Math.max(0, Math.floor(Number(state.commandsRemaining) || 0));
  return {
    speaker: lord ? { name: lord.name, portrait: localStoryPortrait(lord.portrait) } : null,
    caption: `${state.year} 年 ${state.month} 月 · ${faction?.name ?? "本方势力"}`,
    text: lord ? [
      "诸位，本月轮到我军行动。",
      `尚有 ${commands} 道指令可用。请查看军政任务，安排本月事务。`
    ] : [
      `${faction?.name ?? "本方势力"}的行动回合开始了。`,
      `本月尚有 ${commands} 道指令可用。请查看军政任务，安排本月事务。`
    ]
  };
}

/**
 * @returns {Promise<boolean>} true after the last page; false if dismissed.
 * A speaker may be a name or { name, portrait }. Missing images fall back to a
 * name seal. Without a speaker the same component becomes a full-width narrator.
 */
export function showStoryDialog({ continueText = "继续", dismissible = true, ...options } = {}) {
  const pages = normalizeStoryPages(options);
  let root = document.querySelector("#modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "modal-root";
    document.body.append(root);
  }
  const previousFocus = document.activeElement;
  const id = `story-${crypto.randomUUID()}`;
  const backdrop = document.createElement("div");
  backdrop.className = "story-backdrop";
  const panel = document.createElement("section");
  panel.className = "story-dialog";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", `${id}-name`);
  panel.setAttribute("aria-describedby", `${id}-text`);
  panel.tabIndex = -1;

  const portrait = document.createElement("div");
  portrait.className = "story-portrait";
  portrait.setAttribute("aria-hidden", "true");
  const seal = document.createElement("span");
  seal.className = "story-name-seal";
  const portraitLabel = document.createElement("small");
  portraitLabel.className = "story-portrait-label";
  portraitLabel.textContent = "人物";
  const portraitInner = document.createElement("div");
  portraitInner.className = "story-portrait-inner";
  portraitInner.append(seal, portraitLabel);
  portrait.append(portraitInner);

  const header = document.createElement("header");
  header.className = "story-header";
  const name = document.createElement("h2");
  name.id = `${id}-name`;
  const caption = document.createElement("p");
  caption.className = "story-caption";
  header.append(name, caption);

  const body = document.createElement("div");
  body.className = "story-text";
  body.id = `${id}-text`;
  body.setAttribute("aria-live", "polite");
  body.setAttribute("aria-atomic", "true");
  const footer = document.createElement("footer");
  footer.className = "story-footer";
  const progress = document.createElement("span");
  progress.className = "story-progress";
  const hint = document.createElement("span");
  hint.className = "story-key-hint";
  hint.textContent = "Enter / 空格继续";
  hint.setAttribute("aria-hidden", "true");
  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "story-continue";
  const nextLabel = document.createElement("span");
  nextLabel.textContent = continueText;
  const arrow = document.createElement("span");
  arrow.className = "story-continue-mark";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "◆";
  nextButton.append(nextLabel, arrow);
  footer.append(progress, hint, nextButton);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "story-close";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "关闭对话");
  closeButton.hidden = !dismissible;
  panel.append(portrait, header, body, footer, closeButton);
  backdrop.append(panel);
  root.append(backdrop);

  return new Promise((resolve) => {
    let pageIndex = 0;
    let closed = false;
    let focusRequest;
    const isTop = () => isTopWindow(root, backdrop);
    const renderPage = () => {
      const page = pages[pageIndex];
      panel.classList.toggle("story-with-speaker", Boolean(page.speaker));
      panel.classList.toggle("story-narration", !page.speaker);
      name.textContent = page.speaker ?? "旁白";
      caption.textContent = page.caption;
      caption.hidden = !page.caption;
      portrait.hidden = !page.speaker;
      seal.textContent = page.speaker ?? "";
      portraitInner.querySelector("img")?.remove();
      portraitInner.classList.remove("story-has-image");
      if (page.portrait && page.speaker) {
        const img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.addEventListener("load", () => {
          if (img.isConnected) portraitInner.classList.add("story-has-image");
        }, { once: true });
        img.addEventListener("error", () => img.remove(), { once: true });
        img.src = page.portrait;
        portraitInner.append(img);
      }
      body.replaceChildren(...page.paragraphs.map((text) => {
        const p = document.createElement("p");
        p.textContent = text;
        return p;
      }));
      body.scrollTop = 0;
      progress.textContent = pages.length > 1 ? `${pageIndex + 1} / ${pages.length}` : "";
      progress.setAttribute("aria-label", pages.length > 1 ? `第 ${pageIndex + 1} 段，共 ${pages.length} 段` : "");
    };
    const close = (completed) => {
      if (closed) return;
      const wasTop = isTop();
      closed = true;
      window.cancelAnimationFrame(focusRequest);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      nextButton.removeEventListener("click", onContinue);
      closeButton.removeEventListener("click", onDismiss);
      leaveWindow(backdrop);
      if (wasTop && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(completed);
    };
    const onContinue = () => {
      if (!isTop() || closed) return;
      if (pageIndex === pages.length - 1) close(true);
      else { pageIndex += 1; renderPage(); animatePanel(body, pageIndex); }
    };
    const onDismiss = () => { if (dismissible && isTop()) close(false); };
    const onKeydown = (event) => {
      if (!isTop() || closed || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) onDismiss();
      } else if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) {
          if (event.target === closeButton) onDismiss();
          else onContinue();
        }
      } else if (event.key === "Tab") {
        // Exactly these two buttons are interactive. Keep focus in the topmost
        // window without intercepting a confirmation opened above this one.
        const controls = dismissible ? [nextButton, closeButton] : [nextButton];
        const index = controls.indexOf(document.activeElement);
        const next = event.shiftKey ? index <= 0 ? controls.length - 1 : index - 1
          : index === controls.length - 1 ? 0 : index + 1;
        event.preventDefault();
        event.stopImmediatePropagation();
        controls[next].focus();
      }
    };
    const onFocusIn = (event) => {
      if (!closed && isTop() && !panel.contains(event.target)) nextButton.focus({ preventScroll: true });
    };
    nextButton.addEventListener("click", onContinue);
    closeButton.addEventListener("click", onDismiss);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("focusin", onFocusIn, true);
    renderPage();
    enterWindow(backdrop);
    focusRequest = window.requestAnimationFrame(() => { if (!closed && isTop()) nextButton.focus({ preventScroll: true }); });
  });
}
