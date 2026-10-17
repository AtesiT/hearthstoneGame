// cards.js — карточный DB: ровно 30 уникальных карт + мета-карта «Монета зари»
// (+ «Скелет» — призываемое существо Костяного колосса).
//
// DB — ПУБЛИЧНЫЕ данные (клиенту нужен набор карт для рендера и коллекции);
// секреты — содержимое/порядок колод и рука — НИКОГДА не сериализуются в снапшот.
//
// Структура — см. docs/00-ANALYSIS.md §4.1.
// targeting: 'none' | 'enemy_minion' | 'enemy_minion_or_hero' | 'friendly_minion'
//   (правило таунта для урональных спеллов учитывается в getTargetsForMode)
// effects: массив EffectSpec (spell/battlecry/deathrattle), aura — один EffectSpec.

export const CARD_DB = {
  // ─────────── МЕТА: Монета зари (вне 30 карт) ───────────
  dawn_coin: {
    id: 'dawn_coin', name: 'Монета зари', type: 'spell', cost: 0, rarity: 'common',
    flavor: 'Сияние первого утра — за него не нужно платить.',
    spell: [{ kind: 'mana_gain', amount: 1 }],
    targeting: 'none',
  },

  // ─────────── СУЩЕСТВА (15) ───────────
  rat_catcher: {
    id: 'rat_catcher', name: 'Пиксельный крысолов', type: 'minion', cost: 1, rarity: 'common',
    attack: 1, health: 2, keywords: ['taunt'],
    flavor: 'Хвост 8 бит в длину, достоинство — бесконечное.',
    targeting: 'none',
  },
  spark_wyvern: {
    id: 'spark_wyvern', name: 'Виверна-искра', type: 'minion', cost: 1, rarity: 'common',
    attack: 2, health: 1, keywords: ['charge'],
    flavor: 'Маленькая. Быстрая. Жалко, что хрупкая.',
    targeting: 'none',
  },
  goblin_forge: {
    id: 'goblin_forge', name: 'Гоблин-ковач', type: 'minion', cost: 2, rarity: 'common',
    attack: 2, health: 2,
    battlecry: [{ kind: 'draw', amount: 1 }],
    flavor: '«Один молот — для тебя. Второй — я потерял, ищи сам».',
    targeting: 'none',
  },
  grove_spirit: {
    id: 'grove_spirit', name: 'Дух рощи', type: 'minion', cost: 2, rarity: 'rare',
    attack: 1, health: 1,
    aura: { kind: 'buff', atk: 1, health: 1, target: 'other_friendly' },
    flavor: 'Лес не считает. Лес делится.',
    targeting: 'none',
  },
  flame_fairy: {
    id: 'flame_fairy', name: 'Пламенная фея', type: 'minion', cost: 2, rarity: 'rare',
    attack: 1, health: 1,
    deathrattle: [{ kind: 'damage', amount: 2, target: 'enemy_hero' }],
    flavor: 'Она горит. Ты — тоже.',
    targeting: 'none',
  },
  silver_knight: {
    id: 'silver_knight', name: 'Серебряный рыцарь', type: 'minion', cost: 3, rarity: 'rare',
    attack: 2, health: 2, keywords: ['divine_shield', 'charge'],
    flavor: 'Доспехи отполированы до сигнала.',
    targeting: 'none',
  },
  stone_watchman: {
    id: 'stone_watchman', name: 'Каменный страж', type: 'minion', cost: 3, rarity: 'common',
    attack: 3, health: 3, keywords: ['taunt'],
    flavor: 'Не моргает. Не спит. Не тает.',
    targeting: 'none',
  },
  moon_stalker: {
    id: 'moon_stalker', name: 'Лунный охотник', type: 'minion', cost: 4, rarity: 'rare',
    attack: 4, health: 3, keywords: ['poisonous'],
    flavor: 'Один укус — и луна теряет спутника.',
    targeting: 'none',
  },
  ember_wolf: {
    id: 'ember_wolf', name: 'Угольный волк', type: 'minion', cost: 4, rarity: 'common',
    attack: 3, health: 4,
    battlecry: [{ kind: 'damage', amount: 1, target: 'random_enemy_minion' }],
    flavor: 'Смолится вместе с первой жертвой.',
    targeting: 'none',
  },
  frost_elemental: {
    id: 'frost_elemental', name: 'Ледяной элементаль', type: 'minion', cost: 5, rarity: 'rare',
    attack: 3, health: 6,
    battlecry: [{ kind: 'stun', target: 'target' }],
    targeting: 'enemy_minion',
    flavor: 'Дыхание — минус десять градусов.',
  },
  tribe_chief: {
    id: 'tribe_chief', name: 'Вождь племени', type: 'minion', cost: 5, rarity: 'epic',
    attack: 4, health: 4,
    battlecry: [{ kind: 'buff', atk: 1, health: 1, target: 'other_friendly' }],
    flavor: 'Тотем за спиной — не тотем. Просто очень высокий.',
    targeting: 'none',
  },
  garden_guardian: {
    id: 'garden_guardian', name: 'Хранитель сада', type: 'minion', cost: 6, rarity: 'epic',
    attack: 5, health: 5,
    aura: { kind: 'buff', atk: 1, target: 'other_friendly' },
    flavor: 'Всё, что растёт рядом, растёт сильнее.',
    targeting: 'none',
  },
  bone_colossus: {
    id: 'bone_colossus', name: 'Костяной колосс', type: 'minion', cost: 7, rarity: 'epic',
    attack: 6, health: 7, keywords: ['taunt'],
    deathrattle: [{ kind: 'summon', minionCard: { name: 'Скелет', atk: 2, health: 1, cardId: 'skeleton' } }],
    flavor: 'Когда падает — не всё кончается.',
    targeting: 'none',
  },
  ashen_golem: {
    id: 'ashen_golem', name: 'Пепельный голем', type: 'minion', cost: 8, rarity: 'legendary',
    attack: 8, health: 8, keywords: ['taunt'],
    flavor: 'Слеплен из пепла тысяч сгоревших стратегий.',
    targeting: 'none',
  },
  dawn_dragon: {
    id: 'dawn_dragon', name: 'Дракон рассвета', type: 'minion', cost: 9, rarity: 'legendary',
    attack: 7, health: 7, keywords: ['charge'],
    flavor: 'Его тень видна за день до прилёта.',
    targeting: 'none',
  },

  // ─────────── ЗАКЛИНАНИЯ (10) ───────────
  spark_bolt: {
    id: 'spark_bolt', name: 'Искра молний', type: 'spell', cost: 1, rarity: 'common',
    flavor: 'Маленький разряд. Большие неприятности.',
    spell: [{ kind: 'damage', amount: 1, target: 'target' }],
    targeting: 'enemy_minion_or_hero',
  },
  grimoire: {
    id: 'grimoire', name: 'Гримуар', type: 'spell', cost: 1, rarity: 'rare',
    flavor: 'Глава 12. «Как ещё раз прочитать главу 12».',
    spell: [{ kind: 'draw', amount: 2 }],
    targeting: 'none',
  },
  frost_lance: {
    id: 'frost_lance', name: 'Ледяное копьё', type: 'spell', cost: 2, rarity: 'rare',
    flavor: 'Цель не просто ранена. Цель — заморожена.',
    spell: [{ kind: 'damage', amount: 2, target: 'target' }, { kind: 'stun', target: 'target' }],
    targeting: 'enemy_minion_or_hero',
  },
  blessing_of_steel: {
    id: 'blessing_of_steel', name: 'Благословение стали', type: 'spell', cost: 2, rarity: 'common',
    flavor: 'Кузнец благословляет. Кузнец всегда благословляет.',
    spell: [{ kind: 'buff', atk: 3, health: 3, target: 'target_ally' }],
    targeting: 'friendly_minion',
  },
  bone_arrow: {
    id: 'bone_arrow', name: 'Костяная стрела', type: 'spell', cost: 3, rarity: 'rare',
    flavor: 'Тонкая, точная, с характером.',
    spell: [{ kind: 'kill_minion', attackMax: 2, target: 'target' }],
    targeting: 'enemy_minion',
  },
  green_ray: {
    id: 'green_ray', name: 'Зелёный луч', type: 'spell', cost: 3, rarity: 'common',
    flavor: 'Фотосинтез, но для героев.',
    spell: [{ kind: 'heal', amount: 6, target: 'friendly_hero' }],
    targeting: 'none',
  },
  fireball: {
    id: 'fireball', name: 'Огненный шар', type: 'spell', cost: 4, rarity: 'common',
    flavor: 'Классика жанра. Шесть урона и ни одного вопроса.',
    spell: [{ kind: 'damage', amount: 6, target: 'target' }],
    targeting: 'enemy_minion_or_hero',
  },
  chain_lightning: {
    id: 'chain_lightning', name: 'Цепная молния', type: 'spell', cost: 5, rarity: 'rare',
    flavor: 'Разряд на всех. Справедливо и мокро.',
    spell: [{ kind: 'damage_all', amount: 2, target: 'all_enemy_minions' }],
    targeting: 'none',
  },
  pyroclasm: {
    id: 'pyroclasm', name: 'Пироклазм', type: 'spell', cost: 7, rarity: 'epic',
    flavor: 'Пепел и пепел, и ещё немного пепла.',
    spell: [{ kind: 'destroy_all', target: 'all_enemy_minions' }],
    targeting: 'none',
  },
  titan_wrath: {
    id: 'titan_wrath', name: 'Гнев титана', type: 'spell', cost: 8, rarity: 'epic',
    flavor: 'Титан сердится. Поле — на обе стороны.',
    spell: [{ kind: 'damage_all', amount: 5, target: 'all_minions' }],
    targeting: 'none',
  },

  // ─────────── ОРУЖИЕ (5) ───────────
  steel_dagger: {
    id: 'steel_dagger', name: 'Стальной кинжал', type: 'weapon', cost: 1, rarity: 'common',
    attack: 2, durability: 2,
    flavor: 'Маленький, но злой.',
    targeting: 'none',
  },
  forge_mace: {
    id: 'forge_mace', name: 'Молот кузнеца', type: 'weapon', cost: 3, rarity: 'common',
    attack: 2, durability: 3,
    flavor: 'Тот самый молот. Второй он так и не нашёл.',
    targeting: 'none',
  },
  valkyrie_axe: {
    id: 'valkyrie_axe', name: 'Секира валькирии', type: 'weapon', cost: 5, rarity: 'rare',
    attack: 4, durability: 3,
    flavor: 'Выбор тех, кто не любит два хода.',
    targeting: 'none',
  },
  great_sword: {
    id: 'great_sword', name: 'Двуручник', type: 'weapon', cost: 6, rarity: 'epic',
    attack: 5, durability: 2,
    flavor: 'Один взмах — одна проблема решена.',
    targeting: 'none',
  },
  dragonfang: {
    id: 'dragonfang', name: 'Драконий клык', type: 'weapon', cost: 8, rarity: 'legendary',
    attack: 7, durability: 3,
    flavor: 'Вырван лично. Дракон не в восторге.',
    targeting: 'none',
  },

  // ─────────── ПРИЗЫВ (не входит в колоду) ───────────
  skeleton: {
    id: 'skeleton', name: 'Скелет', type: 'minion', cost: 0, rarity: 'common',
    attack: 2, health: 1,
    flavor: 'Собранный из пепла Костяного колосса. Опоздал на парад.',
    targeting: 'none',
  },
};

/** 30 карт базовой колоды (одна из каждой). */
export const DECK_LIST = Object.keys(CARD_DB).filter(
  (id) => id !== 'dawn_coin' && id !== 'skeleton'
);

export const DECK_SIZE = DECK_LIST.length; // 30

export function getCard(cardId) {
  const c = CARD_DB[cardId];
  if (!c) throw new Error(`Неизвестная карта: ${cardId}`);
  return c;
}
