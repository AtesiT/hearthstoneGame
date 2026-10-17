// engine.test.js — unit-тесты игрового движка (Этап 2).
// Движок — чистые функции без WS/таймеров: тестируем напрямую.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, command, getTargetsForMode, computePlayOptions, computeAttackOptions, pushEmotion, EMOTIONS, HEROES } from '../game/engine.js';
import { handleMessage } from '../net/messages.js';
import { getCard, DECK_LIST } from '../game/cards.js';

// ---------- хелперы ----------

const fresh = () => createGame(['Алекс', 'Бора']);

/** Перевести ход к seat (до 2 end_turn). */
function toTurn(state, seat) {
  let guard = 0;
  while (state.turn !== seat && guard++ < 3) {
    const r = command(state, state.turn, { type: 'end_turn' });
    assert.ok(r.ok, `end_turn должен пройти: ${r.code}`);
  }
}

/** Поместить карту прямо в руку (тестовый доступ). */
function give(state, seat, cardId) {
  const p = state.players[seat];
  const inst = { uid: `t${seat}-${cardId}-${p.hand.length}`, cardId };
  p.hand.push(inst);
  return inst;
}

/**
 * Сыграть карту (мана поднимается до 10). Если карты нет в руке —
 * подкладываем её (тестовый доступ): случайная рука не должна мешать проверке.
 */
function play(state, seat, cardId, target) {
  let inst = state.players[seat].hand.find((h) => h.cardId === cardId);
  if (!inst) inst = give(state, seat, cardId);
  state.players[seat].mana = 10;
  const r = command(state, seat, { type: 'play_card', handUid: inst.uid, target });
  assert.ok(r.ok, `play ${cardId}: ${r.code} — ${r.msg}`);
  return r;
}

const heroOf = (state, seat) => state.players[seat].hero;
const eventsOf = (state, k) => state.events.filter((e) => e.k === k);

// ═══════════════════════ СОЗДАНИЕ ═══════════════════════

test('createGame: базы, руки, монета, первый ход', () => {
  const s = fresh();
  assert.equal(s.status, 'running');
  assert.equal(s.turnCount, 1);
  assert.ok(s.turn === 0 || s.turn === 1);
  assert.equal(s.players[s.turn].deck.length, 30 - 3); // 3 стартовых (первый не добирает, Этап 6)
  assert.equal(s.players[1 - s.turn].deck.length, 30 - 3);
  for (const p of s.players) {
    assert.equal(p.hero.hp, 30);
    assert.equal(p.hero.maxHp, 30);
  }
  const active = s.players[s.turn];
  assert.equal(active.maxMana, 1);
  assert.equal(active.mana, 1);
  // HS-модель (Этап 6): первый игрок НЕ добирает на 1-м ходу → стартовые 3.
  // Монета зари — у второго (компенсация) → у активного её нет.
  assert.equal(active.hand.length, 3);
  assert.ok(!active.hand.some((h) => h.cardId === 'dawn_coin'), 'монета у первого игрока');
  const other = s.players[1 - s.turn];
  assert.equal(other.hand.length, 3 + 1, 'у второго: 3 стартовые + монета');
  assert.ok(other.hand.some((h) => h.cardId === 'dawn_coin'), 'монета у второго игрока');
  assert.equal(s.coinOwner, 1 - s.firstSeat);
  // героев 2, разные
  assert.equal(HEROES.length, 2);
  assert.notEqual(s.players[0].hero.name, s.players[1].hero.name);
});

test('createGame: deck = ровно 30 уникальных карт из DECK_LIST', () => {
  const s = fresh();
  for (const p of s.players) {
    const all = [...p.deck, ...p.hand.map((h) => h.cardId).filter((id) => id !== 'dawn_coin')];
    assert.equal(new Set(all).size, all.length, 'карты в колоде+руке уникальны');
  }
  assert.equal(DECK_LIST.length, 30);
});

// ═══════════════════════ ХОД И МАНА ═══════════════════════

test('end_turn: смена хода, рост маны, turnCount', () => {
  const s = fresh();
  const first = s.turn;
  toTurn(s, 1 - first);
  assert.equal(s.turn, 1 - first);
  assert.equal(s.turnCount, 2);
  const p = s.players[1 - first];
  assert.equal(p.maxMana, 1);
  assert.equal(p.mana, 1);
  // и обратно — снова растёт
  toTurn(s, first);
  assert.equal(s.turnCount, 3);
  assert.equal(s.players[first].maxMana, 2);
});

test('мана капится в 10', () => {
  const s = fresh();
  const seat = s.turn; // стартёр: maxMana уже 1
  for (let i = 0; i < 9; i++) {
    command(s, seat, { type: 'end_turn' });
    command(s, 1 - seat, { type: 'end_turn' }); // возврат к seat: maxMana +1
  }
  assert.equal(s.turn, seat);
  assert.equal(s.players[seat].maxMana, 10, 'кап 10');
  assert.equal(s.players[seat].mana, 10);
});

test('в события приходят turn_start с маной', () => {
  const s = fresh();
  const ev = eventsOf(s, 'turn_start');
  assert.ok(ev.length >= 1);
  assert.ok(ev.every((e) => e.mana > 0 && e.maxMana > 0));
});

// ═══════════════════════ ВАЛИДАЦИЯ КОМАНД ═══════════════════════

