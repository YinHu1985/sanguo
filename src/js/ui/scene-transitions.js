/** Visual-only motion. Nothing here changes game state or screen visibility. */
const SCENES = new Set(["menu", "personal", "strategy", "field", "siege"]);
const panelKeys = new WeakMap();

export function prefersReducedMotion(view = globalThis.window) {
  return Boolean(view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** Resolve after the short visual ends, including if the browser cancels it. */
function playMotion(element, keyframes, duration) {
  if (!element || prefersReducedMotion(element.ownerDocument?.defaultView) || typeof element.animate !== "function") return Promise.resolve();
  try {
    const animation = element.animate(keyframes, { duration, easing: "cubic-bezier(.22,.7,.28,1)", fill: "none" });
    return Promise.resolve(animation.finished).catch(() => {});
  } catch {
    // Older embedded browsers still get a fully functional immediate window.
    return Promise.resolve();
  }
}

export function enterWindow(backdrop) {
  const panel = backdrop?.querySelector(".modal, .story-dialog");
  playMotion(backdrop, [{ opacity: 0 }, { opacity: 1 }], 170);
  return playMotion(panel, [
    { opacity: 0, transform: "translateY(9px) scale(.975)", clipPath: "inset(4% 0 4% 0)" },
    { opacity: 1, transform: "translateY(0) scale(1)", clipPath: "inset(0)" }
  ], 210);
}

/** Closing windows remain only as inert visual remnants; callers resolve now. */
export function leaveWindow(backdrop) {
  if (!backdrop) return Promise.resolve();
  backdrop.dataset.windowClosing = "true";
  backdrop.inert = true;
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.style.pointerEvents = "none";
  const panel = backdrop.querySelector(".modal, .story-dialog");
  playMotion(panel, [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(5px) scale(.985)" }], 130);
  return playMotion(backdrop, [{ opacity: 1 }, { opacity: 0 }], 140).finally(() => backdrop.remove());
}

/** Ignore a window's closing animation when deciding which dialog owns input. */
export function isTopWindow(root, backdrop) {
  const visible = Array.from(root?.children ?? []).filter((child) => child.dataset?.windowClosing !== "true");
  return visible.at(-1) === backdrop;
}

/** Pass the selected city id to avoid replaying motion for ordinary rerenders. */
export function animatePanel(element, key) {
  if (!element) return false;
  if (key !== undefined && panelKeys.has(element) && panelKeys.get(element) === key) return false;
  panelKeys.set(element, key);
  playMotion(element, [
    { opacity: .45, transform: "translateY(5px)" },
    { opacity: 1, transform: "translateY(0)" }
  ], 180);
  return true;
}

/** A small injectable controller keeps the scene change policy testable. */
export function createSceneTransitionController({ getDocument = () => globalThis.document, reducedMotion = () => prefersReducedMotion(), schedule = (callback, ms) => setTimeout(callback, ms), unschedule = (handle) => clearTimeout(handle) } = {}) {
  let currentScene = null;
  let veil = null;
  let removalTimer = null;
  const clearVeil = () => {
    if (removalTimer !== null) unschedule(removalTimer);
    removalTimer = null;
    veil?.remove();
    veil = null;
  };
  return (scene) => {
    if (!SCENES.has(scene) || scene === currentScene) return false;
    const previous = currentScene;
    currentScene = scene;
    clearVeil();
    const doc = getDocument();
    if (!doc?.body || reducedMotion()) return true;
    veil = doc.createElement("div");
    veil.className = "scene-transition-veil";
    veil.setAttribute("aria-hidden", "true");
    veil.dataset.fromScene = previous ?? "opening";
    veil.dataset.toScene = scene;
    doc.body.append(veil);
    // CSS handles only opacity. Input remains available throughout the dissolve.
    removalTimer = schedule(clearVeil, 460);
    return true;
  };
}

export const transitionScene = createSceneTransitionController();
