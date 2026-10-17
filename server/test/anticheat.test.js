// anticheat.test.js — Этап 6: надёжность.
//
// Претензия к авторитетному серверу: ЛЮБАЯ нелегальная команда
//   1) отклоняется кодом ERR (никогда не бросает исключение),
//   2) НЕ ИЗМЕНЯЕТ состояние игры (snapshot до = snapshot после).
// Плюс: приватность снапшотов (sanitizeGame).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, command, computePlayOptions, computeAttackOptions } from '../game/engine.js';
import { sanitizeGame } from '../net/sanitize.js';

// ── утилиты ──

/** mulberry32 — детерминированный фазз. */
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

/** Публичное состояние для сравнения: ВСЁ, кроме событий/seq. */
function publicState(s) {
  return JSON.stringify({
    status: s.status,
    turn: s.turn,
    turnCount: s.turnCount,
    winner: s.winner,
    winReason: s.winReason,
    coinOwner: s.coinOwner,
    players: s.players.map((p) => ({
      hp: p.hero.hp,
      mana: p.mana,
      maxMana: p.maxMana,
      fatigue: p.fatigue,
      deckLen: p.deck.length,
      deck: [...p.deck], // порядок колоды — тоже состояние; сравниваем полностью
      hand: p.hand.map((h) => h.uid),
      board: p.board.map((m) => ({ uid: m.uid, atk: m.atk, health: m.health, frozen: m.frozen, ds: m.ds, canAttack: m.canAttack })),
      weapon: p.hero.weapon,
    })),
  });
}

/** Играть до первого legal-хода или N попыток; вернуть состояние. */
function playLegalOnce(state, rnd) {
  const seat = state.turn;
  const plays = computePlayOptions(state, seat) ?? [];
  if (plays.length && rnd() < 0.7) {
    const opt = plays[Math.floor(rnd() * plays.length)];
    const r = command(state, seat, { type: 'play_card', handUid: opt.uid, target: opt.targets[0] });
    if (r.ok) return true;
  }
  const r = command(state, seat, { type: 'end_turn' });
  return r.ok;
}

// ── ТЕСТ 1: прицельные нелегальные команды ──

test('античит: прицельные нелегальные команды отклонены и не меняют состояние', () => {
  const s = createGame(['A', 'B']);
  const me = s.turn;
  const opp = 1 - me;
  const before = publicState(s);

  const cases = [
    // чужая карта / несуществующая
    { type: 'play_card', handUid: s.players[opp].hand[0]?.uid },
    { type: 'play_card', handUid: 'no-such-uid' },
    { type: 'play_card', handUid: 42 },
    { type: 'play_card', handUid: null },
    // не свой ход
    { type: 'end_turn' }, // от opp
    { type: 'attack', fromUid: s.players[opp].board[0]?.uid ?? 'x', fromSeat: opp, toUid: 'x', toSeat: me },
    // мусорные payload
    { type: 'hack' },
    { type: 'play_card' },
    { type: 'play_card', handUid: s.players[me].hand[0]?.uid, target: { kind: 'alien', seat: 9 } },
    { type: 'attack', fromUid: null },
    { type: 'attack', fromUid: 'weapon', fromSeat: me, toUid: null, toSeat: opp }, // оружия нет
    { type: 'attack', fromUid: 'weapon', fromSeat: opp, toUid: null, toSeat: me }, // чужое оружие
    undefined,
    null,
  ];

  for (const [i, cmd] of cases.entries()) {
    let r;
    assert.doesNotThrow(() => {
      r = command(s, opp, cmd); // подавляюще большинство — от opp (не его ход)
    }, `случай ${i} бросил исключение`);
    assert.ok(r.ok === false, `случай ${i} должен быть отклонён: ${JSON.stringify(cmd)}`);
    assert.equal(publicState(s), before, `случай ${i} ИЗМЕНИЛ состояние: ${JSON.stringify(cmd)}`);
  }

  // end_turn СО СВОЕГО места — легальный ход, меняет состояние
  const r = command(s, me, { type: 'end_turn' });
  assert.ok(r.ok);
  assert.notEqual(publicState(s), before);
});

test('античит: после game_over любые команды → game_over, состояние заморожено', () => {
  const s = createGame(['A', 'B']);
  s.status = 'ended';
  s.winner = 0;
  const before = publicState(s);
  const cmds = [
    { type: 'end_turn' },
    { type: 'play_card', handUid: s.players[0].hand[0]?.uid },
    { type: 'attack', fromUid: 'weapon', fromSeat: 0, toUid: null, toSeat: 1 },
  ];
  for (const cmd of cmds) {
    const r = command(s, 0, cmd);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'game_over');
    assert.equal(publicState(s), before);
  }
});

