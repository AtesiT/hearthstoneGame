// client.js — сетевой клиент: WebSocket + автореконнект.
//
// Логика переподключения (docs/00-ANALYSIS.md §5.5):
//  - обрыв → до 10 попыток по 1 раз в секунду;
//  - при наличии комнаты: отправляем hello + reconnect {roomCode, token};
//  - токен хранится в localStorage (переживает перезагрузку страницы
//    в пределах grace-периода сервера);
//  - после 10 неудач → onReconnectFailed (пользователь сам в меню).
//
// ВАЖНО (античит): клиент НИКОГДА не хранит игровую логику — только
// «вид» состояния (viewState) для рендера и отправку команд.

const RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 1000;

export class NetClient {
  /**
   * @param {object} cb
   * @param {(msg: {t: string, d: object}) => void} cb.onMessage
   * @param {() => void} cb.onOpen
   * @param {() => void} cb.onClose
   * @param {(attempt: number) => void} cb.onReconnectAttempt  — есть комната
   * @param {() => void} cb.onReconnectFailed
   * @param {() => void} cb.onLostNoRoom — обрыв вне комнаты (тихий режим)
   */
  constructor(cb) {
    this.cb = cb;
    this.ws = null;
    this.attempts = 0;
    this.gaveUp = false;
    this.roomCode = null;
    this.token = null;
    this.lastSeq = 0; // seq последнего увиденного снапшота (уходит в ping.ack)
    this._pendingReconnect = false;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._lostNoRoomNotified = false;
  }

  /** main.js вызывает при каждом полученном state-снапшоте. */
  noteSeq(seq) {
    const n = Number(seq);
    if (Number.isFinite(n) && n > this.lastSeq) this.lastSeq = n;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === 1;
  }

  /** Открыть (пере)соединение (ping-цикл запускается автоматически). */
  connect() {
    this._killWs();
    this.gaveUp = false;
    this.startPing();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this._lostNoRoomNotified = false;
      this.cb.onOpen?.();
      if (this._pendingReconnect && this.roomCode && this.token) {
        // Возвращение в комнату: hello (для welcome) + reconnect по токену.
        this.send('hello', { nick: this._nickNow() });
        this.send('reconnect', { roomCode: this.roomCode, token: this.token });
        this._pendingReconnect = false;
      } else {
        this.send('hello', { nick: this._nickNow() });
      }
    };

    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return; // мусорный кадр — игнорируем
      }
      if (m && typeof m === 'object' && typeof m.t === 'string') {
        this.cb.onMessage?.(m);
      }
    };

    ws.onclose = () => {
      this.cb.onClose?.();
      this._onLost();
    };
    ws.onerror = () => {
      /* onclose последует сам */
    };
  }

  send(t, d) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ t, d }));
    }
  }

  /** Запомнить комнату/токен (приходит в room_update.myToken). */
  setRoom(code, token) {
    this.roomCode = code;
    this.token = token;
    try {
      localStorage.setItem(`emberfall:tok:${code}`, token);
    } catch {
      /* приватный режим и т.п. */
    }
  }

  clearRoom() {
    if (this.roomCode) {
      try {
        localStorage.removeItem(`emberfall:tok:${this.roomCode}`);
      } catch {
        /* ignore */
      }
    }
    this.roomCode = null;
    this.token = null;
    this._pendingReconnect = false;
  }

  /** Сброс счётчиков (кнопка «В меню» после неудачного reconnect). */
  reset() {
    this.gaveUp = false;
    this.attempts = 0;
    this._pendingReconnect = false;
  }

  /** Полный отказ от автореконнекта (например, вытеснение). */
  giveUp() {
    this.gaveUp = true;
    this.clearRoom();
    this._stopTimers();
  }

  startPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = setInterval(
      () => this.send('ping', { t: Date.now(), ack: this.lastSeq }),
      5000
    );
  }

  _stopTimers() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._reconnectTimer = null;
    this._pingTimer = null;
  }

  _onLost() {
    if (this.gaveUp) return;
    const hadRoom = !!(this.roomCode && this.token);
    if (hadRoom) {
      this._pendingReconnect = true;
      this.attempts++;
      if (this.attempts > RECONNECT_ATTEMPTS) {
        this.attempts = RECONNECT_ATTEMPTS;
        this.cb.onReconnectFailed?.();
        return;
      }
      this.cb.onReconnectAttempt?.(this.attempts);
    } else if (!this._lostNoRoomNotified) {
      this._lostNoRoomNotified = true;
      this.cb.onLostNoRoom?.();
    }
    this._reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  _killWs() {
    const ws = this.ws;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }

  _nickNow() {
    // Ник берём из текущего поля ввода (валидный), иначе запасной.
    const el = document.getElementById('nick-input');
    const v = (el?.value ?? '').trim();
    if (/^[A-Za-zА-Яа-яЁё0-9_]{3,16}$/.test(v)) return v;
    try {
      const saved = localStorage.getItem('emberfall:nick');
      if (saved && /^[A-Za-zА-Яа-яЁё0-9_]{3,16}$/.test(saved)) return saved;
    } catch {
      /* ignore */
    }
    return 'Player';
  }
}
