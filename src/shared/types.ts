export type CardColor = 'red' | 'blue' | 'green' | 'yellow' | 'black';
export type CardType = 'number' | 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4';

export interface ICard {
  id: string;
  color: CardColor;
  type: CardType;
  value?: number; // 0-9 for number cards
}

export interface IChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
}

export enum GameStatus {
  LOBBY = 'lobby',
  PLAYING = 'playing',
  FINISHED = 'finished'
}
