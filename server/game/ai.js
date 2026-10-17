// ai.js — серверный ИИ-оппонент.
//
// Жадный эвристический бот «ЯРОПОЛК» (Яд, Размен, Очки, Прессинг, Оружие, Летал, Клив):
//  1. Считает летальный урон в лицо — если есть, бьёт туда.
//  2. Сортировка разыгрывания: существа вперёд (поле давит), потом оружие, потом спеллы.
//     Приоритет карт по cost/мане (заполняем кривую маны), монету играем только когда
//     можем на следующий кристалл сыграть что-то полезное.
//  3. Существа с разменом >=1 ставят в приоритет; ядовитые бьют только крупных.
//  4 Если нет летала, бьём таунты, потом лучший размен (макс польза/потеря),
//    и только потом добиваем в лицо.
//
// Бот вызывается прямо из NetServer по таймеру (нет сетевого соединения).
// Все команды прогоняются через engineCommand как обычный игрок — античит работает.
//
import { command as engineCommand, computePlayOptions, computeAttackOptions } from './engine.js';
import { getCard } from './cards.js';

const AI_NICK = '🤖 Ярополк';
const THINK_MS = 550; // пауза перед первым ходом и между командами — «человеческое» ощущение

export const AI_SEAT = 1;
export const HUMAN_SEAT = 0;

export function aiNick() { return AI_NICK; }

/** Прикрепить к комнате ИИ-оппонента: готовность + планирование ходов. */
export function attachAI(ns, room) {
  room._ai = {
    timer: null,
    ns,
    room,
    lastTurn: -1,
  };
  // Бот всегда готов и «подключён»
  room.seats[AI_SEAT].ready = true;
  room.seats[AI_SEAT].connected = true;
}

/** Уведомить ИИ о новом состоянии (обычно после хода человека или старта). */
export function aiPoke(ns, room) {
  if (!room._ai) return;
  if (room.phase !== 'game' || !room.game) return;
  if (room.game.status !== 'running') {
    clearTimeout(room._ai.timer);
    room._ai.timer = null;
    return;
  }
  if (room.game.turn !== AI_SEAT) return;
  if (room._ai.timer) return; // уже планируем
  const delay = room.game.turnCount === 0 ? THINK_MS * 2 : THINK_MS + Math.random() * 300;
  room._ai.timer = setTimeout(() => {
    room._ai.timer = null;
    aiTick(ns, room);
  }, delay);
}

function clearAITimer(room) {
  if (room._ai?.timer) {
    clearTimeout(room._ai.timer);
    room._ai.timer = null;
  }
}

/** Один шаг ИИ: пытается сделать одну команду. Если ничего не может — end_turn. */
function aiTick(ns, room) {
  if (room.phase !== 'game' || !room.game || room.game.status !== 'running') {
    clearAITimer(room); return;
  }
  if (room.game.turn !== AI_SEAT) return;
  if (!room.seats[AI_SEAT]) { clearAITimer(room); return; }

  // 1. летал в лицо одной атакой? пробуем все атаки.
  const lethal = findLethal(room.game);
  if (lethal) {
    runCmd(ns, room, lethal);
    return;
  }

  // 2. лучшая карта к розыгрышу
  const play = choosePlayCard(room.game);
  if (play) {
    runCmd(ns, room, play);
    return;
  }

  // 3. лучшая атака
  const atk = chooseAttack(room.game);
  if (atk) {
    runCmd(ns, room, atk);
    return;
  }

  // 4. конец хода
  runCmd(ns, room, { type: 'end_turn' });
}

function runCmd(ns, room, cmd) {
  const res = engineCommand(room.game, AI_SEAT, cmd);
  if (!res.ok) {
    // Такого не должно быть — защитный fallback: сдаём ход.
    console.warn('[ai] команда отклонена:', cmd, res);
    engineCommand(room.game, AI_SEAT, { type: 'end_turn' });
  }
  ns.sendStateAll(room);
  if (room.game.status === 'ended') {
    ns.endRoomGame(room);
    clearAITimer(room);
    return;
  }
  // Планируем следующий шаг
  if (room.game.turn === AI_SEAT) {
    room._ai.timer = setTimeout(() => {
      room._ai.timer = null;
      aiTick(ns, room);
    }, 250 + Math.random() * 250);
  }
}