test('команды: чужой ход / чужая карта / мана / после конца', () => {
  const s = fresh();
  const mine = 1 - s.turn;
  // не твой ход
  const r1 = command(s, mine, { type: 'end_turn' });
  assert.equal(r1.code, 'not_your_turn');
  // чужая карта
  give(s, s.turn, 'fireball');
  const r2 = command(s, mine, { type: 'play_card', handUid: 'нет-такой-uid' });
  assert.equal(r2.code, 'not_your_turn'); // seat проверяется раньше
  // мало маны
  const inst = give(s, s.turn, 'titan_wrath');
  s.players[s.turn].mana = 1;
  const r3 = command(s, s.turn, { type: 'play_card', handUid: inst.uid });
  assert.equal(r3.code, 'not_enough_mana');
  // карта не в руке
  const r4 = command(s, s.turn, { type: 'play_card', handUid: 'привидение' });
  assert.equal(r4.code, 'card_not_yours');
  // плохой payload
  const r5 = command(s, s.turn, { type: 'танец_дождя' });
  assert.equal(r5.code, 'bad_payload');
});

test('атомарность: неудачный play ничего не меняет', () => {
  const s = fresh();
  const inst = give(s, s.turn, 'titan_wrath');
  s.players[s.turn].mana = 1;
  const before = JSON.stringify(s.players);
  command(s, s.turn, { type: 'play_card', handUid: inst.uid });
  assert.equal(JSON.stringify(s.players), before);
});

// ═══════════════════════ СУЩЕСТВА ═══════════════════════

test('minion: поле, justPlayed, чардж-флаг', () => {
  const s = fresh();
  const seat = s.turn;
  play(s, seat, 'rat_catcher');
  const m = s.players[seat].board[0];
  assert.equal(m.cardId, 'rat_catcher');
  assert.equal(m.atk, 1);
  assert.equal(m.health, 2);
  assert.ok(m.justPlayed, 'новое существо — «болеет»');
  assert.equal(m.canAttack, false);
  // charge: флаг уже выставлен (эффект атаки — Этап 3)
  play(s, seat, 'spark_wyvern');
  assert.equal(s.players[seat].board[1].canAttack, true);
});

test('board_full: 7 — максимум', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].mana = 10;
  const ids = ['rat_catcher', 'spark_wyvern', 'goblin_forge', 'grove_spirit', 'flame_fairy', 'silver_knight', 'stone_watchman'];
  for (const id of ids) play(s, seat, id);
  assert.equal(s.players[seat].board.length, 7);
  const inst = give(s, seat, 'rat_catcher');
  const r = command(s, seat, { type: 'play_card', handUid: inst.uid });
  assert.equal(r.code, 'board_full');
  assert.equal(s.players[seat].board.length, 7);
});

// ═══════════════════════ ЗАКЛИНАНИЯ: УРОН ═══════════════════════

test('fireball: урон герою и существо', () => {
  const s = fresh();
  const seat = s.turn;
  toTurn(s, 1 - seat);
  play(s, 1 - seat, 'stone_watchman'); // 3/3 taunt
  toTurn(s, seat);
  play(s, seat, 'fireball', { kind: 'minion', uid: s.players[1 - seat].board[0].uid, seat: 1 - seat });
  assert.equal(s.players[1 - seat].board.length, 0, 'существо погибло');
  assert.ok(eventsOf(s, 'minion_died').length >= 1);
  // по герою
  toTurn(s, 1 - seat);
  toTurn(s, seat);
  s.players[seat].mana = 10;
  give(s, seat, 'fireball');
  play(s, seat, 'fireball', { kind: 'hero', seat: 1 - seat });
  assert.equal(heroOf(s, 1 - seat).hp, 24);
});

test('divine_shield: первый урон поглощён, второй проходит', () => {
  const s = fresh();
  const seat = s.turn;
  toTurn(s, 1 - seat);
  play(s, 1 - seat, 'silver_knight'); // 2/2 DS
  toTurn(s, seat);
  const m = s.players[1 - seat].board[0];
  s.players[seat].mana = 10;
  give(s, seat, 'spark_bolt');
  play(s, seat, 'spark_bolt', { kind: 'minion', uid: m.uid, seat: 1 - seat });
  assert.equal(m.ds, false, 'щит сломан');
  assert.equal(m.health, 2, 'урон не прошёл');
  assert.ok(eventsOf(s, 'shield_break').length === 1);
  // второй раз — уже урон
  give(s, seat, 'spark_bolt');
  play(s, seat, 'spark_bolt', { kind: 'minion', uid: m.uid, seat: 1 - seat });
  assert.equal(m.health, 1);
});

test('frost_lance: урон + оглушение', () => {
  const s = fresh();
  const seat = s.turn;
  toTurn(s, 1 - seat);
  play(s, 1 - seat, 'stone_watchman');
  toTurn(s, seat);
  const m = s.players[1 - seat].board[0];
  s.players[seat].mana = 10;
  give(s, seat, 'frost_lance');
  play(s, seat, 'frost_lance', { kind: 'minion', uid: m.uid, seat: 1 - seat });
  assert.equal(m.health, 1);
  assert.equal(m.frozen, true);
});

// ═══════════════════════ ЦЕЛИ ═══════════════════════

