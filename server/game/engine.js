// engine.js — игровой движок. ЕДИНСТВЕННЫЙ источник истины (сервер).
//
// Ответственность: старт партии, ходы, мана, draw/burn/fatigue,
// разыгрывание карт (спеллы, боевые кличи — включая таргетные,
// смертельные хрипы, ауры, Божественный щит), АТАКИ (существа и оружие),
// Poisonous/Charge/таунт, валидация легальности, выбор целей, конец партии.
//
// Принцип атомарности: сначала ПОЛНАЯ валидация, потом изменение состояния.
// Нелегальная команда не оставляет побочных эффектов.
import { randomUUID } from 'node:crypto';
import { RNG } from './rng.js';
import { CARD_DB, getCard, DECK_LIST } from './cards.js';

export const HEROES = [
  {
    name: 'Кайл', title: 'Рыцарь Искры',
    power: { id: 'spark_bless', name: 'Искра', desc: 'Даёт случайному вашему существу +1/+1 (2 маны).', cost: 2 },
  },
  {
    name: 'Мариса', title: 'Ведьма Инея',
    power: { id: 'frost_dart', name: 'Ледяная игла', desc: 'Наносит 1 урон случайному вражескому существу и замораживает его (2 маны).', cost: 2 },
  },
];

/** Описания геройских способностей (для тултипов клиента). */
export function heroPowerDef(seat) {
  return HEROES[seat]?.power ?? null;
}

const MAX_MANA = 10;
const HERO_HP = 30;
const HAND_MAX = 10;
const BOARD_MAX = 7;
const DEATH_GUARD = 50; // защита от зацикливания deathrattle-цепочек

/** 8 эмоций (документация §5.2): идентификатор → подпись. */
export const EMOTIONS = {
  greet: 'Привет',
  thanks: 'Спасибо',
  threat: 'Угроза',
  laugh: 'Смех',
  sad: 'Печаль',
  surprise: 'Удивление',
  praise: 'Похвала',
  fire: 'Огонь',
};

/** Эмоция: событие в журнал (уходит обоим через state). @returns ok/fail */
export function pushEmotion(state, seat, emotion) {
  if (!state || state.status !== 'running') return fail(ERR.game_over);
  if (seat !== 0 && seat !== 1) return fail(ERR.bad_payload);
  if (!EMOTIONS[emotion]) return fail({ code: 'bad_emotion', msg: 'Неизвестная эмоция' });
  pushEvent(state, { k: 'emotion', seat, emotion });
  return ok();
}

export const ERR = {
  not_in_game: { code: 'not_in_game', msg: 'Матч не начался' },
  game_over: { code: 'game_over', msg: 'Матч уже завершён' },
  not_your_turn: { code: 'not_your_turn', msg: 'Сейчас не ваш ход' },
  card_not_yours: { code: 'card_not_yours', msg: 'Эта карта не в вашей руке' },
  not_enough_mana: { code: 'not_enough_mana', msg: 'Недостаточно маны' },
  power_used: { code: 'power_used', msg: 'Геройская способность уже использована в этом ходу' },
  board_full: { code: 'board_full', msg: 'Поле заполнено (максимум 7)' },
  invalid_target: { code: 'invalid_target', msg: 'Недопустимая цель' },
  target_required: { code: 'target_required', msg: 'Нужна цель' },
  target_not_required: { code: 'target_not_required', msg: 'Эта карта не требует цели' },
  targeting_cry_later: { code: 'targeting_cry_later', msg: 'Эта карта появится в игре на этапе 3' },
  unit_not_mine: { code: 'unit_not_mine', msg: 'Это существо не ваше' },
  cannot_attack: { code: 'cannot_attack', msg: 'Существо не может атаковать (болезнь/столетие/уже атаковало)' },
  weapon_cannot_attack: { code: 'weapon_cannot_attack', msg: 'Новое оружие нельзя использовать в ход его покупки' },
  no_weapon: { code: 'no_weapon', msg: 'Оружие не экипировано' },
  taunt_blocked: { code: 'taunt_blocked', msg: 'Сначала одолейте провокатора' },
  bad_payload: { code: 'bad_payload', msg: 'Некорректная команда' },
};

