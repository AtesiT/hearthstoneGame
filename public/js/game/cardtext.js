// cardtext.js — русский текст карт из публичного EffectSpec (клиент).
//
// Сервер не присылает готовых описаний: клиент сам складывает текст из
// структурированных эффектов (battlecry/deathrattle/spell/aura) — те же
// данные, что и в снапшоте, никаких секретов.

export const TYPE_RU = { minion: 'Существо', spell: 'Заклинание', weapon: 'Оружие' };
export const RARITY_RU = { common: 'Обычная', rare: 'Редкая', epic: 'Эпическая', legendary: 'Легендарная' };

export const KEYWORDS_RU = {
  taunt: {
    name: 'Провокация',
    desc: 'Пока это существо живое, враги могут атаковать только его — и оно, и герой.',
  },
  charge: {
    name: 'Рывок',
    desc: 'Может атаковать в тот же ход, когда было призвано.',
  },
  divine_shield: {
    name: 'Божественный щит',
    desc: 'Первый полученный урон не действует. После этого щит разбивается.',
  },
  poisonous: {
    name: 'Яд',
    desc: 'Убивает любое существо, по которому это существо нанёс урон (Божественный щит защищает).',
  },
};

// Дати́в — для глаголов (нанести / вылечить / оглушить / уничтожить)
const TARGET_DAT = {
  target: 'цели',
  target_ally: 'дружественному существу',
  enemy_hero: 'вражескому герою',
  friendly_hero: 'вашему герою',
  all_enemy_minions: 'всем вражеским существам',
  all_minions: 'всем существам на поле',
  other_friendly: 'другим дружественным существам',
  random_enemy_minion: 'случайному вражескому существу',
};
// Имения́тельный — для «существо получает +X/+Y»
const TARGET_NOM = {
  target_ally: 'дружественное существо',
  other_friendly: 'другие дружественные существа',
};

const SOURCE_PREFIX = {
  battlecry: 'Боевой клич: ',
  deathrattle: 'Смертный хрип: ',
  aura: 'Аура: ',
  spell: '',
};

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

function buffText(eff) {
  const parts = [];
  if (eff.atk) parts.push(`+${eff.atk} к атаке`);
  if (eff.health) parts.push(`+${eff.health} к здоровью`);
  return parts.join(', ');
}

/** Текст одного эффекта (EffectSpec). */
export function effectText(eff) {
  switch (eff.kind) {
    case 'damage':
      return `нанести ${eff.amount} урона ${TARGET_DAT[eff.target] ?? eff.target}`;
    case 'damage_all':
      return `нанести ${eff.amount} урона ${TARGET_DAT[eff.target] ?? 'всем существам'}`;
    case 'buff':
      if (eff.target === 'other_friendly') return `все другие дружественные существа получают ${buffText(eff)}`;
      return `${TARGET_NOM[eff.target] ?? 'дружественное существо'} получает ${buffText(eff)}`;
    case 'heal':
      return `восстановить ${eff.amount} HP ${TARGET_DAT[eff.target] ?? ''}`.trim();
    case 'kill_minion':
      return 'уничтожить ' + (TARGET_DAT[eff.target] ?? 'целевое существо');
    case 'destroy_all':
      return `уничтожить ${TARGET_DAT[eff.target] ?? 'все вражеские существа'}`;
    case 'draw': {
      const n = eff.amount ?? 1;
      return `вытянуть ${n} ${plural(n, 'карту', 'карты', 'карт')}`;
    }
    case 'mana_gain':
      return `+${eff.amount} маны в этот ход`;
    case 'stun':
      return `оглушить ${TARGET_DAT[eff.target] ?? 'цель'} на ход`;
    case 'summon': {
      const m = eff.minionCard ?? {};
      return `призвать «${m.name ?? 'существо'}» ${m.atk}/${m.health}`;
    }
    default:
      return '';
  }
}

/**
 * Полный текст карты (массив строк по эффектам).
 * @param {object} card определение из CARD_DB
 * @returns {string[]}
 */
export function cardTextLines(card) {
  const lines = [];
  const push = (effects, source) => {
    if (!effects) return;
    for (const eff of effects) {
      const t = effectText(eff);
      if (!t) continue;
      const prefix = SOURCE_PREFIX[source] ?? '';
      lines.push(`${prefix}${t[0].toUpperCase()}${t.slice(1)}`);
    }
  };
  push(card.spell, 'spell');
  push(card.battlecry, 'battlecry');
  push(card.deathrattle, 'deathrattle');
  if (card.aura) push([card.aura], 'aura');
  return lines;
}

/** Короткая строка для тултипа/коллекции. */
export function cardText(card) {
  const lines = cardTextLines(card);
  return lines.length ? lines.join('. ') + '.' : '—';
}