test('валидация целей: своя/чужая/отсутствующая/лишняя', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman');
  toTurn(s, seat);
  s.players[seat].mana = 10;

  const inst = give(s, seat, 'fireball');
  // своя цель
  const ownM = give(s, seat, 'rat_catcher');
  command(s, seat, { type: 'play_card', handUid: ownM.uid });
  const myUid = s.players[seat].board[0].uid;
  let r = command(s, seat, { type: 'play_card', handUid: inst.uid, target: { kind: 'minion', uid: myUid, seat } });
  assert.equal(r.code, 'invalid_target');
  // нет цели
  r = command(s, seat, { type: 'play_card', handUid: inst.uid });
  assert.equal(r.code, 'target_required');
  // фейковый uid
  r = command(s, seat, { type: 'play_card', handUid: inst.uid, target: { kind: 'minion', uid: 'ghost', seat: opp } });
  assert.equal(r.code, 'invalid_target');
  // лишний target у нетаргетного
  const gb = give(s, seat, 'grimoire');
  r = command(s, seat, { type: 'play_card', handUid: gb.uid, target: { kind: 'hero', seat: opp } });
  assert.equal(r.code, 'target_not_required');
});

test('таунт: таргетные урональные спеллы бьют только в taunt', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman'); // taunt 3/3
  play(s, opp, 'spark_wyvern'); // без taunt 2/1
  toTurn(s, seat);

  const watchman = s.players[opp].board.find((m) => m.cardId === 'stone_watchman');
  const wyvern = s.players[opp].board.find((m) => m.cardId === 'spark_wyvern');
  const targets = getTargetsForMode(s, seat, 'enemy_minion_or_hero', getCard('fireball'));
  assert.ok(targets.some((t) => t.uid === watchman.uid));
  assert.ok(targets.some((t) => t.kind === 'hero'));
  assert.ok(!targets.some((t) => t.uid === wyvern.uid), 'non-taunt закрыт таунтом');

  s.players[seat].mana = 10;
  const fb = give(s, seat, 'fireball');
  const r = command(s, seat, { type: 'play_card', handUid: fb.uid, target: { kind: 'minion', uid: wyvern.uid, seat: opp } });
  assert.equal(r.code, 'invalid_target');
});

test('bone_arrow: только атака ≤ 2, уничтожение (щит не спасает)', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'rat_catcher'); // taunt 1/2
  play(s, opp, 'silver_knight'); // DS 2/2
  toTurn(s, seat);
  const small = s.players[opp].board[0];
  const ds = s.players[opp].board[1];
  s.players[seat].mana = 10;
  const inst = give(s, seat, 'bone_arrow');
  // silver_knight (2 атаки) — легальная цель
  const r = command(s, seat, { type: 'play_card', handUid: inst.uid, target: { kind: 'minion', uid: ds.uid, seat: opp } });
  assert.ok(r.ok);
  assert.equal(s.players[opp].board.length, 1, 'DS не спасает от «уничтожить»');
  assert.equal(s.players[opp].board[0].uid, small.uid);
});

test('computePlayOptions: без целей — не играбельна', () => {
  const s = fresh();
  const seat = s.turn;
  // вражеское поле пусто → bone_arrow некуда бить
  give(s, seat, 'bone_arrow');
  s.players[seat].mana = 10;
  const opts = computePlayOptions(s, seat);
  const ba = opts.find((o) => o.cardId === 'bone_arrow');
  assert.equal(ba.playable, false);
  assert.deepEqual(ba.targets, []);
  // fireball всегда играбелен (есть хотя бы герой)
  give(s, seat, 'fireball');
  const opts2 = computePlayOptions(s, seat);
  const fb = opts2.find((o) => o.cardId === 'fireball');
  assert.equal(fb.playable, true);
  assert.equal(fb.targets.length, 1);
});

// ═══════════════════════ БАФФЫ, ЛЕЧЕНИЕ, ТЯГИ ═══════════════════════

test('blessing_of_steel: +3/+3, только своё', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'rat_catcher');
  toTurn(s, seat);
  play(s, seat, 'goblin_forge'); // 2/2
  const mine = s.players[seat].board.find((m) => m.cardId === 'goblin_forge');
  s.players[seat].mana = 10;
  const inst = give(s, seat, 'blessing_of_steel');
  // в чужое — нельзя
  let r = command(s, seat, { type: 'play_card', handUid: inst.uid, target: { kind: 'minion', uid: s.players[opp].board[0].uid, seat: opp } });
  assert.equal(r.code, 'invalid_target');
  // в своё — можно
  r = command(s, seat, { type: 'play_card', handUid: inst.uid, target: { kind: 'minion', uid: mine.uid, seat } });
  assert.ok(r.ok);
  assert.equal(mine.atk, 5);
  assert.equal(mine.health, 5);
  assert.equal(mine.baseAtk, 5);
});

test('grimoire: +2 карты; burn при переполненной руке', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].mana = 10;
  give(s, seat, 'grimoire');
  const before = s.players[seat].hand.length;
  const deckBefore = s.players[seat].deck.length;
  play(s, seat, 'grimoire');
  assert.equal(s.players[seat].hand.length, before - 1 + 2);
  assert.equal(s.players[seat].deck.length, deckBefore - 2);
  // переполненная рука
  while (s.players[seat].hand.length < 10) give(s, seat, 'rat_catcher');
  assert.equal(s.players[seat].hand.length, 10);
  give(s, seat, 'grimoire');
  play(s, seat, 'grimoire');
  assert.equal(s.players[seat].hand.length, 10, 'рука не растёт');
  assert.ok(eventsOf(s, 'burn').length >= 2);
});

