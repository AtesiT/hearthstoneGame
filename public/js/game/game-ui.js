// game-ui.js — UI игрового стола (Этап 2).
//
// Клиент тонкий: состояние приходит снапшотами (ViewState), клиент
// только рендерит и отправляет команды (play_card / end_turn).
// Правила здесь НЕ вычисляются — валидные цели приходят от сервера.
//
// Анимации Этапа 2: pop-in карт, fade-out смертей, числа урона,
// баннер хода, вспышки. Полная FX-система (частицы, тряска) — Этап 4.
import { cardDef } from './cards.js';
import { cardArt, heroArt } from './art.js';

// Этап 4: если PNG арта не хватает (развёртка без файлов) — серый плейсхолдер
const ART_FALLBACK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR42mNwcwv4HxWV8p9cmoESzSCaYdQFoy4YdcEgcQEA/JD5ELR8TswAAAAASUVORK5CYII=';
document.addEventListener('error', (e) => {
  const img = e.target;
  if (
    img && img.tagName === 'IMG' && !img.dataset.fb &&
    (img.closest('.unit-art') || img.closest('.hc-art') || img.closest('.hero-avatar'))
  ) {
    img.dataset.fb = '1';
    img.src = ART_FALLBACK;
  }
}, true);
import * as sfx from '../audio/sfx.js';
import { emojiSprite, EMOTION_ORDER, EMOTION_TITLE } from './emojis.js';
import * as log from './log.js';
import { hintsOn } from '../ui/settings.js';
import { KEYWORDS_RU as KW_RU } from './cardtext.js';
import { initFx } from './fx.js';
import {
  KW_TEXT, KW_SHORT, RAR_TEXT,
  effectText, shortDesc, tipHtml, describeCard, esc,
} from './cardtips.js';

// ---------- состояние ----------
let vs = null;            // последний снапшот
let lastSeq = 0;          // seq для ack
let selected = null;      // uid выбранной карты в руке
let resultShownFlag = false;
let hooks = null;         // {send, toast, onBackToLobby}
let fx = null;            // слой анимаций/звука (fx.js)
const unitEls = new Map(); // uid → DOM (поле)
const handEls = new Map(); // uid → DOM (рука)

// ---------- API ----------

export function init({ send, toast, onBackToLobby }) {
  hooks = { send, toast, onBackToLobby };
  fx = initFx({ getVs: () => vs, unitEls, toast: (m, k) => hooks?.toast(m, k) });
  buildTable();
  initUnitTips(); // Этап 5: тултипы существ на поле
}

// ═══════════════════════ ТУЛТИПЫ СУЩЕСТВ (Этап 5) ═══════════════════════

function hideUnitTip() {
  const tip = document.getElementById('card-tip');
  if (tip) tip.hidden = true;
}

function initUnitTips() {
  const tip = document.getElementById('card-tip');
  if (!tip) return;

  const showFor = (el) => {
    if (!vs) return;
    const uid = el.dataset.uid;
    const m = [...vs.self.board, ...vs.opp.board].find((x) => x.uid === uid);
    const def = m && cardDef(m.cardId);
    if (!m || !def) return hideUnitTip();

    const kw = (def.keywords ?? []).map((k) => {
      const d = KW_RU[k];
      return d ? `<div class="ct-kw"><b>${esc(d.name)}:</b> ${esc(d.desc)}</div>` : '';
    }).join('');
    const lines = [];
    if (def.battlecry?.length) lines.push('Боевой клич: ' + def.battlecry.map((e) => effectText(e)).join(', '));
    if (def.deathrattle?.length) lines.push('Смертный хрип: ' + def.deathrattle.map((e) => effectText(e)).join(', '));
    if (def.aura) lines.push('Аура: ' + effectText(def.aura));

    tip.innerHTML = `
      <div class="ct-head"><b>${esc(def.name)}</b> <span class="ct-sub">${m.seat === vs.self.seat ? 'ваше' : 'вражеское'} существо</span></div>
      <div class="ct-cur">${m.atk}/${m.health} (база ${m.baseAtk}/${m.baseHealth})${m.frozen ? ' · оглушено' : ''}${m.ds ? ' · божественный щит' : ''}</div>
      ${lines.map((l) => `<div class="ct-line">${esc(l)}</div>`).join('')}
      ${kw}
      ${def.flavor ? `<div class="ct-flavor">${esc(def.flavor)}</div>` : ''}`;
    tip.hidden = false;
    // позиционирование: над существом, по центру, с клампом к краям
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    let top = r.top - tip.offsetHeight - 10;
    if (top < 8) top = r.bottom + 10;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('.unit');
    if (el && el.closest('#table') && document.getElementById('screen-game')?.classList.contains('active')) {
      showFor(el);
    } else {
      hideUnitTip();
    }
  });
  document.addEventListener('scroll', hideUnitTip, true);
}

