// gen-cards-doc.js — генерация docs/02-CARDS.md из CARD_DB (источник истины).
// Запуск: npm run gen-cards-doc (документ переписывается).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_DB, DECK_LIST } from '../server/game/cards.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPE_RU = { minion: 'Существо', spell: 'Заклинание', weapon: 'Оружие' };
const RAR_RU = { common: 'Обычная', rare: 'Редкая', epic: 'Эпическая', legendary: 'Легендарная' };
const KW_RU = { taunt: 'Провокация', charge: 'Рывок', divine_shield: 'Божественный щит', poisonous: 'Яд' };
const TARGET_RU = { // датив — для глаголов (нанести/лечить/оглушить)
  target: 'цели', target_ally: 'дружественному существу', enemy_hero: 'вражескому герою',
  friendly_hero: 'вашему герою', all_enemy_minions: 'всем вражеским существам', all_minions: 'всем существам',
  other_friendly: 'другим дружественным существам', random_enemy_minion: 'случайному вражескому существу',
};
const PREFIX = { battlecry: 'Боевой клич: ', deathrattle: 'Смертный хрип: ', aura: 'Аура: ', spell: '' };

function effectText(eff) {
  switch (eff.kind) {
    case 'damage': return `нанести ${eff.amount} урона ${TARGET_RU[eff.target] ?? eff.target}`;
    case 'damage_all': return `нанести ${eff.amount} урона ${TARGET_RU[eff.target] ?? 'всем существам'}`;
    case 'buff': {
      const b = [`+${eff.atk || 0} к атаке`, `+${eff.health || 0} к здоровью`].filter((s) => s[1] !== '0').join(', ');
      return eff.target === 'other_friendly' ? `все другие дружественные существа получают ${b}` : `дружественное существо получает ${b}`;
    }
    case 'heal': return `восстановить ${eff.amount} HP ${TARGET_RU[eff.target] ?? ''}`.trim();
    case 'kill_minion': return `уничтожить существо с атакой ≤ ${eff.attackMax}`;
    case 'destroy_all': return 'уничтожить все вражеские существа';
    case 'draw': return `вытянуть ${eff.amount ?? 1} карту`;
    case 'mana_gain': return `+${eff.amount} маны в этот ход`;
    case 'stun': return `оглушить ${TARGET_RU[eff.target] ?? 'цель'} на ход`;
    case 'summon': { const m = eff.minionCard; return `призвать «${m.name}» ${m.atk}/${m.health}`; }
    default: return '';
  }
}
function fullText(card) {
  const lines = [];
  const push = (effects, source) => (effects ?? []).forEach((e) => {
    const t = effectText(e);
    if (t) lines.push(`${PREFIX[source] ?? ''}${t[0].toUpperCase()}${t.slice(1)}`);
  });
  push(card.spell, 'spell');
  push(card.battlecry, 'battlecry');
  push(card.deathrattle, 'deathrattle');
  if (card.aura) push([card.aura], 'aura');
  return lines.length ? lines.join('. ') + '.' : '—';
}

const order = (a, b) => (a.type === b.type ? a.cost - b.cost || a.name.localeCompare(b.name, 'ru') : a.type.localeCompare(b.type));
const all = Object.values(CARD_DB).sort(order);
const byType = { minion: [], spell: [], weapon: [] };
for (const c of all) if (c.id !== 'skeleton') byType[c.type]?.push(c); // скелет — в мета-разделе

