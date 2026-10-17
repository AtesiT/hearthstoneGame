// sanitize.js — построение снапшота ViewState для КОНКРЕТНОГО игрока.
//
// Правила приватности (античит, см. 00-ANALYSIS.md §3.4):
//  - своя рука: карты (с опциями разыгрывания и валидными целями);
//  - чужая рука: ТОЛЬКО handCount;
//  - колоды: только deckCount (порядок — секрет);
//  - rngSeed и RNG-объект: никогда;
//  - внутренние поля (_auraHp и т.п.) не сериализуются.
import { getCard } from '../game/cards.js';
import { computePlayOptions, computeAttackOptions, getHeroPowerState } from '../game/engine.js';

export function sanitizeGame(state, forSeat, roomCode) {
  const self = state.players[forSeat];
  const opp = state.players[1 - forSeat];

  const minionView = (m) => ({
    uid: m.uid,
    cardId: m.cardId,
    seat: m.seat,
    atk: m.atk,
    health: m.health,
    maxHealth: m.maxHealth,
    baseAtk: m.baseAtk,
    baseHealth: m.baseHealth,
    canAttack: m.canAttack,
    frozen: m.frozen,
    ds: m.ds,
    justPlayed: m.justPlayed,
    keywords: getCard(m.cardId).keywords || [],
  });

  const heroView = (p, mine=false) => ({
    name: p.hero.name,
    hp: p.hero.hp,
    maxHp: p.hero.maxHp,
    weapon: p.hero.weapon
      ? { cardId: p.hero.weapon.cardId, attack: p.hero.weapon.attack, durability: p.hero.weapon.durability }
      : null,
    powerUsed: mine ? p.hero.powerUsed : false,
  });

  return {
    v: 1,
    roomCode,
    status: state.status,
    turn: state.turn,
    turnCount: state.turnCount,
    winner: state.winner,
    winReason: state.winReason,
    coinOwner: state.coinOwner,
    self: {
      seat: self.seat,
      nick: self.nick,
      hero: heroView(self, true),
      mana: self.mana,
      maxMana: self.maxMana,
      deckCount: self.deck.length,
      hand: computePlayOptions(state, forSeat),
      board: self.board.map(minionView),
      attacks: computeAttackOptions(state, forSeat),
      power: getHeroPowerState(state, forSeat),
    },
    opp: {
      seat: opp.seat,
      nick: opp.nick,
      hero: heroView(opp, false),
      deckCount: opp.deck.length,
      handCount: opp.hand.length,
      board: opp.board.map(minionView),
    },
    seq: state.seq,
  };
}