/** Новый снапшот от сервера. */
export function onState(v) {
  const first = !vs;
  const freshGame = !first && v.seq < lastSeq; // новая партия: seq сброшен (rematch)
  if (freshGame) {
    for (const el of unitEls.values()) el.remove();
    for (const el of handEls.values()) el.remove();
    unitEls.clear();
    handEls.clear();
    selected = null;
    fx.resetShown();
    resultShownFlag = false;
    hideResultOverlay();
    lastSeq = 0;
  }
  vs = v;
  const newEvents = first ? [] : v.events.filter((e) => e.seq > lastSeq);
  lastSeq = v.seq;

  // Этап 5: боевой лог
  if (freshGame) log.reset();
  log.updateNames(v);
  if (!first) log.appendEvents(newEvents);

  if (first) {
    // Стартовый рендер без «проигрывания» событий; баннер хода покажем позже.
    render();
    setTimeout(() => fx.showBanner(isMyTurn() ? 'ВАШ ХОД' : 'ХОД ПРОТИВНИКА'), 600);
  } else {
    render();
    fx.playEvents(newEvents);
  }

  if (vs.status === 'ended' && !resultShownFlag) showResult();
  if (vs.status === 'running' && selected && !stillSelectedValid()) clearSelection();
}

export function isMyTurn() {
  return !!vs && vs.status === 'running' && vs.turn === vs.self.seat;
}

export function clearSelection() {
  if (!selected) return;
  selected = null;
  applyHighlights();
  updateHint();
}

/** Результат матча сейчас показан (для main.js: не перебивать лобби-обновлением). */
export function resultShown() {
  return resultShownFlag;
}

/** Полный сброс стола (выход из комнаты / новая игра). */
export function reset() {
  vs = null;
  lastSeq = 0;
  selected = null;
  fx.resetShown();
  resultShownFlag = false;
  hideResultOverlay();
  for (const el of unitEls.values()) el.remove();
  for (const el of handEls.values()) el.remove();
  unitEls.clear();
  handEls.clear();
  log.reset();
}

// ═══════════════════════ ПОСТРОЕНИЕ СТОЛА ═══════════════════════

function buildTable() {
  const rowOpp = document.getElementById('row-opp');
  const rowSelf = document.getElementById('row-self');
  for (const row of [rowOpp, rowSelf]) {
    for (let i = 0; i < 7; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      row.appendChild(slot);
    }
  }
  document.getElementById('btn-end-turn').addEventListener('click', () => {
    if (!isMyTurn()) return;
    clearSelection();
    hooks.send('end_turn', { ack: lastSeq });
  });
  document.getElementById('btn-result-lobby').addEventListener('click', () => {
    resultShownFlag = false;
    hideResultOverlay();
    hooks.onBackToLobby();
  });
  // Клик по своему герою — выбор оружия (Этап 3)
  document.getElementById('self-hero').addEventListener('click', (e) => {
    e.stopPropagation();
    onSelfHeroClick();
  });
  // Клик по «воздуху» стола — снять выбор
  document.getElementById('table').addEventListener('click', (e) => {
    if (e.target.id === 'table' || e.target.classList.contains('board')) clearSelection();
  });

  // ── Этап 4: панель эмоций (над рукой, в нижней строке) ──
  const bar = document.createElement('div');
  bar.className = 'emote-bar';
  for (const emo of EMOTION_ORDER) {
    const b = document.createElement('button');
    b.className = 'emote-btn';
    b.title = EMOTION_TITLE[emo];
    b.innerHTML = `<img src="${emojiSprite(emo)}" alt="" draggable="false">`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      hooks.send('send_emotion', { emotion: emo, ack: lastSeq });
      sfx.play('emotion' + EMOTION_ORDER.indexOf(emo)); // локальный бип сразу
    });
    bar.appendChild(b);
  }
  const selfRow = document.querySelector('.self-row');
  if (selfRow) selfRow.insertBefore(bar, selfRow.querySelector('.end-turn-wrap'));

  // ── Этап 4: виньетка урона по моему герою ──
  const vg = document.createElement('div');
  vg.id = 'vignette';
  document.getElementById('table').appendChild(vg);

  // ── Этап 4: аудио разблокируется первым жестом (требование браузеров) ──
  document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });

  // Кнопка звука (вверху справа)
  const mute = document.createElement('button');
  mute.className = 'btn-mute';
  mute.id = 'btn-mute';
  mute.title = 'Звук вкл/выкл';
  mute.textContent = '♪';
  if (sfx.isMuted()) mute.classList.add('off');
  mute.addEventListener('click', (e) => {
    e.stopPropagation();
    sfx.setMuted(!sfx.isMuted());
    mute.classList.toggle('off', sfx.isMuted());
    if (!sfx.isMuted()) sfx.play('blip');
  });
  document.getElementById('table').appendChild(mute);
}