const L = [];
L.push('# 02. КАРТЫ — полное описание и баланс');
L.push('');
L.push('> Генерируется из `server/game/cards.js` (источник истины): `npm run gen-cards-doc`.');
L.push('> 30 уникальных карт + «Монета зари» (мета) + «Скелет» (призываемый токен).');
L.push('');
const curve = new Map();
for (const id of DECK_LIST) { const c = CARD_DB[id]; curve.set(c.cost, (curve.get(c.cost) ?? 0) + 1); }
L.push('## Манакривая колоды (30 карт)');
L.push('');
L.push('| Мана | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
L.push('| карт | ' + Array.from({ length: 11 }, (_, i) => curve.get(i) ?? 0).join(' | ') + ' |');
L.push('');
L.push('Профиль: здоровое среднее (10 карт 0–2, 12 карт 3–5, 8 карт 6+), задел на лейт-гейм (3 карты ≥8).');
L.push('');
L.push('**Компенсация первого хода (HS-модель, Этап 6):** Монета зари достаётся **второму**');
L.push('игроку, **первый игрок не добирает карту на первом ходу**. Замер (1000 партий');
L.push('случайными ботами): первый ход 56.6%, симметрия сидов 49.9/50.1, 100% hero_kill.');
L.push('');

for (const [type, title] of [['minion', 'Существа (15)'], ['spell', 'Заклинания (10)'], ['weapon', 'Оружие (5)']]) {
  L.push(`## ${title}`);
  L.push('');
  const cols = type === 'minion' ? '| Карта | Мана | Статы | Ключевые слова | Эффекты | Редкость |'
    : type === 'weapon' ? '| Карта | Мана | Атака | Прочность | Ключевые слова | Редкость |'
    : '| Карта | Мана | Эффекты | Редкость |';
  L.push(cols);
  L.push('|---|---|---|---|---|---|');
  for (const c of byType[type]) {
    const kw = (c.keywords ?? []).map((k) => KW_RU[k]).join(', ') || '—';
    if (type === 'minion') L.push(`| **${c.name}** \`(${c.id})\` | ${c.cost} | ${c.attack}/${c.health} | ${kw} | ${fullText(c)} | ${RAR_RU[c.rarity]} |`);
    else if (type === 'weapon') L.push(`| **${c.name}** \`(${c.id})\` | ${c.cost} | ${c.attack} | ${c.durability} | ${kw} | ${RAR_RU[c.rarity]} |`);
    else L.push(`| **${c.name}** \`(${c.id})\` | ${c.cost} | ${fullText(c)} | ${RAR_RU[c.rarity]} |`);
  }
  L.push('');
}

L.push('## Мета-карты');
L.push('');
L.push('| Карта | Описание |');
L.push('|---|---|');
const coin = CARD_DB.dawn_coin;
L.push(`| **${coin.name}** \`(dawn_coin)\` | 0 маны, +1 мана в этот ход. Даётся **второму игроку** (компенсация первого хода). |`);
const sk = CARD_DB.skeleton;
L.push(`| **${sk.name}** \`(skeleton)\` | 2/1 токен: призывается Смертным хрипом «Костяного колосса». |`);
L.push('');
L.push('## Баланс-заметки');
L.push('');
L.push('- **Агрессия:** «Виверна-искра» + «Стальной кинжал» + «Искровая стрела» — раннее давление;');
L.push('  ответ — «Пиксельный крысолов»/«Каменный страж» (таунт-стена), «Костяная стрела».');
L.push('- **Контроль:** таунт-стена + «Пироклазм»/«Гнев титана»; ответ — «Дракон зари» (Рывок, 9 маны),');
L.push('  «Костяной колосс» (таунт-милль + хрип).');
L.push('- **Значение:** «Вождь племени» + ауры («Дух рощи», «Страж сада») — среднесрочно;');
L.push('  ответ — «Гнев титана» (чистит поле).');
L.push('- **Циклов нет:** draw-источники — «Гоблин-ковач» (1) и «Гримуар» (2), оба тратят ману.');
L.push('- **Taunt-миллей 4**, ни один без 7+ HP — стен не избыточно.');
L.push('- **Яд — 1 карта** («Лунный охотник»): ниша «убить 8/8 за 4 маны», цена — хрупкий 4/3 и не бьёт в ход игры.');
L.push('- **Оружие — 5 ступеней** (1→8 маны, прочность 2–3), без «бесплатных» атак.');
L.push('');
L.push('## Редкости');
L.push('');
const rarCount = new Map();
for (const c of all) if (c.rarity !== 'common' || true) rarCount.set(c.rarity, (rarCount.get(c.rarity) ?? 0) + 1);
L.push(`Обычные: ${rarCount.get('common') ?? 0} · Редкие: ${rarCount.get('rare') ?? 0} · Эпические: ${rarCount.get('epic') ?? 0} · Легендарные: ${rarCount.get('legendary') ?? 0} (всего ${all.length}, включая монету и скелет).`);
L.push('');

const out = path.join(ROOT, 'docs/02-CARDS.md');
fs.writeFileSync(out, L.join('\n'));
console.log(`Сгенерировано: ${path.relative(ROOT, out)} (${L.length} строк, ${all.length} карт)`);
