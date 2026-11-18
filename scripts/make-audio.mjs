#!/usr/bin/env node
/**
 * RoBugs audio generator. Every sound and music track in the game is
 * synthesized here from scratch (oscillators, noise, filters, a tiny
 * tracker), so all audio is original and reproducible.
 *
 *   node scripts/make-audio.mjs          # writes assets/audio/{sfx,music}
 *
 * Needs ffmpeg (with libmp3lame) for the music; sound effects are plain WAV.
 * Deterministic: seeded noise, so re-running gives the same files.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = 'assets/audio';
const SFX_RATE = 22050;
const MUSIC_RATE = 44100;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- basics

let seed = 0x5eed1;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const noise = () => rand() * 2 - 1;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** 'C#5' → MIDI number. */
function n(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
/** Attack-then-exponential-decay envelope. */
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));
/** Exponential glide from f0 to f1 over `dur`. */
const glide = (f0, f1, dur, t) => f0 * Math.pow(f1 / f0, Math.min(1, t / dur));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Zero-delay-feedback state-variable filter (always stable). Call .run(x, cutoffHz, q); read .lp/.bp/.hp. */
function svf(rate) {
  let ic1 = 0;
  let ic2 = 0;
  const s = { lp: 0, bp: 0, hp: 0 };
  s.run = (x, fc, q = 0.7) => {
    const g = Math.tan((Math.PI * clamp(fc, 20, rate * 0.45)) / rate);
    const k = 1 / Math.max(0.3, q);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    s.lp = v2;
    s.bp = v1;
    s.hp = x - k * v1 - v2;
    return s;
  };
  return s;
}
/** One-pole lowpass. */
function lp1(rate) {
  let y = 0;
  return (x, fc) => {
    const a = 1 - Math.exp((-TAU * fc) / rate);
    y += a * (x - y);
    return y;
  };
}
/** PolyBLEP band-limited saw and pulse. */
function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}
function osc(rate) {
  let ph = rand();
  return {
    saw(f) {
      const dt = f / rate;
      ph = (ph + dt) % 1;
      return 2 * ph - 1 - blep(ph, dt);
    },
    pulse(f, pw = 0.5) {
      const dt = f / rate;
      ph = (ph + dt) % 1;
      let v = ph < pw ? 1 : -1;
      v += blep(ph, dt);
      v -= blep((ph + 1 - pw) % 1, dt);
      return v;
    },
    sin(f) {
      ph = (ph + f / rate) % 1;
      return Math.sin(TAU * ph);
    },
    tri(f) {
      ph = (ph + f / rate) % 1;
      return 1 - 4 * Math.abs(ph - 0.5);
    },
  };
}

// ---------------------------------------------------------------- files

function wavBuffer(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(clamp(samples[i], -1, 1) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Scale to a peak (dBFS) with a gentle soft clip; fade the last few ms to avoid clicks. */
function master(x, peakDb = -1, fadeOut = true) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? Math.pow(10, peakDb / 20) / peak : 1;
  const fade = Math.min(x.length, 200);
  for (let i = 0; i < x.length; i++) {
    let v = x[i] * g;
    if (fadeOut && i > x.length - fade) v *= (x.length - i) / fade;
    x[i] = v;
  }
  return x;
}

const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));
const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');

// ---------------------------------------------------------------- SFX

const SFX = {};
/** Define a sound effect: `fn(t, i)` per sample, with `dur` seconds. Peak level sets loudness. */
function sfx(name, dur, peakDb, make) {
  SFX[name] = { dur, peakDb, make };
}
function renderSfx(dur, make) {
  const out = new Float32Array(Math.ceil(dur * SFX_RATE));
  const fn = make(SFX_RATE);
  for (let i = 0; i < out.length; i++) out[i] = fn(i / SFX_RATE, i);
  return out;
}
/** Inharmonic metal partials (clangs, pings). */
function metal(rate, f, ratios, decays, amps) {
  const os = ratios.map(() => osc(rate));
  return (t) => os.reduce((a, o, k) => a + o.sin(f * ratios[k]) * amps[k] * Math.exp(-t / decays[k]), 0);
}

