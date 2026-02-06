import { Room, Client, Delayed } from "colyseus";
import { ArraySchema } from "@colyseus/schema";
import { UNOState, Player, Card } from "./schema/UNOState";
import { CardColor, CardType, GameStatus } from "../shared/types";

const BOT_NAMES = ["Skipinator", "Trollwild", "Drawtwo", "Plusfour", "ReverseMaster", "UnoBot", "CardShark", "WildOne", "ColorChanger", "Botley"];

export class UNORoom extends Room<UNOState> {
  maxClients = 6;
  playerIndexes: string[] = [];
  unoPenaltyTimeout: Delayed | null = null;
  // SECURITÉ : Stocker les timeouts des bots pour pouvoir les annuler si nécessaire (ex: bot retiré ou tour sauté)
  botTimeouts: Map<string, Delayed> = new Map();
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
        // Vérifier qu'il y a au moins 2 joueurs (humains ou bots)
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
          // Annulation de la pénalité si c'est le joueur ciblé
          if (this.state.pendingUnoPenaltyPlayerId === client.sessionId) {
            this.clearUnoPenalty();
            this.broadcast("notification", `${player.name} saved themselves!`);
          }
        }
      });

      this.onMessage("catchUno", (client: Client) => {
        const culpritId = this.state.pendingUnoPenaltyPlayerId;
        if (!culpritId || culpritId === client.sessionId) return;

        const culprit = this.state.players.get(culpritId);
        const catcher = this.state.players.get(client.sessionId);

        if (culprit && catcher) {
          this.broadcast("notification", `🚨 ${catcher.name} CAUGHT ${culprit.name}! (+2 cards)`);
          this.applyPenalty(culprit, 2);
          this.clearUnoPenalty();
        }
      });

      this.onMessage("restartGame", (client: Client) => {
        if (this.state.status !== GameStatus.FINISHED) return;
        const players = Array.from(this.state.players.values()) as Player[];
        const isHost = players.length > 0 && players[0].sessionId === client.sessionId;
        if (isHost) {
          console.log(`🔄 Host restarting game`);
          this.restartGame();
        }
      });

      // --- GESTION DES BOTS ---
      this.onMessage("addBot", (client: Client) => {
        const players = Array.from(this.state.players.values());
        const isHost = players.length > 0 && players[0].sessionId === client.sessionId;

        if (isHost && this.playerIndexes.length < 6) {
          const usedNames = players.map(p => p.name.replace("🤖 ", ""));
          const availableNames = BOT_NAMES.filter(name => !usedNames.includes(name));
          const botName = availableNames.length > 0
            ? availableNames[Math.floor(Math.random() * availableNames.length)]
            : `Bot-${Math.floor(Math.random() * 1000)}`;

          const botId = `bot_${Math.random().toString(36).substr(2, 9)}`;
          const bot = new Player();
          bot.id = botId;
          bot.sessionId = botId;
          bot.name = `${botName}`;
          bot.isReady = true;
          bot.isConnected = true;

          this.state.players.set(botId, bot);
          this.playerIndexes.push(botId);
          this.broadcast("notification", `${bot.name} a rejoint la partie !`);
        }
      });

      this.onMessage("removeBot", (client: Client, botId: string) => {
        const players = Array.from(this.state.players.values());
        const isHost = players.length > 0 && players[0].sessionId === client.sessionId;

        if (isHost && botId.startsWith("bot_")) {
          const bot = this.state.players.get(botId);
          if (bot) {
            // Si c'était le tour du bot, on passe au suivant AVANT de le supprimer pour éviter les problèmes de tour fantôme
            const wasBotTurn = this.state.currentTurnPlayerId === botId;

            // Nettoyer les timeouts du bot s'il réfléchissait
            if (this.botTimeouts.has(botId)) {
              this.botTimeouts.get(botId)?.clear();
              this.botTimeouts.delete(botId);
            }

            this.state.players.delete(botId);
            this.playerIndexes = this.playerIndexes.filter(id => id !== botId);
            this.broadcast("notification", `${bot.name} a été retiré.`);

            if (this.state.status === GameStatus.PLAYING && wasBotTurn) {
              // On force le tour au joueur suivant (l'index est recalculé automatiquement)
              this.advanceTurn(false);
            }
          }
        }
      });

    } catch (e) {
      console.error("❌ Error in onCreate:", e);
      this.disconnect();
    }
  }

  // Méthode appelée quand la room est détruite (plus de clients ou arrêt du serveur)
  onDispose() {
    console.log("🗑️ Disposing room...");
    if (this.unoPenaltyTimeout) this.unoPenaltyTimeout.clear();
    this.botTimeouts.forEach(t => t.clear());
    this.disconnectionTimeouts.forEach(t => t.clear());
  }

