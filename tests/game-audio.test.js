import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAudioController, isAudibleInteraction, normalizeAudioPreferences } from "../src/js/ui/game-audio.js";

function audioStub() {
  return {
    volume: 1, currentTime: 12, loop: false, paused: true, plays: 0, pauses: 0,
    play() { this.paused = false; this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; this.pauses++; }
  };
}

function harness(options = {}) {
  let time = 0;
  let id = 0;
  const scheduled = new Map();
  const tracks = { strategy: audioStub(), battle: audioStub() };
  const effects = Array.from({ length: 4 }, audioStub);
  const saved = [];
  const controller = createAudioController({ tracks, effects, fadeMs: 1000,
    now: () => time, requestFrame: (callback) => { scheduled.set(++id, callback); return id; },
    cancelFrame: (key) => scheduled.delete(key), persist: (settings) => saved.push(settings), ...options
  });
  const advance = (elapsed) => {
    time += elapsed;
    const callbacks = [...scheduled.values()];
    scheduled.clear();
    for (const callback of callbacks) callback(time);
  };
  return { controller, tracks, effects, saved, advance, scheduled };
}

function event({ trusted = true, disabled = false, ariaDisabled = false, fieldsetDisabled = false, inert = false, button = true } = {}) {
  const target = { disabled, getAttribute: (key) => key === "aria-disabled" && ariaDisabled ? "true" : null,
    matches: () => fieldsetDisabled, closest: () => inert ? {} : null };
  return { isTrusted: trusted, target: { closest: () => button ? target : null } };
}

test("preferences clamp volumes and preserve explicit mute", () => {
  assert.deepEqual(normalizeAudioPreferences({ musicVolume: -1, effectsVolume: 3, muted: true }), { musicVolume: 0, effectsVolume: 1, muted: true });
  assert.deepEqual(normalizeAudioPreferences({ musicVolume: "bad", effectsVolume: null, muted: "true" }), { musicVolume: 0.32, effectsVolume: 0.45, muted: false });
  assert.equal(normalizeAudioPreferences({ musicVolume: 0 }).musicVolume, 0);
});

test("real enabled buttons and cities sound, scripted and disabled activations do not", () => {
  assert.equal(isAudibleInteraction(event()), true);
  for (const options of [{ trusted: false }, { disabled: true }, { ariaDisabled: true }, { fieldsetDisabled: true }, { inert: true }, { button: false }]) {
    assert.equal(isAudibleInteraction(event(options)), false, JSON.stringify(options));
  }
});

test("loading and scene changes never autoplay before first real user click", () => {
  const { controller, tracks, effects } = harness();
  controller.setScene("battle");
  controller.click(event({ trusted: false }));
  assert.equal(controller.getState().unlocked, false);
  assert.equal(tracks.battle.plays, 0);
  assert.equal(effects[0].plays, 0);
  controller.click(event());
  assert.equal(controller.getState().unlocked, true);
  assert.equal(tracks.battle.plays, 1);
  assert.equal(tracks.strategy.plays, 0);
  assert.equal(effects[0].plays, 1);
  assert.equal(effects[0].currentTime, 0);
});

test("menu and strategy share a continuous track without restarting it", () => {
  const { controller, tracks, advance } = harness();
  controller.unlock();
  advance(1000);
  assert.equal(tracks.strategy.volume, 0.32);
  assert.equal(tracks.strategy.loop, true);
  controller.setScene("strategy");
  controller.setScene("menu");
  assert.equal(tracks.strategy.plays, 1);
  assert.equal(tracks.strategy.currentTime, 12);
});

test("scene switch crossfades both tracks and pauses the departed scene", () => {
  const { controller, tracks, advance } = harness();
  controller.unlock();
  advance(1000);
  controller.setScene("battle");
  assert.equal(tracks.strategy.paused, false);
  assert.equal(tracks.battle.paused, false);
  advance(500);
  assert.equal(tracks.strategy.volume, 0.16);
  assert.equal(tracks.battle.volume, 0.16);
  advance(500);
  assert.equal(tracks.strategy.volume, 0);
  assert.equal(tracks.strategy.paused, true);
  assert.equal(tracks.battle.volume, 0.32);
});

test("rapid scene changes cancel stale fades and preserve the latest selected score", () => {
  const { controller, tracks, advance, scheduled } = harness();
  controller.unlock(); advance(1000);
  controller.setScene("battle"); advance(300);
  controller.setScene("strategy");
  assert.equal(scheduled.size, 1);
  advance(1000);
  assert.equal(tracks.strategy.volume, 0.32);
  assert.equal(tracks.strategy.paused, false);
  assert.equal(tracks.battle.volume, 0);
  assert.equal(tracks.battle.paused, true);
});

