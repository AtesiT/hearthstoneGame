// Юнит-тесты RoomStore (лобби-логика) — node --test, без сети.
// RoomStore не знает про WebSocket: все «отправки» ловятся в emit-массив.
// ВАЖНО: каждый тест в конце вызывает store.dispose() — иначе живые
// grace/TTL-таймеры не дадут процессу завершиться.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore, serializeRoom } from '../net/rooms.js';

/** Создаёт хранилище + ловит emit-события. */
function makeStore(graceMs = 50) {
  const events = [];
  const store = new RoomStore((ev) => events.push(ev), { graceMs });
  return { store, events };
}

/** Фейковое «соединение» (контекст NetServer). */
const fakeConn = (id) => ({
  id,
  ws: { id, send() {}, readyState: 1 },
  nick: null,
  room: null,
  seat: null,
  token: null,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('создание комнаты: код 5 символов, хост на сиде 0, рассылка списка', (t) => {
  const { store, events } = makeStore();
  t.after(() => store.dispose());
  const a = fakeConn('a');
  const res = store.createRoom(a, 'Alice');
  assert.equal(res.ok, true);
  const room = a.room;
  assert.match(room.code, /^[A-Z0-9]{5}$/);
  assert.equal(room.phase, 'lobby');
  assert.equal(a.seat, 0);
  assert.ok(a.token);
  // события: room_update для создателя + rooms-рассылка
  assert.ok(events.some((e) => e.kind === 'room_update' && e.ws.id === 'a'));
  assert.ok(events.some((e) => e.kind === 'rooms'));
});

test('присоединение по коду: второй игрок на сиде 1, обоим room_update', (t) => {
  const { store, events } = makeStore();
  t.after(() => store.dispose());
  const a = fakeConn('a');
  store.createRoom(a, 'Alice');
  const code = a.room.code;
  const b = fakeConn('b');
  const res = store.joinRoom(b, code.toLowerCase(), 'Bob'); // код без учёта регистра
  assert.equal(res.ok, true);
  assert.equal(b.seat, 1);
  // оба получили снапшот
  const updates = events.filter((e) => e.kind === 'room_update');
  assert.ok(updates.some((e) => e.ws.id === 'a'));
  assert.ok(updates.some((e) => e.ws.id === 'b'));
});

test('ошибки: несуществующая комната, полная комната, занятый ник, неверный ник', (t) => {
  const { store } = makeStore();
  t.after(() => store.dispose());
  const a = fakeConn('a');
  store.createRoom(a, 'Alice');
  const code = a.room.code;
  const b = fakeConn('b');
  const c = fakeConn('c');

  assert.equal(store.joinRoom(b, 'XXXXX', 'Bob').code, 'room_not_found');
  assert.equal(store.joinRoom(b, code, 'Bob').ok, true); // теперь полная
  assert.equal(store.joinRoom(c, code, 'Carol').code, 'room_full');
  const d = fakeConn('d');
  store.leaveRoom(a); // хост вышел → Bob реиндексируется в сид 0, комната свободна
  // точное совпадение ника (с учётом регистра) → отказ
  assert.equal(store.joinRoom(d, code, 'Bob').code, 'nick_taken');
  // другой регистр — это другой ник, заход разрешён
  assert.equal(store.joinRoom(d, code, 'bob').ok, true);
  assert.equal(store.joinRoom(fakeConn('x'), code, 'b').code, 'bad_nick');
  assert.equal(store.joinRoom(fakeConn('y'), code, 'Bob!').code, 'bad_nick');
});

test('ready и старт: стартит только хост, оба должны быть готовы', (t) => {
  const { store, events } = makeStore();
  t.after(() => store.dispose());
  const a = fakeConn('a');
  const b = fakeConn('b');
  store.createRoom(a, 'Alice');
  store.joinRoom(b, a.room.code, 'Bob');

  assert.equal(store.startGame(a).code, 'not_all_ready');
  store.toggleReady(a, true);
  assert.equal(store.startGame(a).code, 'not_all_ready');
  store.toggleReady(b, true);
  const res = store.startGame(b); // гость не может начать
  assert.equal(res.code, 'only_host');
  const res2 = store.startGame(a);
  assert.equal(res2.ok, true);
  assert.equal(a.room.phase, 'game');
  // Этап 2: RoomStore только переворачивает фазу и шлёт room_update обоим.
  // Сами снапшоты состояния (state) создаёт NetServer.startRoomGame.
  const ru = events.filter((e) => e.kind === 'room_update');
  assert.ok(ru.some((e) => e.ws.id === 'a' && e.room.phase === 'game'));
  assert.ok(ru.some((e) => e.ws.id === 'b' && e.room.phase === 'game'));
  const gs = events.filter((e) => e.kind === 'game_start');
  assert.equal(gs.length, 0, 'game_start больше не шлётся RoomStore');
});

test('обрыв: grace-период, reconnect по токену, opp_back противнику', (t) => {
  const { store, events } = makeStore(60);
  t.after(() => store.dispose());
  const a = fakeConn('a');
  const b = fakeConn('b');
  store.createRoom(a, 'Alice');
  store.joinRoom(b, a.room.code, 'Bob');
  const tokenB = b.token;

  // «обрыв» b
  store.onDisconnect(b);
  assert.equal(a.room.seats[1].connected, false);
  assert.equal(b.token, null);

  // reconnect: новое соединение c с тем же токеном
  const c = fakeConn('c');
  const res = store.reconnect(c, a.room.code, tokenB);
  assert.equal(res.ok, true);
  assert.equal(c.seat, 1);
  assert.equal(c.nick, 'Bob');
  assert.equal(a.room.seats[1].connected, true);
  const oppBack = events.filter((e) => e.kind === 'opp_back');
  assert.equal(oppBack.length, 1);
  assert.equal(oppBack[0].ws.id, 'a');
});

test('grace истёк в лобби: сид освобождается, реиндекс хоста', async (t) => {
  const { store, events } = makeStore(40);
  t.after(() => store.dispose());
  const a = fakeConn('a');
  const b = fakeConn('b');
  store.createRoom(a, 'Alice');
  store.joinRoom(b, a.room.code, 'Bob');
  const code = a.room.code;

  store.onDisconnect(a); // хост отключился
  await wait(70); // grace

  const room = store.rooms.get(code);
  assert.ok(room);
  // Боб (сид 1) должен стать хостом
  assert.equal(room.seats[0]?.nick, 'Bob');
  assert.equal(room.seats[1], null);
  // контекст соединения Боба обновлён (mySeat в снапшоте = 0)
  assert.equal(b.seat, 0);
  const lastUpdate = [...events].reverse().find((e) => e.kind === 'room_update' && e.ws.id === 'b');
  assert.ok(lastUpdate);
  assert.equal(serializeRoom(room, b).mySeat, 0);
});

test('grace истёк в игре: матч «остановлен», возврат в лобби', async (t) => {
  const { store, events } = makeStore(40);
  t.after(() => store.dispose());
  const a = fakeConn('a');
  const b = fakeConn('b');
  store.createRoom(a, 'Alice');
  store.joinRoom(b, a.room.code, 'Bob');
  const code = a.room.code;
  store.toggleReady(a, true);
  store.toggleReady(b, true);
  store.startGame(a);

  store.onDisconnect(b);
  assert.ok(events.some((e) => e.kind === 'opp_left' && e.ws.id === 'a'));
  await wait(70);

  const room = store.rooms.get(code);
  assert.equal(room.phase, 'lobby');
  assert.ok(events.some((e) => e.kind === 'opp_left_final' && e.ws.id === 'a'));
});

test('двойной вход по токену: старое соединение вытесняется', (t) => {
  const { store, events } = makeStore(60);
  t.after(() => store.dispose());
  const a = fakeConn('a');
  const b = fakeConn('b');
  store.createRoom(a, 'Alice');
  store.joinRoom(b, a.room.code, 'Bob');
  const code = a.room.code;
  const tokenB = b.token;

  // b снова «подключается» (новое соединение, то же место, уже подключён)
  const b2 = fakeConn('b2');
  const res = store.reconnect(b2, code, tokenB);
  assert.equal(res.ok, true);
  assert.equal(b2.seat, 1);
  // старому — kick + close_ws
  assert.ok(events.some((e) => e.kind === 'kick' && e.ws.id === 'b'));
  assert.ok(events.some((e) => e.kind === 'close_ws' && e.ws.id === 'b'));
});

test('снапшот: myToken виден только владельцу сида', (t) => {
  const { store } = makeStore();
  t.after(() => store.dispose());
  const a = fakeConn('a');
  const b = fakeConn('b');
  store.createRoom(a, 'Alice');
  store.joinRoom(b, a.room.code, 'Bob');
  const room = a.room;

  const viewA = serializeRoom(room, a);
  const viewB = serializeRoom(room, b);
  assert.equal(viewA.myToken, a.token);
  assert.equal(viewB.myToken, b.token);
  // «чужой» взгляд (ctx без комнаты) не получает токен
  const viewStranger = serializeRoom(room, fakeConn('z'));
  assert.equal(viewStranger.mySeat, null);
  assert.equal(viewStranger.myToken, null);
});

test('добровольный выход ИЗ МАТЧА: оппонент получает opp_left_final, комната → лобби', (t) => {
  const { store, events } = makeStore(60);
  t.after(() => store.dispose());
  const a = fakeConn('a');
  const b = fakeConn('b');
  store.createRoom(a, 'Alice');
  store.joinRoom(b, a.room.code, 'Bob');
  const code = a.room.code;
  store.toggleReady(a, true);
  store.toggleReady(b, true);
  store.startGame(a);
  assert.equal(a.room.phase, 'game');

  store.leaveRoom(a); // хост добровольно выходит из матча

  const room = store.rooms.get(code);
  assert.equal(room.phase, 'lobby');
  assert.ok(events.some((e) => e.kind === 'opp_left_final' && e.ws.id === 'b'));
  // Боб остался один и стал хостом
  assert.equal(room.seats[0]?.nick, 'Bob');
  assert.equal(b.seat, 0);
});

test('добровольный выход: сид освобождается сразу (без grace), пустая комната — TTL', (t) => {
  const { store } = makeStore(60);
  t.after(() => store.dispose());
  const a = fakeConn('a');
  const b = fakeConn('b');
  store.createRoom(a, 'Alice');
  store.joinRoom(b, a.room.code, 'Bob');
  const code = a.room.code;

  store.leaveRoom(a);
  // хост ушёл → Боб реиндексируется в сид 0
  const afterALeft = store.rooms.get(code).seats;
  assert.equal(afterALeft[0]?.nick, 'Bob');
  assert.equal(afterALeft[1], null);
  assert.equal(b.seat, 0);

  store.leaveRoom(b);
  // пустая комната живёт ещё (TTL 60 с), но сиды пусты
  assert.ok(store.rooms.has(code));
  const any = store.rooms.get(code).seats.some((s) => s);
  assert.equal(any, false);
});
