// main.js — клиент EMBERFALL: машина экранов + обработка сетевых сообщений.
// Клиент тонкий: не знает правил игры, только рендер viewState и команды.
//
// Экраны: menu → lobby → waiting → game.
// Оверлей: переподключение / «оппонент отключился» / вытеснение.
import { NetClient } from '../net/client.js';
import * as gameUI from '../game/game-ui.js';
import { cardsMap } from '../game/cards.js';
import * as music from '../audio/music.js';
import * as sfx from '../audio/sfx.js';
import * as collection from './collection.js';
import * as settings from './settings.js';
import * as log from '../game/log.js';

const $ = (s) => document.querySelector(s);
const LS_NICK = 'emberfall:nick';
const NICK_RE = /^[A-Za-zА-Яа-яЁё0-9_]{3,16}$/;

// Безопасный доступ к localStorage (в приватном режиме может быть недоступен).
const ls = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* ignore */ }
  },
};

// ---------- локальное состояние ----------
let currentScreen = 'menu';
let room = null; // последний room_update
let inGame = false;
let oppLeftTimer = null; // обратный отсчёт, пока grace на сервере

// ---------- сетевой клиент ----------
const net = new NetClient({
  onMessage: onNetMessage,
  onOpen: () => setNetStatus(true),
  onClose: () => setNetStatus(false),
  onReconnectAttempt: (n) => showReconnectAttempt(n),
  onReconnectFailed: () => showReconnectFailed(),
  onLostNoRoom: () => toast('Переподключение к серверу…', 'warn'),
});

// ═══════════════════════ СЕТЬ: обработка сообщений ═══════════════════════

