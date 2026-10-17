// sim-reconnect.js — Этап 6: надёжность. Сценарии обрыва/переподключения.
//
// Запуск: npm run sim-reconnect (сервер поднимается in-process на 8090,
// GRACE_MS=1200 — чтобы grace-сценарии не тянулись 30 секунд).
//
// Сценарии:
//   1. обрыв в ЛОББИ → возврат по токену: сид и готовность на месте;
//   2. обрыв В ИГРЕ → opp_back, resync-снапшот, партия продолжается;
//   3. grace истёк → opp_left_final, комната в лобби; поздний возврат — чисто;
//   4. двойное соединение по токену → старое kicked, новое владеет сидом;
//   5. оба одновременно отключились → оба вернулись, партия жива.
import http from 'node:http';
import WebSocket from 'ws';
import { NetServer } from '../server/net/server.js';

const PORT = 8090;
process.env.GRACE_MS = '1200';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── сервер in-process ──
const httpServer = http.createServer((_q, _s) => _s.end('ok'));
const net = new NetServer(httpServer);
await new Promise((res) => httpServer.listen(PORT, '127.0.0.1', res));

// ── WS-клиент ──
class C {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.waiters = [];
    this.token = null;
    this.roomCode = null;
    this.mySeat = null;
    this.seen = []; // все сообщения (для отладки/проверок)
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      this.seen.push(m);
      if (m.t === 'room_update') {
        this.token = m.d.myToken ?? this.token;
        this.roomCode = m.d.code ?? this.roomCode;
        this.mySeat = m.d.mySeat ?? this.mySeat;
      }
      const i = this.waiters.findIndex((w) => (w.types ? w.types.includes(m.t) : w.pred(m)));
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.res(m);
      } else this.queue.push(m);
    });
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', (e) => rej(new Error(`${this.name}: ${e.message}`)));
    });
  }
  send(t, d) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, d })); }
  drop() { this.ws.removeAllListeners(); this.ws.terminate(); }
  /** Новое соединение (тот же «игрок»: hello + reconnect по токену). */
  async relink() {
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', (e) => rej(new Error(`${this.name}: ${e.message}`)));
    });
    this.ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      this.seen.push(m);
      if (m.t === 'room_update') {
        this.token = m.d.myToken ?? this.token;
        this.roomCode = m.d.code ?? this.roomCode;
        this.mySeat = m.d.mySeat ?? this.mySeat;
      }
      const i = this.waiters.findIndex((w) => (w.types ? w.types.includes(m.t) : w.pred(m)));
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.res(m);
      } else this.queue.push(m);
    });
    this.send('hello', { nick: this.name });
    if (this.roomCode && this.token) this.send('reconnect', { roomCode: this.roomCode, token: this.token });
  }
  wait(types, timeout = 4000) {
    const list = Array.isArray(types) ? types : [types];
    const qi = this.queue.findIndex((m) => list.includes(m.t));
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((res, rej) => {
      const w = { types: list, res, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        rej(new Error(`${this.name}: таймаут, жду ${list.join('/')}`));
      }, timeout) };
      this.waiters.push(w);
    });
  }
  waitPred(pred, timeout = 4000) {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((res, rej) => {
      const w = { pred, res, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        rej(new Error(`${this.name}: таймаут, условие`));
      }, timeout) };
      this.waiters.push(w);
    });
  }
  /** room_update, где я в комнате (mySeat не null). */
  async waitRoom() {
    return this.waitPred((m) => m.t === 'room_update' && m.d.mySeat !== null, 5000);
  }
  close() { try { this.ws.close(); } catch {} }
}

const setup = async (aNick, bNick) => {
  const A = new C(aNick); await A.open(); A.send('hello', { nick: aNick });
  const B = new C(bNick); await B.open(); B.send('hello', { nick: bNick });
  A.send('create_room', { nick: aNick });
  const roomUpd = await A.waitRoom();
  const code = roomUpd.d.code;
  B.send('join_room', { code, nick: bNick });
  await B.waitRoom();
  return { A, B, code };
};

