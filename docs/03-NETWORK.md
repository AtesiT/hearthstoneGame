# 03. СЕТЬ — протокол

Транспорт: WebSocket, путь `/ws` (на том же порту 8080, что и HTTP-статика).
Кадры: JSON-текст `{"t": "<тип>", "d": {…}}`, maxPayload 64 КБ.
Rate-limit: **40 сообщений/сек** на соединение (избыток — игнор кадра).

## Клиент → Сервер (14 типов)

| t | d | Когда | Ответ |
|---|---|---|---|
| `hello` | `{nick}` | после каждого (пере)подключения | `welcome {session, name}` |
| `ping` | `{t, ack?}` | каждые 5 с; `ack` — последний увиденный seq | `pong {t}` |
| `list_rooms` | `{}` | открытие лобби | `rooms {rooms:[{code,host,players,phase}]}` |
| `create_room` | `{nick}` | «Создать комнату» | `room_update` |
| `join_room` | `{code, nick}` | по коду | `room_update` |
| `leave_room` | `{}` | выход | `room_update` (остальным) |
| `toggle_ready` | `{ready}` | «Готов» | `room_update` |
| `start_game` | `{}` | только хост, оба ready | `room_update` (phase=game) + `state` обоим |
| `reconnect` | `{roomCode, token}` | после обрыва, если была комната | `room_update` (+ `state` в игре) |
| `request_state` | `{}` | принудительный resync | `state` |
| `play_card` | `{handUid, target?, ack}` | своя карта | `state` обоим / `error` |
| `end_turn` | `{ack}` | завершить ход | `state` обоим / `error` |
| `attack` | `{fromUid, fromSeat, toUid?, toSeat, ack}` | `fromUid` — uid существа или `'weapon'` | `state` обоим / `error` |
| `send_emotion` | `{emotion, ack}` | 8 эмоций, троттлинг 1/с | `state` обоим / `error` |

**Цель** (`target`/`toUid`+`toSeat`): `{kind:'minion', uid, seat}` или
`{kind:'hero', seat}`. Список допустимых целей приходит в снапшоте
(`hand[i].targets`, `self.attacks`) — клиент только выбирает из него.

**Коды `error`** (диспетчер): лобби — `bad_nick, already_in_room,
not_in_room, room_not_found, room_full, nick_taken, room_in_game,
need_2_players, only_host_starts`; игра — `not_your_turn, card_not_yours,
not_enough_mana, board_full, target_required, invalid_target,
target_not_required, unit_not_mine, cannot_attack, weapon_cannot_attack,
no_weapon, taunt_blocked, game_over, not_in_game, throttled, bad_emotion,
bad_payload`. Ошибка — это **норма протокола** (клиент мог устать): снапшот
при этом не меняется, следующий `state` синхронизирует.

## Сервер → Клиент (10 типов)

| t | d | Назначение |
|---|---|---|
| `welcome` | `{session, name}` | подтверждение hello |
| `rooms` | `{rooms[]}` | список лобби |
| `room_update` | `serializeRoom` | снапшот комнаты (см. ниже) |
| `state` | `ViewState` | полный игровой снапшот **для адресата** |
| `opp_left` | `{seat}` | оппонент отключился (grace идёт) |
| `opp_back` | `{seat}` | оппонент вернулся |
| `opp_left_final` | `{seat}` | матч остановлен (grace истёк / выход) |
| `kicked` | `{msg}` | место занял другой ввод по токену |
| `pong` | `{t}` | ответ на ping |
| `error` | `{code, msg}` | команда отклонена |

### `room_update` (serializeRoom)

```json
{ "code": "A1B2C", "phase": "lobby|game",
  "seats": [ {"nick":"Аня","ready":true,"connected":true}, null ],
  "mySeat": 0, "myToken": "uuid" }
```
`myToken` хранится клиентом в localStorage — на нём reconnect.

### `state` (ViewState = sanitizeGame)

```json
{ "v":1, "roomCode":"A1B2C", "status":"running|ended", "turn":0,
  "turnCount":7, "winner":null, "winReason":null, "coinOwner":1,
  "self": { "seat":0, "nick":"Аня",
    "hero": {"name":"Кайл","hp":25,"maxHp":30,"weapon":{…}|null},
    "mana":3, "maxMana":4, "deckCount":22,
    "hand": [ {"uid","cardId","playable":true,"targets":[…]} ],
    "board": [ {"uid","cardId","seat","atk","health","maxHealth",
                "baseAtk","baseHealth","canAttack","frozen","ds",
                "justPlayed","keywords":[…]} ],
    "attacks": {"minions":[{"uid","targets":[…]}], "weapon":{…}|null} },
  "opp": { "seat":1, "nick":"Боб", "hero":{…}, "deckCount":20,
           "handCount":5, "board":[…] },
  "seq": 42,
  "events": [ {"seq":40,"k":"play_minion","seat":0,"cardId":"…"}, … ] }
```

**Приватность:** у `opp` нет `hand` (только `handCount`), нет порядка колод
(только `deckCount`), нет `rngSeed`. `events` — только новые (seq > ack,
лимит 200; дальше клиент делает полный рендер).

### События (`events[].k`) — 19 типов

`coin, turn_start, draw, burn, play_minion, play_weapon, play_spell,
attack, weapon_broke, damage, heal, buff, freeze, shield_break,
minion_died, fatigue, fx, game_over, emotion`.

Поля: `seq` + специфика (например `attack {from,to,damage,fatal,viaWeapon}`,
`minion_died {uid,seat,poison}`, `emotion {seat,emotion}`). Клиент:
`fx.js` → анимации/звук, `log.js` → RU-строки, `game-ui` → тосты.

## Жизненный цикл соединения и reconnect

```
открыть WS → hello → (welcome)
  · есть token в localStorage → reconnect {roomCode, token}
      ok  → room_update (+ state, если phase=game)
      fail→ обычный режим (лобби/меню)
ping каждые 5 с (активность; ack — для упрощения снапшотов)
обрыв (close) → клиент: до 10 попыток × 1 с, при наличии комнаты — reconnect
сервер: close → сид остаётся, grace 30 с
  · reconnect в grace → seat восстановлен, opp_back остальным
  · grace истёк:
      в лобби  → сид освобождается
      в игре   → opp_left_final, комната → лобби, матч остановлен
двойное соединение по токену → старому 'kicked', место переходит новому
сервер: без трафика 40 с → «мёртвое» соединение (sweep)
```

## Безопасность (сводка)

- валидация **всех** команд на сервере (юнит-тесты + античит-фазз: нелегальная
  команда не меняет состояние — snapshot до = после);
- секреты не сериализуются (тест `sanitizeGame` на обоих сидах);
- rate-limit 40/с + maxPayload 64 КБ + sweep мёртвых соединений;
- код комнаты — 5 символов из неотличимого алфавита (без 0/O/1/I);
- путь статики защищён от path traversal (итоговый путь обязан быть в `public/`);
- клиент не доверяет и не хранит правила — только viewState.
