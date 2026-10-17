// gen-art.js — генерация пиксель-арта карт и героев (8×8 → 16×16 PNG).
// Запуск: node scripts/gen-art.js
// Зависимостей нет: PNG кодируется вручную (zlib.deflateSync).
// Стилистика: единая 8-битная, 3–4 цвета на иконку, детерминированно.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── минимальный PNG-энкодер (RGBA 8-bit) ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(pixels, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // фильтр none
    for (let x = 0; x < w; x++) {
      const p = pixels[y * w + x];
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // глубина
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── рисование: шаблон 8×8 строками, 2×2 апскейл до 16×16 ──
// символы: '.' прозрачный, '1'..'.9' цвета палитры, 'E' глаз/тёмная деталь, 'W' блик
const TRANSPARENT = [0, 0, 0, 0];
function render(template, palette) {
  const px = new Array(16 * 16).fill(TRANSPARENT);
  const put = (x, y, c) => { px[y * 16 + x] = c; };
  for (let ty = 0; ty < 8; ty++) {
    const row = template[ty];
    for (let tx = 0; tx < 8; tx++) {
      const ch = row[tx];
      if (ch === '.') continue;
      let c;
      if (ch === 'E') c = palette.E ?? [26, 26, 34, 255];
      else if (ch === 'W') c = palette.W ?? [235, 235, 245, 255];
      else c = palette[ch] ?? palette['1'];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) put(tx * 2 + dx, ty * 2 + dy, c);
    }
  }
  return px;
}

// ── шаблоны (8×8) ──
const T_BEAST = [
  '........',
  '.#..#...',
  '.####.E.',
  '.#####..',
  '#######.',
  '.#######',
  '.#.##.##',
  '.#..#..#',
];
const T_SPIRIT = [
  '...11...',
  '..1111..',
  '.1E11E1.',
  '11111111',
  '.111111.',
  '.111111.',
  '..1.1.1.',
  '...1.1..',
];
const T_CONSTRUCT = [
  '.222222.',
  '22E22E22',
  '22222222',
  '.2.22.2.',
  '22222222',
  '22222222',
  '.22..22.',
  '.22..22.',
];
const T_DRAGON = [
  '.1..1.1.',
  '.1111111',
  '.1E1111.',
  '.111111.',
  '1111111.',
  '.111111.',
  '..1..1..',
  '..1..1..',
];
const T_BOLT = [
  '....11..',
  '...11...',
  '..111...',
  '..11111.',
  '....11..',
  '...11...',
  '..11....',
  '.11.....',
];
const T_ORB = [
  '...11...',
  '..1111..',
  '.1W1111.',
  '.1111E1.',
  '.11E111.',
  '.111111.',
  '..1111..',
  '...11...',
];
const T_WAVE = [
  '........',
  '.1.1.1..',
  '11111111',
  '..1.1.1.',
  '11111111',
  '.1.1.1..',
  '........',
  '........',
];
const T_BURST = [
  '...11...',
  '.1.11.1.',
  '..1111..',
  '11111111',
  '11111111',
  '..1111..',
  '.1.11.1.',
  '...11...',
];
const T_SWORD = [
  '...11...',
  '...11...',
  '...11...',
  '...11...',
  '22222222',
  '...11...',
  '...22...',
  '..2222..',
];
const T_DAGGER = [
  '...1....',
  '...11...',
  '..111...',
  '.22222..',
  '...11...',
  '...11...',
  '..222...',
  '........',
];
const T_AXE = [
  '..11....',
  '..1111..',
  '..111111',
  '..111111',
  '..11.1..',
  '..11.1..',
  '..11.1..',
  '....11..',
];
const T_MACE = [
  '11111111',
  '11111111',
  '11111111',
  '...11...',
  '..2112..',
  '...11...',
  '...11...',
  '..2222..',
];
const T_COIN = [
  '...11...',
  '..1111..',
  '.1W1111.',
  '.1111E1.',
  '.111111.',
  '.11E111.',
  '..1111..',
  '...11...',
];
const T_SKULL = [
  '.111111.',
  '11111111',
  '1E111E11',
  '11111111',
  '.11..11.',
  '..1111..',
  '..1.1...',
  '........',
];
const T_KYLE = [
  '.222222.',
  '.222222.',
  '.2E22E2.',
  '.222222.',
  '..2222..',
  '.112211.',
  '11122111',
  '........',
];
const T_MARISA = [
  '....1...',
  '...11...',
  '..1111..',
  '11111111',
  '...22...',
  '..2E2E2.',
  '..2222..',
  '.112211.',
];