onJoin(client: Client, options: any) {
    try {
        console.log(`👤 Joining: ${client.sessionId} (Device: ${options.deviceId})`);

        // 1. Vérification standard
        let player = this.state.players.get(client.sessionId);
        if (player) { player.isConnected = true; return; }

        // 2. RECUPERATION SÉCURISÉE (Par Device ID)
        // On cherche un joueur déconnecté qui a le MÊME deviceId que celui qui se connecte
        const oldPlayerEntry = Array.from(this.state.players.entries())
            .find(([, p]) => p.deviceId === options.deviceId && !p.isConnected);

        if (oldPlayerEntry) {
            const [oldSessionId, existingPlayer] = oldPlayerEntry;
            console.log(`🔄 Recovery: ${existingPlayer.name} identified by DeviceID!`);

            // Nettoyage timeout suppression
            const timeout = this.disconnectionTimeouts.get(oldSessionId);
            if (timeout) { timeout.clear(); this.disconnectionTimeouts.delete(oldSessionId); }

            // Mise à jour session
            existingPlayer.isConnected = true;
            existingPlayer.sessionId = client.sessionId; 
            
            // Si le joueur a changé de pseudo entre temps, on met à jour le nom aussi
            if (options.name) existingPlayer.name = options.name;

            // Déplacement dans la map
            this.state.players.delete(oldSessionId);
            this.state.players.set(client.sessionId, existingPlayer);

            // Mise à jour index et tour
            const idx = this.playerIndexes.indexOf(oldSessionId);
            if (idx !== -1) { this.playerIndexes[idx] = client.sessionId; }

            if (this.state.currentTurnPlayerId === oldSessionId) this.state.currentTurnPlayerId = client.sessionId;
            if (this.state.pendingUnoPenaltyPlayerId === oldSessionId) this.state.pendingUnoPenaltyPlayerId = client.sessionId;
            
            this.broadcast("notification", `${existingPlayer.name} reconnected!`);
            client.send("state_refresh"); 
            return;
        }
        
        // 3. Nouveau Joueur
        console.log(`🆕 New player: ${options.name}`);
        player = new Player();
        player.id = client.sessionId;
        player.sessionId = client.sessionId;
        player.deviceId = options.deviceId || "unknown"; // ✅ Sauvegarde du Device ID
        player.name = options.name || "Guest";
        this.state.players.set(client.sessionId, player);
        this.playerIndexes.push(client.sessionId);

    } catch (e) { console.error("Join error:", e); }
  }

  async onLeave(client: Client, consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (this.state.status === GameStatus.LOBBY) {
      this.state.players.delete(client.sessionId);
      this.playerIndexes = this.playerIndexes.filter(id => id !== client.sessionId);
      return;
    }

    player.isConnected = false;
    this.broadcast("notification", `⏱️ ${player.name} disconnected.`);

    const timeout = this.clock.setTimeout(() => {
      // Logique de suppression définitive après 60s
      this.state.players.delete(client.sessionId);
      this.playerIndexes = this.playerIndexes.filter(id => id !== client.sessionId);

      const humansRemaining = Array.from(this.state.players.values()).filter(p => !p.sessionId.startsWith("bot_")).length;
      if (humansRemaining < 1) {
        this.state.status = GameStatus.LOBBY;
        this.broadcast("notification", "Game aborted.");
      }
      this.disconnectionTimeouts.delete(client.sessionId);
    }, 60000);

    this.disconnectionTimeouts.set(client.sessionId, timeout);
    try {
      if (consented) throw new Error("Consented");
      await this.allowReconnection(client, 60);
    } catch (e) { }
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

    // Gestion première carte
    let firstCard = this.state.drawPile.pop();
    while (!firstCard) { // Sécurité extrême (ne devrait pas arriver)
      this.createDeck();
      this.shuffleDeck();
      firstCard = this.state.drawPile.pop();
    }

    this.state.discardPile.push(firstCard);
    this.updateCurrentState(firstCard);
    if (firstCard.color === 'black') {
      this.state.currentColor = ['red', 'blue', 'green', 'yellow'][Math.floor(Math.random() * 4)];
    }

    this.state.currentTurnPlayerId = this.playerIndexes[0];
    this.state.winner = "";

    if (this.state.currentTurnPlayerId.startsWith("bot_")) {
      this.handleBotTurn(this.state.currentTurnPlayerId);
    }
  }

  restartGame() {
    this.broadcast("notification", "🎮 Starting a new game!");
    this.startGame();
  }

  handlePlayCard(client: Client, cardId: string, chooseColor?: CardColor) {
    const playerId = (client as any).sessionId || client.sessionId;

    // Vérifier que c'est bien le tour du joueur
    if (this.state.currentTurnPlayerId !== playerId) return;

    const player = this.state.players.get(playerId);
    if (!player) return;

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;
    const card = player.hand[cardIndex];

    if (!this.isValidMove(card)) {
      if (!playerId.startsWith("bot_")) client.send("error", "Invalid move");
      return;
    }

    // --- CLONAGE ET SUPPRESSION ---
    const discardCard = new Card();
    discardCard.id = card.id;
    discardCard.color = card.color;
    discardCard.type = card.type;
    discardCard.value = card.value;

    player.hand.splice(cardIndex, 1); // Suppression
    player.cardsRemaining = player.hand.length;
    this.state.discardPile.push(discardCard); // Ajout Défausse

    // Gestion UNO
    if (player.hand.length === 1 && !player.hasSaidUno) {
      this.state.pendingUnoPenaltyPlayerId = player.sessionId;
      this.resetUnoTimeout();
    } else if (this.state.pendingUnoPenaltyPlayerId === player.sessionId) {
      this.clearUnoPenalty();
    }

    // Victoire
    if (player.hand.length === 0) {
      this.state.winner = player.name;
      this.state.status = GameStatus.FINISHED;
      return; // Arrêt immédiat
    }

    // Reset flag UNO si +1 carte
    if (player.hand.length > 1) player.hasSaidUno = false;

    // Mise à jour couleur/type
    if (card.color === 'black') {
      if (chooseColor) this.state.currentColor = chooseColor;
    } else {
      this.state.currentColor = card.color;
    }
    this.state.currentType = card.type;
    this.state.currentValue = card.value;

    // Gestion Effets
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
    const playerId = (client as any).sessionId || client.sessionId;
    if (this.state.currentTurnPlayerId !== playerId) return;
    const player = this.state.players.get(playerId);
    if (!player) return;

    // Cas Draw Stack (+2/+4)
    if (this.state.drawStack > 0) {
      this.applyPenalty(player, this.state.drawStack);
      this.state.drawStack = 0;
      this.advanceTurn(false);
      return;
    }

    // Pioche normale
    const newCard = this.moveCardFromDrawToHand(player);
    player.hasSaidUno = false;

    // Si carte jouable piochée
    if (newCard && !this.isValidMove(newCard)) {
      this.advanceTurn(false); // Passe le tour
    } else if (newCard) {
      // Carte jouable !
      if (!playerId.startsWith("bot_")) {
        client.send("notification", "Playable card drawn!");
      } else {
        // ✅ SECURITÉ : Le Bot joue automatiquement la carte qu'il vient de piocher
        // On utilise un timeout court pour simuler la réaction
        const botPlayTimeout = this.clock.setTimeout(() => {
          if (!this.state.players.has(playerId)) return; // Vérif anti-zombie
          const color = newCard.color === 'black'
            ? (['red', 'blue', 'green', 'yellow'] as CardColor[])[Math.floor(Math.random() * 4)]
            : undefined;
          this.handlePlayCard({ sessionId: playerId } as any, newCard.id, color);
        }, 1000);
        this.botTimeouts.set(playerId, botPlayTimeout);
      }
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
    // Si le joueur actuel a été supprimé (index -1), on prend le modulo pour revenir à un index valide
    if (currentIndex === -1) currentIndex = 0;

    let nextIndex = currentIndex + (this.state.direction);
    if (skip) nextIndex += this.state.direction;

    const len = this.playerIndexes.length;
    if (len === 0) return;
    nextIndex = ((nextIndex % len) + len) % len;

    const nextPlayerId = this.playerIndexes[nextIndex];
    const nextPlayer = this.state.players.get(nextPlayerId);

    this.state.currentTurnPlayerId = nextPlayerId;

    // Tour du Bot ?
    if (nextPlayerId.startsWith("bot_")) {
      this.handleBotTurn(nextPlayerId);
    }

    // Vérification Stack pour le joueur suivant
    if (this.state.drawStack > 0 && nextPlayer) {
      const incomingIsDraw2 = (this.state.currentType === 'draw2');
      const hasCounter = nextPlayer.hand.some(c => c.type === 'draw2');

      if (incomingIsDraw2 && hasCounter) {
        this.broadcast("notification", `${nextPlayer.name} can stack!`);
      } else {
        // Pénalité automatique après 1s
        this.clock.setTimeout(() => {
          // Vérifier si le jeu est toujours en cours et si c'est toujours son tour
          if (this.state.currentTurnPlayerId === nextPlayerId) {
            this.handleAutoDrawPenalty(nextPlayer);
          }
        }, 1000);
      }
    }
  }

  handleAutoDrawPenalty(player: Player) {
    if (this.state.drawStack > 0) {
      this.applyPenalty(player, this.state.drawStack);
      this.state.drawStack = 0;
      player.hasSaidUno = false;
      this.advanceTurn(false);
    }
  }

  handleBotTurn(botId: string) {
    const bot = this.state.players.get(botId);
    if (!bot || this.state.status !== GameStatus.PLAYING) return;

    // Délai de réflexion
    const timeout = this.clock.setTimeout(() => {
      // Vérifier si le bot existe encore
      if (!this.state.players.has(botId)) return;

      const playableCard = bot.hand.find(card => this.isValidMove(card));

      if (playableCard) {
        let chosenColor: CardColor | undefined;
        if (playableCard.color === 'black') {
          chosenColor = (['red', 'blue', 'green', 'yellow'] as CardColor[])[Math.floor(Math.random() * 4)];
        }

        // Dire UNO ?
        if (bot.hand.length === 2 && Math.random() < 0.8) {
          bot.hasSaidUno = true;
          this.broadcast("notification", `${bot.name} crie UNO !`);
        }

        this.handlePlayCard({ sessionId: botId } as any, playableCard.id, chosenColor);
      } else {
        this.handleDrawCard({ sessionId: botId } as any);
      }
    }, 1500);

    this.botTimeouts.set(botId, timeout);
  }

  applyPenalty(player: Player, amount: number) {
    this.broadcast("notification", `${player.name} +${amount} cards!`);
    for (let i = 0; i < amount; i++) this.moveCardFromDrawToHand(player);
  }

  clearUnoPenalty() {
    this.state.pendingUnoPenaltyPlayerId = "";
    if (this.unoPenaltyTimeout) {
      this.unoPenaltyTimeout.clear();
      this.unoPenaltyTimeout = null;
    }
  }

  resetUnoTimeout() {
    if (this.unoPenaltyTimeout) this.unoPenaltyTimeout.clear();
    this.unoPenaltyTimeout = this.clock.setTimeout(() => {
      this.state.pendingUnoPenaltyPlayerId = "";
      this.unoPenaltyTimeout = null;
    }, 3000);
  }

  updateCurrentState(card: Card) {
    this.state.currentColor = card.color;
    this.state.currentType = card.type;
    this.state.currentValue = card.value;
  }

  moveCardFromDrawToHand(player: Player): Card | null {
    if (this.state.drawPile.length === 0) {
      if (this.state.discardPile.length <= 1) return null; // Plus de cartes du tout

      // Recyclage défausse
      const top = this.state.discardPile.pop();
      const rest = [...this.state.discardPile]; // Copie propre
      this.state.discardPile.clear();
      if (top) this.state.discardPile.push(top);

      // Mélange algo Fisher-Yates
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }

      // Reset des jokers
      rest.forEach(c => {
        // Clonage pour la pioche (nouvelles refs)
        const recycled = new Card();
        recycled.id = c.id;
        recycled.type = c.type;
        recycled.value = c.value;
        recycled.color = (c.type === 'wild' || c.type === 'wild4') ? 'black' : c.color;
        this.state.drawPile.push(recycled);
      });

      this.broadcast("notification", "♻️ Deck reshuffled!");
    }

    const card = this.state.drawPile.pop();
    if (card) {
      player.hand.push(card);
      player.cardsRemaining = player.hand.length;
      return card;
    }
    return null;
  }

  createDeck() {
    this.state.drawPile.clear();
    const colors: CardColor[] = ['red', 'blue', 'green', 'yellow'];
    colors.forEach(color => {
      this.addCard(color, 'number', 0);
      for (let i = 1; i <= 9; i++) {
        this.addCard(color, 'number', i);
        this.addCard(color, 'number', i);
      }
      ['skip', 'reverse', 'draw2'].forEach(type => {
        this.addCard(color, type as CardType);
        this.addCard(color, type as CardType);
      });
    });
    for (let i = 0; i < 4; i++) {
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