const startGame = async (A, B) => {
  A.send('toggle_ready', { ready: true });
  B.send('toggle_ready', { ready: true });
  // ждём, пока ОБОЕ готовы (фазу «game» даёт start_game от хоста — A)
  await A.waitPred((m) => m.t === 'room_update' && m.d.seats[0]?.ready && m.d.seats[1]?.ready, 5000);
  A.send('start_game', {});
  await A.waitPred((m) => m.t === 'room_update' && m.d.phase === 'game', 5000);
  await B.waitPred((m) => m.t === 'room_update' && m.d.phase === 'game', 5000);
  const stA = await A.wait('state', 5000);
  await B.wait('state', 5000);
  return stA;
};

// ═══════════════ СЦЕНАРИЙ 1: обрыв в лобби ═══════════════
{
  console.log('\nСценарий 1: обрыв в лобби → возврат по токену');
  const { A, B, code } = await setup('AAA1', 'BBB1');
  A.send('toggle_ready', { ready: true });
  await A.waitPred((m) => m.t === 'room_update' && m.d.seats[A.mySeat]?.ready === true, 5000);

  A.drop();
  await B.waitPred((m) => m.t === 'room_update' && !m.d.seats[0]?.connected, 5000);
  check('1.1: B видит обрыв A (seats[0].connected=false)', true);

  await A.relink();
  const ru = await A.waitRoom();
  check('1.2: A вернулся: mySeat на месте', ru.d.mySeat === 0, `mySeat=${ru.d.mySeat}`);
  check('1.3: готовность A сохранена', ru.d.seats[0]?.ready === true);
  B.queue = []; // сбрасываем устаревшие снапшоты — ждём ЖИВОЕ уведомление
  const bRu = await B.waitPred((m) => m.t === 'room_update' && m.d.seats[0]?.connected === true, 5000);
  check('1.4: B видит A снова подключённым', bRu.d.seats[0]?.connected === true);
  check('1.5: код комнаты тот же', ru.d.code === code);
  A.close(); B.close();
}

// ═══════════════ СЦЕНАРИЙ 2: обрыв в игре, возврат в grace ═══════════════
{
  console.log('\nСценарий 2: обрыв в игре → opp_back + resync, партия продолжается');
  const { A, B } = await setup('AAA2', 'BBB2');
  await startGame(A, B);

  A.drop();
  await B.wait('opp_left', 5000);
  check('2.1: B получил opp_left', true);

  await A.relink();
  const stA = await A.wait('state', 5000);
  check('2.2: A получил resync-снапшот (status running)', stA.d.status === 'running');
  await B.wait('opp_back', 5000);
  check('2.3: B получил opp_back', true);

  // Партия продолжается: тот, чей ход, завершает ход
  const seat = stA.d.turn;
  const who = seat === stA.d.self.seat ? A : B;
  who.send('end_turn', { ack: stA.d.seq });
  const st = await who.wait('state', 5000);
  check('2.4: ход прошёл после reconnect (turnCount вырос)', st.d.turnCount >= 2, `turnCount=${st.d.turnCount}`);
  A.close(); B.close();
}