// ─────────────── ПРИНЯТИЕ РЕШЕНИЙ ───────────────

function me(state) { return state.players[AI_SEAT]; }
function foe(state) { return state.players[1 - AI_SEAT]; }
function isHero(ref) { return ref.kind === 'hero'; }
function findMinion(state, ref) {
  if (ref.kind !== 'minion') return null;
  for (const p of state.players) {
    const m = p.board.find((x) => x.uid === ref.uid);
    if (m) return m;
  }
  return null;
}
function minionRef(m) { return { kind: 'minion', uid: m.uid, seat: m.seat }; }
function heroRef(seat) { return { kind: 'hero', seat }; }

/** Суммарный урон, который бот может нанести этим ходом в лицо. */
function potentialFaceDmg(state) {
  let dmg = 0;
  for (const m of me(state).board) if (m.canAttack && !m.frozen) dmg += m.atk;
  const w = me(state).hero.weapon;
  if (w && !w.justEquipped) dmg += w.atk;
  return dmg;
}

function hasTaunt(state) {
  return foe(state).board.some((m) => m.keywords?.includes('taunt') && !m.frozen);
}

function findLethal(state) {
  if (hasTaunt(state)) return null;
  const faceHp = foe(state).hero.hp - (foe(state).hero.ds ? 1 : 0);
  // Простая оценка: если общий урон >= hp и нет таунта — бьём всем в лицо.
  // Ищем конкретный первый удар: самое сильное существо/оружие бьёт первым
  // (реально летал гарантирован не одной атакой, а серией — первый удар в лицо ок).
  const atkOpts = computeAttackOptions(state, AI_SEAT);
  const face = heroRef(1 - AI_SEAT);
  const faceTarget = atkOpts.minions.flatMap((m) => m.targets).find((t) => isHero(t));
  if (faceTarget && potentialFaceDmg(state) >= foe(state).hero.hp) {
    // самое сильное существо
    let best = null;
    for (const m of atkOpts.minions) {
      if (!m.targets.some((t) => t.kind === 'hero')) continue;
      const mm = findMinion(state, { uid: m.uid, seat: AI_SEAT });
      if (!mm) continue;
      if (!best || mm.atk > best.atk) best = { uid: m.uid, atk: mm.atk };
    }
    if (best) {
      return { type: 'attack', fromUid: best.uid, fromSeat: AI_SEAT, toUid: null, toSeat: 1 - AI_SEAT };
    }
    const w = atkOpts.weapon;
    if (w && w.targets.some((t) => t.kind === 'hero')) {
      return { type: 'attack', fromUid: 'weapon', fromSeat: AI_SEAT, toUid: null, toSeat: 1 - AI_SEAT };
    }
  }
  return null;
}