const ok = () => ({ ok: true });
const fail = (e) => ({ ok: false, code: e.code, msg: e.msg });
const uid = () => randomUUID();

// ═══════════════════════ СОЗДАНИЕ ИГРЫ ═══════════════════════

/**
 * Создать партию: тасовка (серверный RNG), по 3 карты, Монета зари
 * второму игроку (компенсация первого хода), случайный первый ход.
 * @param {string[]} nicks [ник0, ник1]
 */
export function createGame(nicks) {
  const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const rng = new RNG(seed);

  const players = [0, 1].map((seat) => ({
    seat,
    nick: nicks[seat],
    hero: {
      name: HEROES[seat].name,
      hp: HERO_HP,
      maxHp: HERO_HP,
      armor: 0,
      weapon: null,
      powerUsed: false, // геройская способность в этом ходу
    },
    mana: 0,
    maxMana: 0,
    deck: rng.shuffle([...DECK_LIST]),
    hand: [],
    board: [],
    fatigue: 0,
  }));

  const firstSeat = rng.int(2); // кто ходит первым (компенсация — см. coinOwner/startTurn)
  const state = {
    status: 'running',
    turn: firstSeat,
    firstSeat, // запомним: первый ходит первым, но не добирает на 1-м ходу
    turnCount: 0,
    players,
    winner: null,
    winReason: null,
    coinOwner: null,
    seq: 0,
    rngSeed: seed, // СЕКРЕТ: не сериализуется в снапшот
    rng,
    events: [],
  };

  // Стартовые 3 карты каждому
  for (const seat of [0, 1]) {
    for (let i = 0; i < 3; i++) drawCard(state, seat);
  }
  // Монета зари — ВТОРОМУ игроку (классическая компенсация преимущества
  // первого хода, баланс-пасс Этапа 6: при случайной игре первый выигрывал
  // ~61–64% партий; с монетой у второго — ~53–57%).
  state.coinOwner = 1 - state.turn;
  players[state.coinOwner].hand.push({ uid: uid(), cardId: 'dawn_coin' });
  pushEvent(state, { k: 'coin', seat: state.coinOwner });

  startTurn(state);
  return state;
}

// ═══════════════════════ ХОД И МАНА ═══════════════════════

function startTurn(state) {
  const p = state.players[state.turn];
  state.turnCount++;
  p.maxMana = Math.min(MAX_MANA, p.maxMana + 1);
  p.mana = p.maxMana;
  // Снять «болезнь новичка» и оглушение со своих существ; оружие снова боеготово
  for (const m of p.board) {
    m.canAttack = true;
    m.frozen = false;
    m.justPlayed = false;
  }
  if (p.hero.weapon) p.hero.weapon.justEquipped = false;
  p.hero.powerUsed = false; // геройская способность доступна каждый ход
  pushEvent(state, { k: 'turn_start', seat: state.turn, mana: p.mana, maxMana: p.maxMana });
  // HS-модель (баланс-пасс Этапа 6): первый игрок не добирает на первом ходу —
  // у второго +карта и Монета зари против преимущества темпо.
  if (!(state.turnCount === 1 && state.turn === state.firstSeat)) drawCard(state, state.turn);
  checkWin(state); // fatigue мог убить героя
}

/** Тянуть карту: fatigue при пустой колоде, burn при переполненной руке. */
function drawCard(state, seat) {
  const p = state.players[seat];
  if (p.deck.length === 0) {
    p.fatigue++;
    pushEvent(state, { k: 'fatigue', seat, amount: p.fatigue });
    damageUnit(state, { kind: 'hero', seat }, p.fatigue, 'fatigue');
    return;
  }
  const cardId = p.deck.pop();
  if (p.hand.length >= HAND_MAX) {
    pushEvent(state, { k: 'burn', seat, cardId });
    return;
  }
  p.hand.push({ uid: uid(), cardId });
  pushEvent(state, { k: 'draw', seat, n: 1 });
}

// ═══════════════════════ КОМАНДЫ ═══════════════════════

/**
 * Применить команду игрока. @returns {{ok: true} | {ok: false, code, msg}}
 * cmd: {type:'end_turn'} | {type:'play_card', handUid, target?}
 */
