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
const SFX_LATE = {};
function sfxLate(name, dur, peakDb, make) {
  SFX_LATE[name] = { dur, peakDb, make };
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

// Footwork: dodges, misses, clashes, staggers. (Added after the first set: these render
// after the music, so the seeded noise of everything defined earlier stays byte-identical.)
sfxLate('dash', 0.24, -7, (r) => {
  const f = svf(r);
  return (t) => f.run(noise(), glide(900, 4200, 0.18, t), 1.8).bp * Math.sin(Math.PI * Math.min(1, t / 0.23)) * 1.3;
});
sfxLate('whiff', 0.14, -10, (r) => {
  const f = svf(r);
  return (t) => f.run(noise(), glide(5200, 2200, 0.12, t), 2.5).bp * Math.sin(Math.PI * Math.min(1, t / 0.13));
});
sfxLate('clash', 0.75, -1, (r) => {
  const ring = metal(r, 1240, [1, 1.51, 2.37, 3.42, 4.9], [0.45, 0.34, 0.24, 0.15, 0.08], [0.5, 0.4, 0.3, 0.2, 0.12]);
  const ring2 = metal(r, 1675, [1, 2.09, 3.3], [0.3, 0.2, 0.1], [0.35, 0.22, 0.12]);
  const o = osc(r);
  return (t) => ring(t) + ring2(t) + noise() * env(t, 0.0005, 0.006) * 0.9 + o.sin(glide(180, 70, 0.08, t)) * env(t, 0.001, 0.06) * 0.7;
});
sfxLate('counter', 0.4, -3, (r) => {
  const shing = metal(r, 3100, [1, 1.34, 1.82, 2.47], [0.22, 0.17, 0.12, 0.08], [0.4, 0.3, 0.2, 0.12]);
  const z = osc(r);
  return (t) => shing(t) + z.saw(glide(900, 3200, 0.06, t)) * env(t, 0.001, 0.035) * 0.3 + noise() * env(t, 0.0005, 0.004) * 0.5;
});
sfxLate('stagger', 0.6, -4, (r) => {
  const a = osc(r);
  const b = osc(r);
  const thud = osc(r);
  return (t) => {
    const wob = glide(880, 330, 0.5, t) * (1 + 0.06 * Math.sin(TAU * 11 * t));
    return (a.sin(wob) + b.sin(wob * 1.5) * 0.4) * env(t, 0.004, 0.2) * 0.6 + thud.sin(glide(140, 55, 0.1, t)) * env(t, 0.001, 0.07) * 0.9;
  };
});
sfxLate('overdrive', 0.9, -4, (r) => {
  const a = osc(r);
  const b = osc(r);
  const f = lp1(r);
  return (t) => {
    const k = Math.floor(t / 0.3);
    const u = t - k * 0.3;
    const hz = 440 * Math.pow(2, k * (4 / 12));
    return f(a.pulse(hz, 0.3) + b.pulse(hz * 1.5, 0.3) * 0.5, 3200) * (k < 3 ? env(u, 0.004, 0.11) : 0);
  };
});
sfxLate('m_skewer', 0.5, -3, (r) => {
  // A whip-crack of air, then the barb punching through plate.
  const f = svf(r);
  const o = osc(r);
  const lp = lp1(r);
  const ping = metal(r, 2100, [1, 1.47, 2.2], [0.1, 0.07, 0.05], [0.3, 0.2, 0.12]);
  return (t) => {
    const whip = f.run(noise(), glide(700, 6000, 0.12, t), 3).bp * (t < 0.14 ? Math.sin((Math.PI * t) / 0.14) : 0) * 1.2;
    const u = t - 0.13;
    const punch = u > 0 ? Math.tanh(2.2 * (o.sin(glide(170, 50, 0.1, u)) * env(u, 0.001, 0.1) + lp(noise(), 2400) * env(u, 0.001, 0.05))) + ping(u) : 0;
    return whip + punch;
  };
});

// ---------------------------------------------------------------- music

/*
 * RoBugs' own musical identity, "bug-tech": wing-buzz leads that glide like
 * servos, kalimba plucks, cricket chirps, clicky insect-leg percussion and a
 * bit-crushed gear bass, in shuffles and odd meters with unusual scales.
 * (Deliberately not the usual four-on-the-floor / saw-lead / arpeggio template.)
 */

/**
 * A tiny tracker. A song is `bars` bars of `steps` steps; a step is
 * 1/`sub` of a beat (sub 4 = sixteenths, sub 3 = triplet eighths).
 * Instruments write into named stems; the mix adds reverb/echo sends, then
 * the tail past the loop end is wrapped onto the start so the track loops
 * seamlessly.
 */
function makeSong({ bpm, bars, steps = 16, sub = 4, swing = 0 }) {
  const r = MUSIC_RATE;
  const step = 60 / bpm / sub;
  const len = Math.round(bars * steps * step * r);
  const tail = 3 * r;
  const stems = {};
  const sends = { rev: new Float32Array(len + tail), dly: new Float32Array(len + tail) };
  const stem = (name) => (stems[name] ??= new Float32Array(len + tail));
  /** Start time (s) of a step, with optional swing on odd steps. */
  const at = (bar, s) => (bar * steps + s + (s % 2 === 1 ? swing : 0)) * step;
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
  return { r, step, steps, len, tail, stems, sends, at, put, bars };
}

// Instruments: each returns (t) => sample for one note.
const I = {
  kick: (r, vel = 1) => {
    const o = osc(r);
    return (t) => Math.tanh(1.5 * (o.sin(48 + 90 * Math.exp(-t / 0.035)) * Math.exp(-t / 0.16) + noise() * Math.exp(-t / 0.002) * 0.2)) * vel;
  },
  /** The RoBugs snare: a dry woody "clack", like a beetle shell snapping shut. */
  clack: (r, vel = 1) => {
    const a = osc(r);
    const b = osc(r);
    const c = osc(r);
    const f = svf(r);
    return (t) =>
      (a.sin(830) * Math.exp(-t / 0.028) * 0.5 +
        b.sin(1340) * Math.exp(-t / 0.018) * 0.35 +
        c.sin(205) * Math.exp(-t / 0.04) * 0.5 +
        f.run(noise(), 2600, 1.4).bp * Math.exp(-t / 0.035) * 1.2) *
      vel;
  },
  /** Insect-leg tick: a tiny FM click. */
  chitter: (r, vel = 1, hz = 4200) => {
    let pm = 0;
    let pc = 0;
    return (t) => {
      pm = (pm + (hz * 1.41) / r) % 1;
      pc = (pc + hz / r) % 1;
      return Math.sin(TAU * pc + 4 * Math.exp(-t / 0.004) * Math.sin(TAU * pm)) * Math.exp(-t / 0.011) * vel;
    };
  },
  /** A cricket chirp: three quick trilled pulses. */
  cricket: (r, vel = 1, hz = 4700) => {
    const o = osc(r);
    return (t) => {
      const k = Math.floor(t / 0.028);
      const u = t - k * 0.028;
      const gate = k < 3 && u < 0.017 ? Math.sin((Math.PI * u) / 0.017) : 0;
      return o.sin(hz * (1 + 0.01 * Math.sin(TAU * 90 * t))) * gate * vel;
    };
  },
  shaker: (r, vel = 1) => {
    const f = svf(r);
    return (t) => f.run(noise(), 6000, 1).bp * env(t, 0.006, 0.03) * vel;
  },
  tom: (r, hz, vel = 1) => {
    const o = osc(r);
    const f = lp1(r);
    return (t) => Math.tanh(1.3 * (o.sin(hz * (1 + 0.5 * Math.exp(-t / 0.025))) * Math.exp(-t / 0.28) + f(noise(), 600) * Math.exp(-t / 0.02) * 0.6)) * vel;
  },
  anvil: (r, hz, vel = 1) => metal(r, hz, [1, 2.76, 5.4, 8.93], [0.14, 0.08, 0.05, 0.03], [0.6 * vel, 0.3 * vel, 0.18 * vel, 0.1 * vel]),
  /** Thumb piano: a round tone with a quick inharmonic "tine". */
  kalimba: (r, hz, dur, decay = 0.9) => {
    const a = osc(r);
    const b = osc(r);
    return (t) =>
      (a.sin(hz * (1 + 0.012 * Math.exp(-t / 0.01))) + b.sin(hz * 5.95) * 0.35 * Math.exp(-t / 0.045) + noise() * Math.exp(-t / 0.0015) * 0.15) *
      Math.exp(-t / decay) *
      (t > dur + 0.25 ? Math.exp(-(t - dur - 0.25) / 0.08) : 1);
  },
  /**
   * Wing-buzz voice: a reedy tone through two formant filters, chopped by a
   * fast "wingbeat" tremolo, gliding from the previous note like a servo.
   */
  buzz: (r, hz, dur, { from = null, glideT = 0.06, wing = 28, depth = 0.4, cut = 1700, q = 3, vib = 0.006, attack = 0.015, release = 0.08, drive = 1.3 } = {}) => {
    const o = osc(r);
    const o2 = osc(r);
    const f1 = svf(r);
    const f2 = svf(r);
    return (t) => {
      const base = from ? glide(from, hz, glideT, t) : hz;
      const f = base * (1 + (t > 0.12 ? vib * Math.sin(TAU * 5.2 * t) : 0));
      const raw = o.pulse(f, 0.3) * 0.6 + o2.saw(f * 1.004) * 0.5;
      const sweep = cut * (1 + 0.2 * Math.sin(TAU * 2.6 * t));
      const voiced = f1.run(raw, sweep, q).bp * 1.4 + f2.run(raw, sweep * 1.85, q * 1.2).bp * 0.8 + raw * 0.12;
      const wingbeat = 1 - depth + depth * (0.5 + 0.5 * Math.sin(TAU * wing * t));
      const amp = Math.min(1, t / attack) * (t > dur ? Math.exp(-(t - dur) / release) : 1);
      return Math.tanh(drive * voiced * wingbeat) * amp;
    };
  },
  /** Bit-crushed "gear" bass: sample-and-hold decimation and a few bits of depth. */
  gear: (r, hz, dur, { crush = 7, bits = 5, cut = 500, envAmt = 1500, decay = 0.08 } = {}) => {
    const o = osc(r);
    const o2 = osc(r);
    const f = svf(r);
    const levels = Math.pow(2, bits - 1);
    let held = 0;
    let k = 0;
    return (t) => {
      const raw = o.pulse(hz, 0.35) * 0.7 + o2.sin(hz) * 0.6;
      const v = f.run(raw, cut + envAmt * Math.exp(-t / decay), 1.3).lp;
      if (k++ % crush === 0) held = Math.round(clamp(v, -1, 1) * levels) / levels;
      return held * Math.min(1, t / 0.003) * (t > dur ? Math.exp(-(t - dur) / 0.03) : 1);
    };
  },
  /** Soft round bass (triangle + sine sub). */
  round: (r, hz, dur) => {
    const a = osc(r);
    const b = osc(r);
    return (t) => (a.tri(hz) * 0.6 + b.sin(hz * 0.5) * 0.6) * Math.min(1, t / 0.01) * Math.exp(-t / 1.2) * (t > dur ? Math.exp(-(t - dur) / 0.06) : 1);
  },
  /** The hive: a cluster of detuned buzzing voices, each with its own wingbeat. */
  swarm: (r, hz, dur) => {
    const vs = Array.from({ length: 6 }, (_, k) => ({ o: osc(r), d: 1 + (k - 2.5) * 0.006, w: 21 + rand() * 18, ph: rand() }));
    const f = svf(r);
    return (t) => {
      let v = 0;
      for (const s of vs) v += s.o.saw(hz * s.d) * (0.55 + 0.45 * Math.sin(TAU * (s.w * t + s.ph)));
      const amp = Math.min(1, t / 0.7) * (t > dur ? Math.exp(-(t - dur) / 0.6) : 1);
      return f.run(v / vs.length, 700 + 250 * Math.sin(TAU * 0.4 * t), 1.6).lp * amp;
    };
  },
  /** A servo whir between two pitches. */
  servo: (r, f0, f1, dur) => {
    const o = osc(r);
    const f = lp1(r);
    return (t) => f(o.pulse(glide(f0, f1, dur * 0.8, t), 0.2), 2500) * Math.sin(Math.PI * Math.min(1, t / dur)) * 0.6;
  },
};

/** Melody line: [bar, step, steps, note] items. Consecutive notes glide (for voices that take `from`). */
function line(song, stem, make, items, opts) {
  let prev = null;
  for (const [bar, s, steps, note] of items) {
    const hz = midi(typeof note === 'number' ? note : n(note));
    const t0 = song.at(bar, s);
    const dur = steps * song.step;
    const from = prev && Math.abs(prev.end - t0) < 0.02 ? prev.hz : null;
    song.put(stem, t0, dur + 0.7, make(song.r, hz, dur, from), opts);
    prev = { hz, end: t0 + dur };
  }
}
const shift = (items, bars, semis = 0) => items.map(([b, s, l, m]) => [b + bars, s, l, (typeof m === 'number' ? m : n(m)) + semis]);
/** Notes by name → MIDI. */
const N = (...names) => names.map(n);

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


// ---- Track: hub, "Burrow Lounge". A lazy 12/8 shuffle in F lydian: kalimba, round bass, a soft wing-buzz tune.
function songHub() {
  const s = makeSong({ bpm: 92, bars: 16, steps: 12, sub: 3 });
  const prog = [
    { bass: 'F2', tones: N('F4', 'A4', 'C5', 'E5') },
    { bass: 'F2', tones: N('G4', 'B4', 'D5', 'E5') },
    { bass: 'E2', tones: N('E4', 'G4', 'B4', 'D5') },
    { bass: 'A2', tones: N('A4', 'C5', 'E5', 'G5') },
    { bass: 'F2', tones: N('F4', 'A4', 'C5', 'E5') },
    { bass: 'G2', tones: N('G4', 'B4', 'D5', 'E5') },
    { bass: 'D2', tones: N('D4', 'F4', 'A4', 'E5') },
    { bass: 'C2', tones: N('C4', 'E4', 'G4', 'B4') },
  ];
  const ost = [0, 2, 1, 3, 2, 1, 0, 2, 1, 3, 2, 3];
  for (let bar = 0; bar < 16; bar++) {
    const c = prog[bar % 8];
    for (let st = 0; st < 12; st++) {
      const m = c.tones[ost[st]] + 12;
      const accent = st % 3 === 0 ? 1 : 0.6;
      s.put('kal', s.at(bar, st), 1.4, I.kalimba(s.r, midi(m), s.step, 0.7), { gain: accent, rev: 0.35, dly: st === 11 ? 0.4 : 0 });
    }
    for (const [st, l, iv] of [
      [0, 5, 0],
      [8, 3, 7],
      [11, 1, 12],
    ])
      s.put('bass', s.at(bar, st), l * s.step + 0.3, I.round(s.r, midi(n(c.bass) + iv), l * s.step));
    if (bar >= 2) {
      s.put('drums', s.at(bar, 0), 0.5, I.kick(s.r, 0.9));
      s.put('drums', s.at(bar, 8), 0.5, I.kick(s.r, 0.6));
      s.put('drums', s.at(bar, 6), 0.2, I.clack(s.r, 0.5), { rev: 0.3 });
      for (let st = 0; st < 12; st++) s.put('perc', s.at(bar, st), 0.06, I.shaker(s.r, st % 3 === 0 ? 0.7 : st % 3 === 2 ? 0.5 : 0.25));
    }
    if (bar % 2 === 1) s.put('perc', s.at(bar, 10), 0.12, I.cricket(s.r, 0.5), { rev: 0.5 });
    if (bar % 4 === 3) for (const st of [9, 10, 11]) s.put('perc', s.at(bar, st), 0.05, I.chitter(s.r, 0.6, 3600 + st * 150));
  }
  const A = [
    [0, 0, 2, 'A5'], [0, 2, 1, 'G5'], [0, 3, 3, 'E5'], [0, 6, 6, 'C5'],
    [1, 0, 3, 'B4'], [1, 3, 3, 'D5'], [1, 6, 4, 'E5'], [1, 10, 2, 'D5'],
    [2, 0, 6, 'B4'], [2, 6, 3, 'G4'], [2, 9, 3, 'A4'],
    [3, 0, 9, 'C5'], [3, 9, 3, 'E5'],
  ];
  const B = [
    [0, 0, 3, 'F5'], [0, 3, 3, 'E5'], [0, 6, 3, 'C5'], [0, 9, 3, 'A4'],
    [1, 0, 4, 'B4'], [1, 4, 2, 'C5'], [1, 6, 6, 'D5'],
    [2, 0, 3, 'E5'], [2, 3, 3, 'F5'], [2, 6, 6, 'A5'],
    [3, 0, 6, 'G5'], [3, 6, 6, 'B4'],
  ];
  const voice = (r, hz, d, from) => I.buzz(r, hz, d, { from, wing: 22, depth: 0.22, cut: 1300, q: 2.2, drive: 1.1, attack: 0.03 });
  line(s, 'lead', voice, [...shift(A, 4), ...shift(B, 8), ...shift(A, 12)], { rev: 0.35, dly: 0.25 });
  return mixSong(s, { kal: 0.3, bass: 0.5, drums: 1.29, perc: 1.25, lead: 0.41 }, { delaySteps: 3, fb: 0.3 });
}

// ---- Track: garage, "Workbench Seven". 7/8 workshop groove in D mixolydian: gear bass, ratchets, kalimba, servo whistle.
function songGarage() {
  const s = makeSong({ bpm: 126, bars: 16, steps: 14, sub: 4 });
  const roots = ['D2', 'D2', 'C2', 'C2', 'G2', 'G2', 'A2', 'A2'];
  const riff = [
    [0, 2, 0],
    [2, 1, 12],
    [4, 2, 10],
    [6, 2, 7],
    [8, 3, 0],
    [11, 1, 5],
    [12, 2, 7],
  ];
  for (let bar = 0; bar < 16; bar++) {
    const root = n(roots[bar % 8]);
    for (const st of [0, 8]) s.put('drums', s.at(bar, st), 0.5, I.kick(s.r));
    s.put('drums', s.at(bar, 11), 0.5, I.kick(s.r, 0.5));
    for (const st of [4, 12]) s.put('drums', s.at(bar, st), 0.25, I.clack(s.r, 0.8), { rev: 0.2 });
    for (let st = 1; st < 14; st += 2) s.put('perc', s.at(bar, st), 0.05, I.chitter(s.r, 0.35, 5200));
    for (const [st, hz] of [
      [6, 1560],
      [13, 1180],
    ])
      s.put('perc', s.at(bar, st), 0.3, I.anvil(s.r, hz, 0.6), { rev: 0.3 });
    // A ratchet (rapid clicks) to close every 4 bars.
    if (bar % 4 === 3) for (let k = 0; k < 8; k++) s.put('perc', s.at(bar, 10) + k * s.step * 0.5, 0.04, I.chitter(s.r, 0.6, 3000 + k * 120));
    if (bar % 8 === 7) s.put('fx', s.at(bar, 6), s.step * 8, I.servo(s.r, 260, 980, s.step * 8), { rev: 0.3 });
    for (const [st, l, iv] of riff) s.put('bass', s.at(bar, st), l * s.step + 0.05, I.gear(s.r, midi(root + iv), l * s.step * 0.85));
  }
  const M = [
    [0, 0, 2, 'F#5'], [0, 2, 2, 'A5'], [0, 4, 2, 'D6'], [0, 6, 2, 'C6'], [0, 8, 3, 'A5'], [0, 11, 3, 'G5'],
    [1, 0, 4, 'F#5'], [1, 4, 2, 'E5'], [1, 6, 2, 'D5'], [1, 8, 6, 'E5'],
    [2, 0, 2, 'E5'], [2, 2, 2, 'G5'], [2, 4, 2, 'C6'], [2, 6, 2, 'B5'], [2, 8, 3, 'G5'], [2, 11, 3, 'E5'],
    [3, 0, 4, 'G5'], [3, 4, 4, 'E5'], [3, 8, 6, 'C5'],
    [4, 0, 2, 'D5'], [4, 2, 2, 'G5'], [4, 4, 2, 'B5'], [4, 6, 2, 'D6'], [4, 8, 3, 'C6'], [4, 11, 3, 'B5'],
    [5, 0, 6, 'A5'], [5, 8, 6, 'G5'],
    [6, 0, 2, 'C#6'], [6, 2, 2, 'E6'], [6, 4, 4, 'C6'], [6, 8, 6, 'A5'],
    [7, 0, 4, 'G5'], [7, 4, 2, 'F#5'], [7, 6, 8, 'E5'],
  ];
  line(s, 'kal', (r, hz, d) => I.kalimba(r, hz, d, 0.6), [...shift(M, 0), ...shift(M, 8, -12)], { rev: 0.3, dly: 0.25 });
  const whistle = (r, hz, d, from) => I.buzz(r, hz, d, { from, glideT: 0.08, wing: 0, depth: 0, cut: 2200, q: 1.4, vib: 0.008, drive: 0.9, attack: 0.02 });
  line(s, 'lead', whistle, shift(M, 8), { rev: 0.3, dly: 0.2 });
  return mixSong(s, { drums: 0.75, perc: 0.75, fx: 0.6, bass: 0.32, kal: 0.3, lead: 0.63 }, { delaySteps: 3, fb: 0.3 });
}

// ---- Track: battle, "Swarm Clash". Half-time breakbeat at 168 BPM in E phrygian dominant; wing-buzz bass and lead.
function songBattle() {
  const s = makeSong({ bpm: 168, bars: 16, steps: 16, sub: 4 });
  const prog = [
    { root: 'E2', tones: N('E4', 'G#4', 'B4') },
    { root: 'F2', tones: N('F4', 'A4', 'C5') },
    { root: 'E2', tones: N('E4', 'G#4', 'B4') },
    { root: 'G#2', tones: N('G#4', 'B4', 'D5') },
    { root: 'A2', tones: N('A4', 'C5', 'E5') },
    { root: 'F2', tones: N('F4', 'A4', 'C5') },
    { root: 'E2', tones: N('E4', 'G#4', 'B4') },
    { root: 'E2', tones: N('E4', 'G#4', 'B4') },
  ];
  const wobble = 1 / (s.step * 2); // the bass "wingbeat" locks to eighth notes
  for (let bar = 0; bar < 16; bar++) {
    const c = prog[bar % 8];
    const root = n(c.root);
    const fill = bar % 8 === 7;
    for (const [st, v] of [
      [0, 1],
      [3, 0.55],
      [10, 0.9],
    ])
      if (!(fill && st === 10)) s.put('drums', s.at(bar, st), 0.5, I.kick(s.r, v));
    s.put('drums', s.at(bar, 8), 0.25, I.clack(s.r, 1), { rev: 0.25 });
    s.put('drums', s.at(bar, 14), 0.25, I.clack(s.r, 0.3));
    if (fill) for (const [st, hz] of [[11, 190], [12, 160], [13, 135], [14, 115], [15, 95]]) s.put('drums', s.at(bar, st), 0.4, I.tom(s.r, hz, 0.8));
    // Leg-click hats: sixteenths with accents, plus quick rolls here and there.
    for (let st = 0; st < 16; st++) {
      if (fill && st > 10) continue;
      s.put('hats', s.at(bar, st), 0.05, I.chitter(s.r, st % 4 === 2 ? 0.8 : st % 2 ? 0.35 : 0.5, 5600));
      if (rand() < 0.12) s.put('hats', s.at(bar, st) + s.step / 2, 0.05, I.chitter(s.r, 0.3, 6200));
    }
    if (bar % 4 === 0) s.put('hats', s.at(bar, 4), 0.12, I.cricket(s.r, 0.6, 4300), { rev: 0.4 });
    // Wing-buzz bass, offbeat-driven, with the phrygian half-step.
    for (const [st, l, iv] of [
      [0, 3, 0],
      [3, 1, 0],
      [6, 2, 12],
      [8, 2, 0],
      [11, 2, 1],
      [14, 2, 0],
    ])
      s.put(
        'bass',
        s.at(bar, st),
        l * s.step + 0.1,
        I.buzz(s.r, midi(root + iv), l * s.step * 0.9, { wing: wobble, depth: 0.5, cut: 420, q: 1.6, drive: 2.2, vib: 0, attack: 0.004, release: 0.03 }),
      );
    // Fast kalimba sparkle in the second half.
    if (bar >= 8) for (let st = 0; st < 16; st += 2) s.put('kal', s.at(bar, st), 0.6, I.kalimba(s.r, midi(c.tones[(st / 2) % 3] + 12), s.step, 0.25), { dly: 0.3 });
  }
  const L = [
    [0, 0, 3, 'B4'], [0, 3, 3, 'C5'], [0, 6, 2, 'B4'], [0, 8, 4, 'G#4'], [0, 12, 4, 'E5'],
    [1, 0, 6, 'F5'], [1, 6, 2, 'E5'], [1, 8, 4, 'C5'], [1, 12, 4, 'A4'],
    [2, 0, 2, 'G#4'], [2, 2, 2, 'B4'], [2, 4, 4, 'E5'], [2, 8, 2, 'F5'], [2, 10, 2, 'E5'], [2, 12, 4, 'D5'],
    [3, 0, 8, 'B4'], [3, 8, 4, 'D5'], [3, 12, 4, 'F5'],
    [4, 0, 4, 'E5'], [4, 4, 4, 'C5'], [4, 8, 4, 'A4'], [4, 12, 4, 'B4'],
    [5, 0, 4, 'C5'], [5, 4, 2, 'A4'], [5, 6, 2, 'C5'], [5, 8, 8, 'F5'],
    [6, 0, 3, 'E5'], [6, 3, 3, 'F5'], [6, 6, 2, 'G#5'], [6, 8, 8, 'B5'],
    [7, 0, 8, 'E5'],
  ];
  const lead = (r, hz, d, from) => I.buzz(r, hz, d, { from, wing: 32, depth: 0.35, cut: 2100, q: 3, drive: 1.6 });
  line(s, 'lead', lead, [...shift(L, 0), ...shift(L, 8, 12)], { rev: 0.25, dly: 0.2 });
  line(s, 'lead2', (r, hz, d, from) => I.buzz(r, hz, d, { from, wing: 27, depth: 0.3, cut: 1500, q: 2.5 }), shift(L, 8, 8), { rev: 0.3 });
  return mixSong(s, { drums: 0.76, hats: 0.7, bass: 0.53, kal: 0.18, lead: 0.35, lead2: 0.2 }, { delaySteps: 3, fb: 0.28, revWet: 0.16 });
}

// ---- Track: boss, "Hive Mother". A heavy 12/8 ritual in C locrian: the swarm drone, war toms, crickets and a snarling buzz.
function songBoss() {
  const s = makeSong({ bpm: 96, bars: 12, steps: 12, sub: 3 });
  const prog = [
    { root: 'C2', tones: N('C3', 'Eb3', 'Gb3') },
    { root: 'Db2', tones: N('Db3', 'F3', 'Ab3') },
    { root: 'Bb1', tones: N('Bb2', 'Db3', 'F3') },
    { root: 'Gb1', tones: N('Gb2', 'Bb2', 'Db3') },
    { root: 'C2', tones: N('C3', 'Eb3', 'Gb3') },
    { root: 'Db2', tones: N('Db3', 'F3', 'Ab3') },
    { root: 'Bb1', tones: N('Bb2', 'Db3', 'F3') },
    { root: 'Gb1', tones: N('Gb2', 'Bb2', 'Db3') },
    { root: 'Ab1', tones: N('Ab2', 'C3', 'Eb3') },
    { root: 'Gb1', tones: N('Gb2', 'Bb2', 'Db3') },
    { root: 'Db2', tones: N('Db3', 'F3', 'Ab3') },
    { root: 'C2', tones: N('C3', 'Eb3', 'Gb3') },
  ];
  for (let bar = 0; bar < 12; bar++) {
    const c = prog[bar];
    const root = n(c.root);
    for (const st of [0, 6]) s.put('drums', s.at(bar, st), 0.5, I.kick(s.r));
    for (const [st, hz, v] of [
      [0, 70, 1],
      [2, 70, 0.5],
      [3, 95, 0.8],
      [6, 70, 1],
      [8, 70, 0.5],
      [9, 95, 0.8],
      [11, 130, 0.7],
    ])
      s.put('toms', s.at(bar, st), 0.6, I.tom(s.r, hz, v), { rev: 0.3 });
    s.put('drums', s.at(bar, 9), 0.25, I.clack(s.r, 0.7), { rev: 0.3 });
    for (let k = 0; k < 2; k++) s.put('perc', s.at(bar, Math.floor(rand() * 12)), 0.12, I.cricket(s.r, 0.45, 3900 + rand() * 1500), { rev: 0.5 });
    if (bar % 4 === 0) s.put('bell', s.at(bar, 0), 2.2, I.anvil(s.r, midi(n('C6')), 1), { rev: 0.6 });
    for (const m of c.tones) s.put('swarm', s.at(bar, 0), 12 * s.step + 0.8, I.swarm(s.r, midi(m), 12 * s.step), { rev: 0.4 });
    for (const st of [0, 3, 6, 9]) s.put('bass', s.at(bar, st), 3 * s.step, I.gear(s.r, midi(root), 2.5 * s.step, { crush: 9, bits: 4, cut: 300, envAmt: 1200 }));
  }
  const P1 = [
    [0, 0, 6, 'C5'], [0, 6, 3, 'Db5'], [0, 9, 3, 'Eb5'],
    [1, 0, 6, 'F5'], [1, 6, 6, 'Db5'],
    [2, 0, 3, 'Bb4'], [2, 3, 3, 'Db5'], [2, 6, 3, 'F5'], [2, 9, 3, 'Gb5'],
    [3, 0, 9, 'F5'], [3, 9, 3, 'Db5'],
  ];
  const P2 = [
    [0, 0, 6, 'Eb5'], [0, 6, 6, 'C5'],
    [1, 0, 3, 'Db5'], [1, 3, 3, 'Bb4'], [1, 6, 6, 'Gb4'],
    [2, 0, 3, 'Ab4'], [2, 3, 3, 'Db5'], [2, 6, 6, 'F5'],
    [3, 0, 6, 'Gb5'], [3, 6, 6, 'C5'],
  ];
  const snarl = (r, hz, d, from) => I.buzz(r, hz, d, { from, glideT: 0.09, wing: 40, depth: 0.5, cut: 1500, q: 3.5, drive: 2.4, vib: 0.01 });
  line(s, 'lead', snarl, [...shift(P1, 4), ...shift(P2, 8)], { rev: 0.3, dly: 0.2 });
  line(s, 'kal', (r, hz, d) => I.kalimba(r, hz, d, 1.2), shift(P2, 8, 12), { rev: 0.5 });
  return mixSong(s, { drums: 0.9, toms: 0.56, perc: 1.1, bell: 1.27, swarm: 0.47, bass: 0.33, lead: 0.38, kal: 0.27 }, { delaySteps: 3, fb: 0.25, revWet: 0.2 });
}

// ---------------------------------------------------------------- write

mkdirSync(join(OUT, 'sfx'), { recursive: true });
mkdirSync(join(OUT, 'music'), { recursive: true });

function writeSfx(set) {
  for (const [name, def] of Object.entries(set)) {
    const x = master(renderSfx(def.dur, def.make), def.peakDb);
    writeFileSync(join(OUT, 'sfx', `${name}.wav`), wavBuffer(x, SFX_RATE));
    console.log(`sfx   ${name.padEnd(12)} ${def.dur.toFixed(2)}s rms ${db(rms(x))} dB`);
  }
}
writeSfx(SFX);

const tmp = mkdtempSync(join(tmpdir(), 'robugs-audio-'));
for (const [name, fn] of Object.entries({ hub: songHub, garage: songGarage, battle: songBattle, boss: songBoss })) {
  const { out, report } = fn();
  const wavPath = join(tmp, `${name}.wav`);
  writeFileSync(wavPath, wavBuffer(out, MUSIC_RATE));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '96k', join(OUT, 'music', `${name}.mp3`)]);
  console.log(`music ${name.padEnd(8)} ${(out.length / MUSIC_RATE).toFixed(1)}s rms ${db(rms(out))} dB | ${report.join(', ')}`);
}
rmSync(tmp, { recursive: true, force: true });
writeSfx(SFX_LATE);