sfx('tap', 0.06, -8, (r) => {
  const o = osc(r);
  return (t) => o.sin(glide(1900, 1100, 0.04, t)) * env(t, 0.001, 0.012) + noise() * env(t, 0.0005, 0.002) * 0.3;
});
sfx('snap', 0.16, -5, (r) => {
  const o = osc(r);
  const f = svf(r);
  const ring = metal(r, 2300, [1, 1.53], [0.04, 0.025], [0.25, 0.15]);
  return (t) => {
    const click = f.run(noise(), 3000, 2).bp * env(t, 0.0005, 0.008);
    const click2 = t > 0.035 ? noise() * env(t - 0.035, 0.0005, 0.006) * 0.5 : 0;
    return click + click2 + o.sin(glide(260, 130, 0.05, t)) * env(t, 0.002, 0.035) * 0.8 + ring(t);
  };
});
sfx('unsnap', 0.14, -7, (r) => {
  const o = osc(r);
  return (t) => o.sin(glide(240, 520, 0.08, t)) * env(t, 0.003, 0.04) * 0.8 + noise() * env(t, 0.0005, 0.005) * 0.4;
});
sfx('count', 0.2, -6, (r) => {
  const o = osc(r);
  const f = lp1(r);
  return (t) => f(o.pulse(880, 0.3), 4000) * env(t, 0.003, 0.07);
});
sfx('fight', 1.1, -1, (r) => {
  const os = [n('E3'), n('B3'), n('E4'), n('G#4'), n('B4')].map((m) => ({ o: osc(r), f: midi(m) }));
  const f = svf(r);
  const boom = osc(r);
  return (t) => {
    const horn = os.reduce((a, v) => a + v.o.saw(v.f * (1 + 0.003 * Math.sin(TAU * 5 * t))), 0) / 4;
    const cut = 400 + 3000 * Math.min(1, t / 0.12) * Math.exp(-t / 0.9);
    const amp = (t < 0.02 ? t / 0.02 : 1) * Math.exp(-Math.max(0, t - 0.5) / 0.25);
    return f.run(horn, cut, 1.2).lp * amp + boom.sin(glide(120, 40, 0.3, t)) * env(t, 0.002, 0.25) * 0.9;
  };
});
sfx('hit_light', 0.16, -6, (r) => {
  const o = osc(r);
  const f = svf(r);
  const tick = metal(r, 3100, [1, 1.7], [0.02, 0.012], [0.2, 0.12]);
  return (t) => f.run(noise(), 1600, 1.4).bp * env(t, 0.001, 0.03) + o.sin(glide(190, 90, 0.06, t)) * env(t, 0.001, 0.045) * 0.9 + tick(t);
});
sfx('hit_heavy', 0.34, -2, (r) => {
  const o = osc(r);
  const f = lp1(r);
  const clang = metal(r, 520, [1, 2.47, 4.06], [0.12, 0.08, 0.05], [0.25, 0.18, 0.1]);
  return (t) => {
    const body = o.sin(glide(130, 42, 0.12, t)) * env(t, 0.001, 0.11);
    const crunch = f(noise(), 2200) * env(t, 0.001, 0.07);
    return Math.tanh(2.2 * (body + crunch * 0.9)) + clang(t);
  };
});
sfx('hit_crit', 0.6, -1, (r) => {
  const o = osc(r);
  const z = osc(r);
  const f = lp1(r);
  const shing = metal(r, 2650, [1, 1.48, 1.97, 2.61], [0.3, 0.22, 0.16, 0.1], [0.3, 0.22, 0.16, 0.1]);
  return (t) => {
    const body = o.sin(glide(150, 40, 0.14, t)) * env(t, 0.001, 0.14);
    const crunch = f(noise(), 3000) * env(t, 0.001, 0.09);
    const zap = z.saw(glide(600, 2400, 0.08, t)) * env(t, 0.001, 0.05) * 0.25;
    return Math.tanh(2.5 * (body + crunch)) * 0.9 + shing(t) + zap;
  };
});
sfx('hit_shield', 0.4, -4, (r) => {
  const clang = metal(r, 610, [1, 2.49, 4.05, 5.9], [0.22, 0.15, 0.09, 0.05], [0.5, 0.35, 0.22, 0.12]);
  return (t) => clang(t) + noise() * env(t, 0.0005, 0.004) * 0.5;
});
sfx('break', 0.7, -2, (r) => {
  const o = osc(r);
  const f = lp1(r);
  const ticks = Array.from({ length: 7 }, (_, k) => ({ at: 0.04 + k * 0.045 + rand() * 0.03, m: metal(r, 900 + rand() * 2200, [1, 1.62, 2.3], [0.03, 0.02, 0.015], [0.4, 0.25, 0.15]) }));
  return (t) => {
    let v = Math.tanh(2 * o.sin(glide(420, 70, 0.1, t)) * env(t, 0.001, 0.08)) + f(noise(), 1800) * env(t, 0.001, 0.12) * 0.7;
    for (const k of ticks) if (t > k.at) v += k.m(t - k.at) * 0.7;
    return v;
  };
});
sfx('crash', 0.55, -2, (r) => {
  const o = osc(r);
  const f = lp1(r);
  return (t) => Math.tanh(1.8 * (o.sin(glide(95, 32, 0.2, t)) * env(t, 0.002, 0.2) + f(noise(), 700) * env(t, 0.001, 0.15)));
});
sfx('wall', 0.3, -4, (r) => {
  const o = osc(r);
  const f = lp1(r);
  return (t) => o.sin(glide(210, 105, 0.08, t)) * env(t, 0.001, 0.07) + f(noise(), 1500) * env(t, 0.0005, 0.02) * 0.6;
});
sfx('wall_spike', 0.45, -3, (r) => {
  const o = osc(r);
  const clang = metal(r, 780, [1, 2.2, 3.7], [0.15, 0.1, 0.06], [0.4, 0.3, 0.2]);
  return (t) => o.saw(1300 + 300 * Math.sin(TAU * 37 * t)) * env(t, 0.001, 0.08) * 0.35 + clang(t) + noise() * env(t, 0.0005, 0.01) * 0.4;
});
sfx('erupt', 0.8, -2, (r) => {
  const o = osc(r);
  const f = svf(r);
  return (t) => {
    const cut = 300 + 2200 * env(t, 0.05, 0.15);
    const dirt = f.run(noise(), cut, 0.8).lp * env(t, 0.03, 0.25);
    const grit = rand() < 0.02 * Math.exp(-t / 0.3) ? noise() * 0.8 : 0;
    return Math.tanh(1.5 * (dirt + o.sin(glide(70, 35, 0.4, t)) * env(t, 0.01, 0.3) * 0.8)) + grit;
  };
});
sfx('heal', 0.55, -7, (r) => {
  const notes = [n('C6'), n('E6'), n('G6'), n('C7')].map((m, k) => ({ o: osc(r), o2: osc(r), f: midi(m), at: k * 0.06 }));
  return (t) => notes.reduce((a, v) => (t < v.at ? a : a + (v.o.sin(v.f) + v.o2.sin(v.f * 1.004) * 0.6) * env(t - v.at, 0.004, 0.13) * 0.4), 0);
});
sfx('ult_charge', 1.25, -3, (r) => {
  const os = [0, 7, 12].map((s) => ({ o: osc(r), s }));
  const f = svf(r);
  const hp = svf(r);
  return (t) => {
    const base = glide(110, 880, 1.2, t);
    const trem = 0.65 + 0.35 * Math.sin(TAU * (6 + 24 * t) * t);
    const tone = os.reduce((a, v) => a + v.o.saw(base * Math.pow(2, v.s / 12)), 0) / 3;
    const hiss = hp.run(noise(), 5000).hp * 0.4;
    const amp = Math.min(1, t / 1.1) * (t > 1.15 ? Math.max(0, 1 - (t - 1.15) / 0.1) : 1);
    return (f.run(tone, 300 + 4000 * (t / 1.2), 1.5).lp + hiss) * trem * amp;
  };
});
sfx('ult_boom', 1.6, -0.5, (r) => {
  const o = osc(r);
  const f = lp1(r);
  const f2 = lp1(r);
  return (t) => {
    const body = o.sin(glide(80, 28, 0.6, t)) * env(t, 0.002, 0.5);
    const blast = f(noise(), 1600 * Math.exp(-t / 0.4) + 200) * env(t, 0.001, 0.45);
    const rumble = f2(noise(), 120) * env(t, 0.05, 0.6) * 3;
    return Math.tanh(2.2 * (body + blast + rumble));
  };
});
sfx('ko', 1.3, -1, (r) => {
  const o = osc(r);
  const b = osc(r);
  const f = lp1(r);
  return (t) =>
    Math.tanh(1.6 * (f(noise(), 1200) * env(t, 0.002, 0.35) + b.sin(glide(90, 30, 0.5, t)) * env(t, 0.002, 0.4))) +
    o.pulse(glide(700, 55, 1.0, t), 0.35) * env(t, 0.01, 0.4) * 0.3;
});
/** A short tune: [startBeat, beats, midi] at `bpm`, with a lead voice and a soft pad chord at the end. */
function jingle(r, bpm, notes, chord, chordAt, wave = 'pulse') {
  const beat = 60 / bpm;
  const vs = notes.map(([at, len, m]) => ({ o: osc(r), f: lp1(r), at: at * beat, len: len * beat, hz: midi(m) }));
  const cs = chord.map((m) => ({ o: osc(r), o2: osc(r), hz: midi(m) }));
  const cf = svf(r);
  return (t) => {
    let v = 0;
    for (const s of vs) {
      if (t < s.at || t > s.at + s.len + 0.3) continue;
      const u = t - s.at;
      const a = Math.min(1, u / 0.008) * (u > s.len ? Math.exp(-(u - s.len) / 0.06) : 0.85 + 0.15 * Math.exp(-u / 0.05));
      const vib = 1 + (u > 0.12 ? 0.004 * Math.sin(TAU * 6 * u) : 0);
      v += s.f(wave === 'pulse' ? s.o.pulse(s.hz * vib, 0.4) : s.o.saw(s.hz * vib), 3500) * a * 0.5;
    }
    if (t > chordAt * beat) {
      const u = t - chordAt * beat;
      const pad = cs.reduce((a, c) => a + c.o.saw(c.hz) + c.o2.saw(c.hz * 1.006), 0) / cs.length;
      v += cf.run(pad, 1800, 0.8).lp * Math.min(1, u / 0.05) * Math.exp(-u / 0.7) * 0.5;
    }
    return v;
  };
}
sfx('win', 2.0, -2, (r) =>
  jingle(
    r,
    168,
    [
      [0, 0.5, n('G4')],
      [0.5, 0.5, n('C5')],
      [1, 0.5, n('E5')],
      [1.5, 0.5, n('G5')],
      [2, 0.35, n('E5')],
      [2.5, 2, n('C6')],
    ],
    [n('C4'), n('G4'), n('C5'), n('E5')],
    2.5,
  ),
);
sfx('lose', 1.9, -3, (r) =>
  jingle(
    r,
    96,
    [
      [0, 0.5, n('G4')],
      [0.5, 0.5, n('F#4')],
      [1, 0.5, n('F4')],
      [1.5, 1.4, n('E4')],
    ],
    [n('A2'), n('E3'), n('C4')],
    1.5,
    'saw',
  ),
);
sfx('star', 0.45, -5, (r) => {
  const a = osc(r);
  const b = osc(r);
  const c = osc(r);
  return (t) => (a.sin(1318.5) + b.sin(2637) * 0.4 + c.sin(3955) * 0.15 * Math.exp(-t / 0.05)) * env(t, 0.002, 0.18) * 0.6;
});
sfx('reward', 0.7, -6, (r) => {
  const ns = [n('G5'), n('B5'), n('D6'), n('G6'), n('B6')].map((m, k) => ({ o: osc(r), f: midi(m), at: k * 0.045 }));
  const hp = svf(r);
  return (t) => ns.reduce((a, v) => (t < v.at ? a : a + v.o.sin(v.f) * env(t - v.at, 0.002, 0.2) * 0.35), 0) + hp.run(noise(), 6000).hp * env(t, 0.01, 0.15) * 0.15;
});
// Signature moves.
sfx('m_crush', 0.4, -2, (r) => {
  const o = osc(r);
  const f = lp1(r);
  return (t) => {
    const bite = (u) => (u > 0 ? f(noise(), 2500) * env(u, 0.001, 0.04) : 0);
    return Math.tanh(2.5 * (o.pulse(glide(90, 55, 0.3, t), 0.3) * env(t, 0.005, 0.12) * 0.6 + bite(t) + bite(t - 0.11)));
  };
});
sfx('m_venom', 0.55, -3, (r) => {
  const o = osc(r);
  const f = svf(r);
  return (t) => {
    const bub = o.sin(glide(280, 950, 0.12, t % 0.13) * (1 + 0.1 * Math.sin(TAU * 40 * t))) * env(t % 0.13, 0.004, 0.04) * 0.6;
    const spray = f.run(noise(), glide(700, 2600, 0.3, t), 2).bp * env(t, 0.01, 0.15);
    return (bub + spray) * Math.exp(-t / 0.3);
  };
});
sfx('m_lock', 0.5, -3, (r) => {
  const o = osc(r);
  const f = lp1(r);
  const clang = metal(r, 440, [1, 2.4, 3.9], [0.16, 0.1, 0.07], [0.5, 0.35, 0.2]);
  return (t) => (t < 0.18 ? f(o.pulse(glide(180, 420, 0.18, t), 0.25), 1500) * 0.35 : 0) + (t > 0.18 ? clang(t - 0.18) + noise() * env(t - 0.18, 0.0005, 0.006) * 0.4 : 0);
});
sfx('m_dash', 0.4, -4, (r) => {
  const f = svf(r);
  return (t) => f.run(noise(), glide(500, 3500, 0.3, t), 1.5).bp * Math.sin(Math.PI * Math.min(1, t / 0.38)) * 1.2;
});
sfx('m_web', 0.45, -4, (r) => {
  const o = osc(r);
  // Karplus–Strong twang.
  const len = Math.round(r / 330);
  const ks = Float32Array.from({ length: len }, () => noise());
  let k = 0;
  return (t) => {
    const thwip = o.sin(glide(2400, 260, 0.09, t)) * env(t, 0.001, 0.05);
    let tw = 0;
    if (t > 0.05) {
      const a = ks[k % len];
      const b = ks[(k + 1) % len];
      ks[k % len] = 0.5 * (a + b) * 0.994;
      tw = a * 0.5;
      k++;
    }
    return thwip + tw + noise() * env(t, 0.0005, 0.01) * 0.3;
  };
});
sfx('m_burrow', 0.85, -3, (r) => {
  const f = lp1(r);
  const o = osc(r);
  return (t) => {
    const scrape = f(noise(), 350) * 3 * (0.6 + 0.4 * Math.sin(TAU * 11 * t));
    const crunch = rand() < 0.012 ? noise() * 0.7 : 0;
    return Math.tanh(1.5 * (scrape + o.sin(glide(110, 45, 0.7, t)) * 0.4)) * env(t, 0.03, 0.4) + crunch * Math.exp(-t / 0.5);
  };
});
sfx('m_ghost', 1.0, -6, (r) => {
  const os = [1, 1.007, 1.5, 2.003].map((m) => ({ o: osc(r), m }));
  const hp = svf(r);
  return (t) => {
    const base = glide(1250, 520, 0.9, t) * (1 + 0.01 * Math.sin(TAU * 7 * t));
    const tone = os.reduce((a, v) => a + v.o.sin(base * v.m), 0) / os.length;
    return (tone + hp.run(noise(), 4000).hp * 0.3) * Math.sin(Math.PI * Math.min(1, t / 0.98));
  };
});
sfx('m_beam', 1.1, -3, (r) => {
  const a = osc(r);
  const b = osc(r);
  const f = svf(r);
  return (t) => {
    const hz = glide(200, 320, 1, t) * (1 + 0.02 * Math.sin(TAU * 31 * t));
    const tone = a.saw(hz) * 0.6 + b.pulse(hz * 2.003, 0.25) * 0.4;
    const amp = Math.min(1, t / 0.08) * (t > 0.95 ? Math.max(0, 1 - (t - 0.95) / 0.12) : 1);
    return f.run(tone, 1800 + 1200 * Math.sin(TAU * 3 * t), 2.5).lp * amp + noise() * env(t, 0.001, 0.03) * 0.5;
  };
});
sfx('m_static', 0.65, -3, (r) => {
  const f = svf(r);
  const o = osc(r);
  return (t) => {
    const spark = rand() < 0.08 ? noise() : 0;
    const buzz = o.pulse(110, 0.1) * (0.5 + 0.5 * Math.sign(Math.sin(TAU * 17 * t)));
    return (f.run(spark, 3200, 1.5).bp * 2 + buzz * 0.25) * env(t, 0.005, 0.25);
  };
});
sfx('m_overclock', 0.85, -3, (r) => {
  const o = osc(r);
  const d = osc(r);
  return (t) => {
    const rev = o.saw(glide(70, 420, 0.7, t)) * (0.7 + 0.3 * Math.sin(TAU * (8 + 30 * t) * t));
    const ding = t > 0.7 ? d.sin(1760) * env(t - 0.7, 0.002, 0.08) * 0.6 : 0;
    return Math.tanh(1.8 * rev) * 0.6 * (t < 0.72 ? Math.min(1, t / 0.05) : Math.exp(-(t - 0.72) / 0.05)) + ding;
  };
});
sfx('m_gale', 0.75, -4, (r) => {
  const f = svf(r);
  return (t) => f.run(noise(), 500 + 700 * Math.sin(Math.PI * t / 0.75), 1.2).bp * (0.55 + 0.45 * Math.sin(TAU * 18 * t)) * Math.sin(Math.PI * Math.min(1, t / 0.74)) * 1.5;
});
sfx('m_siphon', 0.75, -4, (r) => {
  const o = osc(r);
  const f = lp1(r);
  return (t) => {
    const slurp = o.sin(300 + 180 * Math.sin(TAU * 3 * t) + 120 * Math.sin(TAU * 13 * t)) * 0.6;
    const gurgle = f(noise(), 500) * (0.5 + 0.5 * Math.sin(TAU * 12 * t)) * 2;
    return (slurp + gurgle) * Math.sin(Math.PI * Math.min(1, t / 0.74));
  };
});