// ═══════════════════════ РЕНДЕР (приведение к снапшоту) ═══════════════════════

function render() {
  if (!vs) return;
  renderHero('self');
  renderHero('opp');
  renderMana();
  renderDeck('self');
  renderDeck('opp');
  renderOppHand();
  renderBoard();
  renderHand();
  renderControls();
}

function renderHero(side) {
  const p = side === 'self' ? vs.self : vs.opp;
  const el = (id) => document.getElementById(id);
  el(`${side}-name`).textContent = `${p.nick} · ${p.hero.name}`;
  const hpEl = el(`${side}-hp`);
  hpEl.textContent = Math.max(0, p.hero.hp);
  hpEl.parentElement.classList.toggle('hurt', p.hero.hp < p.hero.maxHp);
  // оружие
  const w = el(`${side}-weapon`);
  if (p.hero.weapon) {
    const def = cardDef(p.hero.weapon.cardId);
    w.hidden = false;
    w.title = def?.name ?? p.hero.weapon.cardId;
    w.innerHTML = `<span class="w-atk">${p.hero.weapon.attack}</span><span class="w-dur">${p.hero.weapon.durability}</span>`;
  } else {
    w.hidden = true;
    w.innerHTML = '';
  }
  // Этап 4: аватар героя — PNG из репо (seat 0 — Кайл, seat 1 — Мариса)
  const av = el(`${side}-avatar`);
  const img = document.createElement('img');
  img.src = heroArt(p.seat);
  img.alt = p.hero?.name ?? p.nick;
  img.draggable = false;
  av.innerHTML = '';
  av.appendChild(img);
  av.className = `hero-avatar av-${p.seat}` + (p.seat === vs.self.seat ? '' : ' av-opp');
}

function renderMana() {
  const box = document.getElementById('mana');
  const { mana, maxMana } = vs.self;
  if (box.childElementCount !== maxMana) {
    box.innerHTML = '';
    for (let i = 0; i < maxMana; i++) {
      const c = document.createElement('i');
      c.className = 'mana-crystal';
      box.appendChild(c);
    }
  }
  [...box.children].forEach((c, i) => c.classList.toggle('full', i < mana));
}

function renderDeck(side) {
  const p = side === 'self' ? vs.self : vs.opp;
  document.getElementById(`${side}-deck-count`).textContent = p.deckCount;
}

function renderOppHand() {
  const box = document.getElementById('opp-hand');
  const n = Math.min(vs.opp.handCount, 10);
  if (box.childElementCount !== n) {
    box.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const b = document.createElement('div');
      b.className = 'card-back';
      box.appendChild(b);
    }
  }
  document.getElementById('opp-hand-count').textContent = vs.opp.handCount;
}

// ---------- поле ----------

function renderBoard() {
  const seen = new Set();
  for (const side of ['opp', 'self']) {
    const p = side === 'self' ? vs.self : vs.opp;
    const row = document.getElementById(side === 'self' ? 'row-self' : 'row-opp');
    p.board.forEach((m, i) => {
      seen.add(m.uid);
      let el = unitEls.get(m.uid);
      const isNew = !el;
      if (isNew) {
        el = createUnitEl(m);
        unitEls.set(m.uid, el);
      }
      const slot = row.children[Math.min(i, 6)];
      if (el.parentElement !== slot) slot.appendChild(el);
      updateUnitEl(el, m);
      if (isNew) {
        el.classList.add('pop-in');
        setTimeout(() => el.classList.remove('pop-in'), 320);
      }
    });
  }
  // removal — ОДИН проход по обоим полям (unitEls общий).
  // Живой элемент сразу уступает место; fade-out идёт на инертном клоне
  // (cloneNode не копирует обработчики — дублей кликов не будет).
  for (const [uid, el] of [...unitEls]) {
    if (!seen.has(uid)) {
      unitEls.delete(uid);
      const parent = el.parentNode;
      const ghost = el.cloneNode(true);
      ghost.classList.add('dying');
      fx.spawnParticles(el); // пепел (Этап 4)
      if (parent) {
        parent.insertBefore(ghost, el);
        el.remove();
        setTimeout(() => ghost.remove(), 360);
      } else {
        el.remove();
      }
    }
  }
}

