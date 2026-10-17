// collection.js — экран «Коллекция карт» (Этап 5).
// Все 30 карт публичного DB: фильтры по типу, сортировка, детальный просмотр.
import { cardsMap } from '../game/cards.js';
import { cardArt } from '../game/art.js';
import { cardText, TYPE_RU, RARITY_RU, KEYWORDS_RU } from '../game/cardtext.js';

const $ = (s) => document.querySelector(s);
// мета-карты вне коллекции: монета (старт) и скелет (призываемый токен)
const META_IDS = new Set(['dawn_coin', 'skeleton']);
let filterType = 'all';
let sortMode = 'cost';
let allCards = [];
let detailCard = null;

const esc = (s) =>
  String(s).replace(/[&<>\"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

function sortCards(cards) {
  const arr = [...cards];
  if (sortMode === 'cost') arr.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'ru'));
  else if (sortMode === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  else if (sortMode === 'type') arr.sort((a, b) => a.type.localeCompare(b.type) || a.cost - b.cost);
  return arr;
}

function statsHtml(card) {
  if (card.type === 'minion') {
    return `<span class="c-atk">${card.attack}</span><span class="c-hp">${card.health}</span>`;
  }
  if (card.type === 'weapon') {
    return `<span class="c-atk">${card.attack}</span><span class="c-dur">${card.durability}</span>`;
  }
  return '';
}

function tileHtml(card) {
  const kw = (card.keywords ?? []).map((k) => KEYWORDS_RU[k]?.name).filter(Boolean).join(', ');
  return `
    <div class="cc-cost">${card.cost}</div>
    <div class="cc-art"><img src="${cardArt(card)}" alt="" draggable="false"></div>
    <div class="cc-name">${esc(card.name)}</div>
    <div class="cc-sub">${TYPE_RU[card.type]} · ${RARITY_RU[card.rarity]}</div>
    <div class="cc-stats">${statsHtml(card)}${kw ? `<span class="cc-kw">${esc(kw)}</span>` : ''}</div>`;
}

function renderGrid() {
  const grid = $('#collection-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const shown = sortCards(allCards.filter((c) => filterType === 'all' || c.type === filterType));
  for (const card of shown) {
    const tile = document.createElement('div');
    tile.className = `cc-tile rar-${card.rarity} type-${card.type}`;
    tile.innerHTML = tileHtml(card);
    tile.addEventListener('click', () => openDetail(card));
    grid.appendChild(tile);
  }
  $('#collection-count').textContent = `${shown.length} карт`;
}

function openDetail(card) {
  detailCard = card;
  const d = $('#card-detail');
  if (!d) return;
  const kw = (card.keywords ?? [])
    .map((k) => `<div class="cd-kw"><b>${esc(KEYWORDS_RU[k]?.name ?? k)}</b> — ${esc(KEYWORDS_RU[k]?.desc ?? '')}</div>`)
    .join('');
  const text = cardText(card);
  d.innerHTML = `
    <button class="btn btn-small cd-close" data-close>✕</button>
    <div class="cd-art"><img src="${cardArt(card)}" alt="" draggable="false"></div>
    <div class="cd-info">
      <h3 class="cd-name">${esc(card.name)}</h3>
      <div class="cd-sub">${card.cost} маны · ${TYPE_RU[card.type]} · ${RARITY_RU[card.rarity]}</div>
      ${card.type === 'minion' ? `<div class="cd-stats"><span class="c-atk">${card.attack}</span> атак · <span class="c-hp">${card.health}</span> HP</div>` : ''}
      ${card.type === 'weapon' ? `<div class="cd-stats"><span class="c-atk">${card.attack}</span> урона · <span class="c-dur">${card.durability}</span> прочности</div>` : ''}
      <p class="cd-text">${esc(text)}</p>
      ${kw}
      <p class="cd-flavor">${esc(card.flavor ?? '')}</p>
    </div>`;
  d.hidden = false;
  d.querySelector('[data-close]').addEventListener('click', closeDetail);
}

function closeDetail() {
  detailCard = null;
  const d = $('#card-detail');
  if (d) d.hidden = true;
}

export async function render() {
  try {
    const map = await cardsMap();
    allCards = [...map.values()].filter((c) => !META_IDS.has(c.id));
  } catch {
    $('#collection-grid').innerHTML = '<div class="room-empty">Не удалось загрузить карты</div>';
    return;
  }
  renderGrid();
}

export function init() {
  // фильтры
  document.querySelectorAll('#collection-filters .cf-btn').forEach((b) => {
    b.addEventListener('click', () => {
      filterType = b.dataset.type;
      document.querySelectorAll('#collection-filters .cf-btn').forEach((x) => x.classList.toggle('active', x === b));
      renderGrid();
    });
  });
  $('#collection-sort').addEventListener('change', (e) => {
    sortMode = e.target.value;
    renderGrid();
  });
  $('#btn-collection-back').addEventListener('click', () => {
    closeDetail();
    window.__emberfallToMenu?.();
  });
  // Esc закрывает детальную карту, затем уходит в меню
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailCard) closeDetail();
  });
  // клик по фону модального окна — закрыть
  $('#card-detail').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDetail();
  });
}
