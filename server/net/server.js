// server.js — NetServer: управление WS-соединениями, входящие сообщения,
// оркестрация матча (RoomStore ↔ engine ↔ WebSocket).
//
// Протокол: JSON-текст в обёртке {t, d}. maxPayload — 64 КБ (защита от мусора).
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { RoomStore, serializeRoom } from './rooms.js';
import { handleMessage } from './messages.js';
import { createGame, command as engineCommand } from '../game/engine.js';
import { sanitizeGame } from './sanitize.js';
import { aiPoke } from '../game/ai.js';

const RATE_LIMIT_MS = 1000;
const RATE_LIMIT_MAX = 40; // сообщений в окно — больше = спам (см. античит-план)
const DEAD_CONN_MS = 40_000; // без трафика 40 с → «мёртвое» соединение
const MAX_EVENTS_PER_SYNC = 200; // дальше — полный перерисовочный снапшот без анимаций

export class NetServer {
  constructor(httpServer) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    /** @type {Map<import('ws').WebSocket, object>} ws → контекст соединения */
    this.conns = new Map();
    this.store = new RoomStore((ev) => this._emit(ev), {
      graceMs: Number(process.env.GRACE_MS ?? 30_000),
    });

    // WS-апгрейд на том же порту, что и HTTP-статика.
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.wss.emit('connection', ws, req)
      );
    });
    this.wss.on('connection', (ws) => this._onConnection(ws));

    // Периодическая чистка «мёртвых» соединений (без ping/pong от клиента).
    this._sweepTimer = setInterval(() => this._sweep(), 10_000);
    this._sweepTimer.unref?.();
  }

  // ---------- жизненный цикл соединений ----------

  _onConnection(ws) {
    const ctx = {
      id: randomUUID(),
      ws,
      nick: null,
      room: null, // Room
      seat: null, // 0|1|null
      token: null,
      lastAck: 0, // seq последнего увиденного клиентом события
      lastSeen: Date.now(),
      _rateWindow: 0,
      _rateCount: 0,
    };
    this.conns.set(ws, ctx);
    log(`+ соединение ${ctx.id.slice(0, 8)}`);

    ws.on('message', (data) => this._onMessage(ctx, data));
    ws.on('close', () => {
      this.conns.delete(ws);
      log(`- разрыв ${ctx.id.slice(0, 8)}${ctx.nick ? ` (${ctx.nick})` : ''}`);
      this.store.onDisconnect(ctx);
    });
    ws.on('error', (e) => {
      log(`ws error: ${e.message}`);
    });
  }

  _onMessage(ctx, data) {
    ctx.lastSeen = Date.now();

    // Rate-limit: не даём флудом забить процесс (защита №6 из плана).
    const now = Date.now();
    if (now - ctx._rateWindow > RATE_LIMIT_MS) {
      ctx._rateWindow = now;
      ctx._rateCount = 0;
    }
    ctx._rateCount++;
    if (ctx._rateCount > RATE_LIMIT_MAX) {
      this.send(ctx.ws, 'error', { code: 'throttled', msg: 'Слишком много сообщений' });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      this.send(ctx.ws, 'error', { code: 'bad_payload', msg: 'Некорректный JSON' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      this.send(ctx.ws, 'error', { code: 'bad_payload', msg: 'Ожидалось {t, d}' });
      return;
    }
    handleMessage(this, ctx, msg);
  }

  _sweep() {
    const now = Date.now();
    for (const [ws, ctx] of this.conns) {
      if (now - ctx.lastSeen > DEAD_CONN_MS) {
        log(`× «мёртвое» соединение ${ctx.id.slice(0, 8)} закрыто`);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ═══════════════════════ ИГРА (Этап 2) ═══════════════════════

  /** Старт матча в комнате: создаём GameState и рассылаем первые снапшоты. */
  startRoomGame(room) {
    const nicks = room.seats.map((s) => s?.nick ?? '?');
    room.game = createGame(nicks);
    for (const s of room.seats) {
      if (!s || !s.connected) continue;
      const ctx = this.conns.get(s.ws);
      if (ctx) ctx.lastAck = 0;
    }
    this.sendStateAll(room);
    log(`Комната ${room.code}: партия создана (первый ход — ${nicks[room.game.turn]})`);
    if (room._ai && room.game.turn === 1) aiPoke(this, room);
  }

  /** Игровая команда (play_card / end_turn). */
  gameCommand(ctx, cmd) {
    const room = ctx.room;
    if (!room || room.phase !== 'game' || !room.game) {
      return { ok: false, code: 'not_in_game', msg: 'Матч не начался' };
    }
    const res = engineCommand(room.game, ctx.seat, cmd);
    if (!res.ok) return res;
    this.sendStateAll(room);
    if (room.game.status === 'ended') {
      this.endRoomGame(room);
    } else if (room._ai) {
      aiPoke(this, room);
    }
    return res;
  }

  /** Партия закончилась: комната возвращается в лобби (rematch доступен). */
  endRoomGame(room) {
    if (room.phase !== 'game') return;
    room.phase = 'lobby';
    for (const s of room.seats) if (s) s.ready = false;
    const g = room.game;
    log(`Комната ${room.code}: матч завершён, победил ${g.winner !== null ? room.seats[g.winner]?.nick : '—'}`);
    // room_update (фаза lobby) + итоговый state уже ушли через sendStateAll;
    // уведомляем оставшихся о смене фазы комнаты.
    for (const s of room.seats) {
      if (s && s.connected) this.emitRoomUpdate(s.ws, room);
    }
  }

  /** Снапшот состояния для конкретного соединения (с учётом его ack). */
  buildState(ctx) {
    const room = ctx.room;
    if (!room || !room.game) return null;
    const view = sanitizeGame(room.game, ctx.seat, room.code);
    // события после ack клиента (окно ограничено — дальше просто перерисовка)
    const evts = room.game.events.filter((e) => e.seq > ctx.lastAck);
    view.events = evts.length <= MAX_EVENTS_PER_SYNC ? evts : [];
    return view;
  }

  sendState(ctx) {
    const view = this.buildState(ctx);
    if (view) this.send(ctx.ws, 'state', view);
  }

  /** Рассылка снапшотов обоим игрокам (у каждого своя проекция). */
  sendStateAll(room) {
    for (const s of room.seats) {
      if (!s || !s.connected) continue;
      const ctx = this.conns.get(s.ws);
      if (!ctx) continue;
      const view = this.buildState(ctx);
      if (view) this.send(s.ws, 'state', view);
    }
  }

  updateAck(ctx, ack) {
    const n = Number(ack);
    if (Number.isFinite(n) && n >= 0) {
      ctx.lastAck = Math.floor(n);
    }
  }

  // ---------- канал emit от RoomStore ----------

  _emit(ev) {
    switch (ev.kind) {
      case 'room_update':
        this.emitRoomUpdate(ev.ws, ev.room);
        break;
      case 'opp_left':
        this.send(ev.ws, 'opp_left', ev.d);
        break;
      case 'opp_back':
        this.send(ev.ws, 'opp_back', ev.d);
        break;
      case 'opp_left_final':
        this.send(ev.ws, 'opp_left_final', ev.d);
        break;
      case 'kick':
        this.send(ev.ws, 'kicked', ev.d);
        break;
      case 'close_ws':
        try {
          ev.ws.terminate();
        } catch {
          /* ignore */
        }
        break;
      case 'rooms':
        this.broadcast('rooms', { rooms: this.store.getRoomsList() });
        break;
      default:
        console.warn(`[net] неизвестный emit: ${ev.kind}`);
    }
  }

  emitRoomUpdate(ws, room) {
    const ctx = this.conns.get(ws);
    this.send(ws, 'room_update', serializeRoom(room, ctx));
  }

  // ---------- отправка ----------

  send(ws, t, d) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t, d }));
    }
  }

  broadcast(t, d) {
    const s = JSON.stringify({ t, d });
    for (const [ws] of this.conns) {
      if (ws.readyState === 1) ws.send(s);
    }
  }

  /** Корректное закрытие: bye всем + terminate + очистка таймеров. */
  closeAll(msg) {
    const s = JSON.stringify({ t: 'bye', d: { msg } });
    for (const [ws] of this.conns) {
      if (ws.readyState === 1) ws.send(s);
    }
    for (const [ws] of this.conns) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    this.store.dispose();
    clearInterval(this._sweepTimer);
  }
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`);
}