function createUnitEl(m) {
  const def = cardDef(m.cardId);
  const el = document.createElement('div');
  el.className = 'unit';
  el.dataset.uid = m.uid;
  el.innerHTML = `
    <div class="unit-art"><img src="${def ? cardArt(def) : ''}" alt="" draggable="false"></div>
    <div class="unit-name">${esc(def?.name ?? m.cardId)}</div>
    <div class="unit-kw"></div>
    <div class="unit-hp"><i class="v">0</i></div>
    <div class="unit-atk"><i class="v">0</i></div>
    <div class="unit-buff" hidden>▲</div>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onUnitClick(el);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearSelection();
  });
  return el;
}

function updateUnitEl(el, m) {
  el.dataset.seat = String(m.seat);
  el.classList.toggle('unit-mine', m.seat === vs.self.seat);
  el.classList.toggle('unit-opp', m.seat !== vs.self.seat);
  el.classList.toggle('sick', m.justPlayed);
  el.classList.toggle('frozen', m.frozen);
  el.classList.toggle('has-ds', m.ds);
  // готовность к атаке (список приходит от сервера)
  const ready = m.seat === vs.self.seat &&
    vs.self.attacks?.minions?.some((a) => a.uid === m.uid);
  el.classList.toggle('can-attack', !!ready);
  el.querySelector('.unit-hp .v').textContent = m.health;
  el.querySelector('.unit-atk .v').textContent = m.atk;
  el.querySelector('.unit-hp').classList.toggle('buffed', m.health > m.baseHealth);
  el.querySelector('.unit-atk').classList.toggle('buffed', m.atk > m.baseAtk);
  const def = cardDef(m.cardId);
  el.querySelector('.unit-kw').innerHTML = (def?.keywords || [])
    .map((k) => `<span class="kw kw-${k}">${KW_SHORT[k] ?? k}</span>`)
    .join('');
  el.querySelector('.unit-buff').hidden = !(m.atk > m.baseAtk || m.health > m.baseHealth);
  el.title = def ? describeCard(def) : '';
}

// ---------- рука ----------

function renderHand() {
  const box = document.getElementById('hand');
  const seen = new Set();
  vs.self.hand.forEach((opt) => {
    seen.add(opt.uid);
    let el = handEls.get(opt.uid);
    const isNew = !el;
    if (isNew) {
      el = createHandCard(opt.cardId);
      handEls.set(opt.uid, el);
    }
    if (el.parentElement !== box) box.appendChild(el);
    updateHandCard(el, opt);
    if (isNew) {
      el.classList.add('pop-in');
      setTimeout(() => el.classList.remove('pop-in'), 320);
    }
  });
  for (const [uid, el] of [...handEls]) {
    if (!seen.has(uid)) {
      handEls.delete(uid);
      el.classList.add('dying');
      const old = el;
      setTimeout(() => old.remove(), 300);
    }
  }
  applyHighlights();
  updateHint();
}

function createHandCard(cardId) {
  const def = cardDef(cardId);
  const el = document.createElement('div');
  el.className = 'hand-card';
  el.dataset.uid = ''; // заполняется в update
  el.innerHTML = `
    <div class="hc-cost">0</div>
    <div class="hc-art"><img src="${def ? cardArt(def) : ''}" alt="" draggable="false"></div>
    <div class="hc-name"></div>
    <div class="hc-desc"></div>
    <div class="hc-stats" hidden><span class="hc-atk">0</span><span class="hc-hp">0</span></div>
    <div class="hc-tip"></div>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onHandCardClick(el);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearSelection();
  });
  return el;
}

