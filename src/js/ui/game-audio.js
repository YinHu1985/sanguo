import { openDialog } from "./components.js";

export const AUDIO_STORAGE_KEY = "hanmo-audio-v1";
const DEFAULT_PREFERENCES = { musicVolume: 0.32, effectsVolume: 0.45, muted: false };

export function normalizeAudioPreferences(value = {}, defaults = DEFAULT_PREFERENCES) {
  const volume = (input, fallback) => Number.isFinite(Number(input)) && input !== null
    ? Math.max(0, Math.min(1, Number(input))) : fallback;
  return {
    musicVolume: volume(value.musicVolume, defaults.musicVolume),
    effectsVolume: volume(value.effectsVolume, defaults.effectsVolume),
    muted: value.muted === true
  };
}

/** Only genuine activation events sound: script-driven close-button clicks do not double-play. */
export function isAudibleInteraction(event) {
  if (event?.isTrusted !== true) return false;
  const target = event.target?.closest?.('button, [role="button"], input[type="button"], input[type="submit"], [data-city-id], [data-city], summary');
  return Boolean(target && !target.disabled && target.getAttribute?.("aria-disabled") !== "true"
    && !target.matches?.(":disabled") && !target.closest?.('[inert], [data-sound="off"]'));
}

/** Runtime independent of rendering, injectable for deterministic unit tests. */
export function createAudioController({
  tracks, effects = [], preferences = DEFAULT_PREFERENCES, fadeMs = 850,
  requestFrame = (callback) => requestAnimationFrame(callback), cancelFrame = (id) => cancelAnimationFrame(id),
  now = () => performance.now(), persist = () => {}, onChange = () => {}
}) {
  let settings = normalizeAudioPreferences(preferences);
  let scene = "menu";
  let unlocked = false;
  let hidden = false;
  let disposed = false;
  let frame = null;
  let effectIndex = 0;
  let playbackStatus = "waiting-gesture";
  const entries = Object.entries(tracks);
  const currentKey = () => scene === "battle" ? "battle" : "strategy";
  const snapshot = () => ({ ...settings, scene, track: currentKey(), unlocked, hidden, playbackStatus });
  const publish = () => onChange(snapshot());
  const stopFade = () => { if (frame !== null) cancelFrame(frame); frame = null; };
  const play = (audio, reportFailure = false) => {
    if (!audio || disposed) return;
    const failed = () => {
      // Pausing an unfinished play() rejects with AbortError in some browsers.
      // An obsolete track or an optional click sound must not change music state.
      if (reportFailure && !disposed && audio === tracks[currentKey()] && unlocked
        && !hidden && !settings.muted && settings.musicVolume > 0) {
        playbackStatus = "unavailable";
        publish();
      }
    };
    try {
      const playing = audio.play();
      playing?.catch?.(failed);
    } catch { failed(); }
  };
  const stopAll = () => {
    stopFade();
    for (const [, audio] of entries) { audio.pause(); audio.volume = 0; }
    for (const audio of effects) audio.pause();
  };
  function sync() {
    if (disposed) return;
    stopFade();
    if (!unlocked || hidden || settings.muted || settings.musicVolume === 0) {
      for (const [, audio] of entries) { audio.pause(); audio.volume = 0; }
      playbackStatus = !unlocked ? "waiting-gesture" : hidden ? "suspended" : "muted";
      publish();
      return;
    }
    const key = currentKey();
    const active = tracks[key];
    if (!active) { playbackStatus = "unavailable"; publish(); return; }
    playbackStatus = "playing";
    play(active, true); // Must be invoked synchronously inside the user's first activation.
    const from = Object.fromEntries(entries.map(([id, audio]) => [id, audio.volume]));
    const started = now();
    const tick = () => {
      if (disposed) return;
      const progress = fadeMs <= 0 ? 1 : Math.min(1, Math.max(0, (now() - started) / fadeMs));
      const eased = progress * progress * (3 - 2 * progress);
      for (const [id, audio] of entries) {
        audio.volume = Math.max(0, Math.min(1, from[id] + ((id === key ? settings.musicVolume : 0) - from[id]) * eased));
        if (progress === 1 && id !== key) audio.pause();
      }
      frame = progress < 1 ? requestFrame(tick) : null;
    };
    tick();
    publish();
  }
  function changePreferences(next) {
    settings = normalizeAudioPreferences({ ...settings, ...next });
    try { persist(settings); } catch { /* Private mode or full storage must not interrupt play. */ }
    if (settings.muted || settings.effectsVolume === 0) for (const effect of effects) effect.pause();
    sync();
  }
  const controller = {
    setScene(nextScene) {
      if (disposed) return;
      const next = ["menu", "strategy", "battle"].includes(nextScene) ? nextScene : "strategy";
      if (next === scene) return;
      const previousKey = currentKey();
      scene = next;
      if (previousKey !== currentKey()) sync();
      else publish();
    },
    unlock() {
      if (disposed) return;
      if (!unlocked || playbackStatus === "unavailable") { unlocked = true; sync(); }
    },
    click(event) {
      if (disposed || event?.isTrusted !== true) return;
      controller.unlock();
      if (!isAudibleInteraction(event) || hidden || settings.muted || settings.effectsVolume <= 0 || !effects.length) return;
      const audio = effects[effectIndex++ % effects.length];
      audio.volume = settings.effectsVolume;
      try { audio.currentTime = 0; } catch { /* A loading sound can still play from its start. */ }
      play(audio);
    },
    setHidden(value) {
      hidden = Boolean(value);
      if (hidden) stopAll();
      sync();
    },
    setVolume(kind, value) { changePreferences({ [kind === "effects" ? "effectsVolume" : "musicVolume"]: value }); },
    setMuted(value) { changePreferences({ muted: Boolean(value) }); },
    getState: snapshot,
    dispose() { disposed = true; stopAll(); }
  };
  for (const [, audio] of entries) { audio.volume = 0; audio.loop = true; }
  publish();
  return controller;
}