// ── палитры (8-битные) ──
const PALETTES = {
  rat:       { '1': [146, 116, 92, 255], '2': [104, 80, 62, 255], E: [224, 90, 80, 255] },
  wyvern:    { '1': [94, 134, 178, 255], '2': [62, 92, 138, 255], E: [250, 200, 90, 255] },
  goblin:    { '1': [110, 158, 92, 255], '2': [76, 116, 62, 255], E: [235, 90, 70, 255] },
  grove:     { '1': [120, 168, 110, 255], '2': [84, 124, 80, 255], E: [240, 240, 140, 255], W: [200, 240, 190, 255] },
  fairy:     { '1': [232, 150, 90, 255], '2': [196, 110, 60, 255], E: [250, 220, 120, 255], W: [255, 235, 170, 255] },
  knight:    { '1': [188, 196, 210, 255], '2': [128, 138, 158, 255], E: [120, 180, 250, 255] },
  watchman:  { '1': [150, 148, 140, 255], '2': [102, 100, 94, 255], E: [250, 210, 90, 255] },
  stalker:   { '1': [120, 108, 156, 255], '2': [82, 72, 116, 255], E: [240, 200, 250, 255] },
  wolf:      { '1': [178, 122, 76, 255], '2': [128, 82, 50, 255], E: [250, 170, 60, 255] },
  elemental: { '1': [130, 190, 216, 255], '2': [84, 138, 168, 255], E: [230, 250, 255, 255], W: [220, 245, 255, 255] },
  chief:     { '1': [164, 104, 66, 255], '2': [116, 70, 44, 255], E: [250, 220, 120, 255] },
  guardian:  { '1': [126, 170, 88, 255], '2': [88, 122, 60, 255], E: [230, 240, 150, 255] },
  colossus:  { '1': [200, 196, 188, 255], '2': [150, 146, 138, 255], E: [240, 120, 80, 255] },
  golem:     { '1': [122, 110, 100, 255], '2': [82, 72, 64, 255], E: [250, 150, 60, 255] },
  dragon:    { '1': [196, 74, 58, 255], '2': [140, 48, 40, 255], E: [250, 210, 80, 255], W: [255, 200, 120, 255] },
  spark:     { '1': [250, 200, 80, 255], '2': [220, 140, 50, 255], E: [255, 240, 180, 255], W: [255, 245, 200, 255] },
  grimoire:  { '1': [140, 110, 180, 255], '2': [96, 72, 138, 255], E: [235, 220, 250, 255], W: [220, 200, 250, 255] },
  frost:     { '1': [150, 214, 232, 255], '2': [96, 158, 190, 255], E: [240, 252, 255, 255], W: [230, 248, 255, 255] },
  steel:     { '1': [200, 205, 215, 255], '2': [140, 148, 165, 255], E: [150, 200, 250, 255] },
  bone:      { '1': [216, 206, 180, 255], '2': [168, 158, 132, 255], E: [190, 80, 70, 255] },
  green:     { '1': [120, 200, 90, 255], '2': [80, 150, 62, 255], E: [230, 250, 160, 255], W: [200, 250, 180, 255] },
  fire:      { '1': [232, 122, 48, 255], '2': [188, 76, 36, 255], E: [255, 220, 120, 255], W: [255, 235, 160, 255] },
  chain:     { '1': [240, 170, 60, 255], '2': [200, 116, 44, 255], E: [255, 235, 150, 255], W: [255, 240, 170, 255] },
  pyro:      { '1': [226, 84, 52, 255], '2': [176, 52, 36, 255], E: [255, 200, 90, 255], W: [255, 220, 130, 255] },
  titan:     { '1': [160, 150, 170, 255], '2': [112, 102, 126, 255], E: [240, 120, 120, 255] },
  dagger:    { '1': [170, 178, 195, 255], '2': [120, 128, 148, 255], E: [140, 190, 240, 255] },
  forge:     { '1': [150, 140, 130, 255], '2': [104, 96, 88, 255], E: [240, 150, 60, 255] },
  axe:       { '1': [190, 150, 100, 255], '2': [140, 104, 66, 255], E: [220, 225, 235, 255] },
  sword:     { '1': [205, 210, 225, 255], '2': [150, 158, 178, 255], E: [240, 200, 110, 255] },
  dragonfang:{ '1': [200, 80, 60, 255], '2': [150, 52, 40, 255], E: [255, 210, 100, 255] },
  coin:      { '1': [240, 196, 80, 255], '2': [206, 158, 48, 255], E: [255, 235, 150, 255], W: [255, 245, 190, 255] },
  skeleton:  { '1': [222, 214, 190, 255], '2': [180, 172, 148, 255], E: [60, 50, 46, 255] },
  kyle:      { '1': [190, 120, 70, 255], '2': [160, 168, 185, 255], E: [90, 140, 210, 255] },
  marisa:    { '1': [120, 90, 160, 255], '2': [210, 190, 170, 255], E: [230, 130, 200, 255] },
};

