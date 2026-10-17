// fx.js — слой «события → анимации/звук» (Этап 6: вынесен из game-ui.js).
//
// Чистый UI-эффект: ничего не решает, только проигрывает то, что сервер
// уже решил (events из снапшота). Состояние берёт из контекста, переданного
// в initFx (vs через getVs, DOM-карта unitEls, toast).
import * as sfx from '../audio/sfx.js';
import { cardDef } from './cards.js';
import { emojiSprite, EMOTION_ORDER, EMOTION_TITLE } from './emojis.js';

/**
 * @param {object} ctx
 * @param {() => object|null} ctx.getVs — последний ViewState
 * @param {Map<string, HTMLElement>} ctx.unitEls — uid → DOM-элемент существа
 * @param {(msg: string, kind?: string) => void} ctx.toast
 */
export function initFx({ getVs, unitEls, toast }) {
  let shownTurn = null; // для баннера смены хода

  function resetShown() {
    shownTurn = null;
  }

  function heroEl(seat) {
    const vs = getVs();
    return document.getElementById(seat === vs.self.seat ? 'self-hero' : 'opp-hero');
  }

  function unitAnchorFor(ref) {
    if (ref.kind === 'hero') return heroEl(ref.seat);
    return unitEls.get(ref.uid) || null;
  }

  function damageNumber(anchor, amount, kind) {
    if (!anchor) return;
    const d = document.createElement('div');
    d.className = `dmg-num ${kind}`;
    d.textContent = kind === 'heal' ? `+${amount}` : kind === 'buff' ? amount : `-${amount}`;
    anchor.appendChild(d);
    setTimeout(() => d.remove(), 950);
  }

  function flashUnit(ref, kind) {
    const el = unitAnchorFor(ref);
    if (!el) return;
    const f = document.createElement('div');
    f.className = `unit-flash ${kind}`;
    el.appendChild(f);
    setTimeout(() => f.remove(), 500);
  }

  function flashDeck(side) {
    const el = document.getElementById(`${side}-deck`);
    el?.classList.add('burn-flash');
    setTimeout(() => el?.classList.remove('burn-flash'), 500);
  }

  function heroHitFx(seat) {
    const el = heroEl(seat);
    if (!el) return;
    el.classList.remove('hero-hit');
    void el.offsetWidth; // перезапуск CSS-анимации
    el.classList.add('hero-hit');
    sfx.play('heroHurt');
    // красная виньетка — только когда бьют меня (Этап 4)
    if (seat === getVs().self.seat) {
      const v = document.getElementById('vignette');
      if (v) {
        v.classList.remove('show');
        void v.offsetWidth;
        v.classList.add('show');
      }
    }
  }

  /** Пузырь эмоции над портретом (Этап 4). */
  function showBubble(seat, emo) {
    const box = heroEl(seat);
    if (!box) return;
    const b = document.createElement('div');
    b.className = 'emote-bubble';
    b.innerHTML = `<img src="${emojiSprite(emo)}" alt="${EMOTION_TITLE[emo] ?? ''}">`;
    box.appendChild(b);
    setTimeout(() => b.remove(), 2400);
  }

  function showBanner(text) {
    const b = document.getElementById('banner');
    const t = document.getElementById('banner-text');
    t.textContent = text;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => b.classList.remove('show'), 1600);
  }

  /** Пепел: частицы смерти (Этап 4). */
  function spawnParticles(el) {
    const table = document.getElementById('table');
    const rect = el.getBoundingClientRect();
    const tRect = table.getBoundingClientRect();
    if (!rect.width) return; // headless
    const cx = rect.left - tRect.left + rect.width / 2;
    const cy = rect.top - tRect.top + rect.height / 2;
    for (let i = 0; i < 6; i++) {
      const p = document.createElement('i');
      p.className = 'particle';
      p.style.left = cx + 'px';
      p.style.top = cy + 'px';
      p.style.setProperty('--dx', (Math.random() * 64 - 32).toFixed(0) + 'px');
      p.style.setProperty('--dy', (Math.random() * 64 - 32).toFixed(0) + 'px');
      p.style.background = i % 2 ? '#ffd24a' : '#ff6a3a';
      table.appendChild(p);
      setTimeout(() => p.remove(), 620);
    }
  }

  /** Проиграть события (анимации + звук). vs берётся из контекста. */
  function playEvents(events) {
    const vs = getVs();
    for (const e of events) {
      switch (e.k) {
        case 'turn_start':
          if (shownTurn !== e.seat) {
            shownTurn = e.seat;
            showBanner(e.seat === vs.self.seat ? 'ВАШ ХОД' : 'ХОД ПРОТИВНИКА');
            sfx.play('turn');
          }
          break;
        case 'coin':
          if (e.seat === vs.self.seat) toast('Вы получили Монету зари (+1 мана в этот ход)', 'ok');
          sfx.play('draw');
          break;
        case 'draw':
          sfx.play('draw');
          break;
        case 'play_minion':
          sfx.play('play');
          break;
        case 'play_spell':
          sfx.play('spell');
          break;
        case 'play_weapon':
          sfx.play('weapon');
          break;
        case 'minion_died':
          sfx.play('death');
          break;
        case 'game_over':
          sfx.play(e.winner === vs.self.seat ? 'win' : 'lose');
          break;
        case 'emotion': {
          // пузырь над портретом; звук — у отправителя уже сработал по клику
          showBubble(e.seat, e.emotion);
          if (e.seat !== vs.self.seat) {
            sfx.play('emotion' + Math.max(0, EMOTION_ORDER.indexOf(e.emotion)));
          }
          break;
        }
        case 'burn': {
          const card = cardDef(e.cardId);
          toast(`Карта сгорела: ${card?.name ?? e.cardId} (рука переполнена)`, 'warn');
          flashDeck(e.seat === vs.self.seat ? 'self' : 'opp');
          sfx.play('death');
          break;
        }
        case 'fatigue':
          damageNumber(unitAnchorFor({ kind: 'hero', seat: e.seat }), e.amount, 'fatigue');
          sfx.play('heroHurt');
          break;
        case 'damage':
          damageNumber(unitAnchorFor(e.target), e.amount, 'damage');
          if (e.target.kind === 'hero') heroHitFx(e.target.seat);
          break;
        case 'heal':
          damageNumber(unitAnchorFor(e.target), e.amount, 'heal');
          break;
        case 'buff':
          damageNumber(unitAnchorFor(e.target), `+${e.atk || 0}/${e.health || 0}`, 'buff');
          break;
        case 'shield_break':
          flashUnit(e.target, 'shield');
          break;
        case 'freeze':
          flashUnit(e.target, 'frost');
          break;
        case 'attack': {
          // рывок атакующего (Этап 3) + звук
          const src = e.from.kind === 'hero'
            ? heroEl(e.from.seat)
            : unitEls.get(e.from.uid);
          if (src) {
            const cls = e.from.seat === vs.self.seat ? 'lunge-up' : 'lunge-down';
            src.classList.remove(cls);
            void src.offsetWidth;
            src.classList.add(cls);
            setTimeout(() => src.classList.remove(cls), 320);
          }
          sfx.play('attack');
          break;
        }
        case 'weapon_broke':
          if (e.seat === vs.self.seat) toast('Оружие сломалось', 'warn');
          break;
        default:
          break;
      }
    }
  }

  return { playEvents, showBanner, spawnParticles, resetShown };
}