function onNetMessage(m) {
  switch (m.t) {
    case 'welcome':
      break;
    case 'rooms':
      if (currentScreen === 'lobby') renderRoomList(m.d.rooms);
      break;
    case 'room_update':
      onRoomUpdate(m.d);
      break;
    case 'state':
      net.noteSeq(m.d.seq); // ping.ack — сервер упрощает следующие снапшоты
      gameUI.onState(m.d);
      break;
    case 'opp_left':
      onOppLeft();
      break;
    case 'opp_back':
      hideOppLeft();
      toast('Оппонент переподключился', 'ok');
      break;
    case 'opp_left_final':
      // Матч остановлен (обрыв + grace истёк, либо добровольный выход).
      // Комната уже возвращается в лобби — оверлей уйдёт с room_update.
      if (inGame) {
        showOverlay({
          title: 'Противник покинул игру',
          hint: 'Матч остановлен. Комната возвращается в лобби…',
          count: null,
          noMenu: true,
        });
      } else {
        toast('Оппонент покинул матч', 'warn');
      }
      break;
    case 'error':
      toast(m.d.msg || 'Ошибка', 'error');
      break;
    case 'kicked':
      onKicked(m.d);
      break;
    case 'bye':
      toast(m.d.msg || 'Сервер закрыт', 'warn');
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

/** Снапшот комнаты — единственный источник «лобби-истины» для клиента. */
function onRoomUpdate(d) {
  room = d;
  if (d.myToken) net.setRoom(d.code, d.myToken);

  // Меня больше нет в комнате (вышел / комната разобрана).
  if (d.mySeat === null || !d.seats[d.mySeat]) {
    net.clearRoom();
    room = null;
    if (inGame) {
      inGame = false;
    }
    if (currentScreen === 'waiting' || currentScreen === 'game') {
      showScreen('menu');
    }
    return;
  }

  hideOppLeft();
  if (d.phase === 'game') {
    inGame = true;
    if (currentScreen !== 'game') showScreen('game');
    // сам стол нарисует пришедший снапшот (state)
  } else {
    // Партия завершена и результат на экране — не перебиваем его;
    // из него выводят кнопкой «В лобби».
    if (inGame && gameUI.resultShown()) return;
    inGame = false;
    showScreen('waiting');
    renderWaiting();
  }
}

/** Оппонент отключился во время матча (этап 1: игра «остановлена»). */
function onOppLeft() {
  showOverlay({
    title: 'Оппонент отключился',
    hint: 'Ждём переподключения… Игра остановлена.',
    count: 30,
    countStep: -1,
    noMenu: true,
  });
}

function hideOppLeft() {
  if (oppLeftTimer) {
    clearInterval(oppLeftTimer);
    oppLeftTimer = null;
  }
  if (!$('#overlay').hidden && !net._pendingReconnect) hideOverlay();
}

function onKicked(d) {
  net.giveUp();
  room = null;
  inGame = false;
  showOverlay({
    title: 'Вытеснение',
    hint: d.msg || 'Другое устройство заняло ваше место в комнате.',
    count: null,
    noMenu: false,
  });
}

// ═══════════════════════ ЭКРАНЫ ═══════════════════════

function showScreen(name) {
  currentScreen = name;
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $(`#screen-${name}`);
  if (el) el.classList.add('active');
  if (name === 'lobby') {
    net.send('list_rooms', {});
  }
  if (name === 'collection') {
    collection.render(); // Этап 5: коллекция карт
  }
  // Этап 4: музыка — бой в матче, меню во всех остальных экранах
  music.setTheme(name === 'game' ? 'battle' : 'menu');
}

// ---------- лобби ----------

function renderRoomList(rooms) {
  const el = $('#room-list');
  el.innerHTML = '';
  if (!rooms.length) {
    el.innerHTML = '<div class="room-empty">Пока нет комнат — создайте первую!</div>';
    return;
  }
  for (const r of rooms) {
    const joinable = r.players < 2 && r.phase === 'lobby';
    const row = document.createElement('div');
    row.className = 'room-row';
    row.innerHTML = `
      <span class="rr-code">${esc(r.code)}</span>
      <span class="rr-host" title="${esc(r.host)}">${esc(r.host)}</span>
      <span class="rr-players">${r.players}/2</span>
      <span class="rr-phase ${r.phase}">${r.phase === 'game' ? 'в матче' : 'ожидание'}</span>
      <button class="btn btn-small ${joinable ? 'btn-amber' : ''}" ${joinable ? '' : 'disabled'}>Войти</button>`;
    if (joinable) {
      row.querySelector('button').addEventListener('click', () => tryJoin(r.code));
    }
    el.appendChild(row);
  }
}

function tryJoin(code) {
  if (!validNickInput(false)) return;
  net.send('join_room', { code: code.toUpperCase(), nick: nickValue() });
}

// ---------- ожидание ----------

function renderWaiting() {
  if (!room) return;
  $('#room-code').textContent = room.code;
  const seatsEl = $('#seats');
  seatsEl.innerHTML = '';

  room.seats.forEach((s, i) => {
    const div = document.createElement('div');
    if (s) {
      div.className = 'seat-row';
      div.innerHTML = `
        <div class="seat-avatar av-${i}">${esc(s.nick[0].toUpperCase())}</div>
        <div class="seat-name">${esc(s.nick)}${i === room.mySeat ? ' <span class="you">(вы)</span>' : ''}</div>
        <div class="seat-status ${!s.connected ? 'st-disconnect' : s.ready ? 'st-ready' : ''}">
          ${!s.connected ? 'переподключение…' : s.ready ? 'готов' : 'не готов'}
        </div>`;
    } else {
      div.className = 'seat-row seat-empty';
      div.innerHTML = `
        <div class="seat-avatar av-x">?</div>
        <div class="seat-name">Ожидание игрока…</div>
        <div class="seat-status st-wait">—</div>`;
    }
    seatsEl.appendChild(div);
  });

  const me = room.seats[room.mySeat];
  const btnReady = $('#btn-ready');
  btnReady.textContent = me.ready ? 'Снять готовность' : 'Готов';
  btnReady.disabled = !me.connected;
  const bothReady =
    room.seats[0] && room.seats[1] &&
    room.seats[0].ready && room.seats[1].ready &&
    room.seats[0].connected && room.seats[1].connected;
  $('#btn-start').hidden = !(room.mySeat === 0 && bothReady);
}

// ═══════════════════════ ОВЕРЛЕЙ И ТОСТЫ ═══════════════════════

function showOverlay({ title, hint, count = null, countStep = 0, noMenu = false }) {
  if (oppLeftTimer) {
    clearInterval(oppLeftTimer);
    oppLeftTimer = null;
  }
  $('#overlay-title').textContent = title;
  $('#overlay-hint').textContent = hint;
  const c = $('#overlay-count');
  if (count !== null) {
    c.hidden = false;
    c.textContent = String(count);
    if (countStep !== 0) {
      oppLeftTimer = setInterval(() => {
        const v = parseInt(c.textContent, 10);
        if (!Number.isFinite(v) || v <= 0) {
          clearInterval(oppLeftTimer);
          oppLeftTimer = null;
          return;
        }
        c.textContent = String(v + countStep);
      }, 1000);
    }
  } else {
    c.hidden = true;
  }
  $('#btn-overlay-menu').hidden = noMenu;
  $('#overlay').hidden = false;
}

function hideOverlay() {
  if (oppLeftTimer) {
    clearInterval(oppLeftTimer);
    oppLeftTimer = null;
  }
  $('#overlay').hidden = true;
}

function showReconnectAttempt(n) {
  showOverlay({
    title: 'Соединение потеряно',
    hint: 'Пытаемся переподключиться…',
    count: 10 - n + 1,
    countStep: -1,
    noMenu: true,
  });
}

function showReconnectFailed() {
  showOverlay({
    title: 'Соединение потеряно',
    hint: 'Не удалось переподключиться. Комната, вероятно, закрыта.',
    count: null,
    noMenu: false,
  });
}

function toast(msg, kind = 'info') {
  const box = $('#toast-box');
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3100);
}

function setNetStatus(on) {
  const el = $('#net-status');
  el.classList.toggle('off', !on);
  el.querySelector('span').textContent = on ? 'подключено' : 'отсутствует';
}

// ═══════════════════════ UI-УТИЛИТЫ ═══════════════════════

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

function nickValue() {
  return ($('#nick-input').value ?? '').trim();
}

function validNickInput(silent = true) {
  const v = nickValue();
  if (!NICK_RE.test(v)) {
    if (!silent) toast('Введите имя: 3–16 символов (буквы, цифры, «_»)', 'error');
    else if (NICK_RE.test(ls.get(LS_NICK) ?? '')) {
      $('#nick-input').value = ls.get(LS_NICK);
      return true;
    }
    return false;
  }
  ls.set(LS_NICK, v);
  return true;
}

function copyRoomCode() {
  const code = room?.code ?? '';
  if (!code) return;
  const done = () => toast('Код скопирован', 'ok');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(code).then(done, () => fallbackCopy(code, done));
  } else {
    fallbackCopy(code, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    toast(`Ваш код: ${text}`, 'info');
  }
  ta.remove();
}

// ---------- декор: «угольки» и пиксельное пламя ----------

function initEmbers() {
  const box = $('#embers');
  const colors = ['#ffb347', '#ff8c42', '#ffd24a', '#e05252'];
  for (let i = 0; i < 26; i++) {
    const e = document.createElement('i');
    const s = 2 + ((Math.random() * 4) | 0);
    e.style.cssText = `left:${(Math.random() * 100).toFixed(2)}vw;width:${s}px;height:${s}px;` +
      `background:${colors[i % 4]};animation-duration:${(7 + Math.random() * 9).toFixed(1)}s;` +
      `animation-delay:-${(Math.random() * 14).toFixed(1)}s;--o:${(0.2 + Math.random() * 0.5).toFixed(2)};` +
      `--dx:${((Math.random() - 0.5) * 80).toFixed(0)}px;`;
    box.appendChild(e);
  }
}

function initFlame() {
  // Пиксельное пламя 7×8 — рисуется box-shadow-«пикселями» (чистый CSS-арт).
  const P = 4;
  const art = [
    '...#...',
    '..##...',
    '..##.#.',
    '.####..',
    '.#####.',
    '######.',
    '##.###.',
    '..###..',
  ];
  const shadows = [];
  art.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '#') {
        const inner = x >= 1 && x <= 4 && y >= 3 && y <= 6 && !(x === 2 && y >= 5);
        shadows.push(`${x * P}px ${y * P}px 0 0 ${inner ? '#ffd24a' : '#ff8c42'}`);
      }
    });
  });
  const el = $('#flame');
  el.style.width = `${P}px`;
  el.style.height = `${P}px`;
  el.style.boxShadow = shadows.join(',');
}

