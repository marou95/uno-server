import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

export class Card extends Schema {
  @type("string") id: string = "";
  @type("string") color: string = "";
  @type("string") type: string = "";
  @type("number") value: number = -1;
}

export class Player extends Schema {
  @type("string") id: string = "";
  @type("string") sessionId: string = "";
  @type("string") name: string = "";
  @type([Card]) hand = new ArraySchema<Card>();
  @type("boolean") isReady: boolean = false;
  @type("number") cardsRemaining: number = 0;
  @type("boolean") hasSaidUno: boolean = false;
  @type("boolean") isConnected: boolean = true;
}

export class UNOState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Card]) drawPile = new ArraySchema<Card>();
  @type([Card]) discardPile = new ArraySchema<Card>();
  
  @type("string") currentTurnPlayerId: string = "";
  @type("number") direction: number = 1;
  @type("string") currentColor: string = "";
  @type("string") currentType: string = "";
  @type("number") currentValue: number = -1;
  @type("number") drawStack: number = 0;
  @type("string") status: string = "lobby"; 
  @type("string") winner: string = "";
  @type("string") pendingUnoPenaltyPlayerId: string = "";

  // INDISPENSABLE POUR LE LOBBY :
  @type("string") roomCode: string = ""; 
}