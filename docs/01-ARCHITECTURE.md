# 01. АРХИТЕКТУРА

EMBERFALL — двухпользовательская карточная игра по LAN. Один узел поднимает
сервер, второй игрок открывает его адрес в браузере. Без интернета, без Docker,
без сборки: один `npm start`.

## Принципы

1. **Авторитетный сервер.** Вся игровая логика (ходы, мана, эффекты, смерти,
   победа) — в `server/game/engine.js`. Клиент — тонкий: рендерит снапшоты и
   шлёт команды. На клиенте **нет правил** — валидные цели приходят от сервера.
2. **Полная синхронизация.** Ответ на каждую команду — полный ViewState
   (состояние «для конкретного игрока») + список событий с `seq > ack`.
   Клиент не догоняет дельтами — он просто рисует последнее состояние.
3. **Секреты не покидают сервер.** `rngSeed`, содержимое и порядок чужой
   колоды, чужая рука — не сериализуются. Своя рука видна, чужая — только
   `handCount`.
4. **Всё статическое — в репозитории.** Шрифт (woff2), пиксель-арт (PNG),
   звуки (генерируются WebAudio в рантайме, файлов нет). `npm start` работает
   офлайн.

## Структура

```
public/                     тонкий клиент
  index.html                один HTML: все экраны (menu/lobby/waiting/game/коллекция)
  css/main.css              дизайн-система + анимации
  js/net/client.js          WS-клиент: автореконнект, ping, reconnect по токену
  js/ui/main.js             машина экранов + сетевые колбэки (~535 строк)
  js/ui/collection.js       коллекция карт (фильтры, сортировки, детальная карта)
  js/ui/settings.js         настройки (музыка/звук/подсказки, localStorage)
  js/game/game-ui.js        контроллер стола: состояние, рендер, выбор целей (~716)
  js/game/fx.js             события → анимации/звук (баннер, частицы, виньетка)
  js/game/cardtips.js       RU-описания карт для стола/тултипов
  js/game/cardtext.js       RU-текст из EffectSpec + словарь ключевых слов
  js/game/log.js            боевой лог (события → RU-строки)
  js/game/emojis.js         8 пиксель-лиц эмоций (canvas → dataURL)
  js/game/art.js            арт: PNG из репо, procedural-fallback
  js/game/cards.js          кэш публичного DB (GET /api/cards)
  js/audio/sfx.js           8-бит синтезатор (oscillator), dither-free square/saw
  js/audio/music.js         look-ahead секвенсор (lead+bass), темы menu/battle
  assets/                   шрифт, favicon, PNG карт (32) и героев (2)
server/
  index.js                  точка входа: HTTP-статика + /api/cards + WS-апгрейд
  game/rng.js               mulberry32 (детерминированный, seed на сервере)
  game/cards.js             CARD_DB (32), DECK_LIST (30) — публичные данные
  game/engine.js            движок: createGame, command, события, победа (~734)
  net/rooms.js              RoomStore: комнаты, сиды, ready, grace, kick, TTL
  net/server.js             NetServer: соединения, rate-limit, gameCommand
  net/messages.js           диспетчер входящих (14 типов) → store/engine
  net/sanitize.js           ViewState: что именно видит каждый игрок
  test/                     node --test: engine, rooms, anticheat
scripts/
  sim-lobby.js              headless: 2 клиента по WS, лобби (19 проверок)
  sim-game.js               headless: 2 ИИ до конца партии (13 проверок)
  sim-reconnect.js          обрывы/reconnect/kick (in-process сервер, 20)
  sim-balance.js            200+ партий движком, метрики баланса
  sim-ui.js                 jsdom: клиентский UI (78 проверок)
  gen-art.js                генератор PNG (PNG-кодер без зависимостей)
  gen-cards-doc.js          генератор docs/02-CARDS.md из CARD_DB
docs/                       00-анализ, 01-архитектура, 02-карты, 03-сеть,
                            04-управление, 05-разработка
```

**Критерий модульности (Этап 7):** каждый модуль — одна ответственность;
крупнейшие — `engine.js` (734, движок), `game-ui.js` (716, контроллер стола
с общим DOM-состоянием), `main.js` (535, машина экранов). Выносы этапов 4–6:
`fx.js` (эффекты), `cardtips.js`/`cardtext.js` (тексты), `log.js`, `emojis.js`.

## Поток данных (партия)

```
Игрок кликает карту/цель
  → game-ui.js: hooks.send('play_card', {handUid, target, ack})
  → client.js: WS-кадр {t:'play_card', d:{...}}
  → messages.js: updateAck + NetServer.gameCommand
  → engine.command(state, seat, cmd): валидация → изменение state → события
  → sanitizeGame(state, forSeat) × 2 → 'state' каждому (свои секреты)
  → game-ui.onState: рендер + fx.playEvents(новые события) + log.appendEvents
```

Анти-«гонка»: `ack` (последний seq клиента) упрощает следующие снапшоты
(события старше ack не пересылаются); лимит 200 событий на синк — дальше
полный перерисовочный снапшот.

## Ключевые решения

- **`ws` (8.x) — единственная runtime-зависимость.** Статика — ручной
  хендлер (MIME-таблица + path-traversal-защита), без Express.
- **PNG-арт генерируется скриптом в репо** (`npm run art`): 8×8-шаблоны
  (bestiary: зверь/дух/голем/дракон/молния/орб/волна/взрыв/оружие/монета/
  череп) × палитры карт. Оффлайн-требование выполнено жёстко.
- **Звук без файлов:** `sfx.js` — square/saw-осцилляторы + огибающая +
  limiter; дроссели MAX_CONCURRENT=5 и MIN_INTERVAL=40 мс/тип против
  «дребезга» при массовых событиях.
- **Reconnect по токену** (localStorage): обрыв → до 10 попыток по 1 с →
  `hello` + `reconnect {roomCode, token}`. Grace-период сервера (30 с)
  держит сид; в игре — resync-снапшот сразу после возврата.
- **Rate-limit 40 msg/с** на соединение + maxPayload 64 КБ: спам не роняет
  сервер и не засоряет очередь событий.

## Тестовая стратегия (пирамидой)

1. **Юнит (engine/rooms/anticheat, `npm test`)**: правила в изоляции +
   античит-фазз (нелегальные команды не меняют состояние).
2. **Интеграция (sim-lobby/sim-reconnect, WS)**: живые сценарии лобби и
   обрывов, включая grace/kick.
3. **Симуляция партий (sim-game/sim-balance)**: ИИ играют до конца —
   инварианты, договорённость о победителе, баланс.
4. **UI (sim-ui, jsdom)**: рендер снапшотов, выбор целей, эмоции, коллекция,
   лог, настройки, реальная загрузка `main.js` (ловит «молча пропавшие
   импорты»).
