// art.js — пиксель-арт карт (Этап 4).
//
// Основной источник — PNG из репо: /assets/cards/<id>.png (16×16, 8-бит,
// сгенерированы scripts/gen-art.js — офлайн-требование: всё в репозитории).
// Если файла нет (развёртка без арта) — процедурный fallback на канвасе
// (seed от cardId, детерминированный): шум-фон + иконка типа.

const ICONS = {
  // 8×8 пиксельные иконки ('#' = пикс иконки, '.' = прозрачно)
  minion: [
    '.######.',
    '########',
    '##.##.##',
    '########',
    '########',
    '.######.',
    '.##..##.',
    '........',
  ],
  spell: [
    '...##...',
    '..####..',
    '.######.',
    '########',
    '########',
    '.######.',
    '..####..',
    '...##...',
  ],
  weapon: [
    '....#...',
    '....#...',
    '....#...',
    '....#...',
    '.#####..',
    '....#...',
    '...###..',
    '...#.#..',
  ],
};

const PALETTES = {
  minion: { bg: ['#5a3a22', '#6e482a'], icon: '#ffd24a' },
  spell: { bg: ['#2a3a5e', '#33476f'], icon: '#9fd8ff' },
  weapon: { bg: ['#3a3a44', '#4a4a56'], icon: '#d8e2f0' },
};

const artCache = new Map();

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Procedural fallback (canvas): шум + иконка типа. */
function procedural(card) {
  const GRID = 16;
  const CELL = 4;
  const cv = document.createElement('canvas');
  cv.width = GRID * CELL;
  cv.height = GRID * CELL;
  const g = cv.getContext('2d');
  if (!g) return `assets/cards/${card.id}.png`;

  const pal = PALETTES[card.type] || PALETTES.minion;
  const rnd = rng32(hashStr(card.id));
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      g.fillStyle = rnd() < 0.5 ? pal.bg[0] : pal.bg[1];
      g.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
  const icon = ICONS[card.type];
  if (icon) {
    g.fillStyle = pal.icon;
    icon.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === '#') g.fillRect((x + 4) * CELL, (y + 4) * CELL, CELL, CELL);
      });
    });
  }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = 0; i < GRID; i++) {
    g.fillRect(i * CELL, 0, CELL, CELL);
    g.fillRect(i * CELL, (GRID - 1) * CELL, CELL, CELL);
    g.fillRect(0, i * CELL, CELL, CELL);
    g.fillRect((GRID - 1) * CELL, i * CELL, CELL, CELL);
  }
  return cv.toDataURL();
}

/**
 * URL арта карты. PNG из репо; если его нет — procedural dataURL.
 * @param {{id: string, type: string}} card
 */
export function cardArt(card) {
  if (artCache.has(card.id)) return artCache.get(card.id);
  let url;
  try {
    url = new URL(`assets/cards/${card.id}.png`, document.baseURI).href;
  } catch {
    url = `assets/cards/${card.id}.png`;
  }
  // Быстрая проверка наличия файла в jsdom-тестах недоступна (нет fs) —
  // в браузере <img> с onerror уйдёт на fallback (см. game-ui.js).
  // В jsdom (headless-тесты) сразу даём procedural, чтобы не зависеть от fetch.
  const url0 = url;
  url = (globalThis.__HEADLESS__ ? procedural(card) : url0);
  artCache.set(card.id, url);
  return url;
}

/** URL аватара героя: seat 0 — Кайл, seat 1 — Мариса. */
export function heroArt(seat) {
  return seat === 0 ? 'assets/heroes/kyle.png' : 'assets/heroes/marisa.png';
}
