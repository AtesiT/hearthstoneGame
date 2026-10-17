// sim-balance.js — Этап 6: баланс-пасс.
//
// Запуск: npm run sim-balance
// 200 полных партий движком напрямую (без WS — быстро): два случайных бота.
// Метрики: симметрия побед (первый/второй ход), причины победы, длина партий,
// манакривая колоды, инварианты. Ноль исключений = стресс-проверка.
import { createGame, command, computePlayOptions, computeAttackOptions } from '../server/game/engine.js';
import { CARD_DB, DECK_LIST } from '../server/game/cards.js';

const GAMES = Number(process.env.GAMES ?? 200);

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
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

// ── бот: играет playable-карты, атакует, завершает ход (цели — от сервера) ──
function botMove(state, rnd) {
  const seat = state.turn;
  const playable = computePlayOptions(state, seat).filter((o) => o.playable);
  if (playable.length) {
    const opt = playable[Math.floor(rnd() * playable.length)];
    const target = opt.targets.length ? opt.targets[Math.floor(rnd() * opt.targets.length)] : undefined;
    return command(state, seat, { type: 'play_card', handUid: opt.uid, target });
  }
  const atk = computeAttackOptions(state, seat);
  const m = atk.minions.find((x) => x.targets.length);
  if (m) {
    const t = m.targets[Math.floor(rnd() * m.targets.length)];
    return command(state, seat, { type: 'attack', fromUid: m.uid, fromSeat: seat, toUid: t.uid ?? null, toSeat: t.seat ?? null });
  }
  if (atk.weapon?.targets?.length) {
    const t = atk.weapon.targets[Math.floor(rnd() * atk.weapon.targets.length)];
    return command(state, seat, { type: 'attack', fromUid: 'weapon', fromSeat: seat, toUid: t.uid ?? null, toSeat: t.seat ?? null });
  }
  return command(state, seat, { type: 'end_turn' });
}

// ── 200 игр ──
console.log(`\nСимуляция ${GAMES} партий (движок напрямую, случайные боты)`);
const reasons = {};
const turnCounts = [];
let seat0Wins = 0;
let firstWins = 0;
let exceptions = 0;
let badCommands = 0;
const t0 = Date.now();

for (let g = 0; g < GAMES; g++) {
  const rnd = rng32(0xBEEF + g * 7919);
  const s = createGame(['БотА', 'БотБ']);
  const firstSeat = s.turn;
  let moves = 0;
  try {
    while (s.status === 'running' && moves < 8000) {
      const r = botMove(s, rnd);
      if (!r.ok) badCommands++; // бот работает от опций сервера — отказа быть не должно
      moves++;
      for (const p of s.players) {
        if (p.hand.length > 10) throw new Error('рука > 10');
        if (p.board.length > 7) throw new Error('поле > 7');
        if (p.deck.length < 0) throw new Error('колода < 0');
        if (s.status === 'running' && p.hero.hp <= 0) throw new Error('живой матч, герой мёртв');
      }
    }
    if (s.status !== 'ended') throw new Error('партия не завершилась (лимит ходов)');
  } catch (e) {
    exceptions++;
    console.log(`  !! игра ${g}: ${e.message}`);
    continue;
  }
  turnCounts.push(s.turnCount);
  reasons[s.winReason] = (reasons[s.winReason] ?? 0) + 1;
  if (s.winner === 0) seat0Wins++;
  if (s.winner === firstSeat) firstWins++;
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const finished = GAMES - exceptions;
console.log(`  (завершено ${finished} из ${GAMES} за ${elapsed} с)`);

check('исключений 0 (стресс: все инварианты держатся)', exceptions === 0, `${exceptions} ошибок`);
check('бот ни разу не получил отказа (опции сервера легальны)', badCommands === 0, `${badCommands} отказов`);

const p0 = (seat0Wins / finished) * 100;
const pFirst = (firstWins / finished) * 100;
console.log(`\nСимметрия побед: seat 0 — ${seat0Wins}/${finished} (${p0.toFixed(1)}%), seat 1 — ${finished - seat0Wins}`);
console.log(`Преимущество первого хода: выигрывает первый — ${pFirst.toFixed(1)}%`);
check('нет критического перекоса (seat 0: 42–58%)', Math.abs(p0 - 50) <= 8, `p0=${p0.toFixed(1)}%`);
check('первый ход: 45–62% (лёгкое преимущество допустимо)', pFirst >= 45 && pFirst <= 62, `pFirst=${pFirst.toFixed(1)}%`);

console.log('\nПричины победы:');
for (const [k, v] of Object.entries(reasons)) console.log(`  ${k}: ${v} (${((v / finished) * 100).toFixed(0)}%)`);
check('все матчи завершились легальными причинами', Object.keys(reasons).every((k) => ['hero_kill', 'fatigue'].includes(k)), Object.keys(reasons).join(','));

const avg = turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length;
const sorted = [...turnCounts].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
console.log(`\nДлина партий: сред ${avg.toFixed(1)}, медиана ${median}, min ${sorted[0]}, max ${sorted[sorted.length - 1]}`);
check('длина партий разумная (сред < 60 ходов)', avg < 60, `avg=${avg.toFixed(1)}`);

// ── манакривая колоды (статика) ──
console.log('\nМанакривая колоды (30 карт):');
const curve = new Map();
for (const id of DECK_LIST) {
  const c = CARD_DB[id];
  if (!c) { check(`манакривая: известная карта ${id}`, false); continue; }
  curve.set(c.cost, (curve.get(c.cost) ?? 0) + 1);
}
for (let cost = 0; cost <= 10; cost++) {
  const n = curve.get(cost) ?? 0;
  console.log(`  ${cost} маны: ${'▮'.repeat(n)}${n}`);
}
const total = DECK_LIST.length;
check('колода ровно 30 карт', total === 30, `${total}`);
check('нет карт дороже 10 маны', [...curve.keys()].every((c) => c <= 10));
const lowCards = (curve.get(0) ?? 0) + (curve.get(1) ?? 0) + (curve.get(2) ?? 0);
check('открытие: 0–2 маны ≥ 5 карт', lowCards >= 5, `${lowCards}`);
console.log(`  0–2: ${lowCards} · 3–5: ${[3,4,5].reduce((a,c)=>a+(curve.get(c)??0),0)} · 6+: ${[6,7,8,9,10].reduce((a,c)=>a+(curve.get(c)??0),0)}`);

console.log(failures === 0 ? '\n=== SIM BALANCE: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ===' : `\n=== SIM BALANCE: ПРОВАЛОВ: ${failures} ===`);
process.exit(failures === 0 ? 0 : 1);