// ---------------------------------------------------------------- music

/**
 * A tiny tracker. A song is `bars` bars of 16 steps. Instruments write into
 * named stems; the mix adds reverb/echo sends, then the tail past the loop
 * end is wrapped onto the start so the track loops seamlessly.
 */
function makeSong({ bpm, bars, swing = 0 }) {
  const r = MUSIC_RATE;
  const step = 60 / bpm / 4;
  const len = Math.round(bars * 16 * step * r);
  const tail = 3 * r;
  const stems = {};
  const sends = { rev: new Float32Array(len + tail), dly: new Float32Array(len + tail) };
  const stem = (name) => (stems[name] ??= new Float32Array(len + tail));
  /** Start time (s) of a step, with swing on the off 16ths. */
  const at = (bar, s) => (bar * 16 + s + (s % 2 === 1 ? swing : 0)) * step;
  /** Render `fn(t)` for `dur` seconds into a stem (+ sends) from time `t0`. */
  function put(name, t0, dur, fn, { gain = 1, rev = 0, dly = 0 } = {}) {
    const out = stem(name);
    const i0 = Math.round(t0 * r);
    const nS = Math.round(dur * r);
    for (let i = 0; i < nS; i++) {
      const j = i0 + i;
      if (j >= out.length) break;
      const v = fn(i / r) * gain;
      out[j] += v;
      if (rev) sends.rev[j] += v * rev;
      if (dly) sends.dly[j] += v * dly;
    }
  }
  return { r, step, len, tail, stems, sends, at, put, bars };
}

