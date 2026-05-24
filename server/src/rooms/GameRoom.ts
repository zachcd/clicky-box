import { Room, Client } from "colyseus";
import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_TURN_MS         = 20_000;               // starting turn length (slower ramp-up)
const PHASE1_MIN_MS           = INITIAL_TURN_MS / 2;  // 10 000 ms — 2× speed cap for Phase 1
const PHASE2_FACTOR           = Math.pow(0.5, 1 / 3); // half-life of 3 turns ≈ 0.7937
const REALTIME_MS             = 200;                   // floor — "real-time" threshold

const LOBBY_COUNTDOWN_SECONDS = 5;

const DEFAULT_PLAYER_COLORS = [
  "#9B59B6", // purple
  "#2C3E50", // dark navy
  "#4A235A", // dark purple
  "#000000", // black
  "#7F8C8D", // grey
  "#795548", // brown
  "#6D0000", // dark maroon
  "#FFFFFF", // white
];

const VALID_BORDER_STYLES = ["solid", "double", "rounded"];
const MIN_PLAYERS             = 2;
const CELLS_PER_PLAYER        = 40;

// ─── Schema ───────────────────────────────────────────────────────────────────

export class Cell extends Schema {
  @type("uint8")  colorIndex: number  = 0;  // 0–3 — fixed grid colour
  @type("string") ownerId:    string  = "";  // "" = unclaimed
}

export class Player extends Schema {
  @type("string")  sessionId:      string  = "";
  @type("string")  name:           string  = "";
  @type("uint8")   playerIndex:    number  = 0;
  @type("uint16")  score:          number  = 0;
  @type("boolean") ready:          boolean = false;
  @type("boolean") hasSubmitted:   boolean = false;
  @type("int8")    submittedColor: number  = -1;
  @type("boolean") connected:      boolean = true;
  @type("string")  playerColor:    string  = "";   // hex — "" falls back to default on client
  @type("string")  borderStyle:    string  = "solid";
}

export class GameRoomState extends Schema {
  @type("string")        phase:                string            = "lobby";
  @type({ map: Player }) players:              MapSchema<Player> = new MapSchema<Player>();
  @type([Cell])          cells:                ArraySchema<Cell> = new ArraySchema<Cell>();
  @type("uint8")         gridWidth:            number            = 0;
  @type("uint8")         gridHeight:           number            = 0;
  @type("uint16")        currentTurn:          number            = 0;
  @type("float32")       turnTimeLeft:         number            = 1;    // 0–1 normalised
  @type("uint32")        turnDurationMs:       number            = INITIAL_TURN_MS;
  @type("boolean")       isRealtime:           boolean           = false; // true when ≤ REALTIME_MS
  @type("string")        winnerId:             string            = "";
  @type("uint8")         lobbyCountdown:       number            = 0;
  @type("boolean")       lobbyCountdownActive: boolean           = false;
}

// ─── Room ─────────────────────────────────────────────────────────────────────

export class GameRoom extends Room<GameRoomState> {
  maxClients = 8;