export function command(state, seat, cmd) {
  if (!state) return fail(ERR.not_in_game);
  if (state.status !== 'running') return fail(ERR.game_over);
  if (state.turn !== seat) return fail(ERR.not_your_turn);
  const p = state.players[seat];

  if (cmd.type === 'end_turn') {
    state.turn = 1 - seat;
    startTurn(state);
    return ok();
  }

  if (cmd.type === 'hero_power') {
    return applyHeroPower(state, seat, cmd.target ? normalizeUnit(cmd.target) : null);
  }

  if (cmd.type === 'play_card') {
    const inst = p.hand.find((h) => h.uid === cmd.handUid);
    if (!inst) return fail(ERR.card_not_yours);
    const def = getCard(inst.cardId);
    if (p.mana < def.cost) return fail(ERR.not_enough_mana);
    if (def.type === 'minion' && p.board.length >= BOARD_MAX) return fail(ERR.board_full);
    // Требует выбор цели: спелл с targeting или боевой клич с target
    // (Этап 3: Ледяной элементаль — оглушение по выбору)
    const cryTargets = def.type === 'minion' && (def.battlecry || []).some((e) => e.target === 'target');
    const needsTarget = (def.type === 'spell' && def.targeting !== 'none') || cryTargets;
    if (needsTarget) {
      const valid = getTargetsForMode(state, seat, def.targeting, def, { battlecry: cryTargets });
      const provided = cmd.target && normalizeUnit(cmd.target);
      if (!provided) return fail(ERR.target_required);
      if (!valid.some((t) => sameUnit(t, provided))) return fail(ERR.invalid_target);
    } else if (cmd.target) {
      return fail(ERR.target_not_required);
    }

    // ── применение (валидация пройдена) ──
    p.mana -= def.cost;
    p.hand.splice(p.hand.indexOf(inst), 1);
    applyPlay(state, seat, inst, def, cmd.target ? normalizeUnit(cmd.target) : null);
    processDeaths(state);
    recomputeBoard(state);
    checkWin(state);
    return ok();
  }

  if (cmd.type === 'attack') {
    const res = applyAttack(state, seat, cmd);
    if (!res.ok) return res;
    processDeaths(state);
    recomputeBoard(state);
    checkWin(state);
    return ok();
  }

  return fail(ERR.bad_payload);
}

// ═══════════════════════ ГЕРОЙСКАЯ СПОСОБНОСТЬ (Этап 8) ═══════════════════════
//  • Кайл: +1/+1 случайному своему существу (2 маны)
//  • Мариса: 1 урон + заморозка случайному вражескому существу (2 маны)
// Использование раз в ход; если целей нет — сервер вернёт ошибку.

function applyHeroPower(state, seat, _target) {
  const p = state.players[seat];
  const opp = 1 - seat;
  const hdef = HEROES[seat];
  const cost = hdef.power.cost;
  if (p.hero.powerUsed) return fail(ERR.power_used);
  if (p.mana < cost) return fail(ERR.not_enough_mana);
  pushEvent(state, { k: 'hero_power', seat, power: hdef.power.id });

  if (seat === 0) {
    const targets = p.board.slice();
    if (!targets.length) return fail({ code: 'no_targets', msg: 'На вашей стороне нет существ' });
    const m = state.rng.pick(targets);
    p.mana -= cost;
    p.hero.powerUsed = true;
    m.atk += 1; m.health += 1; m.maxHealth += 1;
    pushEvent(state, { k: 'buff', target: { kind:'minion', uid:m.uid, seat }, atk:1, health:1 });
  } else {
    const targets = state.players[opp].board.slice();
    if (!targets.length) return fail({ code: 'no_targets', msg: 'На стороне противника нет существ' });
    const m = state.rng.pick(targets);
    p.mana -= cost;
    p.hero.powerUsed = true;
    damageUnit(state, { kind:'minion', uid:m.uid, seat:opp }, 1, 'hero_power');
    m.frozen = true;
    pushEvent(state, { k: 'freeze', target: { kind:'minion', uid:m.uid, seat:opp } });
  }
  processDeaths(state);
  recomputeBoard(state);
  checkWin(state);
  return ok();
}