// ═══════════════════════ ОБВЯЗКА СОБЫТИЙ ═══════════════════════

function wire() {
  const nick = $('#nick-input');
  nick.addEventListener('input', () => {
    if (NICK_RE.test(nickValue())) ls.set(LS_NICK, nickValue());
  });
  nick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreateRoom();
  });

  $('#btn-create').addEventListener('click', doCreateRoom);
  $('#btn-create-lobby').addEventListener('click', doCreateRoom);
  $('#btn-ai').addEventListener('click', doStartAI);
  $('#btn-lobby').addEventListener('click', () => showScreen('lobby'));
  $('#btn-collection').addEventListener('click', () => showScreen('collection')); // Этап 5
  window.__emberfallToMenu = () => showScreen('menu'); // хук для collection/settings
  $('#btn-join').addEventListener('click', () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 5) {
      toast('Код комнаты — 5 символов', 'error');
      return;
    }
    tryJoin(code);
  });
  $('#join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join').click();
  });

  // «← Меню» в лобби и в ожидании (data-act)
  document.querySelectorAll('[data-act="back-menu"]').forEach((b) =>
    b.addEventListener('click', () => {
      if (currentScreen === 'waiting' && room) {
        leaveRoomLocally();
      }
      showScreen('menu');
    })
  );

  $('#btn-copy-code').addEventListener('click', copyRoomCode);
  $('#btn-ready').addEventListener('click', () => {
    if (!room) return;
    const me = room.seats[room.mySeat];
    net.send('toggle_ready', { ready: !me.ready });
  });
  $('#btn-start').addEventListener('click', () => net.send('start_game', {}));
  $('#btn-leave').addEventListener('click', leaveRoomLocally);
  $('#btn-overlay-menu').addEventListener('click', () => {
    net.reset();
    net.clearRoom();
    gameUI.reset();
    hideOverlay();
    room = null;
    inGame = false;
    showScreen('menu');
    net.connect();
  });

  // Esc — снять выбор / вернуться в меню из лобби
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (currentScreen === 'lobby' || currentScreen === 'menu')) {
      showScreen('menu');
    }
  });
}