  private submissionOrder:      Array<{ playerId: string; colorIndex: number }> = [];
  private submittedThisTurn:    Set<string>                                     = new Set();
  private turnEnded:            boolean                                         = false;
  private turnStartTime:        number                                          = 0;
  private allOccupied:          boolean                                         = false; // Phase 2 flag
  private turnIntervalRef:      ReturnType<typeof setInterval> | null           = null;
  private countdownIntervalRef: ReturnType<typeof setInterval> | null           = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onCreate(_options: unknown) {
    this.setState(new GameRoomState());

    this.onMessage("setAppearance", (client: Client, data: { color?: string; borderStyle?: string }) => {
      if (this.state.phase !== "lobby") return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (typeof data.color === "string" && /^#[0-9a-fA-F]{6}$/.test(data.color)) {
        player.playerColor = data.color;
      }
      if (typeof data.borderStyle === "string" && VALID_BORDER_STYLES.includes(data.borderStyle)) {
        player.borderStyle = data.borderStyle;
      }
    });

    this.onMessage("setName", (client: Client, data: { name?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (player && this.state.phase === "lobby") {
        player.name = sanitiseName(data?.name, player.playerIndex);
      }
    });

    this.onMessage("ready", (client: Client) => {
      const player = this.state.players.get(client.sessionId);
      if (player && this.state.phase === "lobby") {
        player.ready = !player.ready;
        this.checkLobbyReady();
      }
    });

    this.onMessage("selectColor", (client: Client, data: { colorIndex: number }) => {
      if (this.state.phase !== "playing") return;
      const player = this.state.players.get(client.sessionId);
      if (!player?.connected) return;
      if (this.submittedThisTurn.has(client.sessionId)) return;

      const ci = data?.colorIndex;
      if (typeof ci !== "number" || ci < 0 || ci > 3) return;

      this.submittedThisTurn.add(client.sessionId);
      this.submissionOrder.push({ playerId: client.sessionId, colorIndex: ci });
      player.hasSubmitted   = true;
      player.submittedColor = ci;

      this.checkAllSubmitted();
    });

    this.onMessage("playAgain", (client: Client) => {
      if (this.state.phase !== "gameover") return;
      const player = this.state.players.get(client.sessionId);
      if (player) player.ready = true;
    });
  }

  onJoin(client: Client, options: { name?: string } = {}) {
    if (this.state.phase !== "lobby") {
      throw new Error("Game already in progress — please wait for the next lobby.");
    }
    const player       = new Player();
    player.sessionId   = client.sessionId;
    player.playerIndex = this.nextPlayerIndex();
    player.name        = sanitiseName(options?.name, player.playerIndex);
    player.connected   = true;
    player.playerColor = DEFAULT_PLAYER_COLORS[player.playerIndex % DEFAULT_PLAYER_COLORS.length];
    player.borderStyle = "solid";
    this.state.players.set(client.sessionId, player);
    console.log(`[join]  ${player.name}  (${this.state.players.size} in lobby)`);
  }

  onLeave(client: Client, _consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (this.state.phase === "lobby") {
      this.state.players.delete(client.sessionId);
      this.checkLobbyReady();
    } else if (this.state.phase === "playing") {
      player.connected = false;
      this.checkAllSubmitted();
    } else {
      this.state.players.delete(client.sessionId);
    }
    console.log(`[leave] ${player.name}`);
  }

  onDispose() { this.clearTimers(); }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private nextPlayerIndex(): number {
    const used = new Set([...this.state.players.values()].map(p => p.playerIndex));
    let i = 0; while (used.has(i)) i++; return i;
  }

  private activePlayers(): Player[] {
    return [...this.state.players.values()].filter(p => p.connected);
  }

  // ── Lobby ─────────────────────────────────────────────────────────────────

  private checkLobbyReady() {
    const players  = [...this.state.players.values()];
    const allReady = players.length >= MIN_PLAYERS && players.every(p => p.ready);
    if (allReady && !this.state.lobbyCountdownActive) {
      this.startLobbyCountdown();
    } else if (!allReady && this.state.lobbyCountdownActive) {
      this.cancelLobbyCountdown();
    }
  }

  private startLobbyCountdown() {
    this.state.lobbyCountdownActive = true;
    this.state.lobbyCountdown       = LOBBY_COUNTDOWN_SECONDS;
    this.countdownIntervalRef = setInterval(() => {
      this.state.lobbyCountdown--;
      if (this.state.lobbyCountdown <= 0) {
        clearInterval(this.countdownIntervalRef!);
        this.countdownIntervalRef = null;
        this.beginGame();
      }
    }, 1_000);
  }

  private cancelLobbyCountdown() {
    if (this.countdownIntervalRef) {
      clearInterval(this.countdownIntervalRef);
      this.countdownIntervalRef = null;
    }
    this.state.lobbyCountdownActive = false;
    this.state.lobbyCountdown       = 0;
  }

  // ── Game start ────────────────────────────────────────────────────────────

  private beginGame() {
    const players = [...this.state.players.values()];
    const n       = players.length;

    const side = Math.ceil(Math.sqrt(CELLS_PER_PLAYER * n));
    const W = side, H = side;
    this.state.gridWidth  = W;
    this.state.gridHeight = H;

    this.state.cells.splice(0, this.state.cells.length);
    for (let i = 0; i < W * H; i++) {
      const c = new Cell();
      c.colorIndex = Math.floor(Math.random() * 4);
      this.state.cells.push(c);
    }

    const starts = this.startPositions(n, W, H);
    players.forEach((p, i) => {
      this.state.cells[starts[i]].ownerId = p.sessionId;
      p.score = 1; p.ready = false; p.hasSubmitted = false; p.submittedColor = -1;
    });

    this.state.phase               = "playing";
    this.state.currentTurn         = 0;
    this.state.winnerId            = "";
    this.state.turnDurationMs      = INITIAL_TURN_MS;
    this.state.isRealtime          = false;
    this.state.lobbyCountdownActive = false;
    this.state.lobbyCountdown      = 0;
    this.allOccupied               = false;

    this.lock();
    console.log(`[game]  started — ${n} players, ${W}×${H} grid (${W * H} cells)`);
    this.beginTurn();
  }

  private startPositions(n: number, W: number, H: number): number[] {
    const m = (v: number) => Math.floor(v / 2);
    const pts: [number, number][] = [
      [0,   0  ], [W-1, H-1], [W-1, 0  ], [0,   H-1],
      [m(W),0  ], [m(W),H-1], [0,   m(H)], [W-1, m(H)],
    ];
    return pts.slice(0, n).map(([col, row]) => row * W + col);
  }

  // ── Turn management ───────────────────────────────────────────────────────

  private beginTurn() {
    this.turnEnded         = false;
    this.submissionOrder   = [];
    this.submittedThisTurn = new Set();
    for (const p of this.state.players.values()) {
      p.hasSubmitted = false; p.submittedColor = -1;
    }

    this.state.turnTimeLeft = 1;
    this.turnStartTime      = Date.now();
    const durationMs        = this.state.turnDurationMs;

    this.turnIntervalRef = setInterval(() => {
      const elapsed = Date.now() - this.turnStartTime;
      this.state.turnTimeLeft = Math.max(0, 1 - elapsed / durationMs);
      if (this.state.turnTimeLeft <= 0) this.endTurn();
    }, 50); // 20 Hz — snappy at high speeds
  }

  private checkAllSubmitted() {
    const active = this.activePlayers();
    if (active.length > 0 && active.every(p => p.hasSubmitted)) this.endTurn();
  }

  private endTurn() {
    if (this.turnEnded) return;
    this.turnEnded = true;

    if (this.turnIntervalRef) {
      clearInterval(this.turnIntervalRef);
      this.turnIntervalRef = null;
    }
    this.state.turnTimeLeft = 0;

    // ── Process submissions in arrival order ───────────────────────────────
    //
    // Captures include cells owned by other players (they are stolen).
    // The first submission to the server wins any contested group.
    for (const { playerId, colorIndex } of this.submissionOrder) {
      for (const idx of this.captureArea(playerId, colorIndex)) {
        this.state.cells[idx].ownerId = playerId;
      }
    }

    // Recount scores
    const counts = new Map<string, number>();
    for (let i = 0; i < this.state.cells.length; i++) {
      const id = this.state.cells[i].ownerId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    this.state.players.forEach((p: Player, id: string) => {
      p.score = counts.get(id) ?? 0;
    });

    this.state.currentTurn++;

    // ── Phase 2 detection ─────────────────────────────────────────────────
    let hasUnowned = false;
    for (let i = 0; i < this.state.cells.length; i++) {
      if (!this.state.cells[i].ownerId) { hasUnowned = true; break; }
    }
    if (!hasUnowned && !this.allOccupied) {
      this.allOccupied = true;
      console.log("[game]  all cells occupied — Phase 2 (half-life speed-up) begins");
    }

    // Update turn duration for next turn
    this.updateTurnSpeed();

    // ── Win condition: one player owns every single cell ──────────────────
    const total = this.state.cells.length;
    let winnerId = "";
    this.state.players.forEach((p: Player, id: string) => {
      if (p.score === total) winnerId = id;
    });

    if (winnerId) {
      this.endGame(winnerId);
    } else {
      this.beginTurn();
    }
  }

  // ── Speed progression ─────────────────────────────────────────────────────
  //
  // Phase 1 (unowned cells remain):
  //   Each turn gets 10 % faster; floor at half the initial duration (7 500 ms).
  //
  // Phase 2 (all cells occupied, game not yet over):
  //   Half-life of 3 turns (×0.794 per turn); floor at REALTIME_MS (200 ms).
  //   At 200 ms the `isRealtime` flag is set so the client can show the
  //   blinking timer.

  private updateTurnSpeed() {
    if (!this.allOccupied) {
      // Phase 1
      this.state.turnDurationMs = Math.max(
        PHASE1_MIN_MS,
        Math.round(this.state.turnDurationMs * 0.95), // 5 % faster per turn (gentler ramp)
      );
    } else {
      // Phase 2
      this.state.turnDurationMs = Math.max(
        REALTIME_MS,
        Math.round(this.state.turnDurationMs * PHASE2_FACTOR),
      );
      if (this.state.turnDurationMs <= REALTIME_MS) {
        this.state.isRealtime = true;
      }
    }
    console.log(
      `[turn]  #${this.state.currentTurn}  next: ${this.state.turnDurationMs} ms` +
      (this.state.isRealtime ? "  [REALTIME]" : ""),
    );
  }

  // ── Capture logic ─────────────────────────────────────────────────────────
  //
  // BFS flood-fill outward from the edge of `playerId`'s territory through
  // every connected cell of `chosenColor`.  Cells already owned by OTHER
  // players are captured too — ownership is never a barrier to the fill.

  private captureArea(playerId: string, chosenColor: number): number[] {
    const W     = this.state.gridWidth;
    const H     = this.state.gridHeight;
    const cells = this.state.cells;

    const ownedSet = new Set<number>();
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].ownerId === playerId) ownedSet.add(i);
    }

