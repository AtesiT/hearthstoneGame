// cards.js (клиент) — кэш публичного DB карт (GET /api/cards).
// DB карт — ПУБЛИЧНЫЕ данные (как в HS: все описания открыты).
// Секреты (содержимое/порядок колод, чужая рука) к клиенту не приходят —
// на сервере за это отвечает sanitize.js.

let cache = null;
let loading = null;

/** @returns {Promise<Map<string, object>>} cardId → CardDef */
export function cardsMap() {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    loading = fetch('/api/cards')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => new Map(Object.entries(data.cards)))
      .then((map) => {
        cache = map;
        return map;
      })
      .catch((e) => {
        loading = null; // допустить повторную попытку
        throw e;
      });
  }
  return loading;
}

/** Синхронный доступ (после загрузки). @returns {object|undefined} */
export function cardDef(cardId) {
  return cache?.get(cardId);
}