function choosePlayCard(state) {
  const p = me(state);
  const opts = computePlayOptions(state, AI_SEAT).filter((o) => o.playable);
  if (!opts.length) return null;

  // Сортируем опции по эвристике (высшее score = лучше сыграть сейчас):
  //   • Монету (dawn_coin) играем только если это позволит сыграть другую карту
  //   • Существа ценнее спеллов/оружия (дают темп на доске)
  //   • При равном — выше стоимость (используем ману), при равном — толще статы.
  const scored = opts.map((o) => {
    // Берем описание через getCard через замыкание
    const def = cardDefs(state).get(o.cardId);
    if (!def) return { ...o, score: -Infinity };
    let s = 0;
    const onCurve = def.cost <= p.mana;
    if (o.cardId === 'dawn_coin') {
      // выгодно только если есть карта за p.mana+1 (либо сейчас с монетой 10 маны и жирная карта)
      const next = p.hand.find((h) => {
        if (h.uid === o.uid) return false;
        const d = cardDefs(state).get(h.cardId);
        return d && d.cost === p.mana + 1;
      });
      s = next ? 20 - (p.mana + 1) : -100;
      return { ...o, def, score: s };
    }
    // Тип: миньон > оружие > спелл
    if (def.type === 'minion') s += 10;
    else if (def.type === 'weapon') s += 7;
    else s += 5;
    // Ценность = cost + эффекты
    s += def.cost;
    if (def.type === 'minion') {
      s += (def.atk + def.health) * 0.5;
      if (def.keywords?.includes('taunt')) s += 1;
      if (def.keywords?.includes('charge')) s += 2;
      if (def.keywords?.includes('divine_shield')) s += 2;
      if (def.keywords?.includes('poisonous')) s += 2;
      if (def.keywords?.includes('frenzy')) s += 1;
      if (def.battlecry?.length) s += 2;
    }
    // Наказываем за розыгрыш, если поле переполнено (не должно случаться, т.к. playable=false)
    if (p.board.length >= 7 && def.type === 'minion') s -= 20;
    // Огненный шар / молния в лицо если враг на <6 хп
    if (def.type === 'spell' && (def.id === 'fireball' || def.id === 'frost_lance' || def.id === 'spark_bolt' || def.id === 'chain_lightning')) {
      const dmg = { fireball: 6, frost_lance: 3, spark_bolt: 2, chain_lightning: 4 }[def.id] ?? 0;
      if (foe(state).hero.hp <= dmg) s += 50;
    }
    // Если нет целей — всё равно не playable
    return { ...o, def, score: s };
  }).filter((x) => x.score > -100);
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const best = scored[0];
  // Выбираем лучшую цель для карты (если нужна):
  //  • если убойная карта в героя при <hp — герой
  //  • иначе — самое ценное вражеское существо (выживаемость < урону или таунт)
  let target = undefined;
  if (best.targets?.length) {
    const hero = best.targets.find((t) => t.kind === 'hero');
    // direct damage в лицо на летал
    const dmgMap = { fireball:6, frost_lance:3, spark_bolt:2, chain_lightning:4, bone_arrow:2 };
    const dmg = dmgMap[best.cardId] ?? 0;
    if (dmg && hero && foe(state).hero.hp <= dmg) {
      target = hero;
    } else {
      // целевое существо: то, которое лучше убить
      const units = best.targets
        .map((t) => ({ t, m: findMinion(state, t) }))
        .filter((x) => x.m)
        .sort((a, b) => {
          // приоритет: таунты → ядовитые → с большим atk → с большим hp
          const sa = (a.m.keywords?.includes('taunt') ? 100 : 0) + (a.m.keywords?.includes('poisonous') ? 50 : 0) + a.m.atk * 3 + a.m.hp;
          const sb = (b.m.keywords?.includes('taunt') ? 100 : 0) + (b.m.keywords?.includes('poisonous') ? 50 : 0) + b.m.atk * 3 + b.m.hp;
          return sb - sa;
        });
      target = units[0] ? units[0].t : hero;
    }
  }
  return { type: 'play_card', handUid: best.uid, target, ack: state.seq };
}

