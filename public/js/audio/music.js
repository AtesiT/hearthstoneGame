// music.js — 8-бит фоновая музыка (WebAudio, БЕЗ файлов — офлайн).
//
// Секвенсор: таблица нот [midi, dur(доли), vol, ch], look-ahead
// scheduling (каждые 25 мс планируем ноты на 0.12 с вперёд) — без джиттера.
// Две темы: 'menu' (A-minor пентатоника, медленная) и 'battle' (быстрее).
// Переход с кроссфейдом. Mute общий с sfx (localStorage 'emberfall:vol').

import { isMuted } from './sfx.js';

// ---------- палитры тем ----------

// menu: 8 тактов, 80 bpm, A-minor pentatonic (A C D E G), спокойная
const MENU = {
  bpm: 80,
  // [midi | null(пауза), длина в долях, громкость, канал: 'lead'|'bass']
  lead: [
    [69, 1, 0.5], [72, 1, 0.5], [76, 2, 0.55], [74, 1, 0.5], [72, 1, 0.5],
    [69, 2, 0.5], null, [64, 2, 0.45],
    [67, 1, 0.5], [69, 1, 0.5], [72, 1, 0.5], [76, 1, 0.55], [74, 2, 0.5],
    [72, 1, 0.5], [69, 1, 0.5], [64, 2, 0.45],
    [69, 1, 0.5], [74, 1, 0.5], [76, 2, 0.55], [79, 1, 0.55], [76, 1, 0.5],
    [74, 1, 0.5], [72, 1, 0.5], [69, 2, 0.45],
    [67, 1, 0.5], [69, 1, 0.5], [72, 2, 0.5], [69, 1, 0.5], [67, 1, 0.5],
    [64, 2, 0.45], null, null,
  ],
  bass: [
    [45, 4, 0.4], [48, 4, 0.4],
    [43, 4, 0.4], [45, 4, 0.4],
    [41, 4, 0.4], [43, 4, 0.4],
    [45, 4, 0.4], [48, 2, 0.4], [45, 2, 0.35],
  ],
};

// battle: 16 тактов, 120 bpm, другой мотив (напряжённее)
const BATTLE = {
  bpm: 120,
  lead: [
    [69, 0.5, 0.5], [69, 0.5, 0.5], [72, 1, 0.55], [74, 0.5, 0.5], [76, 0.5, 0.55],
    [79, 1, 0.55], [76, 1, 0.5], [74, 1, 0.5],
    [72, 0.5, 0.5], [72, 0.5, 0.5], [76, 1, 0.55], [74, 0.5, 0.5], [72, 0.5, 0.5],
    [69, 1, 0.5], [67, 1, 0.45], [64, 1, 0.45],
    [69, 0.5, 0.5], [69, 0.5, 0.5], [72, 1, 0.55], [76, 1, 0.55], [79, 2, 0.6],
    [81, 1, 0.6], [79, 1, 0.55], null,
    [79, 0.5, 0.55], [76, 0.5, 0.55], [74, 0.5, 0.5], [72, 0.5, 0.5], [69, 2, 0.5],
    [67, 1, 0.45], [64, 1, 0.45], [69, 2, 0.5],
  ],
  bass: [
    [45, 2, 0.45], [45, 2, 0.45], [48, 2, 0.45], [48, 2, 0.45],
    [43, 2, 0.45], [43, 2, 0.45], [45, 2, 0.45], [45, 2, 0.45],
    [41, 2, 0.45], [43, 2, 0.45], [45, 2, 0.45], [45, 2, 0.45],
    [48, 2, 0.45], [48, 2, 0.45], [43, 2, 0.45], [45, 2, 0.35],
  ],
};

const THEMES = { menu: MENU, battle: BATTLE };

// ---------- состояние ----------
let ctx = null;
let leadGain = null;
let bassGain = null;
let timer = null;
let current = null; // 'menu' | 'battle' | null
let nextLeadTime = 0;
let nextBassTime = 0;
let idxLead = 0;
let idxBass = 0;
let vol = 0.35;

try {
  const saved = localStorage.getItem('emberfall:vol');
  if (saved != null) vol = Math.min(0.8, Math.max(0, Number(saved) || 0.35));
} catch { /* ignore */ }

function ensure() {
  if (typeof window === 'undefined' || !window.AudioContext && !window.webkitAudioContext) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    leadGain = ctx.createGain();
    bassGain = ctx.createGain();
    leadGain.gain.value = vol * 0.5;
    bassGain.gain.value = vol * 0.4;
    leadGain.connect(ctx.destination);
    bassGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function setVolume(v) {
  vol = Math.min(0.8, Math.max(0, Number(v) || 0));
  try { localStorage.setItem('emberfall:vol', String(vol)); } catch { /* ignore */ }
  if (leadGain) leadGain.gain.value = vol * 0.5;
  if (bassGain) bassGain.gain.value = vol * 0.4;
}

function midiHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function scheduleNote(ac, theme, channel, note, when) {
  const [midi, dur, noteVol] = note;
  if (midi == null) return 0;
  const beat = 60 / theme.bpm;
  const durSec = dur * beat * 0.92;
  const t0 = when;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = channel === 'lead' ? 'square' : 'triangle';
  osc.frequency.setValueAtTime(midiHz(midi), t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(noteVol, t0 + 0.01);
  g.gain.setValueAtTime(noteVol, t0 + durSec * 0.7);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + durSec);
  osc.connect(g).connect(channel === 'lead' ? leadGain : bassGain);
  osc.start(t0);
  osc.stop(t0 + durSec + 0.03);
  return durSec;
}

/** Look-ahead планировщик: два независимых потока (lead/bass). */
function tick() {
  const ac = ctx;
  const theme = THEMES[current];
  if (!ac || !theme) return;
  const beat = 60 / theme.bpm;
  const horizon = ac.currentTime + 0.12;
  const mutedNow = isMuted();
  while (nextLeadTime < horizon) {
    const [m, d, v] = theme.lead[idxLead % theme.lead.length];
    if (m != null && !mutedNow) {
      scheduleNote(ac, theme, 'lead', [m, d, v], nextLeadTime);
    }
    nextLeadTime += d * beat;
    idxLead++;
  }
  while (nextBassTime < horizon) {
    const [m, d, v] = theme.bass[idxBass % theme.bass.length];
    if (m != null && !mutedNow) {
      scheduleNote(ac, theme, 'bass', [m, d, v], nextBassTime);
    }
    nextBassTime += d * beat;
    idxBass++;
  }
}

/** Переключить тему (null — остановить) с кроссфейдом. */
export function setTheme(name) {
  const ac = ensure();
  if (!ac) return;
  if (name === current) return;
  const from = current;
  current = name;
  if (timer) { clearInterval(timer); timer = null; }
  if (name) {
    // кроссфейд: старая тема гаснет (ноги уже запланированы на <0.12 с), новая стартует
    if (from) {
      const oldLead = leadGain.gain.value;
      leadGain.gain.cancelScheduledValues(ac.currentTime);
      leadGain.gain.setValueAtTime(oldLead, ac.currentTime);
      leadGain.gain.linearRampToValueAtTime(vol * 0.5, ac.currentTime + 0.3);
    }
    idxLead = 0;
    idxBass = 0;
    nextLeadTime = ac.currentTime + 0.08;
    nextBassTime = ac.currentTime + 0.08;
    timer = setInterval(tick, 25);
    timer.unref?.();
  }
}

export function currentTheme() {
  return current;
}

/** Разбудить аудио (первый жест). */
export function unlock() {
  ensure();
}
