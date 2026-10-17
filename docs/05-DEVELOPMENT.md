# 05. РАЗРАБОТКА

## Среда и запуск

- **Node.js ≥ 18** (проверено на 22). Единственная runtime-зависимость — `ws`.
- `npm install && npm start` → сервер на **8080**, в консоли — LAN-адрес
  (его открывает второй игрок).
- Переменные окружения: `PORT` (по умолчанию 8080), `GRACE_MS`
  (grace при обрыве, по умолчанию 30000; для тестов уменьшайте).

```bash
npm start            # сервер (HTTP + WS)
npm test             # юнит-тесты (node --test): engine, rooms, anticheat
npm run sim          # лобби, 2 клиента по WS (нужен запущенный сервер)
npm run sim-game     # полная партия 2 ИИ (нужен запущенный сервер)
npm run sim-reconnect# обрывы/reconnect/kick (сервер in-process, сам)
npm run sim-balance  # 200+ партий движком (сервер не нужен)
npm run test-ui      # UI на jsdom (сервер не нужен)
npm run art          # перегенерация PNG-арта (scripts/gen-art.js)
npm run gen-cards-doc# перегенерация docs/02-CARDS.md из CARD_DB
```

Симуляции `sim`/`sim-game` поднимают **внешний** сервер (`npm start` в другом
окне); `sim-reconnect` и `sim-balance` автономны.

## Как добавить карту

1. `server/game/cards.js` — объект в `CARD_DB` (структура §4.1 в 00-ANALYSIS.md):
   `id, name, type, cost, rarity`, для существа `attack/health/keywords`,
   для оружия `attack/durability`, эффекты `spell/battlecry/deathrattle/aura`
   (массивы EffectSpec), `targeting`, `flavor`.
   EffectSpec: `{kind, amount?, atk?, health?, target?, attackMax?,
   minionCard?}` — kinds: `damage, damage_all, buff, heal, kill_minion,
   destroy_all, draw, mana_gain, stun, summon`.
   `targeting`: `none | enemy_minion | enemy_minion_or_hero | friendly_minion`.
2. `DECK_LIST` — добавить id (если карта входит в 30-карточный сет).
3. `scripts/gen-art.js` — шаблон + палитра в `ASSIGN` (иначе fallback-арт).
4. `npm run gen-cards-doc` — обновить 02-CARDS.md.
5. Тесты:
   - `server/test/engine.test.js` — юнит на эффект/ключевое слово
     (паттерн: `fresh()` → `give(s, seat, cardId)` → `command(...)` → assert);
   - `sim-balance` — убедиться, что карта разыгрывается и не ломает кривую;
   - `sim-ui` — коллекция покажет 31+ карту (обновить число в проверке).

Правила применения эффектов — в `engine.applyEffect` (один switch).
Валидные цели — `engine.getTargetsForMode` (таунт учитывается там,
а не в клиентах).

## Как добавить ключевое слово

1. `cards.js` — значение в `keywords: [...]`.
2. `engine.js` — правило в соответствующем месте (атака: `command`/
   `getTargetsForMode`; пассив: `recomputeBoard`/`startTurn`).
3. RU-имя: `public/js/game/cardtext.js` → `KEYWORDS_RU` (коллекция/тултипы)
   и `public/js/game/cardtips.js` → `KW_TEXT` (лицевые стороны).
4. Арт-иконка ключевых слов — опционально, в `game-ui.js` (unit-kw).
5. Юнит-тест на правило.

## Как добавить эмоцию

1. `server/game/engine.js` — ключ в `EMOTIONS`.
2. `public/js/game/emojis.js` — лицо (12×10 пикселей) + `EMOTION_TITLE`.
3. Кнопка подхватится автоматически (`EMOTION_ORDER`); звук —
   `sfx.js` `emotion{N}` (индекс в порядке `EMOTION_ORDER`).

## Структура состояния (движок)

```
state = { status:'running'|'ended', turn:0|1, firstSeat, turnCount,
  players:[ {seat, nick, hero:{name,hp,maxHp,weapon}, mana, maxMana,
             deck:[cardId…], hand:[{uid,cardId}], board:[Minion], fatigue} ×2 ],
  winner, winReason, coinOwner, seq, rngSeed(секрет), rng, events:[…] }
Minion = { uid, cardId, seat, atk, health, maxHealth, baseAtk, baseHealth,
           canAttack, frozen, ds, justPlayed, keywords, _poisonDeath? }
```

Смерти — очередь (deathrattle может призвать/поразить; защита от зацикливания).
Ауры — пересчёт через `recomputeBoard` после любого изменения поля.

## Тестирование

- **Юнит** (`server/test/*.test.js`): `node --test`, изолированные движки.
  Античит-фазз — см. `anticheat.test.js` (инвариант: fail не меняет состояние).
- **Интеграция** (`scripts/sim-*.js`): класс клиента `P`/`C` с очередью
  сообщений и `wait/types/pred` (паттерн в sim-game.js/sim-reconnect.js).
- **UI** (`scripts/sim-ui.js`, jsdom): canvas/WebAudio заглушены;
  `globalThis.__HEADLESS__ = true` включает procedural-арт.
- **Баланс** (`sim-balance.js`): `GAMES=N npm run sim-balance`.

Правила для симуляций: никогда не гадать цели — только из снапшота
(`hand[i].targets`, `self.attacks`); не реже 50 мс между командами
(WS-rate-limit 40/с).

## Частые грабли (из истории проекта)

- **Свежие существа «больны»**: `canAttack=false` в ход призыва (кроме Charge).
- **board-индексы сдвигаются** после смертей — ориентируйтесь на `uid`.
- **Двойная смерть** (встречный удар + урон) — очередь смертей, не рекурсия.
- **Таунт** закрывает только уронные цели; оглушение/лечение — мимо него.
- **jsdom**: `navigator` read-only, canvas 2D и WebAudio отсутствуют —
  клиенты обязаны headless-safe (no-op без AudioContext).
- **edit_file-регрессии**: после правок grep-айте ключевые символы;
  sim-ui реально исполняет main.js — он ловит недостающие импорты.
- **Сервер кэширует engine в памяти**: после правок движка — рестарт `npm start`.