    const toCapture = new Set<number>();
    const queue: number[] = [];

    for (const idx of ownedSet) {
      for (const nb of this.neighbours(idx, W, H)) {
        if (!ownedSet.has(nb) && cells[nb].colorIndex === chosenColor && !toCapture.has(nb)) {
          toCapture.add(nb); queue.push(nb);
        }
      }
    }

    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (const nb of this.neighbours(cur, W, H)) {
        if (!ownedSet.has(nb) && cells[nb].colorIndex === chosenColor && !toCapture.has(nb)) {
          toCapture.add(nb); queue.push(nb);
        }
      }
    }

    return [...toCapture];
  }

  private neighbours(idx: number, W: number, H: number): number[] {
    const row = Math.floor(idx / W), col = idx % W;
    const nb: number[] = [];
    if (row > 0)     nb.push((row - 1) * W + col);
    if (row < H - 1) nb.push((row + 1) * W + col);
    if (col > 0)     nb.push(row * W + (col - 1));
    if (col < W - 1) nb.push(row * W + (col + 1));
    return nb;
  }

  // ── Game over ─────────────────────────────────────────────────────────────

  private endGame(winnerId: string) {
    this.clearTimers();
    this.state.phase        = "gameover";
    this.state.turnTimeLeft = 0;
    this.state.winnerId     = winnerId;
    const w = this.state.players.get(winnerId);
    console.log(`[game]  over — winner: ${w?.name ?? "?"} (${w?.score ?? 0} cells)`);
    setTimeout(() => this.resetToLobby(), 10_000);
  }

  private resetToLobby() {
    const toRemove: string[] = [];
    this.state.players.forEach((_p: Player, id: string) => {
      if (!this.state.players.get(id)?.connected) toRemove.push(id);
    });
    for (const id of toRemove) this.state.players.delete(id);

    this.state.players.forEach((p: Player) => {
      p.score = 0; p.ready = false; p.hasSubmitted = false; p.submittedColor = -1;
    });

    this.state.cells.splice(0, this.state.cells.length);
    this.state.gridWidth           = 0;
    this.state.gridHeight          = 0;
    this.state.currentTurn         = 0;
    this.state.turnTimeLeft        = 1;
    this.state.turnDurationMs      = INITIAL_TURN_MS;
    this.state.isRealtime          = false;
    this.state.winnerId            = "";
    this.state.lobbyCountdownActive = false;
    this.state.lobbyCountdown      = 0;
    this.state.phase               = "lobby";
    this.allOccupied               = false;

    this.unlock();
    console.log("[game]  reset to lobby");
  }

  private clearTimers() {
    if (this.turnIntervalRef)      { clearInterval(this.turnIntervalRef);      this.turnIntervalRef = null; }
    if (this.countdownIntervalRef) { clearInterval(this.countdownIntervalRef); this.countdownIntervalRef = null; }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sanitiseName(raw: string | undefined, index: number): string {
  return (raw ?? "").trim().slice(0, 20) || `Player ${index + 1}`;
}