// ── карта id → {template, palette, flip} ──
const ASSIGN = {
  // существа
  rat_catcher:  { t: T_BEAST, p: 'rat' },
  spark_wyvern: { t: T_DRAGON, p: 'wyvern', flip: true },
  goblin_forge: { t: T_BEAST, p: 'goblin', flip: true },
  grove_spirit: { t: T_SPIRIT, p: 'grove' },
  flame_fairy:  { t: T_SPIRIT, p: 'fairy', flip: true },
  silver_knight:{ t: T_CONSTRUCT, p: 'knight' },
  stone_watchman:{ t: T_CONSTRUCT, p: 'watchman', flip: true },
  moon_stalker: { t: T_BEAST, p: 'stalker' },
  ember_wolf:   { t: T_BEAST, p: 'wolf', flip: true },
  frost_elemental:{ t: T_SPIRIT, p: 'elemental' },
  tribe_chief:  { t: T_CONSTRUCT, p: 'chief' },
  garden_guardian:{ t: T_BEAST, p: 'guardian' },
  bone_colossus:{ t: T_CONSTRUCT, p: 'colossus', flip: true },
  ashen_golem:  { t: T_CONSTRUCT, p: 'golem' },
  dawn_dragon:  { t: T_DRAGON, p: 'dragon' },
  // заклинания
  spark_bolt:   { t: T_BOLT, p: 'spark' },
  grimoire:     { t: T_ORB, p: 'grimoire', flip: true },
  frost_lance:  { t: T_BOLT, p: 'frost', flip: true },
  blessing_of_steel:{ t: T_ORB, p: 'steel' },
  bone_arrow:   { t: T_BOLT, p: 'bone' },
  green_ray:    { t: T_WAVE, p: 'green' },
  fireball:     { t: T_ORB, p: 'fire' },
  chain_lightning:{ t: T_BURST, p: 'chain' },
  pyroclasm:    { t: T_BURST, p: 'pyro', flip: true },
  titan_wrath:  { t: T_WAVE, p: 'titan', flip: true },
  // оружие
  steel_dagger: { t: T_DAGGER, p: 'dagger' },
  forge_mace:   { t: T_MACE, p: 'forge' },
  valkyrie_axe: { t: T_AXE, p: 'axe' },
  great_sword:  { t: T_SWORD, p: 'sword', flip: true },
  dragonfang:   { t: T_SWORD, p: 'dragonfang' },
  // особые
  dawn_coin:    { t: T_COIN, p: 'coin' },
  skeleton:     { t: T_SKULL, p: 'skeleton' },
};
const HEROES = { kyle: { t: T_KYLE, p: 'kyle' }, marisa: { t: T_MARISA, p: 'marisa' } };

function savePng(dir, name, pixels) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, encodePng(pixels, 16, 16));
  return file;
}

let n = 0;
for (const [id, a] of Object.entries(ASSIGN)) {
  let px = render(a.t, PALETTES[a.p]);
  if (a.flip) {
    const q = new Array(16 * 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) q[y * 16 + x] = px[y * 16 + (15 - x)];
    px = q;
  }
  savePng(path.join(ROOT, 'public/assets/cards'), id, px);
  n++;
}
for (const [id, a] of Object.entries(HEROES)) {
  savePng(path.join(ROOT, 'public/assets/heroes'), id, render(a.t, PALETTES[a.p]));
  n++;
}
console.log(`Сгенерировано ${n} PNG (16×16, 8-бит).`);