// Instruments: each returns (t) => sample for one note.
const I = {
  kick: (r, vel = 1) => {
    const o = osc(r);
    return (t) => Math.tanh(1.6 * (o.sin(44 + 115 * Math.exp(-t / 0.028)) * Math.exp(-t / 0.13) + noise() * Math.exp(-t / 0.003) * 0.25)) * vel;
  },
  snare: (r, vel = 1) => {
    const o = osc(r);
    const h = svf(r);
    return (t) => (o.sin(190 * (1 + 0.3 * Math.exp(-t / 0.01))) * Math.exp(-t / 0.045) * 0.55 + h.run(noise(), 1500).hp * Math.exp(-t / 0.085)) * vel;
  },
  clap: (r, vel = 1) => {
    const f = svf(r);
    return (t) => {
      const e = Math.max(...[0, 0.009, 0.018].map((d) => (t >= d ? Math.exp(-(t - d) / (d === 0.018 ? 0.07 : 0.006)) : 0)));
      return f.run(noise(), 1300, 1.2).bp * e * 1.6 * vel;
    };
  },
  hat: (r, vel = 1, open = false) => {
    const a = svf(r);
    const b = svf(r);
    return (t) => b.run(a.run(noise(), 7000).hp, 8000).hp * Math.exp(-t / (open ? 0.14 : 0.022)) * vel;
  },
  tom: (r, hz, vel = 1) => {
    const o = osc(r);
    return (t) => o.sin(hz * (1 + 0.6 * Math.exp(-t / 0.02))) * Math.exp(-t / 0.16) * vel;
  },
  anvil: (r, hz, vel = 1) => metal(r, hz, [1, 2.76, 5.4, 8.93], [0.14, 0.08, 0.05, 0.03], [0.6 * vel, 0.3 * vel, 0.18 * vel, 0.1 * vel]),
  shaker: (r, vel = 1) => {
    const f = svf(r);
    return (t) => f.run(noise(), 5500, 1).bp * env(t, 0.008, 0.035) * vel;
  },
  /** Saw/pulse bass through an enveloped resonant lowpass. */
  bass: (r, hz, dur, { wave = 'saw', cut = 300, envAmt = 1400, decay = 0.12, q = 1.6, drive = 1.4 } = {}) => {
    const o = osc(r);
    const o2 = osc(r);
    const f = svf(r);
    return (t) => {
      const raw = wave === 'saw' ? o.saw(hz) * 0.7 + o2.saw(hz * 0.5) * 0.4 : o.pulse(hz, 0.5) * 0.7 + o2.sin(hz * 0.5) * 0.5;
      const amp = Math.min(1, t / 0.004) * (t > dur ? Math.exp(-(t - dur) / 0.03) : 1);
      return Math.tanh(drive * f.run(raw, cut + envAmt * Math.exp(-t / decay), q).lp) * amp;
    };
  },
  /** Plucked bass/guitar (Karplus–Strong). */
  pluck: (r, hz, dur, bright = 0.5) => {
    const len = Math.max(2, Math.round(r / hz));
    const f = lp1(r);
    const buf = Float32Array.from({ length: len }, () => f(noise(), 600 + 6000 * bright));
    let k = 0;
    return (t) => {
      const a = buf[k % len];
      const b = buf[(k + 1) % len];
      buf[k % len] = 0.5 * (a + b) * (t > dur ? 0.97 : 0.9985);
      k++;
      return a;
    };
  },
  lead: (r, hz, dur, { wave = 'pulse', pw = 0.4, cut = 3200, vib = 0.005, attack = 0.01, release = 0.09, drive = 1 } = {}) => {
    const o = osc(r);
    const o2 = osc(r);
    const f = svf(r);
    return (t) => {
      const v = 1 + (t > 0.14 ? vib * Math.sin(TAU * 5.6 * t) : 0);
      const raw = wave === 'pulse' ? o.pulse(hz * v, pw) : o.saw(hz * v) * 0.7 + o2.saw(hz * v * 1.005) * 0.5;
      const amp = Math.min(1, t / attack) * (0.75 + 0.25 * Math.exp(-t / 0.08)) * (t > dur ? Math.exp(-(t - dur) / release) : 1);
      return Math.tanh(drive * f.run(raw, cut, 0.9).lp) * amp;
    };
  },
  /** FM electric piano. */
  keys: (r, hz, dur) => {
    let pc = rand();
    let pm = rand();
    const tine = osc(r);
    return (t) => {
      pm = (pm + hz / r) % 1;
      const idx = 1.4 * Math.exp(-t / 0.25) + 0.25;
      pc = (pc + hz / r) % 1;
      const amp = Math.min(1, t / 0.003) * Math.exp(-t / 1.4) * (t > dur ? Math.exp(-(t - dur) / 0.12) : 1);
      return (Math.sin(TAU * pc + idx * Math.sin(TAU * pm)) + tine.sin(hz * 14) * 0.08 * Math.exp(-t / 0.02)) * amp;
    };
  },
  marimba: (r, hz, dur) => {
    const a = osc(r);
    const b = osc(r);
    return (t) => (a.sin(hz) + b.sin(hz * 3.93) * 0.25 * Math.exp(-t / 0.025)) * env(t, 0.002, 0.28) * (t > dur + 0.2 ? Math.exp(-(t - dur - 0.2) / 0.05) : 1);
  },
  /** Detuned saw pad; `vowel` adds formant filtering (choir-ish). */
  pad: (r, hz, dur, { cut = 1400, attack = 0.35, release = 0.6, vowel = false } = {}) => {
    const os = [0.994, 1, 1.006].map((d) => ({ o: osc(r), d }));
    const f = svf(r);
    const f1 = svf(r);
    const f2 = svf(r);
    return (t) => {
      const raw = os.reduce((a, v) => a + v.o.saw(hz * v.d), 0) / 3;
      const amp = Math.min(1, t / attack) * (t > dur ? Math.exp(-(t - dur) / release) : 1);
      const s = vowel ? f1.run(raw, 720, 4).bp * 1.6 + f2.run(raw, 1150, 5).bp * 1.1 : f.run(raw, cut, 0.8).lp;
      return s * amp;
    };
  },
  arp: (r, hz, dur, cut = 2600) => {
    const o = osc(r);
    const f = lp1(r);
    return (t) => f(o.pulse(hz, 0.25), cut) * env(t, 0.002, 0.07) * (t > dur ? Math.exp(-(t - dur) / 0.02) : 1);
  },
};

