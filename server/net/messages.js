// messages.js — диспетчер входящих сообщений клиент → сервер.
// Каждое сообщение: {t: 'тип', d: payload}. Результат — либо ok,
// либо {ok:false, code, msg} → клиенту уходит {t:'error', d:{code, msg}}.
//
// Полный список типов — в docs/00-ANALYSIS.md §5.2.
import { fail, ok, validNick, ERR } from './rooms.js';
import { pushEmotion } from '../game/engine.js';
import { attachAI, aiNick, aiPoke } from '../game/ai.js';

export function handleMessage(ns, ctx, msg) {
  const t = msg.t;
  const d = msg.d && typeof msg.d === 'object' ? msg.d : {};
  let res;
  try {
    switch (t) {
      case 'hello':
        res = onHello(ns, ctx, d);
        break;
      case 'create_room':
        res = ns.store.createRoom(ctx, d.nick ?? ctx.nick);
        break;
      case 'join_room':
        res = ns.store.joinRoom(ctx, d.code, d.nick ?? ctx.nick);
        break;
      case 'start_ai_game':
        res = startAIGame(ns, ctx, d);
        break;
      case 'list_rooms':
        ns.send(ctx.ws, 'rooms', { rooms: ns.store.getRoomsList() });
        return;
      case 'leave_room':
        res = ns.store.leaveRoom(ctx);
        break;
      case 'toggle_ready':
        res = ns.store.toggleReady(ctx, d.ready);
        break;
      case 'start_game':
        res = ns.store.startGame(ctx);
        if (res.ok) ns.startRoomGame(ctx.room);
        break;
      case 'reconnect': {
        res = ns.store.reconnect(ctx, d.roomCode, d.token);
        // Переподключение во время матча — пересылаем текущий снапшот,
        // чтобы стол синхронизировался без ожидания следующего хода.
        if (res.ok && ctx.room?.phase === 'game' && ctx.room.game) ns.sendState(ctx);
        break;
      }
      // ── игровые команды (Этап 2) ──
      case 'play_card':
        ns.updateAck(ctx, d.ack);
        res = ns.gameCommand(ctx, { type: 'play_card', handUid: d.handUid, target: d.target });
        break;
      case 'end_turn':
        ns.updateAck(ctx, d.ack);
        res = ns.gameCommand(ctx, { type: 'end_turn' });
        break;
      case 'attack':
        ns.updateAck(ctx, d.ack);
        res = ns.gameCommand(ctx, {
          type: 'attack',
          fromUid: d.fromUid,
          fromSeat: d.fromSeat,
          toUid: d.toUid ?? null,
          toSeat: d.toSeat ?? null,
        });
        break;
      case 'request_state':
        ns.sendState(ctx);
        return;
      case 'ping':
        ns.updateAck(ctx, d.ack);
        ns.send(ctx.ws, 'pong', { t: d.t ?? 0 });
        return;
      case 'send_emotion': {
        // Эмоции: только в игре, троттлинг 1/с (документация §5.2)
        const room = ctx.room;
        if (!room || room.phase !== 'game' || !room.game) {
          res = fail({ code: 'not_in_game', msg: 'Матч не начался' });
          break;
        }
        const now = Date.now();
        if (now - (ctx._lastEmotion ?? 0) < 1000) {
          res = fail({ code: 'throttled', msg: 'Слишком часто' });
          break;
        }
        ctx._lastEmotion = now;
        res = pushEmotion(room.game, ctx.seat, d.emotion);
        if (res.ok) ns.sendStateAll(room);
        break;
      }
      default:
        res = fail({ code: 'unknown_message', msg: `Неизвестное сообщение: ${t}` });
    }
  } catch (e) {
    // Обработка ОДНОЙ ошибки клиента никогда не должна ронять сервер.
    console.error(`[net] ошибка обработчика «${t}»:`, e);
    res = fail({ code: 'internal', msg: 'Внутренняя ошибка сервера' });
  }
  if (res && !res.ok) {
    ns.send(ctx.ws, 'error', { code: res.code, msg: res.msg });
  }
}

function onHello(ns, ctx, d) {
  const nick = String(d.nick ?? '').trim();
  if (nick.length >= 3 && nick.length <= 16) ctx.nick = nick;
  ns.send(ctx.ws, 'welcome', { session: ctx.id, name: ctx.nick ?? null });
  return ok();
}

/**
 * «Игра против ИИ»: создаём приватную комнату, сажаем бота на сид 1,
 * автоматически готовы и запускаем матч. Комната не показывается в общем
 * списке (isAI=true).
 */
function startAIGame(ns, ctx, d) {
  const name = String(d.nick ?? ctx.nick ?? '').trim();
  if (!validNick(name)) return fail(ERR.bad_nick);
  if (ctx.room) return fail(ERR.already_in_room);

  const code = ns.store._generateCode();
  const room = {
    code,
    phase: 'lobby',
    createdAt: Date.now(),
    seats: [null, null],
    graceTimer: [null, null],
    emptyTimer: null,
    isAI: true, // не показывать в лобби
  };
  ns.store.rooms.set(code, room);
  ns.store._attachSeat(room, 0, ctx, name);

  // ИИ — псевдо-сид без ws
  const aiSeat = {
    seat: 1,
    nick: aiNick(),
    token: null,
    ready: true,
    connected: true,
    connId: null,
    ws: null,
    ctx: null,
    isAI: true,
  };
  room.seats[1] = aiSeat;
  room.seats[0].ready = true;
  room.phase = 'game';
  attachAI(ns, room);

  log(`[ai] матч против ИИ создан (${name}), комната ${code}`);
  // старт игры + отдача room_update и state клиенту
  ns.emitRoomUpdate(ctx.ws, room);
  ns.startRoomGame(room);
  // Если ИИ ходит первым — дать ему подумать
  if (room.game.turn === 1) aiPoke(ns, room);
  return ok();
}

// локальный логгер (повторяет log из server.js, но в рамках модуля — просто no-op на console)
function log(...a) { console.log('[ai-room]', ...a); }
