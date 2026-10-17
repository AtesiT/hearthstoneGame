// log.js — боевой лог (Этап 5): лента событий на русском.
// Данные — только из снапшотов (список events) и публичного DB карт.
import { cardDef } from './cards.js';
import { KEYWORDS_RU } from './cardtext.js';

const MAX_LINES = 120;

let lines = [];          // строки лога
let uidName = new Map(); // uid → cardId (для событий про погибших)
let nicks = ['Вы', 'Противник']; // seat → ник
let turnCount = 1;

const esc = (s) => String(s).replace(/[&<>\"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** Обновить «словарь» имён из снапшота (до обработки событий). */
export function updateNames(vs) {
  nicks = [vs.self.nick, vs.opp.nick];
  turnCount = vs.turnCount;
  for (const side of [vs.self, vs.opp]) {
    for (const m of side.board ?? []) {
      if (m?.uid && m.cardId) uidName.set(m.uid, m.cardId);
    }
  }
}

const nickOf = (seat) => (seat === 0 ? nicks[0] : nicks[1]);

function unitName(ref) {
  if (!ref) return '???';
  if (ref.kind === 'hero') return `герой ${nickOf(ref.seat)}`;
  const cardId = uidName.get(ref.uid);
  const name = cardDef(cardId)?.name ?? (cardId || 'существо');
  return `${name} (${nickOf(ref.seat)})`;
}

function cardName(cardId) {
  return cardDef(cardId)?.name ?? cardId ?? 'карта';
}

/** Одна строка из события. null — событие не отображаем (fx, дубли). */
function lineFor(e) {
  switch (e.k) {
    case 'coin':
      return `Монета зари достаётся: ${nickOf(e.seat)}`;
    case 'turn_start':
      return `— Ход ${turnCount}: ${nickOf(e.seat)} (мана ${e.mana}/${e.maxMana}) —`;
    case 'draw':
      return `${nickOf(e.seat)} вытянул(а) карту`;
    case 'burn':
      return `Рука ${nickOf(e.seat)} переполнена: «${cardName(e.cardId)}» сгорает`;
    case 'play_minion': {
      const c = cardDef(e.cardId);
      return `${nickOf(e.seat)}: «${cardName(e.cardId)}»${c?.type === 'minion' ? ` (${c.attack}/${c.health})` : ''}`;
    }
    case 'play_weapon':
      return `${nickOf(e.seat)} экипировал(а) «${cardName(e.cardId)}»`;
    case 'play_spell': {
      const t = e.target ? unitName(e.target) : '';
      return `${nickOf(e.seat)}: «${cardName(e.cardId)}»${t ? ` → ${t}` : ''}`;
    }
    case 'attack': {
      const from = e.from?.kind === 'minion' ? unitName(e.from) : `«${cardName(e.from?.cardId ?? '')}» ${nickOf(e.from?.seat)}`;
      return `${from} атакует: ${unitName(e.to)} (урон ${e.damage})`;
    }
    case 'weapon_broke':
      return `«${cardName(e.cardId)}» сломалась (${nickOf(e.seat)})`;
    case 'minion_died':
      return `«${cardName(uidName.get(e.uid))}» погиб(ла)${e.poison ? ' [яд]' : ''}`;
    case 'shield_break':
      return `Божественный щит разбит: ${unitName(e.target)}`;
    case 'freeze':
      return `${unitName(e.target)} оглушён(а)`;
    case 'heal':
      return `${unitName(e.target)}: +${e.amount} HP`;
    case 'buff':
      return `${unitName(e.target)}: +${e.atk}/+${e.health}`;
    case 'damage': {
      if (e.source === 'attack') return null; // уже описано в attack
      const srcRu = { battlecry: 'боевой клич', spell: 'заклинание', deathrattle: 'смертный хрип', aura: 'аура', fatigue: 'усталость' }[e.source] ?? e.source;
      return `${unitName(e.target)} получает ${e.amount} урона (${srcRu})`;
    }
    case 'fatigue':
      return `Усталость: ${nickOf(e.seat)} −${e.amount} HP`;
    case 'game_over':
      return `🏆 Победил(а): ${nickOf(e.winner)}`;
    case 'emotion':
      return `${nickOf(e.seat)}: ${emoName(e.emotion)}`;
    default:
      return null; // fx и прочее — не в лог
  }
}

const EMOTIONS_RU = {
  greet: 'Привет 👋', thanks: 'Спасибо 🙏', threat: 'Угроза 😠', laugh: 'Смех 😂',
  sad: 'Печаль 😢', surprise: 'Удивление 😲', praise: 'Похвала 👍', fire: 'Огонь 🔥',
};
function emoName(id) {
  return EMOTIONS_RU[id] ?? id;
}

/** Приём свежих событий (seq > lastSeen) и перерисовка. */
export function appendEvents(events) {
  if (!Array.isArray(events)) return;
  for (const e of events) {
    const line = lineFor(e);
    if (line) lines.push(line);
  }
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  paint();
}

export function reset() {
  lines = [];
  uidName = new Map();
  nicks = ['Вы', 'Противник'];
  turnCount = 1;
  paint();
}

function paint() {
  const box = document.getElementById('log-lines');
  if (!box) return;
  box.innerHTML = lines.map((l) => `<div class="log-line">${esc(l)}</div>`).join('') || '<div class="log-empty">Лог пуст</div>';
  box.scrollTop = box.scrollHeight;
}

/** Кнопка-переключатель панели. */
export function initToggle() {
  const btn = document.getElementById('btn-log');
  const panel = document.getElementById('battle-log');
  if (!btn || !panel) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Л' || e.key === 'л' || e.key === 'L' || e.key === 'l') && document.getElementById('screen-game')?.classList.contains('active')) {
      panel.classList.toggle('open');
    }
  });
}
