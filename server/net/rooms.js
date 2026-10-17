// RoomStore — реестр игровых комнат и вся лобби-логика.
// Чистый модуль: не знает про WebSocket, «отправку клиентам» делает через
// колбэк emit(event) — так модуль полностью тестируется без сети.
//
// Правила (см. docs/00-ANALYSIS.md §5):
//  - код комнаты: 5 символов из алфавита без 0/O/1/I (без путаницы);
//  - сид 0 = хост, сид 1 = гость;
//  - при обрыве соединения сид НЕ освобождается сразу: grace-период
//    (по умолчанию 30 с), противник видит «переподключение»;
//  - если grace истёк в игре — игра останавливается (этап 1: возврат в лобби;
//    этап 2+: поражение отключившегося);
//  - пустая комната (ни одного подключённого игрока) удаляется через 60 с.
import { randomUUID } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const EMPTY_ROOM_TTL_MS = 60_000;
const NICK_RE = /^[A-Za-zА-Яа-яЁё0-9_]{3,16}$/;

// ---- ошибки (код + человекочитаемое сообщение на русском) ----
export const ERR = {
  bad_nick: { code: 'bad_nick', msg: 'Имя: 3–16 символов, буквы, цифры, «_»' },
  already_in_room: { code: 'already_in_room', msg: 'Вы уже находитесь в комнате' },
  not_in_room: { code: 'not_in_room', msg: 'Вы не в комнате' },
  room_not_found: { code: 'room_not_found', msg: 'Комната с таким кодом не найдена' },
  room_full: { code: 'room_full', msg: 'Комната заполнена' },
  room_in_game: { code: 'room_in_game', msg: 'В этой комнате уже идёт матч' },
  nick_taken: { code: 'nick_taken', msg: 'Это имя уже занято в комнате' },
  not_in_lobby: { code: 'not_in_lobby', msg: 'Доступно только в комнате ожидания' },
  only_host: { code: 'only_host', msg: 'Матч может начать только хозяин комнаты' },
  room_not_full: { code: 'room_not_full', msg: 'Нужно двое игроков' },
  not_all_ready: { code: 'not_all_ready', msg: 'Оба игрока должны быть готовы' },
  bad_token: { code: 'bad_token', msg: 'Токен переподключения неверен' },
};

export const ok = () => ({ ok: true });
export const fail = (e) => ({ ok: false, code: e.code, msg: e.msg });

export function validNick(nick) {
  return NICK_RE.test(String(nick ?? '').trim());
}

/**
 * Сериализация комнаты для конкретного игрока (ctx).
 * ВАЖНО: токен переподключения получает только владелец сида.
 */
export function serializeRoom(room, ctx) {
  return {
    code: room.code,
    phase: room.phase,
    seats: room.seats.map((s) =>
      s ? { nick: s.nick, ready: s.ready, connected: s.connected } : null
    ),
    mySeat: ctx && ctx.room === room ? ctx.seat : null,
    myToken: ctx && ctx.room === room ? ctx.token : null,
  };
}

export class RoomStore {
  /**
   * @param {(ev: object) => void} emit — канал на NetServer:
   *   {kind:'room_update', ws, room}  — отправить снапшот комнаты
   *   {kind:'game_start',  ws, room}  — сообщение о старте матча
   *   {kind:'opp_left'|'opp_back'|'opp_left_final', ws, d}
   *   {kind:'kick', ws, d}            — вытеснить старое соединение
   *   {kind:'close_ws', ws}
   *   {kind:'rooms'}                  — рассылить список комнат всем
   *   {kind:'seat_moved', ws, d:{seat}}
   * @param {{graceMs?: number}} opts
   */
  constructor(emit, opts = {}) {
    this.emit = emit;
    this.graceMs = opts.graceMs ?? 30_000;
    /** @type {Map<string, object>} code → Room */
    this.rooms = new Map();
    /** @type {Set<Timeout>} активные таймеры (для dispose) */
    this.timers = new Set();
  }

  // ---------- утилиты ----------

