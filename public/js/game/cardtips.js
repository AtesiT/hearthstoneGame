// cardtips.js — RU-описания карт для стола и тултипов (Этап 6: вынесено из game-ui.js).
// Чистые функции от определения карты — без DOM и состояния.
// (cardtext.js — для коллекции; здесь — компактные строки для лицевой стороны
// карт в руке/на поле и HTML-тултипа.)

export const KW_TEXT = {
  taunt: 'Провокация',
  charge: 'Рывок',
  divine_shield: 'Божественный щит',
  poisonous: 'Яд',
};
export const KW_SHORT = { taunt: 'Пров', charge: 'Рыв', divine_shield: 'Щит', poisonous: 'Яд' };
export const RAR_TEXT = { common: 'обычная', rare: 'редкая', epic: 'эпическая', legendary: 'легендарная' };

export function effectText(eff, prefix = '') {
  switch (eff.kind) {
    case 'damage': {
      const tgt = eff.target === 'random_enemy_minion' ? ' случайному вражескому существу' : '';
      return prefix + `наносит ${eff.amount} урона${tgt}`;
    }
    case 'heal':
      return prefix + `лечит вашего героя на ${eff.amount}`;
    case 'draw':
      return prefix + (eff.amount > 1 ? `вы тянете ${eff.amount} карты` : 'вы тянете карту');
    case 'mana_gain':
      return prefix + `+${eff.amount} мана в этот ход`;
    case 'buff':
      return eff.target === 'other_friendly'
        ? prefix + `ваши другие существа получают +${eff.atk || 0}/${eff.health || 0}`
        : prefix + `+${eff.atk || 0}/${eff.health || 0}`;
    case 'stun':
      return prefix + 'оглушает существо противника';
    case 'summon':
      return prefix + `призывает ${eff.minionCard.name} (${eff.minionCard.atk}/${eff.minionCard.health})`;
    case 'kill_minion':
      return prefix + `уничтожает существо с атакой ≤ ${eff.attackMax}`;
    case 'damage_all':
      return eff.target === 'all_minions'
        ? prefix + `наносит ${eff.amount} урона всем существам на поле`
        : prefix + `наносит ${eff.amount} урона всем вражеским существам`;
    case 'destroy_all':
      return prefix + 'уничтожает все вражеские существа';
    default:
      return '';
  }
}

/** Короткое описание для лицевой стороны карты. */
export function shortDesc(def) {
  if (!def) return '';
  if (def.type === 'minion') {
    const parts = [];
    if (def.keywords?.length) parts.push(def.keywords.map((k) => KW_TEXT[k]).join(', '));
    if (def.battlecry?.length) parts.push('Клич: ' + def.battlecry.map((e) => effectText(e)).join(', '));
    if (def.deathrattle?.length) parts.push('Хрип: ' + def.deathrattle.map((e) => effectText(e)).join(', '));
    if (def.aura) parts.push('Аура: ' + effectText(def.aura));
    return parts.join(' · ');
  }
  if (def.type === 'weapon') return `Оружие: атака ${def.attack}, прочность ${def.durability}`;
  return def.spell?.map((e) => effectText(e)).join(' · ') || '';
}

/** Полное описание для тултипа. */
export function tipHtml(def) {
  if (!def) return '';
  const lines = [`<b>${esc(def.name)}</b> — ${def.cost} маны, ${RAR_TEXT[def.rarity] ?? def.rarity}`];
  if (def.type === 'minion') lines.push(`Существо ${def.attack}/${def.health}`);
  if (def.type === 'weapon') lines.push(`Оружие: ${def.attack} атаки, ${def.durability} прочности`);
  for (const k of def.keywords || []) lines.push(KW_TEXT[k]);
  if (def.battlecry?.length) lines.push('Боевой клич: ' + def.battlecry.map((e) => effectText(e)).join(', '));
  if (def.deathrattle?.length) lines.push('Смертный хрип: ' + def.deathrattle.map((e) => effectText(e)).join(', '));
  if (def.aura) lines.push('Аура: ваши другие существа ' + effectText(def.aura).replace(/^(наносит|лечит|вы)/, ''));
  if (def.spell?.length) lines.push(def.spell.map((e) => effectText(e)).join('; '));
  lines.push(`<i>${esc(def.flavor ?? '')}</i>`);
  return lines.map((l) => `<div>${l}</div>`).join('');
}

/** Текстовое (без HTML) описание для title-подсказки юнита. */
export function describeCard(def) {
  if (!def) return '';
  const parts = [];
  if (def.type === 'minion') parts.push(`Существо ${def.attack}/${def.health}`);
  if (def.type === 'weapon') parts.push(`Оружие: ${def.attack} атаки, ${def.durability} прочности`);
  for (const k of def.keywords || []) parts.push(KW_TEXT[k]);
  if (def.battlecry?.length) parts.push('Клич: ' + def.battlecry.map((e) => effectText(e)).join(', '));
  if (def.deathrattle?.length) parts.push('Хрип: ' + def.deathrattle.map((e) => effectText(e)).join(', '));
  if (def.aura) parts.push('Аура: ' + effectText(def.aura));
  if (def.spell?.length) parts.push(def.spell.map((e) => effectText(e)).join('; '));
  if (def.flavor) parts.push(def.flavor);
  return parts.join('\n');
}

export function esc(s) {
  return String(s).replace(/[&<>\"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