test('античит: нелегальная цель (friendly для вражеского спелла, мёртвые uid)', () => {
  const s = createGame(['A', 'B']);
  const me = s.turn;
  // Дай мне в руку спелл с целью: подставим fireball напрямую
  s.players[me].hand.push({ uid: 'hack-spell', cardId: 'fireball' });
  const before = publicState(s);
  const friendlyUid = s.players[me].board.length
    ? s.players[me].board[0].uid
    : null;
  // дружественная цель для вражеского спелла
  if (friendlyUid) {
    const r = command(s, me, { type: 'play_card', handUid: 'hack-spell', target: { kind: 'minion', uid: friendlyUid, seat: me } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'invalid_target');
  }
  // несуществующее существо
  const r2 = command(s, me, { type: 'play_card', handUid: 'hack-spell', target: { kind: 'minion', uid: 'ghost-uid', seat: 1 - me } });
  assert.equal(r2.ok, false);
  assert.equal(publicState(s), before, 'нелегальный спелл не должен менять состояние');
});

// ── ТЕСТ 2: фазз — 2000 случайных команд в живой партии ──

test('античит-фазз: 2000 случайных команд — ни одного исключения, fail не меняет состояние', () => {
  const rnd = rng32(0xC0FFEE);
  let s = createGame(['Фаззер', 'Жертва']);
  let legal = 0;
  let illegal = 0;
  let games = 1;

  for (let i = 0; i < 2000; i++) {
    if (s.status !== 'running') {
      s = createGame(['Фаззер', 'Жертва']); // партия кончилась — продолжаем в новой
      games++;
    }
    const seat = rnd() < 0.5 ? s.turn : 1 - s.turn; // половина — не в свой ход
    const before = publicState(s);

    const roll = rnd();
    let cmd;
    if (roll < 0.35) {
      const hand = s.players[seat].hand;
      cmd = { type: 'play_card', handUid: hand.length ? (rnd() < 0.3 ? s.players[1 - seat].hand[0]?.uid : hand[Math.floor(rnd() * hand.length)].uid) : 'ghost', target: undefined };
    } else if (roll < 0.6) {
      const boards = [s.players[seat].board, s.players[1 - seat].board];
      const fromBoard = boards[rnd() < 0.7 ? 0 : 1];
      const fromUid = rnd() < 0.2 ? 'weapon' : (fromBoard.length ? fromBoard[Math.floor(rnd() * fromBoard.length)].uid : 'ghost');
      const toBoard = boards[rnd() < 0.5 ? 0 : 1];
      const toUid = toBoard.length ? toBoard[Math.floor(rnd() * toBoard.length)].uid : null;
      cmd = { type: 'attack', fromUid, fromSeat: seat, toUid, toSeat: toUid ? (toBoard === s.players[seat].board ? seat : 1 - seat) : (rnd() < 0.5 ? 1 - seat : seat) };
    } else if (roll < 0.85) {
      cmd = { type: 'end_turn' };
    } else {
      cmd = { type: ['teleport', 'cheat_mana', 'give_card'][Math.floor(rnd() * 3)], payload: rnd() };
    }

    let r;
    assert.doesNotThrow(() => { r = command(s, seat, cmd); }, `итерация ${i}: исключение на ${JSON.stringify(cmd)}`);
    if (r.ok) {
      legal++;
      // после legal-хода инварианты
      for (const p of s.players) {
        assert.ok(p.hand.length <= 10, 'рука > 10');
        assert.ok(p.board.length <= 7, 'поле > 7');
        assert.ok(p.deck.length >= 0, 'колода < 0');
        if (s.status === 'running') assert.ok(p.hero.hp > 0, 'живой герой с hp <= 0');
      }
    } else {
      illegal++;
      assert.equal(publicState(s), before, `итерация ${i}: FAIL-команда изменила состояние: ${JSON.stringify(cmd)}`);
    }
  }
  assert.ok(illegal > 500, `слишком мало нелегальных (${illegal}) — фазз слабый`);
  assert.ok(legal > 100, 'почти ни одного legal-хода — фазз не дотягивает до валидных команд');
  assert.ok(games >= 1);
});

// ── ТЕСТ 3: приватность снапшотов ──

test('античит: снапшот не содержит секретов (seed, чужая рука, порядок колоды)', () => {
  const s = createGame(['A', 'B']);
  for (const seat of [0, 1]) {
    const snap = sanitizeGame(s, seat, 'TST1');
    const json = JSON.stringify(snap);
    assert.ok(!json.includes('rngSeed'), 'rngSeed в снапшоте');
    assert.ok(snap.self.hand.length <= 10 && Array.isArray(snap.self.hand));
    assert.ok(snap.opp.hand === undefined, 'чужая рука в снапшоте!');
    assert.ok(typeof snap.opp.handCount === 'number');
    assert.ok(typeof snap.opp.deckCount === 'number' && typeof snap.self.deckCount === 'number');
    assert.ok(!('deck' in snap.self) || snap.self.deck === undefined, 'массив колоды в снапшоте');
  }
  // снапшоты обоих игроков: у каждого СВОЯ рука (разные uid)
  const a = sanitizeGame(s, 0, 'TST1');
  const b = sanitizeGame(s, 1, 'TST1');
  assert.notDeepStrictEqual(
    a.self.hand.map((c) => c.uid).sort(),
    b.self.hand.map((c) => c.uid).sort(),
    'у обоих одна и та же рука (перепутаны сиды)'
  );
});