  _timed(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  _clear(t) {
    if (t) {
      clearTimeout(t);
      this.timers.delete(t);
    }
    return null;
  }

  _generateCode() {
    for (let tries = 0; tries < 100; tries++) {
      let c = '';
      for (let i = 0; i < 5; i++) {
        c += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
      }
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('Не удалось сгенерировать код комнаты');
  }

  /**
   * Список комнат для лобби. Комнаты без подключённых игроков скрыты
   * (игрок в grace-период ещё может вернуться по токену — видимость
   * вернётся при reconnect; пустые комнаты удалятся по TTL).
   */
  getRoomsList() {
    return [...this.rooms.values()]
      .filter((r) => !r.isAI)
      .filter((r) => r.seats.some((s) => s && s.connected))
      .map((r) => ({
        code: r.code,
        host: r.seats[0]?.nick ?? '—',
        players: r.seats.filter((s) => s && s.connected).length,
        phase: r.phase,
      }));
  }

  // ---------- операции ----------

  createRoom(ctx, nick) {
    const name = String(nick ?? '').trim();
    if (!validNick(name)) return fail(ERR.bad_nick);
    if (ctx.room) return fail(ERR.already_in_room);

    const room = {
      code: this._generateCode(),
      phase: 'lobby',
      createdAt: Date.now(),
      seats: [null, null],
      graceTimer: [null, null],
      emptyTimer: null,
    };
    this._attachSeat(room, 0, ctx, name);
    this.rooms.set(room.code, room);
    log(`Комната ${room.code} создана (хост: ${name})`);

    this.emit({ kind: 'room_update', ws: ctx.ws, room });
    this.broadcastRooms();
    return ok();
  }

  joinRoom(ctx, code, nick) {
    const name = String(nick ?? '').trim();
    if (!validNick(name)) return fail(ERR.bad_nick);
    if (ctx.room) return fail(ERR.already_in_room);

    const room = this.rooms.get(String(code ?? '').trim().toUpperCase());
    if (!room) return fail(ERR.room_not_found);
    if (room.phase !== 'lobby') return fail(ERR.room_in_game);

    const i = room.seats[0] ? 1 : 0;
    if (room.seats[i]) return fail(ERR.room_full);
    if (room.seats[1 - i]?.nick === name) return fail(ERR.nick_taken);

    room.emptyTimer = this._clear(room.emptyTimer);
    this._attachSeat(room, i, ctx, name);
    log(`${name} присоединился к комнате ${room.code}`);

    this._notifyRoom(room);
    this.broadcastRooms();
    return ok();
  }

  leaveRoom(ctx) {
    const room = ctx.room;
    if (!room) return fail(ERR.not_in_room);
    const i = ctx.seat;
    const other = room.seats[1 - i];
    const wasGame = room.phase === 'game';
    this._detach(ctx, room);
    log(`${ctx.nick ?? 'Игрок'} покинул комнату ${room.code}`);
    // ИИ-комната: человек вышел — матч заканчивается, комната удаляется.
    if (room.isAI) {
      if (room._ai?.timer) clearTimeout(room._ai.timer);
      room._ai = null;
      room.seats[1 - i] = null;
      this.rooms.delete(room.code);
      this.broadcastRooms();
      return ok();
    }
    if (wasGame && other && other.connected) {
      // Выход из матча: «игра остановлена» — оппоненту уведомление,
      // комната возвращается в лобби (ждём нового соперника).
      room.phase = 'lobby';
      for (const s of room.seats) if (s) s.ready = false;
      log(`Комната ${room.code}: оппонент покинул матч (добровольный выход)`);
      this.emit({ kind: 'opp_left_final', ws: other.ws, d: { seat: i } });
    }
    this._afterSeatChange(room);
    return ok();
  }

  toggleReady(ctx, ready) {
    const room = ctx.room;
    if (!room) return fail(ERR.not_in_room);
    if (room.phase !== 'lobby') return fail(ERR.not_in_lobby);
    room.seats[ctx.seat].ready = !!ready;
    this._notifyRoom(room);
    return ok();
  }

  startGame(ctx) {
    const room = ctx.room;
    if (!room) return fail(ERR.not_in_room);
    if (room.phase !== 'lobby') return fail(ERR.not_in_lobby);
    if (ctx.seat !== 0) return fail(ERR.only_host);
    if (!room.seats[1]) return fail(ERR.room_not_full);
    if (!room.seats[0].ready || !room.seats[1].ready) return fail(ERR.not_all_ready);

    room.phase = 'game';
    log(`Матч начинается в комнате ${room.code}`);
    // Создание GameState и первые снапшоты делает NetServer (см. startRoomGame).
    this._notifyRoom(room);
    return ok();
  }

  /** Обрыв WebSocket-соединения игрока. */
  onDisconnect(ctx) {
    const room = ctx.room;
    if (!room) return;
    const i = ctx.seat;
    const seat = room.seats[i];
    if (!seat || seat.connId !== ctx.id) {
      // Сид уже занят новым соединением (вытеснение) — просто отвязываем ctx.
      ctx.room = null;
      ctx.seat = null;
      ctx.token = null;
      return;
    }

    // В ИИ-комнате при обрыве человека матч немедленно завершается,
    // т.к. бот не нуждается в переподключении и продолжать игру не с кем.
    if (room.isAI) {
      log(`[ai] игрок ${seat.nick} отключился — комната ${room.code} удаляется`);
      // уведомляем отключившегося нет смысла — он ушёл
      room.seats[i] = null;
      room.seats[1 - i] = null; // убрать бота
      if (room._ai?.timer) clearTimeout(room._ai.timer);
      room._ai = null;
      this.rooms.delete(room.code);
      this.broadcastRooms();
      ctx.room = null; ctx.seat = null; ctx.token = null;
      return;
    }

    seat.connected = false;
    seat.ws = null;
    seat.connId = null;
    ctx.room = null;
    ctx.seat = null;
    ctx.token = null;
    log(`! ${seat.nick} отключился (комната ${room.code}, grace ${this.graceMs / 1000} с)`);

    room.graceTimer[i] = this._timed(() => this._graceExpired(room, i), this.graceMs);

    const other = room.seats[1 - i];
    if (other && other.connected && other.ws) {
      this.emit({ kind: 'room_update', ws: other.ws, room });
      if (room.phase === 'game') {
        this.emit({ kind: 'opp_left', ws: other.ws, d: { seat: i } });
      }
    }
    this.broadcastRooms();
  }

  /** Переподключение по токену: {roomCode, token}. */
  reconnect(ctx, code, token) {
    const room = this.rooms.get(String(code ?? '').trim().toUpperCase());
    if (!room) return fail(ERR.room_not_found);

    let i = -1;
    for (let j = 0; j < 2; j++) {
      if (room.seats[j] && room.seats[j].token === token) i = j;
    }
    if (i === -1) return fail(ERR.bad_token);

    const seat = room.seats[i];
    if (seat.connected && seat.ws && seat.ws !== ctx.ws) {
      // Двойной вход по одному токену: новый вход вытесняет старое соединение.
      log(`Комната ${room.code}: двойной вход, старое соединение вытеснено`);
      this.emit({
        kind: 'kick',
        ws: seat.ws,
        d: { reason: 'duplicate_token', msg: 'Вы вошли в игру с другого устройства' },
      });
      this.emit({ kind: 'close_ws', ws: seat.ws });
    }

    room.graceTimer[i] = this._clear(room.graceTimer[i]);
    room.emptyTimer = this._clear(room.emptyTimer);
    seat.connected = true;
    seat.ws = ctx.ws;
    seat.connId = ctx.id;
    seat.ctx = ctx;
    ctx.room = room;
    ctx.seat = i;
    ctx.token = seat.token;
    ctx.nick = seat.nick;
    log(`+ ${seat.nick} переподключился (комната ${room.code})`);

    this._notifyRoom(room);
    const other = room.seats[1 - i];
    if (other && other.connected) {
      this.emit({ kind: 'opp_back', ws: other.ws, d: { seat: i } });
    }
    this.broadcastRooms();
    return ok();
  }

  // ---------- внутреннее ----------

  /** Привязать ctx (соединение) к сиду комнаты. */
  _attachSeat(room, i, ctx, nick) {
    const seat = {
      seat: i,
      nick,
      token: randomUUID(),
      ready: false,
      connected: true,
      connId: ctx.id,
      ws: ctx.ws,
      ctx,
    };
    room.seats[i] = seat;
    ctx.room = room;
    ctx.seat = i;
    ctx.token = seat.token;
    ctx.nick = nick;
    return seat;
  }

  /** Полное освобождение сида (добровольный выход — без grace). */
  _detach(ctx, room) {
    const i = ctx.seat;
    room.seats[i] = null;
    room.graceTimer[i] = this._clear(room.graceTimer[i]);
    ctx.room = null;
    ctx.seat = null;
    ctx.token = null;
  }

  _graceExpired(room, i) {
    room.graceTimer[i] = null;
    if (!this.rooms.has(room.code)) return;
    const other = room.seats[1 - i];

    if (room.phase === 'game' && other && other.connected) {
      // «Игра остановлена»: матч прерван, комната возвращается в лобби.
      // (Этап 2+: здесь засчитывается поражение отключившегося.)
      room.phase = 'lobby';
      for (const s of room.seats) if (s) s.ready = false;
      log(`Комната ${room.code}: оппонент покинул матч (grace истёк)`);
      this.emit({ kind: 'opp_left_final', ws: other.ws, d: { seat: i } });
    }
    // Сид отключившегося освобождается в обоих случаях — иначе комната
    // оставалась бы «полной» с мёртвым игроком.
    room.seats[i] = null;
    this._afterSeatChange(room);
  }

  /** Реакция на смену состава: пустая комната → TTL, хост-реиндекс, уведомления. */
  _afterSeatChange(room) {
    if (!this.rooms.has(room.code)) return;
    const anyConnected = room.seats.some((s) => s && s.connected);
    if (!anyConnected && !room.emptyTimer) {
      room.emptyTimer = this._timed(() => {
        this.rooms.delete(room.code);
        log(`Комната ${room.code} удалена (пустая)`);
        this.broadcastRooms();
      }, EMPTY_ROOM_TTL_MS);
    }
    this._reindexHost(room);
    this._notifyRoom(room);
    this.broadcastRooms();
  }

  /**
   * Если хост (сид 0) свободен, а игрок остался на сиде 1 —
   * переводим его в хосты, чтобы комната могла продолжить жить.
   */
  _reindexHost(room) {
    if (room.phase !== 'lobby') return;
    if (!room.seats[0] && room.seats[1] && room.seats[1].connected) {
      const s = room.seats[1];
      s.seat = 0;
      if (s.ctx) s.ctx.seat = 0; // обновляем контекст соединения напрямую
      room.seats = [s, null];
      log(`Комната ${room.code}: ${s.nick} теперь хост`);
    }
  }

  _notifyRoom(room) {
    for (const s of room.seats) {
      if (s && s.connected) this.emit({ kind: 'room_update', ws: s.ws, room });
    }
  }

  broadcastRooms() {
    this.emit({ kind: 'rooms' });
  }

  /** Остановка всех таймеров (закрытие сервера / тесты). */
  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`);
}
