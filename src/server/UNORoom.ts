import { Room, Client, Delayed } from "colyseus";
import { ArraySchema } from "@colyseus/schema";
import { UNOState, Player, Card } from "./schema/UNOState";
import { CardColor, CardType, GameStatus } from "../shared/types";

export class UNORoom extends Room<UNOState> {
  maxClients = 6;
  playerIndexes: string[] = [];
  unoPenaltyTimeout: Delayed | null = null;
  disconnectionTimeouts: Map<string, Delayed> = new Map();

  async onCreate(options: any) {
    try {
        console.log(`🏗️ Creating room... ID: ${this.roomId}`);
        
        this.setState(new UNOState());
        this.playerIndexes = []; 
        
        const code = this.generateRoomCode();
        this.state.roomCode = code;
        
        await this.setMetadata({ roomCode: code });
        
        console.log(`✅ Room ready: ${this.roomId} | Code: ${code}`);

        this.onMessage("setInfo", (client: Client, data: any) => {
          const player = this.state.players.get(client.sessionId);
          if (player) player.name = data.name || "Guest";
        });

        this.onMessage("toggleReady", (client: Client) => {
          if (this.state.status !== GameStatus.LOBBY) return;
          const player = this.state.players.get(client.sessionId);
          if (player) player.isReady = !player.isReady;
        });

        this.onMessage("startGame", (client: Client) => {
          if (this.state.status !== GameStatus.LOBBY) return;
          const readyCount = Array.from(this.state.players.values()).filter((p: Player) => p.isReady).length;
          if (readyCount >= 2 && readyCount === this.state.players.size) {
            this.startGame();
          }
        });

        this.onMessage("playCard", (client: Client, data: { cardId: string, chooseColor?: CardColor }) => {
          this.handlePlayCard(client, data.cardId, data.chooseColor);
        });

        this.onMessage("drawCard", (client: Client) => {
          this.handleDrawCard(client);
        });

        this.onMessage("sayUno", (client: Client) => {
          const player = this.state.players.get(client.sessionId);
          if (player) {
             if (player.hand.length <= 2) {
                player.hasSaidUno = true;
                this.broadcast("notification", `${player.name} shouted UNO!`);
             }

             if (this.state.pendingUnoPenaltyPlayerId === client.sessionId) {
                this.state.pendingUnoPenaltyPlayerId = "";
                if (this.unoPenaltyTimeout) {
                    this.unoPenaltyTimeout.clear();
                    this.unoPenaltyTimeout = null;
                }
                this.broadcast("notification", `${player.name} saved themselves!`);
             }
          }
        });

        this.onMessage("catchUno", (client: Client) => {
            const culpritId = this.state.pendingUnoPenaltyPlayerId;
            if (!culpritId) return;
            
            if (culpritId === client.sessionId) return;

            const culprit = this.state.players.get(culpritId);
            const catcher = this.state.players.get(client.sessionId);

            if (culprit && catcher) {
                this.broadcast("notification", `🚨 ${catcher.name} CAUGHT ${culprit.name}! (+2 cards)`);
                
                this.moveCardFromDrawToHand(culprit);
                this.moveCardFromDrawToHand(culprit);
                culprit.hasSaidUno = false;

                this.state.pendingUnoPenaltyPlayerId = "";
                if (this.unoPenaltyTimeout) {
                    this.unoPenaltyTimeout.clear();
                    this.unoPenaltyTimeout = null;
                }
            }
        });

        this.onMessage("restartGame", (client: Client) => {
          if (this.state.status !== GameStatus.FINISHED) return;
          
          const players = Array.from(this.state.players.values()) as Player[];
          const isHost = players.length > 0 && players[0].sessionId === client.sessionId;
          
          if (!isHost) {
            client.send("notification", "Only the host can restart the game!");
            return;
          }

          console.log(`🔄 Host ${client.sessionId} restarting game in room ${this.roomId}`);
          this.restartGame();
        });

    } catch (e) {
        console.error("❌ Error in onCreate:", e);
        this.disconnect();
    }
  }

  onJoin(client: Client, options: any) {
    try {
        console.log(`👤 Joining: ${client.sessionId}`);
        
        // ✅ NOUVEAU: Vérifier si c'est une reconnexion
        let player = this.state.players.get(client.sessionId);
        
        if (player && !player.isConnected) {
            // C'est une reconnexion !
            console.log(`🔄 Player ${client.sessionId} reconnected!`);
            player.isConnected = true;
            player.name = options.name || player.name;
            
            // Annuler le timeout de déconnexion
            const timeout = this.disconnectionTimeouts.get(client.sessionId);
            if (timeout) {
                timeout.clear();
                this.disconnectionTimeouts.delete(client.sessionId);
            }
            
            this.broadcast("notification", `${player.name} reconnected!`);
            return;
        }
        
        // Première connexion
        if (!player) {
            player = new Player();
            player.id = client.sessionId;
            player.sessionId = client.sessionId;
            player.name = options.name || "Guest";
            this.state.players.set(client.sessionId, player);
            this.playerIndexes.push(client.sessionId);
        }
    } catch (e) {
        console.error("Join error:", e);
    }
  }