/** Initialize once. This module never blocks game startup if loading or playback fails. */
export async function createGameAudio() {
  const manifestUrl = new URL("../../data/audio.json", import.meta.url);
  let manifest;
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error("Audio manifest unavailable");
    manifest = await response.json();
  } catch { manifest = { tracks: {}, effects: {}, defaults: DEFAULT_PREFERENCES }; }
  let preferences = manifest.defaults;
  try { preferences = { ...preferences, ...JSON.parse(localStorage.getItem(AUDIO_STORAGE_KEY) || "{}") }; } catch { /* Optional preferences. */ }
  const root = document.createElement("div");
  root.id = "game-audio-engine";
  root.hidden = true;
  root.setAttribute("aria-hidden", "true");
  document.body.append(root);
  const makeAudio = (asset, id) => {
    if (!asset?.src) return null;
    const audio = document.createElement("audio");
    audio.src = new URL(asset.src, manifestUrl).href;
    audio.preload = "auto";
    audio.dataset.audioId = id;
    audio.dataset.title = asset.title ?? "";
    root.append(audio);
    return audio;
  };
  const tracks = Object.fromEntries(Object.entries(manifest.tracks ?? {}).map(([id, asset]) => [id, makeAudio(asset, id)]).filter(([, audio]) => audio));
  const effects = Array.from({ length: 4 }, (_, index) => makeAudio(manifest.effects?.click, `click-${index}`)).filter(Boolean);
  const controller = createAudioController({
    tracks, effects, preferences, fadeMs: manifest.fadeMs,
    persist: (value) => localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(value)),
    onChange: (state) => {
      for (const [key, value] of Object.entries(state)) root.dataset[key] = String(value);
    }
  });
  const onClick = (event) => controller.click(event);
  const onVisibility = () => controller.setHidden(document.hidden);
  const onPageHide = () => controller.setHidden(true);
  const onPageShow = () => controller.setHidden(document.hidden);
  document.addEventListener("click", onClick, true);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  onVisibility();
  const openSettings = async () => {
    const state = controller.getState();
    const body = document.createElement("div");
    body.className = "audio-settings";
    body.innerHTML = `<p>大地图与主界面 · 江山闲赋<br>野战与攻城 · 旌旗动地</p>
      <label class="audio-volume-label" for="music-volume">背景音乐 <output id="music-volume-value">${Math.round(state.musicVolume * 100)}%</output></label>
      <input id="music-volume" type="range" min="0" max="100" step="1" value="${Math.round(state.musicVolume * 100)}" aria-label="背景音乐音量">
      <label class="audio-volume-label" for="effects-volume">点击音效 <output id="effects-volume-value">${Math.round(state.effectsVolume * 100)}%</output></label>
      <input id="effects-volume" type="range" min="0" max="100" step="1" value="${Math.round(state.effectsVolume * 100)}" aria-label="点击音效音量">
      <label class="audio-mute-label"><input id="audio-muted" type="checkbox" ${state.muted ? "checked" : ""}> 静音全部声音</label>
      <p class="audio-settings-note">音量设置即时保存。首次点击后播放；切换到后台时自动暂停。音乐与音效均从本地资源目录读取。</p>`;
    for (const kind of ["music", "effects"]) body.querySelector(`#${kind}-volume`).addEventListener("input", (event) => {
      controller.setVolume(kind, Number(event.target.value) / 100);
      body.querySelector(`#${kind}-volume-value`).textContent = `${event.target.value}%`;
    });
    body.querySelector("#audio-muted").addEventListener("change", (event) => controller.setMuted(event.target.checked));
    await openDialog({ title: "声音设置", content: body, hideCancel: true, confirmText: "返回" });
  };
  return { ...controller, openSettings, dispose() {
    controller.dispose();
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    root.remove();
  } };
}
