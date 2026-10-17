// sim-ui.js — headless-тест клиентского UI игрового стола (jsdom).
//
// Запуск:
//   npm run test-ui
//
// Проверяет БЕЗ браузера и БЕЗ сервера:
//   • все id элементов, на которые ссылаются game-ui.js и main.js, существуют в index.html;
//   • кэш карт (cards.js) отдаёт определения;
//   • процедурный арт (art.js) возвращает dataURL;
//   • render из ViewState рисует руку/поле/ману/колоды/героев/оружие;
//   • выбор карты подсвечивает валидные цели;
//   • status=ended открывает результат.
//
// jsdom не умеет canvas 2D — подменяем getContext/toDataURL заглушками.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CARD_DB } from '../server/game/cards.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
}

// ── DOM ──
const dom = new JSDOM(html, { url: 'http://localhost:8080/', pretendToBeVisual: true });
const { window } = dom;

// canvas-заглушка (jsdom без node-canvas)
const fake2d = new Proxy({}, {
  get: (t, prop) => {
    if (prop === 'canvas') return null;
    return (..._a) => undefined;
  },
  set: () => true,
});
window.HTMLCanvasElement.prototype.getContext = () => fake2d;
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,TEST';

// глобалы, которых ждут браузерные модули
globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.localStorage = window.localStorage;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/cards')) {
    return { ok: true, status: 200, json: async () => ({ cards: CARD_DB, deck: Object.keys(CARD_DB) }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
// Этап 4: art.js в headless-режиме не ходит в fetch за PNG, а рендит procedural
globalThis.__HEADLESS__ = true;

// ── 1. статика: все id из JS существуют в HTML ──
function referencedIds(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const ids = new Set();
  for (const re of [/getElementById\(['"]([a-z0-9-]+)['"]\)/gi, /\$\(['"]#([a-z0-9-]+)['"]\)/gi]) {
    let m;
    while ((m = re.exec(src))) ids.add(m[1]);
  }
  // шаблоны вида ${side}-hp покрываем вручную
  return ids;
}
{
  const docIds = new Set();
  const re = /id="([a-z0-9-]+)"/gi;
  let m;
  while ((m = re.exec(html))) docIds.add(m[1]);
  // динамические id (renderHero, vignette-этап4 и др.)
  for (const s of ['self', 'opp']) for (const sfx of ['name', 'hp', 'weapon', 'avatar', 'deck', 'deck-count']) docIds.add(`${s}-${sfx}`);
  docIds.add('vignette'); // создаётся в buildTable (Этап 4)

  const missing = [];
  for (const file of ['public/js/game/game-ui.js', 'public/js/ui/main.js']) {
    for (const id of referencedIds(file)) if (!docIds.has(id)) missing.push(`${file} → #${id}`);
  }
  check('все id из game-ui.js и main.js есть в index.html', missing.length === 0, missing.join(', '));
}

// ── 2. кэш карт ──
const { cardsMap, cardDef } = await import('../public/js/game/cards.js');
{
  const map = await cardsMap();
  check('cardsMap: 32 записи (30 + coin + skeleton)', map.size === 32, `получено ${map.size}`);
  check('cardDef: fireball — spell', cardDef('fireball')?.type === 'spell');
  check('cardDef: rat_catcher — таунт', cardDef('rat_catcher')?.keywords?.includes('taunt'));
  check('cardDef: неизвестная карта → undefined', cardDef('nope') === undefined);
}

// ── 3. процедурный арт ──
const { cardArt } = await import('../public/js/game/art.js');
{
  const a = cardArt({ id: 'fireball', type: 'spell' });
  const b = cardArt({ id: 'fireball', type: 'spell' });
  check('cardArt: dataURL', a.startsWith('data:image/png;base64,'));
  check('cardArt: детерминирован (кэш)', a === b);
}

// ── 4. render из ViewState ──
const gameUI = await import('../public/js/game/game-ui.js');
const sent = [];
let backToLobby = false;
gameUI.init({
  send: (t, d) => sent.push({ t, d }),
  toast: () => {},
  onBackToLobby: () => { backToLobby = true; },
});

function view(over = {}) {
  return {
    v: 1, roomCode: 'TEST1', status: 'running', turn: 0, turnCount: 3,
    winner: null, winReason: null, coinOwner: 0, seq: 10,
    self: {
      seat: 0, nick: 'Alice',
      hero: { name: 'Кайл', hp: 25, maxHp: 30, weapon: { cardId: 'steel_dagger', attack: 2, durability: 2 } },
      mana: 3, maxMana: 4, deckCount: 22,
      hand: [
        { uid: 'h-fireball', cardId: 'fireball', playable: true, targets: [{ kind: 'hero', seat: 1 }] },
        { uid: 'h-rat', cardId: 'rat_catcher', playable: true, targets: [] },
        { uid: 'h-coin', cardId: 'dawn_coin', playable: true, targets: [] },
      ],
      board: [
        { uid: 'm-grove', cardId: 'grove_spirit', seat: 0, atk: 2, health: 2, maxHealth: 2, baseAtk: 1, baseHealth: 1, canAttack: true, frozen: false, ds: false, justPlayed: false, keywords: [] },
      ],
      attacks: {
        minions: [{ uid: 'm-grove', targets: [{ kind: 'minion', uid: 'm-watch', seat: 1 }] }],
        weapon: { targets: [{ kind: 'minion', uid: 'm-watch', seat: 1 }] },
      },
    },
    opp: {
      seat: 1, nick: 'Bob',
      hero: { name: 'Мариса', hp: 30, maxHp: 30, weapon: null },
      deckCount: 20, handCount: 5,
      board: [
        { uid: 'm-watch', cardId: 'stone_watchman', seat: 1, atk: 3, health: 3, maxHealth: 3, baseAtk: 3, baseHealth: 3, canAttack: false, frozen: false, ds: false, justPlayed: true, keywords: ['taunt'] },
        { uid: 'm-knight', cardId: 'silver_knight', seat: 1, atk: 2, health: 2, maxHealth: 2, baseAtk: 2, baseHealth: 2, canAttack: true, frozen: false, ds: true, justPlayed: false, keywords: ['divine_shield', 'charge'] },
      ],
    },
    events: [],
    ...over,
  };
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

gameUI.onState(view());
{
  check('рука: 3 карты', $$('#hand .hand-card').length === 3, `получено ${$$('#hand .hand-card').length}`);
  check('рука: fireball и rat отрисованы', !!$('#hand .hand-card[data-uid="h-fireball"]'));
  check('своё поле: 1 существо (grove_spirit)', $$('#row-self .unit').length === 1);
  check('чужое поле: 2 существа', $$('#row-opp .unit').length === 2);
  check('существу простоявшего таунта — класс sick', $('#row-opp .unit[data-uid="m-watch"]')?.classList.contains('sick'));
  check('DS-существу — класс has-ds', $('#row-opp .unit[data-uid="m-knight"]')?.classList.contains('has-ds'));
  check('масса-бафф: grove atk=2 > base 1 → buffed', $('#row-self .unit .unit-atk')?.classList.contains('buffed'));
  check('мана: 4 кристалла, 3 полных', $$('#mana .mana-crystal').length === 4 && $$('#mana .mana-crystal.full').length === 3);
  check('своя колода: 22', $('#self-deck-count').textContent === '22');
  check('чужая колода: 20', $('#opp-deck-count').textContent === '20');
  check('чужая рука: 5 рубашек', $$('#opp-hand .card-back').length === 5);
  check('чужая рука: счётчик 5', $('#opp-hand-count').textContent === '5');
  check('свой герой: hp 25, ник+имя', $('#self-hp').textContent === '25' && /Alice · Кайл/.test($('#self-name').textContent));
  check('своё оружие видно (2/2)', !$('#self-weapon').hidden && /2/.test($('#self-weapon').textContent));
  check('чужое оружие скрыто', $('#opp-weapon').hidden);
  check('индикатор хода: ваш', /Ваш ход · 3/.test($('#turn-indicator').textContent));
  check('кнопка «Завершить ход» активна', !$('#btn-end-turn').disabled);
}

// ── 5. выбор карты → подсветка целей ──
{
  const fb = $('#hand .hand-card[data-uid="h-fireball"]');
  fb.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('выбранная карта — класс selected', fb.classList.contains('selected'));
  check('цель-герой подсвечена', $('#opp-hero').classList.contains('targetable'));
  check('неподсвечено чужое существо (таунт закрывает)', !$('#row-opp .unit[data-uid="m-watch"]')?.classList.contains('targetable'));
  check('подсказка про цель', /цель/i.test($('#hint-line').textContent));

  // клик по цели-герою → play_card с ack
  $('#opp-hero').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('play_card отправлен (hero, ack=10)',
    sent.some((m) => m.t === 'play_card' && m.d.handUid === 'h-fireball' && m.d.target?.kind === 'hero' && m.d.ack === 10),
    JSON.stringify(sent));
}

// ── 6. end_turn ──
{
  const before = sent.length;
  $('#btn-end-turn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('end_turn отправлен (ack=10)', sent.length === before + 1 && sent.at(-1).t === 'end_turn' && sent.at(-1).d.ack === 10);
}

// ── 7. конец партии ──
{
  const ended = view({ status: 'ended', winner: 0, winReason: 'hero_kill', turn: 0 });
  ended.opp.hero.hp = 0;
  gameUI.onState(ended);
  check('результат открыт', !$('#result-overlay').hidden);
  check('заголовок ПОБЕДА', /ПОБЕДА/.test($('#result-title').textContent));
  check('кнопка «В лобби» возвращает', (() => { $('#btn-result-lobby').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); return backToLobby; })());
}

// ── 8. атаки (Этап 3): выбор юнита и оружия → команда attack ──
{
  const v = view();
  gameUI.onState(v);
  check('боеготовое существо — класс can-attack', $('#row-self .unit[data-uid="m-grove"]')?.classList.contains('can-attack'));
  check('оружие готово: герой подсвечен (can-weapon)', $('#self-hero').classList.contains('can-weapon'));

  // выбор существа → цели (таунт; DS-рыцарь закрыт)
  $('#row-self .unit[data-uid="m-grove"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('существо выбрано (selected)', $('#row-self .unit[data-uid="m-grove"]')?.classList.contains('selected'));
  check('цель-таунт подсвечена', $('#row-opp .unit[data-uid="m-watch"]')?.classList.contains('targetable'));
  check('non-taunt не подсвечен (таунт)', !$('#row-opp .unit[data-uid="m-knight"]')?.classList.contains('targetable'));
  check('подсказка про цель атаки', /атак/i.test($('#hint-line').textContent));

  const before = sent.length;
  $('#row-opp .unit[data-uid="m-watch"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const atkMsg = sent.slice(before).find((m) => m.t === 'attack');
  check('attack отправлено (юнит → юнит, ack=10)',
    atkMsg && atkMsg.d.fromUid === 'm-grove' && atkMsg.d.fromSeat === 0 && atkMsg.d.toUid === 'm-watch' && atkMsg.d.toSeat === 1 && atkMsg.d.ack === 10,
    JSON.stringify(atkMsg));
  check('выбор снят после атаки', !$('#row-self .unit[data-uid="m-grove"]')?.classList.contains('selected'));

  // выбор оружия → удар по таунту
  $('#self-hero').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('оружие выбрано (подсказка)', /атак/i.test($('#hint-line').textContent));
  const before2 = sent.length;
  $('#row-opp .unit[data-uid="m-watch"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const wAtk = sent.slice(before2).find((m) => m.t === 'attack');
  check('attack отправлено (оружие → юнит)',
    wAtk && wAtk.d.fromUid === 'weapon' && wAtk.d.fromSeat === 0 && wAtk.d.toUid === 'm-watch' && wAtk.d.toSeat === 1,
    JSON.stringify(wAtk));

  // таунт жив → герой недопустимая цель
  $('#self-hero').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const before3 = sent.length;
  $('#opp-hero').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('удар в героя при таунте не отправлен', !sent.slice(before3).some((m) => m.t === 'attack'));
}

// ── 7. Этап 4: эмоции, звук, музыка, арт в репо, main.js загружается ──
{
  // 7a. панель эмоций: 8 кнопок, клик → send_emotion
  const btns = [...document.querySelectorAll('.emote-btn')];
  check('панель эмоций: 8 кнопок', btns.length === 8, `найдено ${btns.length}`);
  if (btns.length === 8) {
    const before = sent.length;
    btns[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const em = sent.slice(before).find((m) => m.t === 'send_emotion');
    check('клик по эмоции → send_emotion {emotion, ack}',
      !!em && typeof em.d.emotion === 'string' && em.d.ack === 10,
      JSON.stringify(em));
  }

  // 7b. sfx без AudioContext (jsdom) — безопасный no-op, не бросает
  const sfx = await import('../public/js/audio/sfx.js');
  let sfxOk = true;
  try {
    for (const k of ['blip', 'draw', 'turn', 'attack', 'death', 'win', 'lose', 'emotion0', 'emotion7']) sfx.play(k);
    sfx.unlock();
    sfx.setMuted(true);
    sfx.setMuted(false);
    sfx.play('blip');
  } catch (e) { sfxOk = false; check('sfx headless', false, e.message); }
  if (sfxOk) check('sfx: headless-safe (нет AudioContext — no-op, без исключений)', true);

  // 7c. музыка без AudioContext — setTheme не бросает
  const music = await import('../public/js/audio/music.js');
  let musicOk = true;
  try {
    music.unlock();
    music.setTheme('battle');
    await new Promise((r) => setTimeout(r, 120)); // дать тикнуть look-ahead
    music.setTheme('menu');
    music.setTheme(null);
  } catch (e) { musicOk = false; check('music headless', false, e.message); }
  if (musicOk) check('music: headless-safe (setTheme без AudioContext)', true);
}

// ── 8. Этап 4: пиксель-арт всех карт лежит в репо (офлайн-требование) ──
{
  const assets = path.join(ROOT, 'public/assets/cards');
  const missing = Object.keys(CARD_DB).filter((id) => !fs.existsSync(path.join(assets, `${id}.png`)));
  check('PNG-арт всех 32 карт в public/assets/cards/', missing.length === 0, missing.slice(0, 5).join(', '));
  const heroes = path.join(ROOT, 'public/assets/heroes');
  const missingH = ['kyle.png', 'marisa.png'].filter((f) => !fs.existsSync(path.join(heroes, f)));
  check('PNG-арт героев (kyle, marisa) в репо', missingH.length === 0, missingH.join(', '));
}

// ── 9. Этап 4: main.js реально загружается (ловим недостающие импорты, как был gameUI) ──
{
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null; }
    send() {}
    close() {}
    addEventListener() {}
  }
  globalThis.WebSocket = FakeWS;
  try {
    await import('../public/js/ui/main.js');
    check('main.js: модуль загружается (импорты на месте)', true);
  } catch (e) {
    check('main.js: модуль загружается (импорты на месте)', false, e.message);
  }
}

// ── 10. Этап 5: cardtext (RU-тексты карт) ──
{
  const ct = await import('../public/js/game/cardtext.js');
  check('cardtext: 4 ключевых слова со словарём', Object.keys(ct.KEYWORDS_RU).length === 4);
  check('cardtext: fireball — «нанести … урона»', /нанести 6 урона/i.test(ct.cardText(cardDef('fireball'))), ct.cardText(cardDef('fireball')));
  check('cardtext: dawn_coin — мана', /ман/i.test(ct.cardText(cardDef('dawn_coin'))));
  check('cardtext: grove_spirit — аура', /Аура:/.test(ct.cardTextLines(cardDef('grove_spirit')).join(' ')));
}

// ── 11. Этап 5: коллекция карт ──
{
  const col = await import('../public/js/ui/collection.js');
  await col.render();
  let tiles = document.querySelectorAll('#collection-grid .cc-tile');
  check('коллекция: ровно 30 карт (без монеты/скелета)', tiles.length === 30, `плиток ${tiles.length}`);

  document.querySelector('#collection-filters .cf-btn[data-type="minion"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  tiles = document.querySelectorAll('#collection-grid .cc-tile');
  check('коллекция: фильтр «существа» — 15', tiles.length === 15, `плиток ${tiles.length}`);

  document.querySelector('#collection-filters .cf-btn[data-type="all"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const sortSel = document.getElementById('collection-sort');
  sortSel.value = 'name';
  sortSel.dispatchEvent(new window.Event('change'));
  const names = [...document.querySelectorAll('#collection-grid .cc-name')].map((e) => e.textContent);
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'ru'));
  check('коллекция: сортировка по имени', JSON.stringify(names) === JSON.stringify(sorted));

  // детальная карта
  document.querySelector('#collection-grid .cc-tile').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const d = document.getElementById('card-detail');
  const firstName = names[0];
  check('коллекция: детальная карта открыта (имя + текст)', !d.hidden && d.textContent.includes(firstName), d.textContent.slice(0, 80));
  d.querySelector('[data-close]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('коллекция: детальная закрыта', d.hidden);
}

// ── 12. Этап 5: настройки (localStorage, живое применение) ──
{
  const st = await import('../public/js/ui/settings.js');
  const sfxChk = document.getElementById('set-sfx');
  sfxChk.checked = false;
  sfxChk.dispatchEvent(new window.Event('change'));
  let saved = JSON.parse(window.localStorage.getItem('emberfall:settings') ?? 'null');
  check('настройки: sfx выкл — сохранено', !!saved && saved.sfxOn === false);
  check('настройки: hintsOn() — true', st.hintsOn() === true);

  const vol = document.getElementById('set-music-vol');
  vol.value = '40';
  vol.dispatchEvent(new window.Event('input'));
  saved = JSON.parse(window.localStorage.getItem('emberfall:settings') ?? 'null');
  check('настройки: громкость музыки — сохранена (40)', !!saved && saved.musicVol === 40);

  const hintsChk = document.getElementById('set-hints');
  hintsChk.checked = false;
  hintsChk.dispatchEvent(new window.Event('change'));
  check('настройки: подсказки выкл → hintsOn() false', st.hintsOn() === false);
  hintsChk.checked = true;
  hintsChk.dispatchEvent(new window.Event('change')); // обратно, не ломая дальнейшие проверки
}

// ── 13. Этап 5: боевой лог ──
{
  const log = await import('../public/js/game/log.js');
  log.reset();
  log.updateNames(view());
  log.appendEvents([
    { k: 'coin', seat: 1 },
    { k: 'turn_start', seat: 0, mana: 1, maxMana: 1 },
    { k: 'play_minion', seat: 0, handUid: 'h1', cardId: 'grove_spirit' },
    { k: 'attack', from: { kind: 'minion', uid: 'm-grove', seat: 0 }, to: { kind: 'minion', uid: 'm-watch', seat: 1 }, damage: 2, fatal: true, viaWeapon: false },
    { k: 'minion_died', uid: 'm-watch', seat: 1, poison: false },
    { k: 'emotion', seat: 1, emotion: 'praise' },
  ]);
  const logText = document.getElementById('log-lines').textContent;
  check('лог: «Ход 3: Alice»', /Ход 3: Alice/.test(logText), logText.slice(0, 120));
  check('лог: «Дух рощи» сыгран', /Дух рощи/.test(logText));
  check('лог: атака описана', /атакует/.test(logText));
  check('лог: «Каменный страж» погиб(ла)', /Каменный страж» погиб/.test(logText), logText.slice(0, 200));
  check('лог: эмоция на русском', /Похвала/.test(logText));
  check('лог: монета', /Монета зари/.test(logText));

  // переключатель панели
  const panel = document.getElementById('battle-log');
  document.getElementById('btn-log').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('лог: панель открывается кнопкой', panel.classList.contains('open'));
  log.reset();
  check('лог: reset очищает', /Лог пуст/.test(document.getElementById('log-lines').textContent));
}

// ── 14. Этап 5: тултип существа + контекстные подсказки ──
{
  document.getElementById('screen-game').classList.add('active');
  const watch = document.querySelector('#row-opp .unit[data-uid="m-watch"]');
  watch.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  const tip = document.getElementById('card-tip');
  check('тултип: показан при наведении', !tip.hidden);
  check('тултип: имя + текущие статы', /Каменный страж/.test(tip.textContent) && /3\/3/.test(tip.textContent));
  check('тултип: словарь ключевых слов', /Провокация:/.test(tip.textContent));
  document.getElementById('hand').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  check('тултип: скрыт при уходе курсора', tip.hidden);

  // контекстная подсказка «действий нет»
  const v = view();
  v.self.hand = [{ uid: 'h-x', cardId: 'fireball', playable: false, targets: [] }];
  v.self.attacks = { minions: [], weapon: null };
  v.turn = 0;
  v.status = 'running';
  gameUI.onState(v);
  check('подсказка: «Действий нет»', /Действий нет/.test(document.getElementById('hint-line').textContent), document.getElementById('hint-line').textContent);

  // подсказки выключены → строка пустая
  const hintsChk = document.getElementById('set-hints');
  hintsChk.checked = false;
  hintsChk.dispatchEvent(new window.Event('change'));
  gameUI.onState(view());
  check('подсказка: выкл в настройках → строка пуста', document.getElementById('hint-line').textContent === '');
  hintsChk.checked = true;
  hintsChk.dispatchEvent(new window.Event('change'));
}

console.log(failures === 0 ? '\n=== SIM UI: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ===' : `\n=== SIM UI: ПРОВАЛОВ: ${failures} ===`);
process.exit(failures === 0 ? 0 : 1);