/** Клиент хочет знать, можно ли использовать способность сейчас — и сколько это стоит. */
export function getHeroPowerState(state, seat) {
  const p = state.players[seat];
  const def = HEROES[seat].power;
  const hasTargets = seat === 0 ? p.board.length > 0 : state.players[1-seat].board.length > 0;
  return {
    id: def.id,
    name: def.name,
    desc: def.desc,
    cost: def.cost,
    used: !!p.hero.powerUsed,
    playable: state.status === 'running'
      && state.turn === seat
      && !p.hero.powerUsed
      && p.mana >= def.cost
      && hasTargets,
  };
}

// ═══════════════════════ АТАКИ (Этап 3) ═══════════════════════

/**
 * Атака существом или оружием.
 * cmd: {type:'attack', fromUid, fromSeat, toUid?, toSeat, ack}
 *   fromUid = uid существа | 'weapon'; toUid = uid чужого существа | null (герой).
 * Правила (HS): существо бьёт и получает урон в ответ (кроме героя);
 * Провокаторы закрывают всё чужое поле и героя; оружие не контратакует
 * и тратит прочность; Яд убивает цель, если урон реально прошёл (щит — нет).
 */
function applyAttack(state, seat, cmd) {
  const p = state.players[seat];
  const opp = 1 - seat;
  const taunts = enemyTaunts(state, seat);

  // ── атакующий ──
  let viaWeapon = false;
  let attackerAtk = 0;
  let sourceRef;
  let attackerMinion = null;
  if (cmd.fromUid === 'weapon') {
    if (cmd.fromSeat !== seat) return fail(ERR.unit_not_mine);
    if (!p.hero.weapon) return fail(ERR.no_weapon);
    if (p.hero.weapon.justEquipped) return fail(ERR.weapon_cannot_attack);
    viaWeapon = true;
    attackerAtk = p.hero.weapon.attack;
    sourceRef = { kind: 'hero', seat };
  } else {
    if (cmd.fromSeat !== seat) return fail(ERR.unit_not_mine);
    attackerMinion = p.board.find((m) => m.uid === cmd.fromUid);
    if (!attackerMinion) return fail(ERR.unit_not_mine);
    if (!attackerMinion.canAttack) return fail(ERR.cannot_attack);
    if (attackerMinion.frozen) return fail(ERR.cannot_attack);
    attackerAtk = attackerMinion.atk;
    sourceRef = { kind: 'minion', uid: attackerMinion.uid, seat };
  }

  // ── цель ──
  let targetRef;
  let defenderMinion = null;
  if (cmd.toUid) {
    if (cmd.toSeat !== opp) return fail(ERR.unit_not_mine);
    defenderMinion = state.players[opp].board.find((m) => m.uid === cmd.toUid);
    if (!defenderMinion) return fail(ERR.invalid_target);
    if (defenderMinion.frozen) return fail(ERR.invalid_target); // оглушение: бить нельзя
    if (taunts.length && !(getCard(defenderMinion.cardId).keywords || []).includes('taunt')) {
      return fail(ERR.taunt_blocked);
    }
    targetRef = { kind: 'minion', uid: defenderMinion.uid, seat: opp };
  } else if (cmd.toSeat === opp) {
    if (taunts.length) return fail(ERR.taunt_blocked);
    targetRef = { kind: 'hero', seat: opp };
  } else {
    return fail(ERR.unit_not_mine);
  }

  // ── разрешение ──
  if (viaWeapon) {
    // оружие: урон по цели, без контратаки; прочность -1
    damageUnit(state, targetRef, attackerAtk, 'attack');
    const fatal = targetRef.kind === 'minion' && defenderMinion.health <= 0;
    pushEvent(state, { k: 'attack', from: sourceRef, to: targetRef, damage: attackerAtk, fatal, viaWeapon: true });
    p.hero.weapon.durability -= 1;
    if (p.hero.weapon.durability <= 0) {
      pushEvent(state, { k: 'weapon_broke', seat, cardId: p.hero.weapon.cardId, reason: 'durability' });
      p.hero.weapon = null;
    }
    return ok();
  }

  // существо: ход атаки (один раз за ход)
  attackerMinion.canAttack = false;
  if (targetRef.kind === 'hero') {
    damageUnit(state, targetRef, attackerAtk, 'attack');
    pushEvent(state, { k: 'attack', from: sourceRef, to: targetRef, damage: attackerAtk, fatal: false, viaWeapon: false });
    return ok();
  }

  // существо ↔ существо: обмен уроном + Яд
  const defenderAtk = defenderMinion.atk;
  const dealtToDefender = damageUnit(state, targetRef, attackerAtk, 'attack');
  const dealtToAttacker = damageUnit(state, sourceRef, defenderAtk, 'attack');
  const aPoison = (getCard(attackerMinion.cardId).keywords || []).includes('poisonous');
  const dPoison = (getCard(defenderMinion.cardId).keywords || []).includes('poisonous');
  if (aPoison && dealtToDefender > 0) {
    defenderMinion._poisonDeath = true;
    defenderMinion.health = 0;
  }
  if (dPoison && dealtToAttacker > 0) {
    attackerMinion._poisonDeath = true;
    attackerMinion.health = 0;
  }
  pushEvent(state, {
    k: 'attack', from: sourceRef, to: targetRef,
    damage: attackerAtk, fatal: defenderMinion.health <= 0, viaWeapon: false,
  });
  return ok();
}

