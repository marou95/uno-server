import express from "express";
import http from "http";
import { Server, matchMaker } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { UNORoom } from "./UNORoom";
import cors from "cors";

const port = Number(process.env.PORT) || 2567;
const app = express();

console.log('🚀 Starting UNO Server...');
console.log('📍 Port:', port);
console.log('🌍 Environment:', process.env.NODE_ENV || 'development');

app.set('trust proxy', 1);

// Standard CORS config - robust for Railway/Vercel
app.use(cors({
  origin: true, // Dynamically set Access-Control-Allow-Origin to the request origin
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'X-Requested-With', 'Accept']
}));

// Cast to any to avoid TypeScript overload error with Express types
app.use(express.json() as any);

app.get("/", (req, res) => {
  res.send("UNO Server Running! 🚀");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// --- API DE RECHERCHE DE SALLE (CORRECTIF FIABILITÉ) ---
app.get("/lookup/:code", async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    // On utilise le singleton 'matchMaker' importé directement de 'colyseus'
    // au lieu de 'gameServer.matchMaker' qui n'existe plus dans les types récents.
    const rooms = await matchMaker.query({ name: "uno" });
    
    // On cherche la salle qui correspond au code dans ses métadonnées
    const match = rooms.find((room) => room.metadata && room.metadata.roomCode === code);
    
    if (match) {
      // On renvoie l'ID unique de la salle pour une connexion directe via joinById
      res.json({ roomId: match.roomId });
    } else {
      res.status(404).json({ error: "Room not found" });
    }
  } catch (e) {
    console.error("Lookup error:", e);
    res.status(500).json({ error: "Server error" });
  }
});
// -------------------------------------------------------

const server = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: server,
    // Disable ping interval to prevent premature disconnects on proxies (Railway/Vercel)
    pingInterval: 0, 
    verifyClient: (info, next) => {
      // Allow all connections
      next(true);
    }
  }),
});

// Enable filterBy logic for strict Room Code matching
// Note: On garde filterBy et enableRealtimeListing pour que les métadonnées existent
gameServer.define("uno", UNORoom)
  .filterBy(['roomCode'])
  .enableRealtimeListing();

gameServer.listen(port);
console.log(`✅ Server ready on port ${port}`);

(process as any).on('unhandledRejection', (reason: any) => {
  console.error('❌ Unhandled Rejection:', reason);
});

(process as any).on('uncaughtException', (error: any) => {
  console.error('❌ Uncaught Exception:', error);
});