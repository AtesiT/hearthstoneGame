// emojis.js — 8 эмоций: пиксель-спрайты 8×8 (рисуются canvas-ом, в коде).
// Спрайт — dataURL для иконок панели и пузырей над портретами.
//
// Палитра: жёлтая морда (F), тёмный контур/глаза (K), рот (M),
// слеза (B), пламя (R), звезда (Y). '.' — прозрачный.

const SKIN = '#ffd24a';
const DARK = '#2a1808';
const MOUTH = '#7a3a1a';
const BLUE = '#4aa3ff';
const RED = '#ff6a3a';
const GOLD = '#fff2b0';

// 8 морд 12×10. Контур K, морда F, глаза K (row 4), рот M (row 6).
const BASE = [
  '............',
  '..KKKKKKKK..',
  '.KFFFFFFFFK.',
  '.KFFFFFFFFK.',
  '.KFFKFFKFFK.',
  '.KFFFFFFFFK.',
  '.KFFMMMMFFK.',
  '.KFFFFFFFFK.',
  '.KKKKKKKKKK.',
  '............',
];

const FACES = {
  // Привет: обычная улыбка + поднятая «лапка» справа
  greet: [
    '.......KK...',
    '..KKKKKKKKK.',
    '.KFFFFFFFFK.',
    '.KFFFFFFFFK.',
    '.KFFKFFKFFK.',
    '.KFFFFFFFFK.',
    '.KFFMMMMFFK.',
    '.KFFFFFFFFK.',
    '.KKKKKKKKKK.',
    '............',
  ],
  // Спасибо: счастливые закрытые глаза (KK)
  thanks: [
    '............',
    '..KKKKKKKK..',
    '.KFFFFFFFFK.',
    '.KFFFFFFFFK.',
    '.KFFKKFFKKF.',
    '.KFFFFFFFFK.',
    '.KFFMMMMFFK.',
    '.KFFFFFFFFK.',
    '.KKKKKKKKKK.',
    '............',
  ],
  // Угроза: злые сдвинутые брови (row 3)
  threat: [
    '............',
    '..KKKKKKKK..',
    '.KFKFFFFKFK.',
    '.KFFKKFFKFF.',
    '.KFFKFFKFFK.',
    '.KFFFFFFFFK.',
    '.KFFMMMMFFK.',
    '.KFFFFFFFFK.',
    '.KKKKKKKKKK.',
    '............',
  ],
  // Смех: прищур + широкий рот
  laugh: [
    '............',
    '..KKKKKKKK..',
    '.KFFFFFFFFK.',
    '.KFFFFFFFFK.',
    '.KKKKFFKKKK.',
    '.KFFFFFFFFK.',
    '.KFMMMMMMFK.',
    '.KFMMMMMMFK.',
    '.KKKKKKKKKK.',
    '............',
  ],
  // Печаль: приподнятый уголок рта вниз + слеза
  sad: [
    '............',
    '..KKKKKKKK..',
    '.KFFFFFFFFK.',
    '.KFFFFFFFFK.',
    '.KFFKFFKFFK.',
    '.KFFFFFFFFK.',
    '.KFFMMMMFFK.',
    '.KFBFFFFBFK.',
    '.KKKKKKKKKK.',
    '....B.......',
  ],
  // Удивление: глаза шире (row 3-5) + рот-«О»
  surprise: [
    '............',
    '..KKKKKKKK..',
    '.KFFFFFFFFK.',
    '.KFKFFFFKFK.',
    '.KFFKFFKFFK.',
    '.KFFKFFKFFK.',
    '.KFFFKKFFFK.',
    '.KFFFFFFFFK.',
    '.KKKKKKKKKK.',
    '............',
  ],
  // Похвала: улыбка + звезда над головой
  praise: [
    '.....YY.....',
    '....Y..Y....',
    '..KKKKKKKKY.',
    '.KFFFFFFFFK.',
    '.KFFKFFKFFK.',
    '.KFFFFFFFFK.',
    '.KFFMMMMFFK.',
    '.KFFFFFFFFK.',
    '.KKKKKKKKKK.',
    '............',
  ],
  // Огонь: пламя над головой
  fire: [
    '...R...R....',
    '..RRR.RRR...',
    '..RRRRRRR...',
    '.KFFFFFRFK..',
    '.KFFKFFKFFK.',
    '.KFFFFFFFFK.',
    '.KFFMMMMFFK.',
    '.KFFFFFFFFK.',
    '.KKKKKKKKKK.',
    '............',
  ],
};

const CHAR_MAP = { K: DARK, F: SKIN, M: MOUTH, B: BLUE, R: RED, Y: GOLD };

const cache = new Map();
const SIZE = 10; // 12×10 пикселей
const CELL = 4; // → 48×40 px

/** DataURL пиксель-спрайта эмоции. */
export function emojiSprite(emotion) {
  if (cache.has(emotion)) return cache.get(emotion);
  const face = FACES[emotion];
  if (!face) return null;

  const cv = document.createElement('canvas');
  cv.width = SIZE * CELL;
  cv.height = SIZE * CELL;
  const g = cv.getContext('2d');
  face.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = CHAR_MAP[ch];
      if (!c) return;
      g.fillStyle = c;
      g.fillRect(x * CELL, y * CELL, CELL, CELL);
    });
  });
  const url = cv.toDataURL();
  cache.set(emotion, url);
  return url;
}

/** Порядок панели. */
export const EMOTION_ORDER = ['greet', 'thanks', 'praise', 'laugh', 'surprise', 'sad', 'threat', 'fire'];
export const EMOTION_TITLE = {
  greet: 'Привет', thanks: 'Спасибо', praise: 'Похвала', laugh: 'Смех',
  surprise: 'Удивление', sad: 'Печаль', threat: 'Угроза', fire: 'Огонь',
};
