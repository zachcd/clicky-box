import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { GameRoom } from "./rooms/GameRoom";

const PORT = Number(process.env.PORT) || 2567;

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});
gameServer.define("game", GameRoom);

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Clicky Box server running" });
});

httpServer.listen(PORT, () => {
  console.log(`\n🎮  Clicky Box  —  ws://localhost:${PORT}\n`);
});