// ---------------------------------------------------------------- SFX, third set

// The second wave of signature moves, the lightning rod and mirror bounces. (Rendered last
// of all, so every file above keeps its exact bytes.)
const SFX_MOVES = {};
function sfxMove(name, dur, peakDb, make) {
  SFX_MOVES[name] = { dur, peakDb, make };
}
/** A short, crackly electric zap at `hz` (bright band-passed sparks over a buzzing saw). */
function zap(r, hz, len) {
  const o = osc(r);
  const f = svf(r);
  return (u) => {
    if (u < 0 || u > len + 0.06) return 0;
    const a = Math.min(1, u / 0.003) * Math.exp(-u / (len * 0.6));
    const spark = rand() < 0.35 ? noise() : 0;
    return (f.run(spark, hz * 3, 1.8).bp * 1.6 + o.saw(hz * (1 + 0.3 * Math.sin(TAU * 60 * u))) * 0.35) * a;
  };
}
sfxMove('m_chain', 0.6, -3, (r) => {
  // Four zaps leaping from part to part, each one a little higher.
  const zs = [0, 0.09, 0.17, 0.24].map((at, k) => ({ at, z: zap(r, 420 + k * 140, 0.08) }));
  const hum = osc(r);
  return (t) => zs.reduce((a, v) => a + v.z(t - v.at), 0) + hum.pulse(95, 0.15) * env(t, 0.01, 0.18) * 0.18;
});
sfxMove('m_pounce', 0.45, -4, (r) => {
  // A coiled spring letting go: a quick sproing up, then the rush of the leap.
  const o = osc(r);
  const f = svf(r);
  return (t) => {
    const spring = o.tri(glide(160, 760, 0.16, t) * (1 + 0.06 * Math.sin(TAU * 34 * t))) * env(t, 0.004, 0.1) * 0.8;
    const rush = f.run(noise(), glide(600, 2600, 0.35, t), 1.3).bp * Math.sin(Math.PI * Math.min(1, t / 0.44)) * 0.9;
    return spring + rush;
  };
});
sfxMove('m_thorn', 0.5, -4, (r) => {
  // The plate bristles (a dry rattle), then a ring of thorns fwips out all at once.
  const f = svf(r);
  const g = svf(r);
  const ticks = Array.from({ length: 10 }, (_, k) => ({ at: 0.1 + k * 0.007 + rand() * 0.01, hz: 1800 + rand() * 2200 }));
  const ch = ticks.map((k) => ({ ...k, o: osc(r) }));
  return (t) => {
    const rattle = t < 0.11 ? f.run(rand() < 0.25 ? noise() : 0, 3500, 2).bp * 1.5 * (t / 0.11) : 0;
    const fwip = t > 0.1 ? g.run(noise(), glide(1800, 6500, 0.12, t - 0.1), 2.2).bp * env(t - 0.1, 0.003, 0.1) * 1.3 : 0;
    let v = rattle + fwip;
    for (const k of ch) if (t > k.at) v += k.o.sin(glide(k.hz, k.hz * 0.6, 0.05, t - k.at)) * env(t - k.at, 0.0005, 0.02) * 0.18;
    return v;
  };
});
sfxMove('m_ink', 0.9, -5, (r) => {
  // A wet, low "pfoomp" and a long hiss of smog rolling out.
  const o = osc(r);
  const f = svf(r);
  const lp = lp1(r);
  return (t) => {
    const pfoomp = Math.tanh(1.6 * o.sin(glide(150, 48, 0.18, t)) * env(t, 0.006, 0.12));
    const puff = lp(noise(), 900) * env(t, 0.005, 0.06) * 1.4;
    const smog = f.run(noise(), 500 + 900 * Math.exp(-t / 0.3), 0.9).lp * env(t, 0.08, 0.35) * 1.3 * (0.8 + 0.2 * Math.sin(TAU * 7 * t));
    return pfoomp + puff + smog;
  };
});
sfxMove('m_rally', 0.85, -5, (r) => {
  // A warm repair pulse: three throbs of a rising major chord, sparkle on top.
  const chord = [n('F4'), n('A4'), n('C5'), n('F5')].map((m) => ({ o: osc(r), o2: osc(r), f: midi(m) }));
  const lp = lp1(r);
  const sp = osc(r);
  return (t) => {
    const throb = 0.55 + 0.45 * Math.cos(TAU * 7.5 * t);
    const rise = Math.pow(2, Math.min(t, 0.5) * (5 / 12) / 0.5);
    const pad = chord.reduce((a, c) => a + c.o.tri(c.f * rise) + c.o2.tri(c.f * rise * 1.005) * 0.5, 0) / chord.length;
    const amp = Math.min(1, t / 0.04) * (t > 0.6 ? Math.exp(-(t - 0.6) / 0.08) : 1);
    const sparkle = sp.sin(midi(n('C7')) * (1 + Math.floor(t * 16) % 3 * 0.25)) * (t > 0.3 ? env((t - 0.3) % 0.0625, 0.001, 0.02) : 0) * 0.25;
    return lp(pad, 2400) * throb * amp * 0.9 + sparkle * amp;
  };
});
sfxMove('m_magnet', 0.7, -4, (r) => {
  // The core spins up a throbbing hum that bends upward as it pulls, then a metal clunk.
  const a = osc(r);
  const b = osc(r);
  const f = svf(r);
  const clank = metal(r, 380, [1, 2.3, 3.1], [0.12, 0.08, 0.05], [0.45, 0.3, 0.2]);
  return (t) => {
    const hz = glide(70, 210, 0.5, t);
    const wob = 0.5 + 0.5 * Math.sin(TAU * glide(6, 22, 0.5, t) * t);
    const hum = f.run(a.saw(hz) + b.saw(hz * 1.5 + 2), 300 + 1500 * Math.min(1, t / 0.5), 3).lp * wob;
    const amp = t < 0.5 ? Math.min(1, t / 0.05) : Math.exp(-(t - 0.5) / 0.04);
    return hum * amp * 0.9 + (t > 0.5 ? clank(t - 0.5) + noise() * env(t - 0.5, 0.0005, 0.005) * 0.4 : 0);
  };
});
sfxMove('m_swarm', 1.3, -3, (r) => {
  // The hive opens: a dozen wing-buzzes at slightly different pitches swell, scatter and fly off.
  const bees = Array.from({ length: 9 }, (_, k) => ({ o: osc(r), hz: 190 + k * 23 + rand() * 15, wing: 26 + rand() * 14, ph: rand() * TAU }));
  const f = svf(r);
  const pop = osc(r);
  return (t) => {
    let v = 0;
    for (const b of bees) {
      const bend = 1 + 0.12 * Math.sin(TAU * 1.3 * t + b.ph) + 0.25 * Math.max(0, t - 0.6);
      v += b.o.saw(b.hz * bend) * (0.6 + 0.4 * Math.sin(TAU * b.wing * t + b.ph));
    }
    const amp = Math.min(1, t / 0.25) * (t > 0.85 ? Math.exp(-(t - 0.85) / 0.15) : 1);
    const lid = pop.sin(glide(320, 90, 0.06, t)) * env(t, 0.001, 0.05) * 0.8;
    return f.run(v / bees.length, 1400 + 900 * Math.sin(TAU * 2 * t), 2).lp * amp * 1.6 + lid;
  };
});
sfxMove('m_quake', 1.3, -0.5, (r) => {
  // The slam: a huge low thud, a crack of stone and a long rumble with falling grit.
  const o = osc(r);
  const sub = osc(r);
  const f = lp1(r);
  const rum = lp1(r);
  const crack = svf(r);
  return (t) => {
    const thud = o.sin(glide(95, 26, 0.35, t)) * env(t, 0.002, 0.3) + sub.sin(glide(48, 30, 0.6, t)) * env(t, 0.01, 0.5) * 0.6;
    const snap = crack.run(noise(), 2200, 1.2).bp * env(t, 0.0008, 0.04) * 1.5;
    const rumble = rum(noise(), 140) * env(t, 0.04, 0.55) * 4 * (0.7 + 0.3 * Math.sin(TAU * 9 * t));
    const grit = rand() < 0.02 * Math.exp(-t / 0.5) ? noise() * 0.6 : 0;
    return Math.tanh(2 * (thud + rumble + f(noise(), 900) * env(t, 0.001, 0.08))) + snap + grit;
  };
});
sfxMove('m_dive', 0.7, -3, (r) => {
  // A falling whistle as it drops out of the sky, then the impact.
  const o = osc(r);
  const o2 = osc(r);
  const f = svf(r);
  const thump = osc(r);
  return (t) => {
    const hz = glide(1900, 420, 0.5, t);
    const fall = t < 0.52 ? (o.sin(hz) + o2.sin(hz * 1.01) * 0.5) * Math.min(1, t / 0.08) * 0.4 + f.run(noise(), hz * 1.5, 2).bp * 0.6 * Math.min(1, t / 0.3) : 0;
    const u = t - 0.5;
    const hit = u > 0 ? Math.tanh(2 * (thump.sin(glide(140, 45, 0.1, u)) * env(u, 0.001, 0.1) + noise() * env(u, 0.001, 0.03) * 0.7)) : 0;
    return fall + hit;
  };
});
sfxMove('m_mirror', 0.75, -6, (r) => {
  // A glassy shimmer: bright inharmonic chimes that swirl (a slow chorus) as the field rises.
  const chime = metal(r, 1480, [1, 1.414, 2.08, 2.83, 3.6], [0.5, 0.4, 0.3, 0.2, 0.12], [0.4, 0.32, 0.25, 0.15, 0.1]);
  const chime2 = metal(r, 1497, [1, 2.08, 3.6], [0.45, 0.28, 0.15], [0.3, 0.2, 0.1]);
  const f = svf(r);
  return (t) => {
    const sweep = f.run(noise(), glide(2000, 8000, 0.4, t), 3).bp * env(t, 0.05, 0.12) * 0.5;
    return (chime(t) + chime2(t)) * (0.75 + 0.25 * Math.sin(TAU * 5 * t)) + sweep;
  };
});
sfxMove('m_anchor', 0.65, -3, (r) => {
  // Hooks rattle down and bite into the floor: a chain clatter, then two heavy clunks.
  const ticks = Array.from({ length: 8 }, (_, k) => ({ at: k * 0.022 + rand() * 0.008, m: metal(r, 1500 + rand() * 900, [1, 1.7], [0.02, 0.012], [0.3, 0.2]) }));
  const clunk = metal(r, 230, [1, 2.6, 4.2], [0.18, 0.1, 0.06], [0.5, 0.3, 0.15]);
  const o = osc(r);
  const f = lp1(r);
  return (t) => {
    let v = 0;
    for (const k of ticks) if (t > k.at) v += k.m(t - k.at);
    for (const at of [0.2, 0.29]) {
      const u = t - at;
      if (u > 0) v += Math.tanh(2 * (o.sin(glide(120, 50, 0.08, u)) * env(u, 0.001, 0.08) + f(noise(), 1200) * env(u, 0.001, 0.03))) * 0.8 + clunk(u) * 0.8;
    }
    return v;
  };
});
sfxMove('m_ram', 0.6, -3, (r) => {
  // A snorting motor rev and a drum-roll of footfalls gathering speed.
  const o = osc(r);
  const f = svf(r);
  const feet = osc(r);
  return (t) => {
    const rev = f.run(o.pulse(glide(55, 140, 0.45, t), 0.3) * (0.6 + 0.4 * Math.sin(TAU * 30 * t)), 700 + 1600 * Math.min(1, t / 0.4), 1.6).lp;
    const period = glide(0.09, 0.045, 0.5, t);
    const u = t % period;
    const step = feet.sin(glide(150, 70, 0.03, u)) * env(u, 0.001, 0.02);
    const amp = Math.min(1, t / 0.04) * (t > 0.5 ? Math.exp(-(t - 0.5) / 0.04) : 1);
    return (Math.tanh(1.8 * rev) * 0.6 + step * 0.7) * amp;
  };
});
sfxMove('m_vise', 0.5, -3, (r) => {
  // A ratchet clicking tight, then a crunching squeeze.
  const lp = lp1(r);
  const o = osc(r);
  const clicks = [0, 0.045, 0.085, 0.12, 0.15].map((at, k) => ({ at, o: osc(r), hz: 2400 + k * 300 }));
  return (t) => {
    let v = 0;
    for (const c of clicks) if (t > c.at) v += (c.o.sin(c.hz) * 0.5 + noise() * 0.5) * env(t - c.at, 0.0005, 0.008);
    const u = t - 0.17;
    if (u > 0) v += Math.tanh(2.4 * (o.pulse(glide(110, 70, 0.25, u), 0.2) * env(u, 0.004, 0.12) * 0.5 + lp(noise(), 1800) * env(u, 0.002, 0.09) * (0.7 + 0.3 * Math.sin(TAU * 45 * u))));
    return v;
  };
});
sfxMove('m_mark', 0.45, -6, (r) => {
  // Lock-on: two quick rising blips, then a bright held tone with a soft hiss.
  const a = osc(r);
  const b = osc(r);
  const hp = svf(r);
  return (t) => {
    const blip = (at, hz) => (t > at && t < at + 0.05 ? a.pulse(hz, 0.5) * env(t - at, 0.001, 0.025) * 0.5 : 0);
    const u = t - 0.13;
    const lock = u > 0 ? b.sin(1980 * (1 + 0.004 * Math.sin(TAU * 18 * u))) * env(u, 0.002, 0.14) * 0.6 : 0;
    const hiss = hp.run(noise(), 6000).hp * (u > 0 ? env(u, 0.002, 0.05) * 0.2 : 0);
    return blip(0, 1320) + blip(0.065, 1660) + lock + hiss;
  };
});
sfxMove('bolt', 1.4, -0.5, (r) => {
  // Thunder from the lightning rod: a sharp crack of sizzle, then a rolling boom.
  const crack = svf(r);
  const sizz = svf(r);
  const o = osc(r);
  const rum = lp1(r);
  const rum2 = lp1(r);
  return (t) => {
    const snap = crack.run(noise(), 3800, 0.9).hp * env(t, 0.0005, 0.03) * 1.4;
    const fizz = sizz.run(rand() < 0.3 ? noise() : 0, 5000, 2).bp * env(t, 0.001, 0.12) * 1.5;
    const boom = o.sin(glide(70, 30, 0.5, t)) * env(t, 0.01, 0.4) * 0.8;
    const roll = rum(noise(), 220) * env(t, 0.06, 0.5) * 3.5 * (0.6 + 0.4 * Math.sin(TAU * 4.5 * t + 1)) + rum2(noise(), 90) * env(t, 0.15, 0.6) * 3;
    return snap + fizz + Math.tanh(1.8 * (boom + roll));
  };
});
sfxMove('reflect', 0.22, -7, (r) => {
  // A shot glancing off the mirror: a quick bright "tink" that bends up.
  const o = osc(r);
  const o2 = osc(r);
  return (t) => (o.sin(glide(2600, 3900, 0.05, t)) + o2.sin(glide(3900, 5200, 0.05, t)) * 0.4) * env(t, 0.001, 0.05) + noise() * env(t, 0.0005, 0.003) * 0.4;
});
sfxMove('land', 0.35, -4, (r) => {
  // A Pounce / Dive Bomb coming down: a dull thump and a puff of grit.
  const o = osc(r);
  const f = lp1(r);
  return (t) => Math.tanh(1.8 * (o.sin(glide(120, 40, 0.12, t)) * env(t, 0.002, 0.1) + f(noise(), 1100) * env(t, 0.001, 0.06) * 0.9));
});

writeSfx(SFX_MOVES);