  async onLeave(client: Client, consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (this.state.status === GameStatus.LOBBY) {
      // En LOBBY, suppression immédiate
      this.state.players.delete(client.sessionId);
      this.playerIndexes = this.playerIndexes.filter(id => id !== client.sessionId);
      return;
    }

    // En PLAYING ou FINISHED, on laisse 60s pour se reconnecter
    player.isConnected = false;
    this.broadcast("notification", `⏱️ ${player.name} disconnected. Waiting for reconnection... (60s)`);

    console.log(`💔 Player ${client.sessionId} disconnected from game`);

    // Mettre en place un timeout de 60s
    const timeout = this.clock.setTimeout(() => {
      const connectedCount = Array.from(this.state.players.values()).filter(p => p.isConnected).length;
      
      if (connectedCount < 2) {
        console.log(`⏰ Timeout: Not enough players, aborting game`);
        this.broadcast("notification", "⏸️ Game aborted (not enough players)");
        this.state.status = GameStatus.LOBBY;
        this.state.winner = "";
        
        // Supprimer le joueur
        this.state.players.delete(client.sessionId);
        this.playerIndexes = this.playerIndexes.filter(id => id !== client.sessionId);
      } else {
        console.log(`⏰ Timeout: Player ${client.sessionId} permanently removed`);
        this.state.players.delete(client.sessionId);
        this.playerIndexes = this.playerIndexes.filter(id => id !== client.sessionId);
      }
      
      this.disconnectionTimeouts.delete(client.sessionId);
    }, 60000); // 60 secondes

    this.disconnectionTimeouts.set(client.sessionId, timeout);

    try {
      if (consented) throw new Error("Consented leave");
      await this.allowReconnection(client, 60); // Permettre la reconnexion pendant 60s
    } catch (e) {
      // Si allowReconnection échoue, on l'a déjà supprimé du timeout
    }
  }

  startGame() {
    this.state.status = GameStatus.PLAYING;
    this.createDeck();
    this.shuffleDeck();
    
    this.playerIndexes.forEach(sessionId => {
      const player = this.state.players.get(sessionId);
      if (player) {
        player.hand.clear();
        for (let i = 0; i < 7; i++) {
          this.moveCardFromDrawToHand(player);
        }
        player.cardsRemaining = 7;
        player.hasSaidUno = false;
      }
    });

    const firstCard = this.state.drawPile.pop();
    if (firstCard) {
      this.state.discardPile.push(firstCard);
      this.updateCurrentState(firstCard);
      if (firstCard.color === 'black') {
        this.state.currentColor = ['red','blue','green','yellow'][Math.floor(Math.random()*4)];
      }
    }

    this.state.currentTurnPlayerId = this.playerIndexes[0];
    this.state.winner = "";
  }

  restartGame() {
    console.log(`🔄 Restarting game in room ${this.roomId}`);
    this.broadcast("notification", "🎮 Starting a new game!");
    this.startGame();
  }

  handlePlayCard(client: Client, cardId: string, chooseColor?: CardColor) {
    if (this.state.currentTurnPlayerId !== client.sessionId) return;
    
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;
    const card = player.hand[cardIndex];

    if (!this.isValidMove(card)) {
      client.send("error", "Invalid move");
      return;
    }

    player.hand.splice(cardIndex, 1);
    this.state.discardPile.push(card);
    player.cardsRemaining = player.hand.length;
    
    if (player.hand.length === 1 && !player.hasSaidUno) {
        this.state.pendingUnoPenaltyPlayerId = player.sessionId;
        
        if (this.unoPenaltyTimeout) this.unoPenaltyTimeout.clear();
        this.unoPenaltyTimeout = this.clock.setTimeout(() => {
            this.state.pendingUnoPenaltyPlayerId = "";
            this.unoPenaltyTimeout = null;
        }, 3000);
    } else {
        if (this.state.pendingUnoPenaltyPlayerId === player.sessionId) {
            this.state.pendingUnoPenaltyPlayerId = "";
            if (this.unoPenaltyTimeout) this.unoPenaltyTimeout.clear();
        }
    }
    
    if (player.hand.length === 0) {
        this.state.winner = player.name;
        this.state.status = GameStatus.FINISHED;
        return;
    }

    if (player.hand.length > 1) {
        player.hasSaidUno = false;
    }

    if (card.color === 'black') {
      if (chooseColor) this.state.currentColor = chooseColor;
    } else {
      this.state.currentColor = card.color;
    }
    this.state.currentType = card.type;
    this.state.currentValue = card.value;

    let skipNext = false;
    switch (card.type) {
      case 'reverse':
        if (this.playerIndexes.length === 2) skipNext = true;
        else this.state.direction *= -1;
        break;
      case 'skip': skipNext = true; break;
      case 'draw2': this.state.drawStack += 2; break;
      case 'wild4': this.state.drawStack += 4; break;
    }

    this.advanceTurn(skipNext);
  }