function doCreateRoom() {
  if (!validNickInput(false)) return;
  net.send('create_room', { nick: nickValue() });
}

function doStartAI() {
  if (!validNickInput(false)) return;
  // Режим ИИ: сервер сам посадит бота и запустит матч.
  net.send('start_ai_game', { nick: nickValue() });
  // Ждём room_update → game_start как обычно.
  toast('Создаём матч против Ярополка…', 'ok');
}

/**
 * Добровольный выход из комнаты: сервер уведомляет только остальных
 * участников, поэтому свой экран переключаем локально сразу.
 */
function leaveRoomLocally() {
  if (!room) return;
  net.send('leave_room', {});
  net.clearRoom();
  room = null;
  inGame = false;
  gameUI.reset();
  hideOppLeft();
  showScreen('menu');
}

// ═══════════════════════ СТАРТ ═══════════════════════

function forceHideResult() {
  const ov = document.getElementById('result-overlay');
  if (ov) { ov.hidden = true; ov.setAttribute('aria-hidden', 'true'); }
}

function init() {
  initEmbers();
  initFlame();
  // Гарантия: оверлей результата НЕ виден на старте — даже если в CSS/кэше что-то пошло не так.
  forceHideResult();
  document.addEventListener('visibilitychange', forceHideResult);
  const savedNick = (ls.get(LS_NICK) ?? '').trim();
  if (NICK_RE.test(savedNick)) $('#nick-input').value = savedNick;
  // Публичный DB карт (для рендера) — подгружаем заранее
  cardsMap().catch(() => {
    toast('Не удалось загрузить описания карт', 'error');
  });
  // Игровой стол
  gameUI.init({
    send: (t, d) => net.send(t, d),
    toast,
    onBackToLobby: () => {
      // Выход в меню с экрана результата: уведомим сервер и сбросим локальное состояние.
      if (room) net.send('leave_room', {});
      net.clearRoom();
      room = null;
      inGame = false;
      gameUI.reset();
      showScreen('menu');
    },
  });
  // Esc — снять выбор карты
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentScreen === 'game') gameUI.clearSelection();
  });
  // Этап 5: коллекция, настройки, боевой лог
  collection.init();
  settings.init();
  log.initToggle();
  wire();
  net.connect();
}

init();