function updateHandCard(el, opt) {
  const def = cardDef(opt.cardId);
  el.dataset.uid = opt.uid;
  el.className = `hand-card type-${def?.type} rar-${def?.rarity ?? 'common'}`;
  if (!opt.playable) el.classList.add('unplayable');
  if (selected === opt.uid) el.classList.add('selected');
  el.querySelector('.hc-cost').textContent = def?.cost ?? 0;
  el.querySelector('.hc-name').textContent = def?.name ?? opt.cardId;
  el.querySelector('.hc-desc').textContent = shortDesc(def);
  const stats = el.querySelector('.hc-stats');
  if (def?.type === 'minion') {
    stats.hidden = false;
    el.querySelector('.hc-atk').textContent = def.attack;
    el.querySelector('.hc-hp').textContent = def.health;
  } else if (def?.type === 'weapon') {
    stats.hidden = false;
    el.querySelector('.hc-atk').textContent = def.attack;
    el.querySelector('.hc-hp').textContent = def.durability;
  } else {
    stats.hidden = true;
  }
  el.querySelector('.hc-tip').innerHTML = tipHtml(def);
}

// ---------- управление ----------

function renderControls() {
  const btn = document.getElementById('btn-end-turn');
  btn.disabled = !isMyTurn();
  const ti = document.getElementById('turn-indicator');
  ti.textContent = isMyTurn() ? `Ваш ход · ${vs.turnCount}` : `Ход противника · ${vs.turnCount}`;
  ti.classList.toggle('mine', isMyTurn());
  // оружие: подсвечка готовности к атаке
  document.getElementById('self-hero').classList.toggle('can-weapon', !!vs.self.attacks?.weapon);
}

// ═══════════════════════ ВЫБОР И ЦЕЛИ ═══════════════════════
// selected: {kind:'card', uid} | {kind:'unit', uid} | {kind:'weapon'} | null

/** Валидные цели текущего выбора (из данных сервера). */
function selectedTargets() {
  if (!selected || !vs) return [];
  if (selected.kind === 'card') {
    return vs.self.hand.find((o) => o.uid === selected.uid)?.targets ?? [];
  }
  if (selected.kind === 'unit') {
    return vs.self.attacks?.minions?.find((a) => a.uid === selected.uid)?.targets ?? [];
  }
  if (selected.kind === 'weapon') {
    return vs.self.attacks?.weapon?.targets ?? [];
  }
  return [];
}

function onHandCardClick(el) {
  const uid = el.dataset.uid;
  if (!isMyTurn()) return;
  const opt = vs.self.hand.find((o) => o.uid === uid);
  if (!opt || !opt.playable) {
    hooks.toast('Сейчас эту карту сыграть нельзя', 'error');
    return;
  }
  if (selected?.kind === 'card' && selected.uid === uid) {
    if (!opt.targets.length) {
      playCard(uid, null); // второй клик — сыграть без цели
    } else {
      clearSelection();
    }
    return;
  }
  selected = { kind: 'card', uid };
  applyHighlights();
  updateHint();
}

function onUnitClick(el) {
  const uid = el.dataset.uid;
  const seat = Number(el.dataset.seat);
  const ref = { kind: 'minion', uid, seat };

  if (selected) {
    if (seat === vs.self.seat) {
      // Свой юнит: либо цель для friendly-спелла, либо снятие выбора
      const targets = selected.kind === 'card' ? selectedTargets() : [];
      if (selected.kind === 'card' && targets.some((t) => sameRef(t, ref))) {
        playCard(selected.uid, ref);
      } else {
        clearSelection();
      }
      return;
    }
    // Чужой юнит
    if (selectedTargets().some((t) => sameRef(t, ref))) {
      if (selected.kind === 'card') playCard(selected.uid, ref);
      else sendAttack(ref);
    } else {
      hooks.toast('Недопустимая цель (таунт? столетие?)', 'error');
    }
    return;
  }

  // Без выбора: своё существо — атака?
  if (seat === vs.self.seat && isMyTurn()) {
    const opt = vs.self.attacks?.minions?.find((a) => a.uid === uid);
    if (opt) {
      selected = { kind: 'unit', uid };
      applyHighlights();
      updateHint();
    } else {
      const m = vs.self.board.find((b) => b.uid === uid);
      document.getElementById('hint-line').textContent = m?.frozen
        ? 'Оглушено — атака невозможна'
        : 'Не может атаковать (болезнь новичка / уже атаковало)';
    }
  }
}

function onSelfHeroClick() {
  // Оружие: клик по своему герою
  if (selected) {
    clearSelection();
    return;
  }
  if (!isMyTurn()) return;
  if (vs.self.attacks?.weapon) {
    selected = { kind: 'weapon' };
    applyHighlights();
    updateHint();
  }
}