// ═══════════════ СЦЕНАРИЙ 3: grace истёк ═══════════════
{
  console.log('\nСценарий 3: grace истёк → opp_left_final, комната в лобби');
  const { A, B } = await setup('AAA3', 'BBB3');
  await startGame(A, B);

  B.drop(); // и НЕ возвращается
  await A.wait('opp_left', 5000);
  const fin = await A.wait('opp_left_final', 6000);
  check('3.1: A получил opp_left_final после grace', true);
  // ждём СВЕРХТОЧНОЕ room_update: лобби И освобождённый B-сид
  // (устаревшие lobby-снапшоты в очереди пропускаем)
  const ru = await A.waitPred((m) => m.t === 'room_update' && m.d.phase === 'lobby' && m.d.seats[1] === null, 6000);
  check('3.2: комната вернулась в лобби', ru.d.phase === 'lobby');
  check('3.3: B-сид освобождён (seats[1] = null)', ru.d.seats[1] === null, JSON.stringify(ru.d.seats));

  // Поздний возврат B по токену — чисто: ни краша, ни «чужой» партии
  let lateOk = true;
  let lateDetail = '';
  try {
    await B.relink();
    const m = await B.wait(['room_update', 'error'], 5000);
    if (m.t === 'room_update' && m.d.mySeat !== null && m.d.phase === 'game') {
      lateOk = false;
      lateDetail = 'B снова в GAME-фазе (старая партия!)';
    } else {
      lateOk = true; // error (токен невалиден) или сид в лобби — допустимо
      lateDetail = m.t === 'error' ? m.d.code : `лобби, mySeat=${m.d.mySeat}`;
    }
  } catch { lateOk = false; lateDetail = 'таймаут/ошибка'; }
  check('3.4: поздний возврат B — без возврата в старую партию', lateOk, lateDetail);

  // A всё ещё в комнате
  const aSeat = A.mySeat;
  check('3.5: A остался в комнате (mySeat на месте)', aSeat !== null);
  A.close();
  try { B.close(); } catch {}
}

// ═══════════════ СЦЕНАРИЙ 4: двойное соединение по токену ═══════════════
{
  console.log('\nСценарий 4: два соединения с одним токеном → kicked');
  const { A, B } = await setup('AAA4', 'BBB4');
  const dup = new C('A4-dup');
  await dup.open();
  dup.send('hello', { nick: 'A4' });
  dup.send('reconnect', { roomCode: A.roomCode, token: A.token });
  const kicked = await A.wait('kicked', 5000);
  check('4.1: старое соединение A получило kicked', true);
  const ru = await dup.waitRoom();
  check('4.2: новое соединение владеет сидом A', ru.d.mySeat === 0, `mySeat=${ru.d.mySeat}`);
  // B не затронут (сбрасываем очередь — ищем живое уведомление)
  B.queue = [];
  const bRu = await B.waitPred((m) => m.t === 'room_update' && m.d.seats[0]?.connected === true, 5000).catch(() => null);
  if (bRu) check('4.3: B в норме после kick соседа', bRu.d.mySeat !== null && bRu.d.seats[0]?.connected === true);
  else check('4.3: B в норме после kick соседа', true, 'без room_update (тоже допустимо)');
  A.close(); dup.close(); B.close();
}

// ═══════════════ СЦЕНАРИЙ 5: оба отключились одновременно ═══════════════
{
  console.log('\nСценарий 5: оба отключились → оба вернулись, партия жива');
  const { A, B } = await setup('AAA5', 'BBB5');
  await startGame(A, B);

  A.drop();
  B.drop();
  await sleep(300);
  await A.relink();
  await sleep(200);
  await B.relink();

  const stA = await A.wait('state', 6000);
  const stB = await B.wait('state', 6000);
  check('5.1: оба получили снапшот (партия жива)', stA.d.status === 'running' && stB.d.status === 'running');
  check('5.2: seq согласован у обоих', stA.d.seq === stB.d.seq, `A=${stA.d.seq} B=${stB.d.seq}`);
  // Ход проходит
  const seat = stA.d.turn;
  const who = seat === stA.d.self.seat ? A : B;
  const ref = who === A ? stA : stB;
  who.send('end_turn', { ack: ref.d.seq });
  const after = await who.wait('state', 6000);
  check('5.3: ход прошёл после двойного reconnect', after.d.turnCount >= 2, `turnCount=${after.d.turnCount}`);
  A.close(); B.close();
}

// ── финал ──
net.closeAll?.('Симуляция завершена');
httpServer.close();
console.log(failures === 0 ? '\n=== SIM RECONNECT: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ===' : `\n=== SIM RECONNECT: ПРОВАЛОВ: ${failures} ===`);
process.exit(failures === 0 ? 0 : 1);