function applyPlay(state, seat, inst, def, target) {
  const p = state.players[seat];

  if (def.type === 'minion') {
    const keywords = def.keywords || [];
    const m = makeMinion(state, seat, inst.uid, def.id, def.attack, def.health, {
      canAttack: keywords.includes('charge'), // эффект Charge — Этап 3, флаг уже хранится
      ds: keywords.includes('divine_shield'),
    });
    p.board.push(m);
    pushEvent(state, {
      k: 'play_minion', seat, handUid: inst.uid, cardId: def.id,
      slot: p.board.length - 1,
    });
    // Боевой клич (включая таргетные — цель уже валидирована)
    if (def.battlecry?.length) {
      applyEffects(state, seat, def.battlecry, 'battlecry', { sourceMinion: m, target });
    }
    recomputeBoard(state);
    return;
  }

  if (def.type === 'weapon') {
    const hero = p.hero;
    if (hero.weapon) {
      pushEvent(state, { k: 'weapon_broke', seat, cardId: hero.weapon.cardId, reason: 'replaced' });
    }
    // HS-правило: свежее оружие нельзя применять в ход его покупки
    hero.weapon = { cardId: def.id, attack: def.attack, durability: def.durability, justEquipped: true };
    pushEvent(state, { k: 'play_weapon', seat, handUid: inst.uid, cardId: def.id });
    return;
  }

  // заклинание
  pushEvent(state, { k: 'play_spell', seat, handUid: inst.uid, cardId: def.id, target: target ?? undefined });
  applyEffects(state, seat, def.spell, 'spell', { target });
}

// ═══════════════════════ ЭФФЕКТЫ ═══════════════════════

function applyEffects(state, seat, effects, source, ctx) {
  for (const eff of effects || []) {
    applyEffect(state, seat, eff, source, ctx);
    if (state.status !== 'running') break;
  }
}