test('green_ray: лечение до maxHp', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].mana = 10;
  heroOf(s, seat).hp = 25;
  give(s, seat, 'green_ray');
  play(s, seat, 'green_ray');
  assert.equal(heroOf(s, seat).hp, 30);
  heroOf(s, seat).hp = 20;
  give(s, seat, 'green_ray');
  play(s, seat, 'green_ray');
  assert.equal(heroOf(s, seat).hp, 26);
});

// ═══════════════════════ МАССОВЫЕ ЭФФЕКТЫ ═══════════════════════

test('chain_lightning: 2 урона всем вражеским (DS поглощает)', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman'); // 3/3
  play(s, opp, 'silver_knight'); // 2/2 DS
  toTurn(s, seat);
  s.players[seat].mana = 10;
  give(s, seat, 'chain_lightning');
  play(s, seat, 'chain_lightning');
  const w = s.players[opp].board.find((m) => m.cardId === 'stone_watchman');
  const k = s.players[opp].board.find((m) => m.cardId === 'silver_knight');
  assert.equal(w.health, 1);
  assert.equal(k.health, 2, 'щит поглотил');
  assert.equal(k.ds, false);
});

test('titan_wrath: 5 урона всем существам на обе стороны', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman');
  toTurn(s, seat);
  play(s, seat, 'rat_catcher');
  s.players[seat].mana = 10;
  give(s, seat, 'titan_wrath');
  play(s, seat, 'titan_wrath');
  assert.equal(s.players[opp].board.length, 0); // 3 hp — не выжил
  assert.equal(s.players[seat].board.length, 0); // 2 hp — не выжил
});

test('pyroclasm: уничтожает всё вражеское, щиты не спасают', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'silver_knight');
  play(s, opp, 'ashen_golem'); // 8/8
  toTurn(s, seat);
  s.players[seat].mana = 10;
  give(s, seat, 'pyroclasm');
  play(s, seat, 'pyroclasm');
  assert.equal(s.players[opp].board.length, 0);
});

// ═══════════════════════ БОЕВЫЕ КЛИЧИ И СМЕРТНЫЕ ХРИПЫ ═══════════════════════

test('goblin_forge: боевой клич — тянет карту', () => {
  const s = fresh();
  const seat = s.turn;
  const before = s.players[seat].deck.length;
  play(s, seat, 'goblin_forge');
  assert.equal(s.players[seat].deck.length, before - 1);
});

test('ember_wolf: клич — 1 урон случайному вражескому', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman');
  toTurn(s, seat);
  s.players[seat].mana = 10;
  give(s, seat, 'ember_wolf');
  play(s, seat, 'ember_wolf');
  assert.equal(s.players[opp].board[0].health, 2);
});

test('tribe_chief: +1/+1 другим своим', () => {
  const s = fresh();
  const seat = s.turn;
  play(s, seat, 'goblin_forge'); // 2/2
  const mine = s.players[seat].board[0];
  s.players[seat].mana = 10;
  give(s, seat, 'tribe_chief');
  play(s, seat, 'tribe_chief');
  assert.equal(mine.atk, 3);
  assert.equal(mine.health, 3);
  assert.equal(mine.baseAtk, 3);
});

test('flame_fairy: смерть — 2 урона вражескому герою', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  play(s, seat, 'flame_fairy');
  const heroHp = heroOf(s, opp).hp;
  // убиваем фей (1 hp) спеллом
  s.players[seat].mana = 10;
  toTurn(s, opp);
  give(s, opp, 'spark_bolt');
  const fairyUid = s.players[seat].board[0].uid;
  play(s, opp, 'spark_bolt', { kind: 'minion', uid: fairyUid, seat });
  assert.equal(s.players[seat].board.length, 0);
  assert.equal(heroOf(s, opp).hp, heroHp - 2);
});

test('bone_colossus: смерть — призывает скелета', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].mana = 10;
  give(s, seat, 'bone_colossus');
  play(s, seat, 'bone_colossus');
  // убиваем колосса (7 hp) двумя огненными шарами
  toTurn(s, 1 - seat);
  const col = s.players[seat].board[0];
  play(s, 1 - seat, 'fireball', { kind: 'minion', uid: col.uid, seat });
  play(s, 1 - seat, 'fireball', { kind: 'minion', uid: col.uid, seat });
  const skel = s.players[seat].board.find((m) => m.cardId === 'skeleton');
  assert.ok(skel, 'скелет призван');
  assert.equal(skel.atk, 2);
  assert.equal(skel.health, 1);
  assert.equal(skel.justPlayed, false, 'призыв — без болезни');
});

