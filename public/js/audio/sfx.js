// sfx.js — процедурные 8-бит звуки (WebAudio, БЕЗ файлов — офлайн).
//
// Все звуки синтезируются на лету: осцилляторы (square/triangle/noise)
// в духе Game Boy. AudioContext создаётся лениво после первого жеста
// пользователя (требование браузеров), в headless-среде (тесты) — no-op.
//
// API: sfx.play('attack') и т.д.; sfx.setMuted(bool); sfx.muted.
//
// Ограничение: не более MAX_CONCURRENT одновременных голосов и минимальный
// интервал на тип — массовые эффекты (titan_wrath) не превращаются в кашу.

const MAX_CONCURRENT = 5;
const MIN_INTERVAL_MS = 40; // на один тип звука

let ctx = null;
let masterGain = null;
let muted = false;
let active = 0;
const lastPlayed = new Map(); // тип → время

try {
  muted = localStorage.getItem('emberfall:sfx') === '0';
} catch { /* приватный режим */ }

/** Ленивая инициализация (вызывается по первому пользовательскому жесту). */
function ensure() {
  if (typeof window === 'undefined' || !window.AudioContext && !window.webkitAudioContext) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 0.5;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Разбудить аудио (клик по кнопке/карте — в main.js). */
export function unlock() {
  ensure();
}

export function setMuted(m) {
  muted = !!m;
  try { localStorage.setItem('emberfall:sfx', muted ? '0' : '1'); } catch { /* ignore */ }
  if (masterGain) masterGain.gain.value = muted ? 0 : 0.5;
}

export function isMuted() {
  return muted;
}

// ---------- примитивы синтеза ----------

/** Нота: тип, частота, начало, длительность, громкость (огибающая). */
function tone(ac, { type = 'square', freq = 440, at = 0, dur = 0.1, vol = 0.5, slide = null }) {
  const t0 = ac.currentTime + at;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide != null) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Шумовой всплеск (тёх/whoosh) через bandpass. */
function noise(ac, { at = 0, dur = 0.1, vol = 0.4, from = 800, to = null }) {
  const t0 = ac.currentTime + at;
  const len = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(from, t0);
  if (to != null) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  f.Q.value = 1.2;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(f).connect(g).connect(masterGain);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// ---------- 8-бит палитра (ноты) ----------

const N = { // midi → герц
  midi(m) { return 440 * Math.pow(2, (m - 69) / 12); },
};

const RECIPES = {
  // клик/выбор
  blip() {
    tone(this, { type: 'square', freq: N.midi(88), dur: 0.05, vol: 0.35 });
  },
  // существо поставлено: низкий square + шумовой тёх
  play() {
    tone(this, { type: 'square', freq: N.midi(45), dur: 0.16, vol: 0.5 });
    tone(this, { type: 'square', freq: N.midi(50), at: 0.07, dur: 0.14, vol: 0.4 });
    noise(this, { dur: 0.12, vol: 0.25, from: 400, to: 150 });
  },
  // заклинание: восходящее арпеджио
  spell() {
    const notes = [72, 76, 81, 84];
    notes.forEach((m, i) => tone(this, { type: 'square', freq: N.midi(m), at: i * 0.05, dur: 0.09, vol: 0.3 }));
  },
  // оружие: металлический «тук» (noise + резонансный triangle)
  weapon() {
    noise(this, { dur: 0.08, vol: 0.5, from: 2500, to: 900 });
    tone(this, { type: 'triangle', freq: N.midi(57), dur: 0.22, vol: 0.55, slide: N.midi(48) });
  },
  // атака: whoosh (noise sweep) + удар
  attack() {
    noise(this, { dur: 0.14, vol: 0.35, from: 300, to: 2200 });
    noise(this, { at: 0.12, dur: 0.1, vol: 0.5, from: 900, to: 200 });
    tone(this, { type: 'square', freq: N.midi(38), at: 0.12, dur: 0.1, vol: 0.5 });
  },
  // смерть: падающее арпеджио
  death() {
    const notes = [64, 59, 53, 46];
    notes.forEach((m, i) => tone(this, { type: 'square', freq: N.midi(m), at: i * 0.06, dur: 0.1, vol: 0.35 }));
  },
  // герой ранен: низкий boom
  heroHurt() {
    tone(this, { type: 'square', freq: N.midi(30), dur: 0.28, vol: 0.6, slide: N.midi(24) });
    noise(this, { dur: 0.2, vol: 0.3, from: 500, to: 120 });
  },
  // добор карты: быстрый swish
  draw() {
    noise(this, { dur: 0.07, vol: 0.2, from: 2000, to: 4000 });
  },
  // смена хода: две ноты
  turn() {
    tone(this, { type: 'square', freq: N.midi(67), dur: 0.09, vol: 0.35 });
    tone(this, { type: 'square', freq: N.midi(71), at: 0.1, dur: 0.14, vol: 0.35 });
  },
  // победа: мажорная фанфара
  win() {
    const notes = [72, 76, 79, 84];
    notes.forEach((m, i) => tone(this, { type: 'square', freq: N.midi(m), at: i * 0.12, dur: i === 3 ? 0.4 : 0.14, vol: 0.4 }));
  },
  // поражение: минорный спуск
  lose() {
    const notes = [72, 68, 65, 60];
    notes.forEach((m, i) => tone(this, { type: 'square', freq: N.midi(m), at: i * 0.14, dur: i === 3 ? 0.5 : 0.16, vol: 0.4 }));
  },
  // эмоции: 8 разных бипов
  emotion0() { tone(this, { type: 'square', freq: N.midi(84), dur: 0.08, vol: 0.3 }); tone(this, { type: 'square', freq: N.midi(88), at: 0.09, dur: 0.1, vol: 0.3 }); },
  emotion1() { tone(this, { type: 'triangle', freq: N.midi(80), dur: 0.12, vol: 0.35 }); },
  emotion2() { tone(this, { type: 'sawtooth', freq: N.midi(40), dur: 0.22, vol: 0.35, slide: N.midi(36) }); },
  emotion3() { [76, 79, 83, 86].forEach((m, i) => tone(this, { type: 'square', freq: N.midi(m), at: i * 0.04, dur: 0.05, vol: 0.25 })); },
  emotion4() { tone(this, { type: 'triangle', freq: N.midi(64), dur: 0.3, vol: 0.35, slide: N.midi(57) }); },
  emotion5() { tone(this, { type: 'square', freq: N.midi(91), dur: 0.09, vol: 0.35 }); },
  emotion6() { [72, 79, 84].forEach((m, i) => tone(this, { type: 'square', freq: N.midi(m), at: i * 0.07, dur: 0.09, vol: 0.3 })); },
  emotion7() { noise(this, { dur: 0.25, vol: 0.4, from: 300, to: 2500 }); tone(this, { type: 'square', freq: N.midi(45), at: 0.1, dur: 0.15, vol: 0.35 }); },
};

/**
 * Воспроизвести звук по имени ('blip' | 'play' | ... | 'emotion' (s.n — индекс 0..7)).
 * Безопасно в headless-среде (тихий no-op).
 */
export function play(name) {
  if (muted) return;
  const ac = ensure();
  if (!ac) return;
  if (active >= MAX_CONCURRENT) return;
  const now = Date.now();
  const last = lastPlayed.get(name) ?? 0;
  if (now - last < MIN_INTERVAL_MS) return;
  lastPlayed.set(name, now);

  const recipe = RECIPES[name] || RECIPES[`emotion${name.replace('emotion', '')}`];
  if (!recipe) return;
  active++;
  let done = 0;
  try {
    recipe.call(ac, ac);
  } catch {
    /* сломанное аудио не должно ронять игру */
  }
  // голос считается завершённым через 500 мс (все рецепты короче)
  setTimeout(() => {
    done = 1;
    if (active > 0) active--;
  }, 500);
}