/** Reverb (Freeverb-style mono) and a filtered echo, then wrap and master. */
function mixSong(song, gains, { revWet = 0.22, delaySteps = 3, fb = 0.35 } = {}) {
  const { r, len, tail, stems, sends } = song;
  const total = len + tail;
  const mix = new Float32Array(total);
  const report = [];
  for (const [name, buf] of Object.entries(stems)) {
    const g = gains[name] ?? 1;
    for (let i = 0; i < total; i++) mix[i] += buf[i] * g;
    report.push(`${name} ${db(rms(buf.subarray(0, len)) * g)}`);
  }
  // Echo.
  const d = Math.round(delaySteps * song.step * r);
  const echo = new Float32Array(total);
  const elp = lp1(r);
  for (let i = 0; i < total; i++) {
    const back = i >= d ? echo[i - d] : 0;
    echo[i] = sends.dly[i] + elp(back, 2800) * fb;
  }
  // Reverb.
  const combs = [1116, 1188, 1277, 1356].map((L) => ({ buf: new Float32Array(L), i: 0, z: 0 }));
  const aps = [556, 441].map((L) => ({ buf: new Float32Array(L), i: 0 }));
  const wet = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const x = sends.rev[i] * 0.3;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.z = o * 0.75 + c.z * 0.25;
      c.buf[c.i] = x + c.z * 0.82;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    for (const a of aps) {
      const o = a.buf[a.i];
      a.buf[a.i] = y + o * 0.5;
      y = o - y * 0.5;
      a.i = (a.i + 1) % a.buf.length;
    }
    wet[i] = y;
  }
  for (let i = 0; i < total; i++) mix[i] += echo[i] * 0.6 + wet[i] * revWet * 4;
  // Wrap the tail onto the start: the loop sounds like it never stopped.
  const out = mix.slice(0, len);
  for (let i = len; i < total; i++) out[i - len] += mix[i];
  // Glue: soft-knee saturation, then normalize.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < len; i++) out[i] = Math.tanh((out[i] / peak) * 1.4) / Math.tanh(1.4);
  master(out, -1.2, false);
  return { out, report };
}