test('frost_elemental: таргетный клич (оглушение) — Этап 3', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman'); // цель для клича
  toTurn(s, seat);
  s.players[seat].mana = 10;
  const inst = give(s, seat, 'frost_elemental');
  const w = s.players[opp].board[0];

  // без цели — нельзя
  let r = command(s, seat, { type: 'play_card', handUid: inst.uid });
  assert.equal(r.code, 'target_required');
  // в героя — нельзя (режим enemy_minion)
  r = command(s, seat, { type: 'play_card', handUid: inst.uid, target: { kind: 'hero', seat: opp } });
  assert.equal(r.code, 'invalid_target');
  // в своё существо — нельзя
  const fb = give(s, seat, 'goblin_forge');
  command(s, seat, { type: 'play_card', handUid: fb.uid });
  r = command(s, seat, { type: 'play_card', handUid: inst.uid, target: { kind: 'minion', uid: s.players[seat].board[0].uid, seat } });
  assert.equal(r.code, 'invalid_target');
  // в чужое — можно: существо поставлено, цель оглушена
  r = command(s, seat, { type: 'play_card', handUid: inst.uid, target: { kind: 'minion', uid: w.uid, seat: opp } });
  assert.ok(r.ok, r.msg);
  assert.equal(s.players[seat].board.some((m) => m.cardId === 'frost_elemental'), true);
  assert.equal(w.frozen, true);
  assert.ok(eventsOf(s, 'freeze').length >= 1);
});

test('frost_elemental: без вражеских целей — не играбелен', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].mana = 10;
  give(s, seat, 'frost_elemental');
  const opts = computePlayOptions(s, seat);
  const fe = opts.find((o) => o.cardId === 'frost_elemental');
  assert.equal(fe.playable, false, 'вражеское поле пусто — кличу некому');
  assert.deepEqual(fe.targets, []);
});

// ═══════════════════════ АУРЫ ═══════════════════════

test('grove_spirit: аура +1/+1 другим своим; снятие ауры', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].mana = 10;
  play(s, seat, 'grove_spirit'); // 1/1
  // goblin_forge без таунта: спелл противника сможет в него прицелиться
  play(s, seat, 'goblin_forge'); // 2/2
  const cat = s.players[seat].board.find((m) => m.cardId === 'goblin_forge');
  const sp = s.players[seat].board.find((m) => m.cardId === 'grove_spirit');
  assert.equal(cat.atk, 3, 'аура +1 атака');
  assert.equal(cat.health, 3, 'аура +1 здоровье');
  assert.equal(cat.baseAtk, 2, 'база не тронута');
  assert.equal(sp.atk, 1, 'сама себе аура не действует');
  // убиваем духа — аура уходит
  toTurn(s, 1 - seat);
  play(s, 1 - seat, 'spark_bolt', { kind: 'minion', uid: sp.uid, seat });
  assert.equal(s.players[seat].board.length, 1);
  assert.equal(cat.atk, 2);
  assert.equal(cat.health, 2);
});

test('garden_guardian: аура только +1 атака', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].mana = 10;
  give(s, seat, 'garden_guardian');
  play(s, seat, 'garden_guardian'); // 5/5
  give(s, seat, 'rat_catcher');
  play(s, seat, 'rat_catcher');
  const cat = s.players[seat].board.find((m) => m.cardId === 'rat_catcher');
  assert.equal(cat.atk, 2);
  assert.equal(cat.health, 2);
});

// ═══════════════════════ ОРУЖИЕ ═══════════════════════

test('weapon: экипировка и замена', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].mana = 10;
  give(s, seat, 'steel_dagger');
  play(s, seat, 'steel_dagger');
  assert.equal(s.players[seat].hero.weapon.cardId, 'steel_dagger');
  assert.equal(s.players[seat].hero.weapon.durability, 2);
  give(s, seat, 'forge_mace');
  play(s, seat, 'forge_mace');
  assert.equal(s.players[seat].hero.weapon.cardId, 'forge_mace');
  const broke = eventsOf(s, 'weapon_broke');
  assert.ok(broke.some((e) => e.reason === 'replaced'));
});

// ═══════════════════════ MONETA, FATIGUE, BURN ═══════════════════════

test('dawn_coin: +1 мана (может превысить maxMana)', () => {
  const s = fresh();
  const seat = s.coinOwner;
  toTurn(s, seat);
  const p = s.players[seat];
  const inst = p.hand.find((h) => h.cardId === 'dawn_coin');
  assert.ok(inst, 'монета в руке владельца');
  const manaBefore = p.mana;
  const r = command(s, seat, { type: 'play_card', handUid: inst.uid });
  assert.ok(r.ok, r.msg);
  assert.equal(p.mana, manaBefore + 1);
});

test('fatigue: пустая колода — растущий урон герою', () => {
  const s = fresh();
  const seat = 1 - s.turn; // чтобы draw был не у стартера? нет — просто у seat
  s.players[seat].deck = [];
  s.players[seat].hero.hp = 30;
  toTurn(s, seat); // draw → fatigue 1
  const hp1 = s.players[seat].hero.hp;
  assert.equal(hp1, 29);
  toTurn(s, 1 - seat);
  toTurn(s, seat); // fatigue 2
  assert.equal(s.players[seat].hero.hp, 27);
  const f = eventsOf(s, 'fatigue');
  assert.ok(f.some((e) => e.seat === seat && e.amount === 1));
  assert.ok(f.some((e) => e.seat === seat && e.amount === 2));
});

test('burn: draw в полную руку сжигает карту', () => {
  const s = fresh();
  const seat = s.turn;
  while (s.players[seat].hand.length < 10) give(s, seat, 'rat_catcher');
  const deckBefore = s.players[seat].deck.length;
  toTurn(s, 1 - seat);
  toTurn(s, seat); // startTurn → draw → burn
  assert.equal(s.players[seat].hand.length, 10);
  assert.equal(s.players[seat].deck.length, deckBefore - 1, 'карта снята с колоды');
  assert.ok(eventsOf(s, 'burn').length >= 1);
});