// Клик по герою противника (бублит до document)
document.addEventListener('click', (e) => {
  if (!vs || !selected) return;
  if (e.target.id === 'opp-hero' || e.target.closest('#opp-hero')) {
    const ref = { kind: 'hero', seat: vs.opp.seat };
    if (selectedTargets().some((t) => sameRef(t, ref))) {
      if (selected.kind === 'card') playCard(selected.uid, ref);
      else sendAttack(ref);
    } else if (selected.kind !== 'card') {
      hooks.toast('Герой — недопустимая цель (таунт?)', 'error');
    }
  }
});

function playCard(uid, target) {
  hooks.send('play_card', { handUid: uid, target: target ?? undefined, ack: lastSeq });
  clearSelection();
}

function sendAttack(targetRef) {
  hooks.send('attack', {
    fromUid: selected.kind === 'weapon' ? 'weapon' : selected.uid,
    fromSeat: vs.self.seat,
    toUid: targetRef.kind === 'minion' ? targetRef.uid : null,
    toSeat: targetRef.seat,
    ack: lastSeq,
  });
  clearSelection();
}

function sameRef(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'hero') return a.seat === b.seat;
  return a.uid === b.uid;
}

function stillSelectedValid() {
  if (!isMyTurn() || !selected || !vs) return false;
  return selectedTargets().length >= 0 &&
    (selected.kind !== 'unit' || vs.self.attacks?.minions?.some((a) => a.uid === selected.uid)) &&
    (selected.kind !== 'weapon' || !!vs.self.attacks?.weapon) &&
    (selected.kind !== 'card' || vs.self.hand.some((o) => o.uid === selected.uid && o.playable));
}

function applyHighlights() {
  // сброс
  for (const el of unitEls.values()) {
    el.classList.remove('targetable');
    el.classList.remove('selected');
  }
  document.getElementById('opp-hero').classList.remove('targetable');
  for (const el of handEls.values()) {
    el.classList.toggle('selected', selected?.kind === 'card' && el.dataset.uid === selected.uid);
  }
  if (!selected || !vs) return;
  if (selected.kind === 'unit') {
    unitEls.get(selected.uid)?.classList.add('selected');
  }
  for (const t of selectedTargets()) {
    if (t.kind === 'minion') {
      unitEls.get(t.uid)?.classList.add('targetable');
    } else if (t.kind === 'hero' && t.seat === vs.opp.seat) {
      document.getElementById('opp-hero').classList.add('targetable');
    }
  }
}

function updateHint() {
  const el = document.getElementById('hint-line');
  if (!hintsOn()) { el.textContent = ''; return; } // Этап 5: настройки
  if (!selected || !vs) {
    if (!isMyTurn()) {
      el.textContent = 'Ждём ход противника…';
      return;
    }
    // Этап 5: контекстные подсказки
    const boardFull = vs.self.board.length >= 7;
    const canPlay = vs.self.hand.some((o) => o.playable);
    const canAtk = (vs.self.attacks?.minions?.length ?? 0) > 0
      || (vs.self.attacks?.weapon?.targets?.length ?? 0) > 0;
    if (boardFull) el.textContent = 'Поле полное (7/7) — существа сыграть нельзя';
    else if (!canPlay && !canAtk) el.textContent = 'Действий нет — завершите ход';
    else if (!canPlay) el.textContent = 'Карты сыграть нельзя (мана) — атакуйте';
    else el.textContent = 'Сыграйте карту, атакуйте или завершите ход';
    return;
  }
  if (selected.kind === 'card') {
    const opt = vs.self.hand.find((o) => o.uid === selected.uid);
    el.textContent = opt?.targets.length
      ? 'Выберите цель (ПКМ / Esc — отмена)'
      : 'Кликните карту ещё раз — чтобы сыграть';
  } else {
    el.textContent = 'Выберите цель атаки (ПКМ / Esc — отмена)';
  }
}


// ═══════════════════════ РЕЗУЛЬТАТ ═══════════════════════

function hideResultOverlay() {
  const ov = document.getElementById('result-overlay');
  if (!ov) return;
  ov.hidden = true;
  ov.setAttribute('aria-hidden', 'true');
}
function showResult() {
  resultShownFlag = true;
  const won = vs.winner === vs.self.seat;
  document.getElementById('result-title').textContent = won ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ';
  document.getElementById('result-title').className = won ? 'win' : 'lose';
  const reason =
    vs.winReason === 'hero_kill' ? 'Герой противника пал' : 'Матч завершён';
  document.getElementById('result-reason').textContent = reason;
  const ov = document.getElementById('result-overlay');
  ov.hidden = false;
  ov.setAttribute('aria-hidden', 'false');
}