  handleDrawCard(client: Client) {
    if (this.state.currentTurnPlayerId !== client.sessionId) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (this.state.drawStack > 0) {
       for(let i=0; i<this.state.drawStack; i++) this.moveCardFromDrawToHand(player);
       this.broadcast("notification", `${player.name} drew ${this.state.drawStack} cards!`);
       this.state.drawStack = 0;
       player.hasSaidUno = false; 
       this.advanceTurn(false);
       return;
    }

    const newCard = this.moveCardFromDrawToHand(player);
    player.hasSaidUno = false; 
    
    if (newCard && !this.isValidMove(newCard)) {
       this.advanceTurn(false);
    } else {
       client.send("notification", "Playable card drawn!");
    }
  }

  isValidMove(card: Card): boolean {
    if (card.color === 'black') return true;
    if (card.color === this.state.currentColor) return true;
    if (card.type === this.state.currentType) {
        if (card.type === 'number') return card.value === this.state.currentValue;
        return true;
    }
    return false;
  }

  advanceTurn(skip: boolean) {
     let currentIndex = this.playerIndexes.indexOf(this.state.currentTurnPlayerId);
     let nextIndex = currentIndex + (this.state.direction);
     
     if (skip) nextIndex += this.state.direction;

     if (nextIndex >= this.playerIndexes.length) nextIndex = nextIndex % this.playerIndexes.length;
     if (nextIndex < 0) nextIndex = this.playerIndexes.length + (nextIndex % this.playerIndexes.length);

     const nextPlayerId = this.playerIndexes[nextIndex];
     const nextPlayer = this.state.players.get(nextPlayerId);

     this.state.currentTurnPlayerId = nextPlayerId;

     if (this.state.drawStack > 0 && nextPlayer) {
         const incomingIsDraw2 = (this.state.currentType === 'draw2');
         const hasCounter = nextPlayer.hand.some(c => c.type === 'draw2');

         if (incomingIsDraw2 && hasCounter) {
             this.broadcast("notification", `${nextPlayer.name} can stack!`);
         } else {
             this.clock.setTimeout(() => {
                this.handleAutoDrawPenalty(nextPlayer);
             }, 1000);
         }
     }
  }

  handleAutoDrawPenalty(player: Player) {
      if (this.state.drawStack > 0) {
          const count = this.state.drawStack;
          for(let i=0; i<count; i++) this.moveCardFromDrawToHand(player);
          this.broadcast("notification", `${player.name} forced to draw ${count}!`);
          this.state.drawStack = 0;
          player.hasSaidUno = false;
          this.advanceTurn(false);
      }
  }

  updateCurrentState(card: Card) {
     this.state.currentColor = card.color;
     this.state.currentType = card.type;
     this.state.currentValue = card.value;
  }

  moveCardFromDrawToHand(player: Player): Card | null {
     if (this.state.drawPile.length === 0) {
        if (this.state.discardPile.length <= 1) return null;
        const top = this.state.discardPile.pop();
        const rest = [...this.state.discardPile];
        this.state.discardPile.clear();
        if(top) this.state.discardPile.push(top);
        
        for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        rest.forEach(c => {
             if(c.type === 'wild' || c.type === 'wild4') c.color = 'black';
             this.state.drawPile.push(c);
        });
     }

     const card = this.state.drawPile.pop();
     if (card) {
        player.hand.push(card);
        player.cardsRemaining++;
        return card;
     }
     return null;
  }

  createDeck() {
     this.state.drawPile.clear();
     const colors: CardColor[] = ['red', 'blue', 'green', 'yellow'];
     
     colors.forEach(color => {
        this.addCard(color, 'number', 0);
        for(let i=1; i<=9; i++) {
           this.addCard(color, 'number', i);
           this.addCard(color, 'number', i);
        }
        ['skip', 'reverse', 'draw2'].forEach(type => {
            this.addCard(color, type as CardType);
            this.addCard(color, type as CardType);
        });
     });

     for(let i=0; i<4; i++) {
        this.addCard('black', 'wild');
        this.addCard('black', 'wild4');
     }
  }

  addCard(color: CardColor, type: CardType, value: number = -1) {
     const card = new Card();
     card.id = Math.random().toString(36).substr(2, 9);
     card.color = color;
     card.type = type;
     card.value = value;
     this.state.drawPile.push(card);
  }

  shuffleDeck() {
      const cards = Array.from(this.state.drawPile);
      for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }
      this.state.drawPile.clear();
      cards.forEach(c => this.state.drawPile.push(c));
  }

  generateRoomCode() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    return code;
  }
}