function applyEffect(state, seat, eff, source, ctx) {
  const opp = 1 - seat;
  switch (eff.kind) {
    case 'damage': {
      const target = eff.target === 'target'
        ? ctx.target
        : resolveFixedTarget(state, seat, eff.target);
      if (target) {
        pushEvent(state, { k: 'fx', kind: source === 'battlecry' ? 'fire' : 'fire', target });
        damageUnit(state, target, eff.amount, source);
      }
      break;
    }
    case 'heal': {
      const h = state.players[seat].hero;
      const before = h.hp;
      h.hp = Math.min(h.maxHp, h.hp + eff.amount);
      if (h.hp > before) pushEvent(state, { k: 'heal', target: { kind: 'hero', seat }, amount: h.hp - before });
      break;
    }
    case 'draw':
      for (let i = 0; i < eff.amount; i++) drawCard(state, seat);
      break;
    case 'mana_gain':
      state.players[seat].mana += eff.amount; // Монета: мана может превысить maxMana в этом ходе
      break;
    case 'buff': {
      const target = eff.target === 'target_ally'
        ? ctx.target
        : eff.target === 'other_friendly' ? null : null; // ауры/массовые — не здесь
      if (target?.kind === 'minion') {
        const m = findMinion(state, target);
        if (m) {
          m.baseAtk += eff.atk || 0;
          m.baseHealth += eff.health || 0;
          m.health += eff.health || 0;
          m.maxHealth += eff.health || 0;
          pushEvent(state, { k: 'buff', target, atk: eff.atk || 0, health: eff.health || 0 });
        }
      } else if (eff.target === 'other_friendly') {
        // массовый бафф «ваши другие существа» (боевой клич вождя)
        for (const m of state.players[seat].board) {
          if (m === ctx.sourceMinion) continue;
          m.baseAtk += eff.atk || 0;
          m.baseHealth += eff.health || 0;
          m.health += eff.health || 0;
          m.maxHealth += eff.health || 0;
          pushEvent(state, { k: 'buff', target: { kind: 'minion', uid: m.uid, seat }, atk: eff.atk || 0, health: eff.health || 0 });
        }
      }
      break;
    }
    case 'stun': {
      const t = ctx.target;
      if (t?.kind === 'minion') {
        const m = findMinion(state, t);
        if (m) {
          m.frozen = true;
          pushEvent(state, { k: 'freeze', target: t });
        }
      }
      // по герою оглушение не действует
      break;
    }
    case 'summon': {
      if (state.players[seat].board.length < BOARD_MAX && eff.minionCard) {
        const mc = eff.minionCard;
        const m = makeMinion(state, seat, uid(), mc.cardId, mc.atk, mc.health, { summoned: true });
        state.players[seat].board.push(m);
        pushEvent(state, { k: 'fx', kind: 'summon', seat });
        pushEvent(state, { k: 'play_minion', seat, cardId: mc.cardId, slot: state.players[seat].board.length - 1, summoned: true });
      }
      break;
    }
    case 'kill_minion': {
      // «уничтожить» — прямой removal: Божественный щит НЕ блокирует
      const t = ctx.target;
      if (t?.kind === 'minion') {
        const m = findMinion(state, t);
        if (m) {
          m.health = 0;
          pushEvent(state, { k: 'fx', kind: 'dark', target: t });
        }
      }
      break;
    }
    case 'damage_all': {
      const list = eff.target === 'all_minions'
        ? [...state.players[seat].board, ...state.players[opp].board]
        : state.players[opp].board;
      pushEvent(state, { k: 'fx', kind: eff.target === 'all_minions' ? 'lightning' : 'fire', seat });
      for (const m of [...list]) {
        damageUnit(state, { kind: 'minion', uid: m.uid, seat: m.seat }, eff.amount, source);
      }
      break;
    }
    case 'destroy_all': {
      // «уничтожить всё» — removal: щиты НЕ спасают (как Пироклазм в HS)
      const list = state.players[opp].board;
      pushEvent(state, { k: 'fx', kind: 'fire', seat });
      for (const m of [...list]) {
        m.health = 0;
      }
      break;
    }
    default:
      console.warn(`[engine] неизвестный эффект: ${eff.kind}`);
  }
}

/** Решить «фиксированную» цель без выбора игрока. */
function resolveFixedTarget(state, seat, target) {
  const opp = 1 - seat;
  switch (target) {
    case 'enemy_hero':
      return { kind: 'hero', seat: opp };
    case 'friendly_hero':
      return { kind: 'hero', seat };
    case 'random_enemy_minion': {
      const list = state.players[opp].board;
      return list.length ? { kind: 'minion', uid: state.rng.pick(list).uid, seat: opp } : null;
    }
    default:
      return null;
  }
}

/**
 * Нанести урон единице (с учётом Божественного щита).
 * @returns {number} урон, реально доставленный (0 — поглощён щитом/некому)
 */
function damageUnit(state, ref, amount, source) {
  if (amount <= 0) return 0;
  if (ref.kind === 'hero') {
    const h = state.players[ref.seat].hero;
    h.hp -= amount;
    pushEvent(state, { k: 'damage', target: ref, amount, source });
    return amount;
  }
  const m = findMinion(state, ref);
  if (!m) return 0;
  if (m.ds) {
    m.ds = false;
    pushEvent(state, { k: 'shield_break', target: ref });
    return 0; // инстанс урона полностью поглощён
  }
  m.health -= amount;
  pushEvent(state, { k: 'damage', target: ref, amount, source });
  return amount;
}