/** Chord tones → MIDI arrays. */
const CH = {
  m: [0, 3, 7],
  M: [0, 4, 7],
  m7: [0, 3, 7, 10],
  M7: [0, 4, 7, 11],
  '7': [0, 4, 7, 10],
  m9: [0, 3, 7, 10, 14],
  '6': [0, 4, 7, 9],
};
const chord = (root, kind) => CH[kind].map((s) => n(root) + s);
/** Melody line helper: [bar, step, steps, note] items. */
function melody(song, inst, items, opts) {
  for (const [bar, s, steps, note] of items) {
    const hz = midi(typeof note === 'number' ? note : n(note));
    const dur = steps * song.step;
    song.put(inst.stem, song.at(bar, s), dur + 0.6, inst.make(song.r, hz, dur), opts);
  }
}
const at8 = (fn) => [0, 2, 4, 6, 8, 10, 12, 14].forEach(fn);
const shift = (items, bars, semis = 0) => items.map(([b, s, l, m]) => [b + bars, s, l, typeof m === 'number' ? m + semis : n(m) + semis]);

// ---- Track: hub (menu). Mellow funky A minor, 96 BPM.
function songHub() {
  const s = makeSong({ bpm: 96, bars: 16, swing: 0.18 });
  const prog = [chord('A3', 'm9'), chord('F3', 'M7'), chord('C4', 'M7'), chord('G3', '6')];
  for (let bar = 0; bar < 16; bar++) {
    const c = prog[bar % 4];
    const root = c[0] - 12;
    // Keys: syncopated comping.
    for (const [st, l] of [
      [0, 3],
      [6, 2],
      [11, 4],
    ])
      for (const m of c.slice(0, 4)) s.put('keys', s.at(bar, st), l * s.step + 1, I.keys(s.r, midi(m), l * s.step), { gain: 0.16, rev: 0.4 });
    // Drums (from bar 2).
    if (bar >= 2) {
      for (const st of [0, 7, 10]) s.put('drums', s.at(bar, st), 0.35, I.kick(s.r, st === 7 ? 0.7 : 1));
      for (const st of [4, 12]) s.put('drums', s.at(bar, st), 0.3, I.snare(s.r, 0.7), { rev: 0.25 });
      at8((st) => s.put('drums', s.at(bar, st), 0.1, I.hat(s.r, st % 4 === 2 ? 0.55 : 0.35)));
      if (bar % 4 === 3) s.put('drums', s.at(bar, 14), 0.25, I.hat(s.r, 0.4, true));
    }
    // Bass (from bar 4).
    if (bar >= 4)
      for (const [st, l, iv] of [
        [0, 3, 0],
        [3, 1, 12],
        [6, 2, 0],
        [10, 2, 7],
        [14, 2, 10],
      ])
        s.put('bass', s.at(bar, st), l * s.step + 0.1, I.bass(s.r, midi(root + iv), l * s.step * 0.9, { wave: 'pulse', cut: 220, envAmt: 700, q: 1.2 }));
    // Arp sparkle on the intro and last phrase.
    if (bar < 4 || bar >= 12) for (let st = 0; st < 16; st += 2) s.put('arp', s.at(bar, st), 0.3, I.arp(s.r, midi(c[(st / 2) % c.length] + 12), s.step, 2200), { rev: 0.3, dly: 0.3 });
  }
  const A = [
    [0, 0, 3, 'E5'], [0, 3, 3, 'G5'], [0, 6, 4, 'A5'], [0, 10, 2, 'G5'], [0, 12, 4, 'E5'],
    [1, 0, 6, 'C5'], [1, 6, 2, 'D5'], [1, 8, 8, 'E5'],
    [2, 0, 3, 'G5'], [2, 3, 3, 'E5'], [2, 6, 2, 'D5'], [2, 8, 4, 'C5'], [2, 12, 4, 'D5'],
    [3, 0, 8, 'B4'], [3, 10, 2, 'D5'], [3, 12, 4, 'E5'],
  ];
  const B = [
    [0, 0, 4, 'A5'], [0, 4, 2, 'C6'], [0, 6, 2, 'B5'], [0, 8, 4, 'A5'], [0, 12, 4, 'G5'],
    [1, 0, 6, 'A5'], [1, 6, 2, 'E5'], [1, 8, 8, 'F5'],
    [2, 0, 3, 'E5'], [2, 3, 3, 'G5'], [2, 6, 6, 'C6'], [2, 12, 2, 'B5'], [2, 14, 2, 'A5'],
    [3, 0, 4, 'G5'], [3, 4, 4, 'D5'], [3, 8, 8, 'B4'],
  ];
  const lead = { stem: 'lead', make: (r, hz, d) => I.lead(r, hz, d, { pw: 0.5, cut: 2400, vib: 0.006, attack: 0.02 }) };
  melody(s, lead, [...shift(A, 4), ...shift(B, 8), ...shift(A, 12)], { rev: 0.35, dly: 0.25 });
  return mixSong(s, { keys: 1, drums: 0.97, bass: 0.37, arp: 0.26, lead: 0.45 });
}