test("background tabs stop music and effects, then resume the current scene softly", () => {
  const { controller, tracks, effects, advance } = harness();
  controller.click(event()); advance(1000);
  controller.setHidden(true);
  assert.equal(controller.getState().playbackStatus, "suspended");
  assert.equal(tracks.strategy.paused, true);
  assert.equal(effects[0].paused, true);
  controller.setScene("battle");
  assert.equal(tracks.battle.plays, 0);
  controller.setHidden(false);
  assert.equal(tracks.battle.plays, 1);
  assert.equal(tracks.battle.volume, 0);
  advance(1000);
  assert.equal(tracks.battle.volume, 0.32);
});

test("mute is persisted, suppresses both channels, and keeps selected scene for unmute", () => {
  const { controller, tracks, effects, saved, advance } = harness();
  controller.click(event()); advance(1000);
  controller.setMuted(true);
  controller.setScene("battle");
  controller.click(event());
  assert.equal(tracks.strategy.paused, true);
  assert.equal(tracks.battle.plays, 0);
  assert.equal(effects.reduce((sum, effect) => sum + effect.plays, 0), 1);
  assert.equal(saved.at(-1).muted, true);
  controller.setMuted(false); advance(1000);
  assert.equal(tracks.battle.volume, 0.32);
  assert.equal(saved.at(-1).muted, false);
});

test("stored mute applies even to the initial unlocking click", () => {
  const { controller, tracks, effects } = harness({ preferences: { musicVolume: 0.3, effectsVolume: 0.4, muted: true } });
  controller.click(event());
  assert.equal(controller.getState().unlocked, true);
  assert.equal(tracks.strategy.plays, 0);
  assert.equal(effects[0].plays, 0);
});

test("music and effects volumes are independent and pooled clicks do not cut off each other", () => {
  const { controller, tracks, effects, advance } = harness();
  controller.setVolume("music", 0);
  controller.setVolume("effects", 0.7);
  for (let index = 0; index < 4; index++) controller.click(event());
  assert.equal(tracks.strategy.plays, 0);
  for (const effect of effects) { assert.equal(effect.plays, 1); assert.equal(effect.volume, 0.7); }
  controller.setVolume("music", 0.6); advance(1000);
  controller.setVolume("effects", 0);
  controller.click(event());
  assert.equal(tracks.strategy.volume, 0.6);
  assert.equal(effects[0].plays, 1);
});

test("disabled or plain background clicks can unlock music but never play an effect", () => {
  const { controller, effects } = harness();
  controller.click(event({ button: false }));
  controller.click(event({ disabled: true }));
  assert.equal(controller.getState().unlocked, true);
  assert.equal(effects.every((effect) => effect.plays === 0), true);
});

test("unavailable audio, blocked play and failed preference storage never throw into game flow", async () => {
  const blocked = audioStub();
  blocked.play = () => Promise.reject(new Error("Autoplay unavailable"));
  const { controller } = harness({ tracks: { strategy: blocked }, persist: () => { throw new Error("Quota"); } });
  assert.doesNotThrow(() => controller.click(event()));
  await Promise.resolve();
  assert.equal(controller.getState().playbackStatus, "unavailable");
  assert.doesNotThrow(() => controller.setVolume("music", 0.5));
  assert.doesNotThrow(() => controller.setScene("battle"));
  assert.equal(controller.getState().playbackStatus, "unavailable");
});

test("dispose cancels fades and prevents subsequent playback", () => {
  const { controller, tracks, scheduled } = harness();
  controller.unlock();
  assert.equal(scheduled.size, 1);
  controller.dispose();
  assert.equal(scheduled.size, 0);
  assert.equal(tracks.strategy.paused, true);
  controller.click(event());
  controller.setScene("battle");
  assert.equal(tracks.battle.plays, 0);
});

test("late play rejection from paused audio cannot overwrite suspended or muted state", async () => {
  const pending = audioStub();
  let rejectPlay;
  pending.play = () => new Promise((resolve, reject) => { rejectPlay = reject; });
  const { controller } = harness({ tracks: { strategy: pending } });
  controller.unlock();
  controller.setHidden(true);
  rejectPlay(new Error("AbortError"));
  await Promise.resolve();
  assert.equal(controller.getState().playbackStatus, "suspended");
  controller.setHidden(false);
  controller.setMuted(true);
  rejectPlay(new Error("AbortError"));
  await Promise.resolve();
  assert.equal(controller.getState().playbackStatus, "muted");
});

test("all three bundled original assets are real playable PCM files with expected durations", async () => {
  const manifestUrl = new URL("../src/data/audio.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(Object.keys(manifest.tracks).length, 2);
  for (const asset of [...Object.values(manifest.tracks), ...Object.values(manifest.effects)]) {
    assert.match(asset.src, /^\.\.\/assets\/audio\/[\w-]+\.wav$/);
    const wav = await readFile(new URL(asset.src, manifestUrl));
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 2);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    const duration = wav.readUInt32LE(40) / wav.readUInt32LE(28);
    assert.ok(Math.abs(duration - asset.duration) < 0.01, `${asset.title} duration`);
    assert.ok(wav.some((sample, index) => index > 44 && sample !== 0));
  }
});