// ═══════════════════════ СМЕРТИ И ДУХИ ═══════════════════════

/** Очередь смертей: deathrattle может убить других (глубина ограничена). */
function processDeaths(state) {
  let guard = 0;
  while (guard++ < DEATH_GUARD) {
    const dead = [];
    for (const p of state.players) {
      for (const m of p.board) if (m.health <= 0) dead.push(m);
    }
    if (!dead.length) return;
    for (const m of dead) {
      const board = state.players[m.seat].board;
      const i = board.indexOf(m);
      if (i >= 0) board.splice(i, 1);
      pushEvent(state, { k: 'minion_died', uid: m.uid, seat: m.seat, poison: !!m._poisonDeath });
      const def = getCard(m.cardId);
      if (def.deathrattle?.length) {
        applyEffects(state, m.seat, def.deathrattle, 'deathrattle', {});
      }
    }
  }
}

// ══════════════════════ АУРЫ (статические эффекты) ═══════════════════════

/**
 * Пересчитать текущие атаки/HP с учётом аур («ваши другие существа +1/+1»).
 * Вызывается при любом изменении состава поля.
 */
export function recomputeBoard(state) {
  for (const p of state.players) {
    for (const m of p.board) {
      let aAtk = 0;
      let aHp = 0;
      for (const other of p.board) {
        if (other === m) continue;
        const def = getCard(other.cardId);
        if (!def.aura) continue;
        aAtk += def.aura.atk || 0;
        aHp += def.aura.health || 0;
      }
      if (aHp !== m._auraHp) {
        m.health += aHp - m._auraHp;
        m.maxHealth += aHp - m._auraHp;
        m._auraHp = aHp;
      }
      m.atk = m.baseAtk + aAtk;
    }
  }
}

// ═══════════════════════ ПОБЕДА ═══════════════════════

function checkWin(state) {
  const dead = state.players.filter((p) => p.hero.hp <= 0).map((p) => p.seat);
  if (!dead.length) return;
  // Одновременная (теоретически, через цепочку deathrattle) — побеждает активный
  const winner = dead.length === 2 ? state.turn : 1 - dead[0];
  state.status = 'ended';
  state.winner = winner;
  state.winReason = 'hero_kill';
  pushEvent(state, { k: 'game_over', winner, reason: 'hero_kill' });
}

// ═══════════════════════ ЦЕЛИ И ОПЦИИ ═══════════════════════

function makeMinion(state, seat, cardUid, cardId, atk, health, opts = {}) {
  return {
    uid: cardUid,
    cardId,
    seat,
    baseAtk: atk,
    baseHealth: health,
    health,
    maxHealth: health,
    atk,
    canAttack: !!opts.canAttack,
    frozen: false,
    ds: !!opts.ds,
    justPlayed: !opts.summoned && !opts.canAttack,
    _auraAtk: 0,
    _auraHp: 0,
  };
}

/** Даёт ли набор эффектов урон по выбранной цели (таунт ограничивает только такие). */
function isTargetingDamage(effects) {
  return (effects || []).some((e) => e.kind === 'damage' && e.target === 'target');
}

/** Есть ли на поле противника Провокация (для атак и урональных спеллов). */
function enemyTaunts(state, seat) {
  return state.players[1 - seat].board.filter((m) =>
    (getCard(m.cardId).keywords || []).includes('taunt')
  );
}

/**
 * Валидные цели для режима таргетинга (спелл или боевой клич).
 * Правило таунта (как в HS): урональные эффекты обязаны бить в Taunt,
 * если он есть. Непрямые эффекты (bone_arrow — «уничтожить», баффы,
 * оглушение) таунтом НЕ ограничены.
 */