// ═══════════════════════ ПОБЕДА ═══════════════════════

test('hero_kill: конец партии, winner, события, больше команд нельзя', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  heroOf(s, opp).hp = 5;
  s.players[seat].mana = 10;
  give(s, seat, 'fireball');
  play(s, seat, 'fireball', { kind: 'hero', seat: opp });
  assert.equal(s.status, 'ended');
  assert.equal(s.winner, seat);
  assert.equal(s.winReason, 'hero_kill');
  assert.ok(eventsOf(s, 'game_over').length === 1);
  const r = command(s, seat, { type: 'end_turn' });
  assert.equal(r.code, 'game_over');
});

test('fatigue может убить героя и завершить партию', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].deck = [];
  s.players[seat].hero.hp = 1;
  toTurn(s, 1 - seat);
  toTurn(s, seat); // fatigue 1 → 0 hp
  assert.equal(s.status, 'ended');
  assert.equal(s.winner, 1 - seat);
});

// ═══════════════════════ СОБЫТИЯ ═══════════════════════

// ═══════════════════════ АТАКИ (Этап 3) ═══════════════════════

/** Атака + assert (helper): fromUid — uid или 'weapon'. */
function atk(state, seat, fromUid, toUid, toSeat, expectOk = true) {
  const r = command(state, seat, { type: 'attack', fromUid, fromSeat: seat, toUid: toUid ?? null, toSeat });
  if (expectOk) assert.ok(r.ok, `attack ${fromUid}→${toUid ?? 'hero'}: ${r.code} — ${r.msg}`);
  return r;
}

test('minion attack: обмен уроном, существо погибает', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  play(s, seat, 'goblin_forge'); // 2/2 (в этот ход «болеет»)
  toTurn(s, opp);
  play(s, opp, 'stone_watchman'); // 3/3 (taunt)
  toTurn(s, seat);
  const g = s.players[seat].board.find((m) => m.cardId === 'goblin_forge');
  const w = s.players[opp].board[0];
  atk(s, seat, g.uid, w.uid, opp);
  assert.equal(w.health, 1, 'цель получила 2 урона');
  assert.equal(g.health, -1, 'атаковавший получил 3 (контратака)');
  assert.equal(s.players[seat].board.length, 0, 'гоблин погиб');
  const at = s.events.find((e) => e.k === 'attack');
  assert.equal(at.damage, 2);
  assert.equal(at.viaWeapon, false);
  assert.equal(at.fatal, false);
});

test('sickness: существо не атакует в ход разыгрывания', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'rat_catcher'); // 1/2 taunt
  toTurn(s, seat);
  play(s, seat, 'goblin_forge');
  const g = s.players[seat].board.find((m) => m.cardId === 'goblin_forge');
  const r = atk(s, seat, g.uid, s.players[opp].board[0].uid, opp, false);
  assert.equal(r.code, 'cannot_attack');
});

test('charge: Виверна-искра атакует в ход разыгрывания', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'rat_catcher'); // 1/2
  toTurn(s, seat);
  play(s, seat, 'spark_wyvern'); // 2/1 charge
  const sw = s.players[seat].board.find((m) => m.cardId === 'spark_wyvern');
  assert.equal(sw.canAttack, true);
  atk(s, seat, sw.uid, s.players[opp].board[0].uid, opp);
  // 2/1 бьёт 1/2: оба гибнут (встречный 1 урона по виверне)
  assert.equal(s.players[opp].board.length, 0, 'крысолов убит (2 урона > 2 hp)');
  assert.equal(s.players[seat].board.length, 0, 'виверна от встречного урона');
});

test('двойная атака за ход запрещена', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'rat_catcher'); // 1/2 taunt
  play(s, opp, 'rat_catcher'); // второй 1/2 taunt
  toTurn(s, seat);
  play(s, seat, 'goblin_forge'); // 2/2 (в этот ход «болеет»)
  toTurn(s, opp);
  toTurn(s, seat);
  const g = s.players[seat].board.find((m) => m.cardId === 'goblin_forge');
  atk(s, seat, g.uid, s.players[opp].board[0].uid, opp); // 2/2 vs 1/2: гоблин → 1 hp
  assert.equal(g.health, 1);
  const r = atk(s, seat, g.uid, s.players[opp].board[0].uid, opp, false);
  assert.equal(r.code, 'cannot_attack', 'второй удар за ход запрещён');
});

test('столетие: оглушённую цель нельзя бить; столетие спадает к началу хода контроллера', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman'); // 3/3 taunt
  toTurn(s, seat);
  play(s, seat, 'spark_wyvern'); // 2/1 charge — есть чем бить
  const w = s.players[opp].board[0];
  const sw = s.players[seat].board[0];
  s.players[seat].mana = 10;
  give(s, seat, 'frost_lance');
  play(s, seat, 'frost_lance', { kind: 'minion', uid: w.uid, seat: opp });
  assert.equal(w.frozen, true);
  assert.equal(w.health, 1);
  // оглушённый таунт — невалидная цель (и герой закрыт таунтом)
  const r = atk(s, seat, sw.uid, w.uid, opp, false);
  assert.equal(r.code, 'invalid_target');
  const opts = computeAttackOptions(s, seat);
  assert.equal(opts.minions[0]?.targets.length ?? 1, 0, 'целей нет: таунт оглушён');
  // ход противника: столетие спало, страж бьёт героя
  toTurn(s, opp);
  assert.equal(w.frozen, false);
  const hp = s.players[seat].hero.hp;
  atk(s, opp, w.uid, null, seat);
  assert.equal(s.players[seat].hero.hp, hp - 3);
});

