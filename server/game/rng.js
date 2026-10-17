// rng.js — детерминированный ГПСЧ (mulberry32).
// Seed хранится в GameState и НЕ отправляется клиентам (античит:
// тасовка и случайные цели эффектов воспроизводятся только сервером).
export class RNG {
  /** @param {number} seed 32-bit */
  constructor(seed) {
    this.state = seed >>> 0;
  }

  /** Случайное число в [0, 1). */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Целое в [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** Случайный элемент массива. */
  pick(arr) {
    return arr[this.int(arr.length)];
  }

  /** Перемешивание Фишера–Йейтса (на месте). */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