export function getTargetsForMode(state, seat, mode, def, { battlecry = false } = {}) {
  const opp = 1 - seat;
  const oppBoard = state.players[opp].board;
  const myBoard = state.players[seat].board;
  const effects = battlecry ? def.battlecry : def.spell;
  const taunts = enemyTaunts(state, seat);
  let enemyList = oppBoard;
  if (mode.startsWith('enemy') && isTargetingDamage(effects) && taunts.length) {
    enemyList = taunts;
  }
  if (def?.attackMax != null) enemyList = enemyList.filter((m) => m.atk <= def.attackMax);

  const ref = (m) => ({ kind: 'minion', uid: m.uid, seat: m.seat });
  switch (mode) {
    case 'enemy_minion':
      return enemyList.map(ref);
    case 'enemy_minion_or_hero':
      return [...enemyList.map(ref), { kind: 'hero', seat: opp }];
    case 'friendly_minion':
      return myBoard.map((m) => ({ kind: 'minion', uid: m.uid, seat }));
    default:
      return [];
  }
}

/**
 * Валидные ЦЕЛИ АТАКИ (существо или оружие) для игрока seat:
 * чужие существа (только Провокаторы, если они есть) + герой (если нет Провокаторов).
 */
function attackTargets(state, seat) {
  const opp = 1 - seat;
  const taunts = enemyTaunts(state, seat);
  const ref = (m) => ({ kind: 'minion', uid: m.uid, seat: opp });
  // оглушённое существо атаковать нельзя (HS: «can't be attacked»)
  const base = (taunts.length ? taunts : state.players[opp].board).filter((m) => !m.frozen);
  const minions = base.map(ref);
  if (!taunts.length) minions.push({ kind: 'hero', seat: opp });
  return minions;
}

/**
 * Опции атак игрока seat — уходят в снапшот (клиент лишь подсвечивает).
 * { minions: [{uid, targets[]}], weapon: {targets[]} | null }
 */
export function computeAttackOptions(state, seat) {
  if (state.status !== 'running' || state.turn !== seat) {
    return { minions: [], weapon: null };
  }
  const p = state.players[seat];
  const targets = attackTargets(state, seat);
  const minions = p.board
    .filter((m) => m.canAttack && !m.frozen)
    .map((m) => ({ uid: m.uid, targets }));
  const weapon = p.hero.weapon && !p.hero.weapon.justEquipped ? { targets } : null;
  return { minions, weapon };
}

/**
 * Опции разыгрывания для руки игрока — уходит в снапшот.
 * Клиент лишь подсвечивает; сервер перепроверит при play_card.
 */
export function computePlayOptions(state, seat) {
  const p = state.players[seat];
  return p.hand.map((inst) => {
    const def = getCard(inst.cardId);
    const cryTargets = def.type === 'minion' && (def.battlecry || []).some((e) => e.target === 'target');
    let playable =
      state.status === 'running' &&
      state.turn === seat &&
      p.mana >= def.cost &&
      (def.type !== 'minion' || p.board.length < BOARD_MAX);
    let targets = [];
    if (playable && def.type === 'spell' && def.targeting !== 'none') {
      targets = getTargetsForMode(state, seat, def.targeting, def);
      if (!targets.length) playable = false; // целей нет — играть нечего
    } else if (playable && cryTargets) {
      targets = getTargetsForMode(state, seat, def.targeting, def, { battlecry: true });
      if (!targets.length) playable = false;
    }
    return { uid: inst.uid, cardId: inst.cardId, playable, targets };
  });
}

// ═══════════════════════ УТИЛИТЫ ═══════════════════════

function pushEvent(state, ev) {
  state.seq++;
  state.events.push({ seq: state.seq, ...ev });
}

function findMinion(state, ref) {
  if (ref.kind !== 'minion') return null;
  for (const p of state.players) {
    const m = p.board.find((x) => x.uid === ref.uid);
    if (m) return m;
  }
  return null;
}

function normalizeUnit(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.kind === 'hero' && (t.seat === 0 || t.seat === 1)) return { kind: 'hero', seat: t.seat };
  if (t.kind === 'minion' && typeof t.uid === 'string' && (t.seat === 0 || t.seat === 1)) {
    return { kind: 'minion', uid: t.uid, seat: t.seat };
  }
  return null;
}

function sameUnit(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'hero') return a.seat === b.seat;
  return a.uid === b.uid;
}