test('таунт: атака мимо Провокатора запрещена (и герой закрыт)', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman'); // taunt
  play(s, opp, 'spark_wyvern'); // без taunt
  toTurn(s, seat);
  play(s, seat, 'spark_wyvern');
  const sw = s.players[seat].board[0];
  const nonTaunt = s.players[opp].board.find((m) => m.cardId === 'spark_wyvern');
  let r = atk(s, seat, sw.uid, nonTaunt.uid, opp, false);
  assert.equal(r.code, 'taunt_blocked');
  r = atk(s, seat, sw.uid, null, opp, false);
  assert.equal(r.code, 'taunt_blocked', 'герой закрыт таунтом');
  const taunt = s.players[opp].board.find((m) => m.cardId === 'stone_watchman');
  atk(s, seat, sw.uid, taunt.uid, opp);
});

test('poison: Яд убивает цель, урон которой прошёл (и взаимно)', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  // оба ставят лунных охотников 4/3 (яд)
  play(s, seat, 'moon_stalker'); // «болеет» в этот ход
  toTurn(s, opp);
  play(s, opp, 'moon_stalker');
  toTurn(s, seat);
  const mine = s.players[seat].board[0];
  const theirs = s.players[opp].board[0];
  atk(s, seat, mine.uid, theirs.uid, opp);
  assert.equal(s.players[seat].board.length, 0);
  assert.equal(s.players[opp].board.length, 0, 'взаимная смерть (яд + обмен уроном)');
  const died = s.events.filter((e) => e.k === 'minion_died');
  assert.equal(died.length, 2);
  assert.ok(died.every((e) => e.poison), 'оба — от яда');
});

test('poison: слабое ядовитое существо убивает сильного голема', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  play(s, seat, 'moon_stalker'); // 4/3 яд
  toTurn(s, opp);
  play(s, opp, 'ashen_golem'); // 8/8 (без яда)
  toTurn(s, seat);
  const m = s.players[seat].board[0];
  const g = s.players[opp].board[0];
  atk(s, seat, m.uid, g.uid, opp);
  // урона 4 < 8, но яд добил: голем мёртв; охотник — от 8 контратаки
  assert.equal(s.players[opp].board.length, 0);
  const golemDeath = s.events.find((e) => e.k === 'minion_died' && e.uid === g.uid);
  assert.equal(golemDeath.poison, true);
});

test('poison: щит поглощает урон — яд НЕ срабатывает', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  play(s, seat, 'moon_stalker');
  toTurn(s, opp);
  play(s, opp, 'silver_knight'); // 2/2 DS
  toTurn(s, seat);
  const m = s.players[seat].board[0];
  const k = s.players[opp].board[0];
  atk(s, seat, m.uid, k.uid, opp);
  assert.equal(s.players[opp].board.length, 1, 'рыцарь жив (щит)');
  assert.equal(k.health, 2, 'урон не прошёл');
  assert.equal(k.ds, false);
  assert.ok(!s.events.some((e) => e.k === 'minion_died' && e.uid === k.uid));
});

test('weapon: в ход покупки атаковать нельзя', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'rat_catcher');
  toTurn(s, seat);
  play(s, seat, 'steel_dagger');
  const r = atk(s, seat, 'weapon', null, opp, false);
  assert.equal(r.code, 'weapon_cannot_attack');
});

test('weapon: атака без контратаки, прочность, поломка', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman'); // 3/3 — переживёт удар 2
  toTurn(s, seat);
  play(s, seat, 'steel_dagger'); // 2 атаки, 2 прочности
  toTurn(s, opp);
  toTurn(s, seat); // в этот ход оружием можно
  const w = s.players[opp].board[0];
  atk(s, seat, 'weapon', w.uid, opp);
  assert.equal(w.health, 1, 'страж получил 2 и выжил');
  assert.equal(s.players[seat].hero.hp, 30, 'контратаки по герою НЕТ');
  atk(s, seat, 'weapon', w.uid, opp); // второй удар: страж мёртв, прочность 0
  assert.equal(s.players[opp].board.length, 0);
  assert.equal(s.players[seat].hero.weapon, null, 'оружие сломалось');
  assert.ok(s.events.some((e) => e.k === 'weapon_broke' && e.reason === 'durability'));
});

test('weapon: удар по герою', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  toTurn(s, seat);
  play(s, seat, 'steel_dagger');
  toTurn(s, opp);
  toTurn(s, seat);
  const atkEv = (n) => s.events.filter((e) => e.k === 'attack' && e.viaWeapon).length;
  atk(s, seat, 'weapon', null, opp);
  assert.equal(s.players[opp].hero.hp, 28);
  assert.equal(atkEv(), 1);
});

