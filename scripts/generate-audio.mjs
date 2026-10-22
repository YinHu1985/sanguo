/** Original, deterministic score and synthesis. No samples or external assets.
 * Regenerate with: node scripts/generate-audio.mjs
 * All generated audio and this score are part of this game's source assets.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RATE = 22050;
const TAU = Math.PI * 2;
let seed = 196;
const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const hz = (note) => 440 * 2 ** ((note - 69) / 12);
const output = fileURLToPath(new URL("../src/assets/audio/", import.meta.url));
await mkdir(output, { recursive: true });

function score(bpm, bars) {
  const beat = 60 / bpm;
  const frames = Math.round(bars * 4 * beat * RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  function note(instrument, pitch, atBeat, duration, gain = 0.12, pan = 0) {
    const start = Math.round(atBeat * beat * RATE);
    const seconds = duration * beat;
    const count = Math.ceil((seconds + (instrument === "pluck" ? 1.3 : 0.4)) * RATE);
    const frequency = hz(pitch);
    const panLeft = Math.sqrt((1 - pan) / 2);
    const panRight = Math.sqrt((1 + pan) / 2);
    let phase = 0;
    for (let i = 0; i < count; i++) {
      const t = i / RATE;
      let value = 0;
      if (instrument === "pluck") {
        const attack = Math.min(1, t / 0.006);
        const decay = Math.exp(-t * (1.3 + frequency / 2300));
        for (let harmonic = 1; harmonic <= 6; harmonic++) {
          value += Math.sin(TAU * frequency * harmonic * t * (1 + harmonic * 0.00015))
            * Math.exp(-t * harmonic * 0.65) / (harmonic ** 1.7);
        }
        value *= attack * decay * Math.min(1, (seconds + 1.3 - t) / 0.1);
      } else if (instrument === "flute") {
        if (t > seconds) continue;
        const envelope = Math.min(1, t / 0.12) * Math.min(1, (seconds - t) / 0.16);
        const vibrato = 1 + 0.003 * Math.sin(TAU * 4.8 * t) * Math.min(1, t / 0.4);
        phase += TAU * frequency * vibrato / RATE;
        value = (Math.sin(phase) + 0.16 * Math.sin(phase * 2) + 0.045 * Math.sin(phase * 3)) * envelope;
      } else if (instrument === "pad") {
        if (t > seconds) continue;
        const envelope = Math.min(1, t / 0.8) * Math.min(1, (seconds - t) / 0.8);
        value = (Math.sin(TAU * frequency * t) + Math.sin(TAU * frequency * 1.003 * t) * 0.45
          + Math.sin(TAU * frequency * 2 * t) * 0.12) * envelope;
      } else if (instrument === "bell") {
        value = (Math.sin(TAU * frequency * t) * Math.exp(-t * 2.5)
          + Math.sin(TAU * frequency * 2.76 * t) * 0.2 * Math.exp(-t * 6)) * Math.min(1, t / 0.003);
      } else if (instrument === "drum") {
        phase += TAU * (frequency + 70 * Math.exp(-t * 30)) / RATE;
        value = Math.sin(phase) * Math.exp(-t * 7) + random() * 0.2 * Math.exp(-t * 30);
        value *= Math.min(1, t / 0.002);
      } else if (instrument === "wood") {
        value = (Math.sin(TAU * frequency * t) * 0.6 + random() * 0.45) * Math.exp(-t * 90)
          * Math.min(1, t / 0.001);
      }
      const index = (start + i) % frames;
      left[index] += value * gain * panLeft;
      right[index] += value * gain * panRight;
    }
  }
  function save(name, reverberation = true) {
    if (reverberation) {
      // Circular early reflections preserve the final phrase across the loop.
      const dryLeft = left.slice();
      const dryRight = right.slice();
      for (const [delay, amount] of [[0.087, 0.14], [0.173, 0.11], [0.293, 0.075], [0.433, 0.04]]) {
        const offset = Math.round(delay * RATE);
        for (let i = 0; i < frames; i++) {
          const target = (i + offset) % frames;
          left[target] += dryRight[i] * amount;
          right[target] += dryLeft[i] * amount;
        }
      }
    }
    let peak = 0;
    for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    const gain = 0.85 / Math.max(peak, 0.001);
    const wav = Buffer.alloc(44 + frames * 4);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 4, 28);
    wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
    wav.writeUInt32LE(frames * 4, 40);
    for (let i = 0; i < frames; i++) {
      wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i] * gain)) * 32767), 44 + i * 4);
      wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i] * gain)) * 32767), 46 + i * 4);
    }
    return writeFile(`${output}/${name}.wav`, wav).then(() => console.log(`${name}: ${(frames / RATE).toFixed(2)} s · ${wav.length.toLocaleString()} bytes`));
  }
  return { note, save };
}

// 《江山闲赋》: D pentatonic, four phrases, open fifths and guzheng-like arpeggios.
const calm = score(72, 16);
const roots = [50, 50, 55, 57, 53, 55, 57, 50, 62, 57, 55, 53, 55, 57, 50, 50];
const melody = [
  [[74, 0, 1.5], [77, 2, 1], [79, 3, 0.75]], [[81, 0, 2], [79, 2.5, 1]],
  [[77, 0, 1], [74, 1.5, 1.5]], [[72, 0, 1.5], [74, 2, 1.75]],
  [[77, 0, 1.5], [81, 2, 1]], [[79, 0, 2], [77, 2.5, 1]],
  [[74, 0, 1], [72, 1.5, 1]], [[74, 0, 3]],
  [[86, 0, 1.5], [84, 2, 1]], [[81, 0, 1], [79, 1.5, 2]],
  [[77, 0, 1], [79, 1.5, 1], [81, 3, 0.75]], [[77, 0, 2.5]],
  [[79, 0, 1], [77, 1.5, 1]], [[74, 0, 1.5], [72, 2, 1]],
  [[74, 0, 3]], [[69, 0, 1.5], [72, 2, 0.75]]
];
for (let bar = 0; bar < 16; bar++) {
  const root = roots[bar];
  calm.note("pad", root - 12, bar * 4, 4, 0.055, -0.1);
  calm.note("pad", root + 7, bar * 4, 4, 0.028, 0.25);
  for (let step = 0; step < 8; step++) {
    const pitch = root + [0, 7, 12, 19, 12, 7, 19, 12][step];
    calm.note("pluck", pitch, bar * 4 + step * 0.5, 0.45, step % 2 ? 0.07 : 0.10, step % 2 ? 0.45 : -0.4);
  }
  for (const [pitch, start, duration] of melody[bar]) calm.note("flute", pitch, bar * 4 + start, duration, 0.105, 0.1);
  if (bar % 4 === 0) calm.note("bell", root + 24, bar * 4, 2, 0.055, 0.5);
  if (bar % 2 === 0) calm.note("wood", 68, bar * 4 + 3, 0.1, 0.035, -0.5);
}
await calm.save("strategy-courtyard");

// 《旌旗动地》: same tonal world, martial ostinato and alternating drum phrases.
const battle = score(104, 16);
const warRoots = [38, 38, 41, 43, 38, 45, 43, 38, 41, 43, 45, 45, 43, 41, 38, 38];
const warMotifs = [
  [62, 62, 65, 67, 69, 67, 65, 62], [62, 65, 67, 69, 72, 69, 67, 65],
  [65, 67, 69, 72, 74, 72, 69, 67], [69, 67, 65, 62, 60, 62, 65, 62]
];
for (let bar = 0; bar < 16; bar++) {
  const root = warRoots[bar];
  battle.note("pad", root, bar * 4, 4, 0.045, -0.2);
  for (let step = 0; step < 8; step++) {
    battle.note("pluck", root + [12, 19, 24, 19, 12, 24, 19, 24][step], bar * 4 + step * 0.5, 0.3, 0.115, step % 2 ? 0.5 : -0.5);
    if (bar >= 2) battle.note("flute", warMotifs[Math.floor(bar / 4)][step] + 12, bar * 4 + step * 0.5, 0.37, 0.065, 0.15);
    if (step % 2 === 0 || bar % 4 === 3) battle.note("wood", 72, bar * 4 + step * 0.5, 0.1, 0.04, 0.65);
  }
  for (const beat of [0, 1.5, 2, 3.25]) battle.note("drum", beat === 0 || beat === 2 ? 33 : 40, bar * 4 + beat, 0.5, beat === 0 ? 0.25 : 0.16, -0.15);
  if (bar % 4 === 3) for (const beat of [3.5, 3.75]) battle.note("drum", 43, bar * 4 + beat, 0.3, 0.13, 0.2);
  if (bar % 4 === 0) battle.note("bell", 74, bar * 4, 1, 0.075, -0.4);
}
await battle.save("battle-banners");

const click = score(1200, 1);
click.note("wood", 79, 0, 0.12, 0.8, 0);
click.note("wood", 91, 0.08, 0.08, 0.2, 0);
await click.save("ui-wood", false);