// ---- Track: garage. Workshop groove in D dorian, 112 BPM, clanky percussion.
function songGarage() {
  const s = makeSong({ bpm: 112, bars: 16, swing: 0.12 });
  const prog = [chord('D3', 'm7'), chord('G3', '7'), chord('D3', 'm7'), chord('A3', 'm7'), chord('Bb3', 'M7'), chord('C4', 'M'), chord('D3', 'm7'), chord('D3', 'm7')];
  for (let bar = 0; bar < 16; bar++) {
    const c = prog[bar % 8];
    const root = c[0] - 12;
    for (const st of [0, 6, 8, 11]) s.put('drums', s.at(bar, st), 0.35, I.kick(s.r, st === 0 || st === 8 ? 1 : 0.6));
    for (const st of [4, 12]) s.put('drums', s.at(bar, st), 0.3, I.clap(s.r, 0.8), { rev: 0.2 });
    for (let st = 0; st < 16; st++) s.put('perc', s.at(bar, st), 0.08, I.shaker(s.r, st % 2 ? 0.5 : 0.3));
    // Anvil pings on the offbeats: the "workshop" sound.
    for (const st of [2, 7, 10, 15]) s.put('perc', s.at(bar, st), 0.3, I.anvil(s.r, st === 7 ? 1180 : 1560, st === 15 ? 0.5 : 0.8), { rev: 0.3 });
    if (bar % 4 === 3) for (const [st, hz] of [[12, 180], [13, 150], [14, 120], [15, 100]]) s.put('drums', s.at(bar, st), 0.3, I.tom(s.r, hz, 0.7));
    // Plucked bass groove.
    for (const [st, l, iv] of [[0, 2, 0], [2, 1, 0], [3, 2, 12], [6, 2, 7], [8, 2, 0], [11, 2, 10], [13, 1, 12], [14, 2, 7]])
      s.put('bass', s.at(bar, st), l * s.step + 0.4, I.pluck(s.r, midi(root + iv), l * s.step, 0.35));
    // Keys stabs.
    for (const st of [2, 10]) for (const m of c) s.put('keys', s.at(bar, st), 0.8, I.keys(s.r, midi(m + 12), s.step * 1.5), { gain: 0.12, rev: 0.3 });
  }
  const M = [
    [0, 0, 2, 'D5'], [0, 2, 2, 'F5'], [0, 4, 2, 'A5'], [0, 6, 2, 'G5'], [0, 8, 4, 'F5'], [0, 12, 2, 'E5'], [0, 14, 2, 'D5'],
    [1, 0, 3, 'B4'], [1, 3, 3, 'D5'], [1, 6, 2, 'F5'], [1, 8, 6, 'E5'],
    [2, 0, 2, 'D5'], [2, 2, 2, 'F5'], [2, 4, 2, 'A5'], [2, 6, 2, 'C6'], [2, 8, 4, 'B5'], [2, 12, 4, 'A5'],
    [3, 0, 6, 'G5'], [3, 6, 2, 'E5'], [3, 8, 8, 'C5'],
    [4, 0, 3, 'D5'], [4, 3, 3, 'F5'], [4, 6, 4, 'A5'], [4, 10, 2, 'G5'], [4, 12, 4, 'F5'],
    [5, 0, 4, 'E5'], [5, 4, 4, 'G5'], [5, 8, 4, 'C6'], [5, 12, 4, 'B5'],
    [6, 0, 6, 'A5'], [6, 8, 2, 'G5'], [6, 10, 2, 'F5'], [6, 12, 4, 'E5'],
    [7, 0, 12, 'D5'],
  ];
  const mar = { stem: 'lead', make: (r, hz, d) => I.marimba(r, hz, d) };
  melody(s, mar, [...shift(M, 0), ...shift(M, 8)], { rev: 0.3, dly: 0.2 });
  // Second time round, an octave-up echo on the off-beat.
  melody(s, mar, shift(M, 8, 12).map(([b, st, l, m]) => [b, st + 1 > 15 ? st : st + 1, l, m]), { gain: 0.3, rev: 0.4 });
  return mixSong(s, { drums: 0.8, perc: 0.6, bass: 0.9, keys: 1.5, lead: 0.55 }, { delaySteps: 3, fb: 0.3 });
}

// ---- Track: battle. Driving E minor, 140 BPM.
function songBattle() {
  const s = makeSong({ bpm: 140, bars: 16 });
  const A = [chord('E3', 'm'), chord('C3', 'M'), chord('D3', 'M'), chord('B2', 'M')];
  const B = [chord('C3', 'M'), chord('D3', 'M'), chord('E3', 'm'), chord('E3', 'm'), chord('C3', 'M'), chord('D3', 'M'), chord('B2', 'M'), chord('B2', 'M')];
  const prog = [...A, ...A, ...B];
  for (let bar = 0; bar < 16; bar++) {
    const c = prog[bar];
    const root = c[0] - 12;
    const fill = bar === 15;
    for (const st of [0, 4, 8, 12]) if (!(fill && st >= 8)) s.put('drums', s.at(bar, st), 0.35, I.kick(s.r));
    for (const st of [4, 12]) if (!(fill && st === 12)) s.put('drums', s.at(bar, st), 0.3, I.snare(s.r), { rev: 0.2 });
    for (let st = 0; st < 16; st++) if (!(fill && st >= 8)) s.put('hats', s.at(bar, st), 0.1, I.hat(s.r, st % 4 === 2 ? 0.7 : st % 2 ? 0.3 : 0.45));
    if (fill) for (let st = 8; st < 16; st++) s.put('drums', s.at(bar, st), 0.25, st < 12 ? I.snare(s.r, 0.4 + st * 0.03) : I.tom(s.r, [200, 170, 140, 110][st - 12], 0.9));
    if (bar % 8 === 0) s.put('drums', s.at(bar, 0), 0.5, I.hat(s.r, 0.8, true), { rev: 0.4 });
    // Pumping octave bass.
    for (let st = 0; st < 16; st += 2) s.put('bass', s.at(bar, st), s.step * 2 + 0.05, I.bass(s.r, midi(root + (st % 4 === 2 ? 12 : 0)), s.step * 1.6, { cut: 260, envAmt: 1800, decay: 0.09, drive: 1.8 }));
    // 16th arps of the chord.
    for (let st = 0; st < 16; st++) {
      const tones = [c[0], c[1], c[2], c[0] + 12];
      s.put('arp', s.at(bar, st), 0.2, I.arp(s.r, midi(tones[st % 4] + 24), s.step * 0.7, 3200), { dly: 0.15 });
    }
    // Power-chord pad under section B.
    if (bar >= 8) for (const m of [c[0] + 12, c[2] + 12, c[0] + 24]) s.put('pad', s.at(bar, 0), 16 * s.step + 0.6, I.pad(s.r, midi(m), 16 * s.step, { cut: 1600, attack: 0.05, release: 0.2 }), { rev: 0.3 });
  }
  const LA = [
    [0, 0, 2, 'E5'], [0, 2, 2, 'G5'], [0, 4, 4, 'B5'], [0, 8, 2, 'A5'], [0, 10, 2, 'G5'], [0, 12, 4, 'F#5'],
    [1, 0, 4, 'G5'], [1, 4, 4, 'E5'], [1, 8, 4, 'C5'], [1, 12, 4, 'E5'],
    [2, 0, 2, 'F#5'], [2, 2, 2, 'A5'], [2, 4, 6, 'D6'], [2, 10, 2, 'C6'], [2, 12, 2, 'B5'], [2, 14, 2, 'A5'],
    [3, 0, 8, 'B5'], [3, 8, 4, 'D#5'], [3, 12, 4, 'F#5'],
  ];
  const LA2 = [...LA.slice(0, 16), [3, 0, 4, 'B5'], [3, 4, 2, 'A5'], [3, 6, 2, 'G5'], [3, 8, 8, 'F#5']];
  const LB = [
    [0, 0, 6, 'E6'], [0, 6, 2, 'D6'], [0, 8, 4, 'C6'], [0, 12, 4, 'B5'],
    [1, 0, 6, 'A5'], [1, 6, 2, 'B5'], [1, 8, 4, 'C6'], [1, 12, 4, 'D6'],
    [2, 0, 12, 'B5'], [2, 12, 2, 'G5'], [2, 14, 2, 'A5'],
    [3, 0, 4, 'B5'], [3, 4, 4, 'E6'], [3, 8, 4, 'D6'], [3, 12, 4, 'B5'],
    [4, 0, 4, 'C6'], [4, 4, 4, 'B5'], [4, 8, 4, 'G5'], [4, 12, 4, 'E5'],
    [5, 0, 4, 'F#5'], [5, 4, 4, 'G5'], [5, 8, 4, 'A5'], [5, 12, 4, 'D6'],
    [6, 0, 14, 'D#6'],
  ];
  const lead = { stem: 'lead', make: (r, hz, d) => I.lead(r, hz, d, { wave: 'saw', cut: 3800, vib: 0.006, drive: 1.3 }) };
  melody(s, lead, [...shift(LA, 0), ...shift(LA2, 4), ...shift(LB, 8)], { rev: 0.25, dly: 0.25 });
  // Harmony a sixth below on the B section.
  melody(s, { stem: 'lead2', make: (r, hz, d) => I.lead(r, hz, d, { pw: 0.3, cut: 2600 }) }, shift(LB, 8, -8), { rev: 0.3 });
  return mixSong(s, { drums: 0.74, hats: 1.1, bass: 0.36, arp: 0.125, pad: 0.23, lead: 0.6, lead2: 0.24 }, { delaySteps: 3, fb: 0.3, revWet: 0.18 });
}