test('weapon: против Провокатора атакует только его', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman'); // taunt
  play(s, opp, 'spark_wyvern');
  toTurn(s, seat);
  play(s, seat, 'steel_dagger');
  toTurn(s, opp);
  toTurn(s, seat);
  const r1 = atk(s, seat, 'weapon', null, opp, false);
  assert.equal(r1.code, 'taunt_blocked');
  const wyv = s.players[opp].board.find((m) => m.cardId === 'spark_wyvern');
  const r2 = atk(s, seat, 'weapon', wyv.uid, opp, false);
  assert.equal(r2.code, 'taunt_blocked');
  const w = s.players[opp].board.find((m) => m.cardId === 'stone_watchman');
  atk(s, seat, 'weapon', w.uid, opp);
  assert.equal(w.health, 1);
});

test('computeAttackOptions: ход/таунт/свежее оружие/атаковало', () => {
  const s = fresh();
  const seat = s.turn;
  const opp = 1 - seat;
  toTurn(s, opp);
  play(s, opp, 'stone_watchman'); // taunt
  toTurn(s, seat);
  play(s, seat, 'spark_wyvern'); // charge — готово к бою сразу
  play(s, seat, 'steel_dagger');

  // не мой ход → пусто
  const other = computeAttackOptions(s, opp);
  assert.deepEqual(other, { minions: [], weapon: null });

  // мой ход: цель только таунт (герой закрыт), оружие — нельзя (свежее)
  let opts = computeAttackOptions(s, seat);
  assert.equal(opts.minions.length, 1);
  const t = opts.minions[0].targets;
  assert.equal(t.length, 1, 'только Провокатор');
  assert.equal(t[0].kind, 'minion');
  assert.equal(opts.weapon, null, 'свежее оружие');

  // после атаки существо из списка пропадает
  const sw = s.players[seat].board.find((m) => m.cardId === 'spark_wyvern');
  atk(s, seat, sw.uid, t[0].uid, opp);
  opts = computeAttackOptions(s, seat);
  assert.equal(opts.minions.length, 0, 'атаковало — больше не в списке');
});

test('не тот seat в атаке — unit_not_mine', () => {
  const s = fresh();
  const seat = s.turn;
  play(s, seat, 'spark_wyvern'); // charge
  const sw = s.players[seat].board[0];
  const r = command(s, seat, { type: 'attack', fromUid: sw.uid, fromSeat: 1 - seat, toUid: null, toSeat: 1 - seat });
  assert.equal(r.code, 'unit_not_mine');
});

// ═══════════════════════ ЭМОЦИИ (Этап 4) ═══════════════════════

test('emotion: 8 эмоций, событие в журнал, мусор отклонён', () => {
  const s = fresh();
  const seat = s.turn;
  assert.equal(Object.keys(EMOTIONS).length, 8);
  for (const e of Object.keys(EMOTIONS)) {
    const r = pushEmotion(s, seat, e);
    assert.ok(r.ok, e);
  }
  const last = s.events[s.events.length - 1];
  assert.equal(last.k, 'emotion');
  assert.equal(last.seat, seat);
  // мусорная эмоция
  const r2 = pushEmotion(s, seat, 'dance');
  assert.equal(r2.code, 'bad_emotion');
  // не в игре
  s.status = 'ended';
  const r3 = pushEmotion(s, seat, 'greet');
  assert.equal(r3.code, 'game_over');
});

test('send_emotion: только в игре, троттлинг 1/с, снапшот обоим', () => {
  const s = fresh();
  const room = { phase: 'game', game: s, code: 'TST1' };
  const ctx = { seat: s.turn, room, ws: {}, _lastEmotion: 0 };
  const errors = [];
  let stateAll = 0;
  const ns = {
    send: (_ws, t, d) => { if (t === 'error') errors.push(d); },
    sendStateAll: () => { stateAll++; },
  };
  // вне комнаты
  handleMessage(ns, { seat: 0, room: null, ws: {} }, { t: 'send_emotion', d: { emotion: 'greet' } });
  assert.equal(errors.at(-1).code, 'not_in_game');
  // в лобби
  ctx.room.phase = 'lobby';
  handleMessage(ns, ctx, { t: 'send_emotion', d: { emotion: 'greet' } });
  assert.equal(errors.at(-1).code, 'not_in_game');
  // в игре: проходит, снапшот ушёл
  ctx.room.phase = 'game';
  stateAll = 0;
  handleMessage(ns, ctx, { t: 'send_emotion', d: { emotion: 'praise' } });
  assert.equal(stateAll, 1);
  assert.ok(s.events.some((e) => e.k === 'emotion' && e.emotion === 'praise'));
  // сразу снова — троттлинг
  handleMessage(ns, ctx, { t: 'send_emotion', d: { emotion: 'fire' } });
  assert.equal(errors.at(-1).code, 'throttled');
  // мусорная эмоция в игре
  ctx._lastEmotion = 0;
  handleMessage(ns, ctx, { t: 'send_emotion', d: { emotion: 'jump' } });
  assert.equal(errors.at(-1).code, 'bad_emotion');
});

test('events: seq строго растёт, события типизированы', () => {
  const s = fresh();
  const seat = s.turn;
  s.players[seat].mana = 10;
  give(s, seat, 'fireball');
  play(s, seat, 'fireball', { kind: 'hero', seat: 1 - seat });
  let prev = 0;
  for (const e of s.events) {
    assert.ok(e.seq > prev, 'seq растёт');
    prev = e.seq;
    assert.ok(typeof e.k === 'string' && e.k.length > 0);
  }
  assert.equal(s.events.length, prev);
});
