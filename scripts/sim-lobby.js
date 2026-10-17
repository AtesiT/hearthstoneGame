// sim-lobby.js — headless-симуляция «двух игроков» для проверки лобби (этап 1).
//
// Запуск:
//   1) npm start            (в отдельном терминале)
//   2) npm run sim          (этот скрипт; для быстрой проверки grace можно:
//                            GRACE_MS=3000 npm run sim)
//
// Сценарий:
//   A создаёт комнату → B видит её в списке и заходит по коду → оба ready →
//   A (хост) начинает матч → B обрывается → A видит opp_left → B
//   переподключается по токену (opp_back) → B обрывается НАВСЕГДА → grace
//   истёк → матч «остановлен», комната возвращается в лобби → A выходит.
import WebSocket from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const GRACE_MS = Number(process.env.GRACE_MS ?? 30_000);
const URL = `ws://127.0.0.1:${PORT}/ws`;

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

/**
 * Тестовый «игрок». Все входящие сообщения складываются в очередь —
 * так не теряется сообщение, пришедшее между двумя wait().
 */
class P {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket(URL);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      const i = this.waiters.findIndex((w) =>
        w.types ? w.types.includes(m.t) : w.pred(m)
      );
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.res(m);
      } else {
        this.queue.push(m);
      }
    });
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', (e) => rej(new Error(`${this.name}: ${e.message}`)));
    });
  }
  send(t, d) {
    this.ws.send(JSON.stringify({ t, d }));
  }
  /** Дождаться сообщения типа t (или любого из списка), сначала из очереди. */
  wait(types, timeout = 4000) {
    const list = Array.isArray(types) ? types : [types];
    const qi = this.queue.findIndex((m) => list.includes(m.t));
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((res, rej) => {
      const w = { types: list, res, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        rej(new Error(`${this.name}: таймаут, жду ${list.join('/')}` +
          ` (в очереди: ${this.queue.map((m) => m.t).join(',') || '—'})`));
      }, timeout) };
      this.waiters.push(w);
    });
  }
  /** Дождаться сообщения, удовлетворяющего предикату (сначала очередь). */
  waitPred(pred, timeout = 4000) {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((res, rej) => {
      const w = { pred, res, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        rej(new Error(`${this.name}: таймаут, условие не выполнено (в очереди: ${this.queue.map((m) => m.t).join(',') || '—'})`));
      }, timeout) };
      this.waiters.push(w);
    });
  }
  /** Слить очередь устаревших сообщений (активные ожидатели сохраняются). */
  flush() {
    this.queue = [];
  }
  close() {
    this.ws.removeAllListeners();
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Симуляция лобби против ws://127.0.0.1:${PORT} (grace=${GRACE_MS} мс)\n`);

  // --- A: создаёт комнату ---
  const A = new P('A');
  await A.open();
  A.send('hello', { nick: 'Alice' });
  await A.wait('welcome');
  A.send('create_room', { nick: 'Alice' });
  const ruA = await A.wait('room_update');
  const code = ruA.d.code;
  check('A создал комнату (код 5 символов)', /^[A-Z0-9]{5}$/.test(code));
  check('A — хост (mySeat=0) с токеном', ruA.d.mySeat === 0 && !!ruA.d.myToken);

  // --- B: список комнат + заход по коду ---
  const B = new P('B');
  await B.open();
  B.send('hello', { nick: 'Bob' });
  await B.wait('welcome');
  B.send('list_rooms', {});
  const roomsMsg = await B.wait('rooms');
  check('B видит комнату в списке', roomsMsg.d.rooms.some((r) => r.code === code && r.players === 1));
  B.send('join_room', { code, nick: 'Bob' });
  const ruB = await B.wait('room_update');
  check('B зашёл (mySeat=1, 2 игрока)', ruB.d.mySeat === 1 && ruB.d.seats.filter(Boolean).length === 2);
  const ruA2 = await A.wait('room_update');
  check('A узнал о госте', ruA2.d.seats[1] && ruA2.d.seats[1].nick === 'Bob');
  const tokenB = ruB.d.myToken;
  check('B получил токен переподключения', !!tokenB);

  // --- ready + старт ---
  B.send('toggle_ready', { ready: true });
  await B.wait('room_update');
  A.send('toggle_ready', { ready: true });
  await A.wait('room_update');
  // гость не может начать
  B.send('start_game', {});
  const e1 = await B.wait('error');
  check('старт от гостя отклонён (only_host)', e1.d.code === 'only_host');
  A.send('start_game', {});
  // Этап 2: room_update(phase=game) + снапшот state (game_start больше не шлётся)
  const ruA3 = await A.waitPred((m) => m.t === 'room_update' && m.d.phase === 'game', 4000);
  check('A: фаза комнаты стала game', ruA3.d.phase === 'game');
  const stA = await A.waitPred((m) => m.t === 'state', 4000);
  const stB = await B.waitPred((m) => m.t === 'state', 4000);
  check('матч начался: state-снапшот обоим', stA.d.status === 'running' && stB.d.status === 'running');
  check('снапшоты по-seat: своя рука видна, чужая — только счёт',
    stA.d.self.hand.length >= 3 && stB.d.self.hand.length >= 3 &&
    stA.d.opp.handCount >= 3 && stA.d.opp.hand === undefined);
  check('секреты не утекают в снапшот (нет deck/rngSeed)',
    !JSON.stringify(stA.d).includes('rngSeed') && stA.d.self.deck === undefined);

  // --- B обрывается: A видит room_update(connected:false) + opp_left ---
  B.close();
  await sleep(50); // даём серверу обработать close
  let sawUpdate = false;
  try {
    await A.waitPred(
      (m) => m.t === 'room_update' && m.d.seats[1] && m.d.seats[1].connected === false,
      4000
    );
    sawUpdate = true;
  } catch {
    /* проверяем дальше */
  }
  check('A: seat B показан «отключён»', sawUpdate);
  let sawOppLeft = false;
  try {
    await A.wait('opp_left', 4000);
    sawOppLeft = true;
  } catch {
    /* проверяем дальше */
  }
  check('A: получен opp_left', sawOppLeft);

  // --- B переподключается по токену ---
  const C = new P('C(=Bob)');
  await C.open();
  C.send('hello', { nick: 'Bob' });
  await C.wait('welcome');
  C.send('reconnect', { roomCode: code, token: tokenB });
  const ruC = await C.wait('room_update');
  check('B вернён в комнату (connected=true)', ruC.d.seats[1] && ruC.d.seats[1].connected === true);
  const backA = await A.wait('opp_back');
  check('A: получен opp_back', backA.d.seat === 1);

  // --- B обрывается навсегда: grace → возврат в лобби ---
  C.close();
  await sleep(50);
  let sawOppLeft2 = false;
  try {
    await A.wait('opp_left', 4000);
    sawOppLeft2 = true;
  } catch {
    /* проверяем дальше */
  }
  check('A: второй opp_left (окончательный обрыв)', sawOppLeft2);
  A.flush(); // сбрасываем устаревшие сообщения, ждём только финальное
  const finalA = await A.waitPred(
    (m) => m.t === 'room_update' && m.d.phase === 'lobby',
    GRACE_MS + 5000
  );
  check('после grace матч остановлен, фаза = lobby', finalA.d.phase === 'lobby');
  check('сид B освобождён', finalA.d.seats[1] === null);

  // --- A выходит из комнаты (сервер уведомляет остальных; A — локально) ---
  A.flush();
  A.send('leave_room', {});
  A.send('list_rooms', {});
  // пустая комната скрывается из лобби: ждём рассылку, где её нет
  await A.waitPred(
    (m) => m.t === 'rooms' && !m.d.rooms.some((r) => r.code === code),
    4000
  );
  check('A вышел: комната исчезла из лобби (пустые скрыты)', true);

  A.close();
  await sleep(50);
  console.log(
    failures === 0
      ? '\n=== SIM LOBBY: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ==='
      : `\n=== SIM LOBBY: ПРОВАЛОВ: ${failures} ===`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nОШИБКА СИМУЛЯЦИИ:', e.message);
  process.exit(1);
});