// ---- Track: boss. Heavy C minor with a phrygian edge, 150 BPM.
function songBoss() {
  const s = makeSong({ bpm: 150, bars: 16 });
  const A = [chord('C3', 'm'), chord('Db3', 'M'), chord('C3', 'm'), chord('Bb2', 'M')];
  const B = [chord('Ab2', 'M'), chord('Bb2', 'M'), chord('C3', 'm'), chord('G2', 'M')];
  const prog = [...A, ...A, ...B, ...B];
  for (let bar = 0; bar < 16; bar++) {
    const c = prog[bar];
    const root = c[0] - 12;
    // Gallop: x.xx x.xx …
    const gallop = [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15];
    for (const st of [0, 3, 8, 11]) s.put('drums', s.at(bar, st), 0.35, I.kick(s.r));
    for (const st of [4, 12]) s.put('drums', s.at(bar, st), 0.3, I.snare(s.r), { rev: 0.3 });
    at8((st) => s.put('hats', s.at(bar, st), 0.1, I.hat(s.r, 0.5)));
    if (bar % 4 === 3) for (const [st, hz] of [[12, 160], [13, 130], [14, 105], [15, 85]]) s.put('drums', s.at(bar, st), 0.3, I.tom(s.r, hz));
    for (const st of gallop)
      s.put('bass', s.at(bar, st), s.step + 0.05, I.bass(s.r, midi(root), s.step * 0.8, { cut: 180, envAmt: 2200, decay: 0.06, q: 2, drive: 3 }));
    // Choir.
    for (const m of [c[0] + 12, c[1] + 12, c[2] + 12]) s.put('choir', s.at(bar, 0), 16 * s.step + 0.8, I.pad(s.r, midi(m), 16 * s.step, { vowel: true, attack: 0.25, release: 0.5 }), { rev: 0.5 });
    // Bell toll on the downbeat of each phrase.
    if (bar % 4 === 0) s.put('bell', s.at(bar, 0), 2, I.anvil(s.r, midi(n('C6')), 1), { rev: 0.6 });
  }
  const P1 = [
    [0, 0, 6, 'C5'], [0, 6, 2, 'Db5'], [0, 8, 4, 'C5'], [0, 12, 4, 'G4'],
    [1, 0, 6, 'Ab4'], [1, 6, 2, 'Bb4'], [1, 8, 8, 'C5'],
    [2, 0, 4, 'Eb5'], [2, 4, 2, 'D5'], [2, 6, 2, 'C5'], [2, 8, 4, 'B4'], [2, 12, 4, 'C5'],
    [3, 0, 8, 'D5'], [3, 8, 4, 'F5'], [3, 12, 4, 'D5'],
  ];
  const P2 = [
    [0, 0, 6, 'Eb5'], [0, 6, 2, 'C5'], [0, 8, 8, 'Ab4'],
    [1, 0, 6, 'F5'], [1, 6, 2, 'D5'], [1, 8, 8, 'Bb4'],
    [2, 0, 4, 'G5'], [2, 4, 4, 'Eb5'], [2, 8, 4, 'C5'], [2, 12, 4, 'Eb5'],
    [3, 0, 4, 'D5'], [3, 4, 4, 'F5'], [3, 8, 8, 'B4'],
  ];
  const lead = { stem: 'lead', make: (r, hz, d) => I.lead(r, hz, d, { pw: 0.35, cut: 3000, vib: 0.008, drive: 2 }) };
  melody(s, lead, [...shift(P1, 4), ...shift(P2, 8), ...shift(P2, 12, 12)], { rev: 0.3, dly: 0.2 });
  melody(s, { stem: 'lead2', make: (r, hz, d) => I.lead(r, hz, d, { wave: 'saw', cut: 2000 }) }, shift(P2, 12), { rev: 0.3 });
  return mixSong(s, { drums: 0.67, hats: 1.1, bass: 0.34, choir: 0.068, bell: 1.05, lead: 0.35, lead2: 0.6 }, { delaySteps: 3, fb: 0.25, revWet: 0.2 });
}

// ---------------------------------------------------------------- write

mkdirSync(join(OUT, 'sfx'), { recursive: true });
mkdirSync(join(OUT, 'music'), { recursive: true });

for (const [name, def] of Object.entries(SFX)) {
  const x = master(renderSfx(def.dur, def.make), def.peakDb);
  writeFileSync(join(OUT, 'sfx', `${name}.wav`), wavBuffer(x, SFX_RATE));
  console.log(`sfx   ${name.padEnd(12)} ${def.dur.toFixed(2)}s rms ${db(rms(x))} dB`);
}

const tmp = mkdtempSync(join(tmpdir(), 'robugs-audio-'));
for (const [name, fn] of Object.entries({ hub: songHub, garage: songGarage, battle: songBattle, boss: songBoss })) {
  const { out, report } = fn();
  const wavPath = join(tmp, `${name}.wav`);
  writeFileSync(wavPath, wavBuffer(out, MUSIC_RATE));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '96k', join(OUT, 'music', `${name}.mp3`)]);
  console.log(`music ${name.padEnd(8)} ${(out.length / MUSIC_RATE).toFixed(1)}s rms ${db(rms(out))} dB | ${report.join(', ')}`);
}
rmSync(tmp, { recursive: true, force: true });