function chooseAttack(state) {
  const atkOpts = computeAttackOptions(state, AI_SEAT);
  const taunts = foe(state).board.filter((m) => m.keywords?.includes('taunt') && !m.frozen);
  const hasTauntFlag = taunts.length > 0;
  // Собираем всех доступных атакующих с их лучшими целями
  const attackers = [];
  for (const m of atkOpts.minions) {
    const mm = findMinion(state, { uid: m.uid, seat: AI_SEAT });
    if (!mm) continue;
    attackers.push({ uid: m.uid, atk: mm.atk, hp: mm.hp, weapon: false, targets: m.targets, minion: mm });
  }
  if (atkOpts.weapon) {
    attackers.push({ uid: 'weapon', atk: me(state).hero.weapon.atk, hp: 999, weapon: true, targets: atkOpts.weapon.targets, minion: null });
  }
  if (!attackers.length) return null;

  // Если есть таунт — надо бить только его. Выбираем лучший размен на таунта.
  const allowedTargets = hasTauntFlag
    ? taunts.map((t) => minionRef(t))
    : null;

  let best = null; // { cmd, score }
  for (const a of attackers) {
    for (const t of a.targets) {
      if (allowedTargets && !allowedTargets.some((x) => x.kind === t.kind && (t.kind === 'hero' || x.uid === t.uid))) continue;
      const score = scoreAttack(state, a, t);
      if (!best || score > best.score) {
        best = {
          score,
          cmd: {
            type: 'attack',
            fromUid: a.uid,
            fromSeat: AI_SEAT,
            toUid: t.kind === 'minion' ? t.uid : null,
            toSeat: t.seat,
            ack: state.seq,
          },
        };
      }
    }
  }
  return best?.cmd ?? null;
}

/** Оценка обмена: больше = лучше. */
function scoreAttack(state, attacker, tgt) {
  const atk = attacker.atk;
  if (tgt.kind === 'hero') {
    let s = 1 + atk * 0.5;
    if (atk >= foe(state).hero.hp) s += 1000;
    if (foe(state).board.length >= 3 && attacker.hp <= 2 && attacker.minion) s -= 10;
    return s;
  }
  const tm = findMinion(state, tgt);
  if (!tm) return -1000;
  const tgtDS = !!tm.ds;
  const poisonA = !!attacker.minion?.keywords?.includes('poisonous');
  const poisonT = !!tm.keywords?.includes('poisonous');
  const attackerDS = !!attacker.minion?.ds;
  // У цели БЩ — после атаки щит слетит, но существо не умрёт; урон в hp не проходит.
  // Без БЩ — урон проходит в hp; если >= hp — существо умирает.
  // Яд (poison) при ЛЮБОМ нанесённом уроне убивает цель (игнорируя hp).
  const tgtReallyDies = (!tgtDS && atk >= tm.hp) || (poisonA && atk > 0);
  // Атакующий получает контрудар (кроме героя/оружия). Его щит слетит первым.
  const attackerTakesDmg = !!attacker.minion;
  const attackerLosesShield = attackerTakesDmg && attackerDS && tm.atk > 0;
  const attackerReallyDies = attackerTakesDmg && !attackerDS && tm.atk >= attacker.hp;
  let s = 0;
  if (tgtReallyDies) s += 30;
  else if (tgtDS && atk > 0) s += 6; // сбить щит полезно, но не летально
  s += (tm.atk + tm.hp);
  if (tm.keywords?.includes('taunt')) s += 10;
  if (tgtDS) s += 4;
  if (poisonT) s += 12;
  if (attacker.minion) {
    if (attackerReallyDies) s -= (attacker.atk + attacker.hp);
    if (attackerLosesShield) s -= 3; // мы теряем щит
  } else {
    const w = me(state).hero.weapon;
    if (w && w.durability <= 1 && !tgtReallyDies && !tgtDS) s -= 5;
  }
  if (poisonA && !tgtReallyDies && tm.atk + tm.hp <= 2 && !tgtDS) s -= 10;
  return s;
}

function cardDefs(state) {
  if (!state._cardDefs) {
    const map = new Map();
    const visit = (inst) => {
      if (inst && inst.cardId && !map.has(inst.cardId)) map.set(inst.cardId, getCard(inst.cardId));
    };
    for (const p of state.players) {
      [...p.hand, ...p.board, ...p.deck].forEach(visit);
      // геройское оружие
      if (p.hero.weapon) visit({ cardId: p.hero.weapon.cardId });
    }
    // dawn_coin
    visit({ cardId: 'dawn_coin' });
    state._cardDefs = map;
  }
  return state._cardDefs;
}
