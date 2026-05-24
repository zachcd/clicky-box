import { Room, Client } from "colyseus";
import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_TURN_MS         = 20_000;               // starting turn length (slower ramp-up)
const PHASE1_MIN_MS           = INITIAL_TURN_MS / 2;  // 10 000 ms — 2× speed cap for Phase 1
const PHASE2_SWEET_SPOT_MS    = 2_000;  // decay rate eases below this threshold
const PHASE2_FAST_FACTOR      = 0.90;   // above sweet spot: −10 %/turn → ~15 turns to 2 s
const PHASE2_SLOW_FACTOR      = 0.95;   // below sweet spot: −5 %/turn  → ~45 turns to 200 ms
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
  @type("uint32")  captures:       number  = 0;
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

    const { W, H, cellColors, starts } = this.buildValidMap(n);
    this.state.gridWidth  = W;
    this.state.gridHeight = H;

    this.state.cells.splice(0, this.state.cells.length);
    for (const colorIndex of cellColors) {
      const c = new Cell();
      c.colorIndex = colorIndex;
      this.state.cells.push(c);
    }

    players.forEach((p, i) => {
      this.state.cells[starts[i]].ownerId = p.sessionId;
      p.score = 1; p.captures = 0; p.ready = false; p.hasSubmitted = false; p.submittedColor = -1;
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

  // ── Map generation ─────────────────────────────────────────────────────────
  //
  // Strategy:
  //   1. Compute a baseline board side-length from CELLS_PER_PLAYER.
  //   2. Find starting positions that maximise the minimum pairwise Euclidean
  //      distance (greedy "farthest-point" heuristic, 30 random seeds).
  //   3. Generate a random colour grid and simulate greedy flood-fill expansion
  //      (attacker always picks the colour that captures the most new cells)
  //      from every starting position for SAFETY_MOVES turns.
  //   4. If any player's simulated territory reaches another player's start,
  //      retry with a fresh colour grid (up to 40 attempts).
  //   5. If all attempts fail at this board size, grow the board by 1 and repeat
  //      (up to +15 beyond baseline).
  //
  // Result: the returned map is guaranteed that no player could capture another
  // player's starting cell in SAFETY_MOVES moves even with perfect greedy play.

  private buildValidMap(n: number): {
    W: number; H: number; cellColors: number[]; starts: number[];
  } {
    const SAFETY_MOVES   = 4;
    const BASE_SIDE      = Math.ceil(Math.sqrt(CELLS_PER_PLAYER * n));
    const MAX_EXTRA      = 15;   // max additional rows/cols beyond baseline
    const COLOR_ATTEMPTS = 40;   // colour-grid retries per board size

    for (let extra = 0; extra <= MAX_EXTRA; extra++) {
      const side = BASE_SIDE + extra;
      const W = side, H = side;
      const starts = this.spreadStartPositions(n, W, H);

      for (let attempt = 0; attempt < COLOR_ATTEMPTS; attempt++) {
        const colors = new Uint8Array(W * H);
        for (let i = 0; i < colors.length; i++) colors[i] = Math.floor(Math.random() * 4);

        if (this.checkSafetyGuarantee(starts, colors, W, H, SAFETY_MOVES)) {
          console.log(
            `[map]   ${W}×${H} (size +${extra}), ` +
            `safety passed on colour attempt ${attempt + 1}`,
          );
          return { W, H, cellColors: Array.from(colors), starts };
        }
      }
    }

    // Absolute fallback — largest board, safety not formally guaranteed
    const side = BASE_SIDE + MAX_EXTRA;
    const colors = new Uint8Array(side * side);
    for (let i = 0; i < colors.length; i++) colors[i] = Math.floor(Math.random() * 4);
    const starts = this.spreadStartPositions(n, side, side);
    console.warn(`[map]   fallback ${side}×${side} — safety not fully verified`);
    return { W: side, H: side, cellColors: Array.from(colors), starts };
  }

  /** Place n starts to maximise the minimum pairwise Euclidean distance.
   *  Runs the greedy "farthest-point" heuristic from 30 random seeds and
   *  returns the trial whose minimum pairwise distance is greatest. */
  private spreadStartPositions(n: number, W: number, H: number): number[] {
    const posCount = W * H;

    const euclidean = (a: number, b: number): number => {
      const ax = a % W, ay = Math.floor(a / W);
      const bx = b % W, by = Math.floor(b / W);
      return Math.hypot(ax - bx, ay - by);
    };

    const minPairDist = (pts: number[]): number => {
      let best = Infinity;
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) {
          const d = euclidean(pts[i], pts[j]);
          if (d < best) best = d;
        }
      return best;
    };

    const NUM_SEEDS = 30;
    let bestStarts: number[] = [];
    let bestMin    = -1;

    for (let seed = 0; seed < NUM_SEEDS; seed++) {
      const trial: number[]  = [];
      const inTrial = new Set<number>();

      // Random initial position
      const first = Math.floor(Math.random() * posCount);
      trial.push(first);
      inTrial.add(first);

      // Greedy: each new point maximises its minimum distance to existing starts
      while (trial.length < n) {
        let farthestPos  = 0;
        let farthestDist = -1;

        for (let pos = 0; pos < posCount; pos++) {
          if (inTrial.has(pos)) continue;
          let minD = Infinity;
          for (const s of trial) {
            const d = euclidean(pos, s);
            if (d < minD) minD = d;
          }
          if (minD > farthestDist) { farthestDist = minD; farthestPos = pos; }
        }

        trial.push(farthestPos);
        inTrial.add(farthestPos);
      }

      const md = minPairDist(trial);
      if (md > bestMin) { bestMin = md; bestStarts = [...trial]; }
    }

    return bestStarts;
  }

  /** Return false if greedy flood-fill from any start can reach another
   *  player's starting cell within `moves` turns. */
  private checkSafetyGuarantee(
    starts: number[], colors: Uint8Array,
    W: number, H: number, moves: number,
  ): boolean {
    for (let i = 0; i < starts.length; i++) {
      const territory = this.simulateGreedyExpansion(starts[i], colors, W, H, moves);
      for (let j = 0; j < starts.length; j++) {
        if (i !== j && territory.has(starts[j])) return false;
      }
    }
    return true;
  }

  /** Expand `startIdx` greedily for `moves` turns, picking the colour that
   *  yields the most new captured cells each turn.  Returns the full territory. */
  private simulateGreedyExpansion(
    startIdx: number, colors: Uint8Array,
    W: number, H: number, moves: number,
  ): Set<number> {
    const territory = new Set<number>([startIdx]);

    for (let move = 0; move < moves; move++) {
      let bestCapture: number[] = [];

      for (let color = 0; color < 4; color++) {
        const captured = this.simulateFloodCapture(territory, colors, W, H, color);
        if (captured.length > bestCapture.length) bestCapture = captured;
      }

      if (bestCapture.length === 0) break; // fully surrounded by own territory
      for (const idx of bestCapture) territory.add(idx);
    }

    return territory;
  }

  /** Flood-fill on a raw colour array without mutating any state.
   *  Identical logic to captureArea but operates on a plain Uint8Array. */
  private simulateFloodCapture(
    territory: Set<number>, colors: Uint8Array,
    W: number, H: number, targetColor: number,
  ): number[] {
    const toCapture = new Set<number>();
    const queue: number[] = [];

    for (const idx of territory) {
      for (const nb of this.neighbours(idx, W, H)) {
        if (!territory.has(nb) && colors[nb] === targetColor && !toCapture.has(nb)) {
          toCapture.add(nb); queue.push(nb);
        }
      }
    }

    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (const nb of this.neighbours(cur, W, H)) {
        if (!territory.has(nb) && colors[nb] === targetColor && !toCapture.has(nb)) {
          toCapture.add(nb); queue.push(nb);
        }
      }
    }

    return [...toCapture];
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
      const captured = this.captureArea(playerId, colorIndex);
      for (const idx of captured) {
        this.state.cells[idx].ownerId = playerId;
      }
      const player = this.state.players.get(playerId);
      if (player) player.captures += captured.length;
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
  //   −5 %/turn; floor at PHASE1_MIN_MS (10 000 ms).
  //
  // Phase 2 (all cells occupied, game not yet over):
  //   Two-stage decay centred on PHASE2_SWEET_SPOT_MS (2 000 ms):
  //     • Above 2 s : −10 %/turn (PHASE2_FAST_FACTOR = 0.90)
  //                   ~15 turns to descend from 10 000 ms → 2 000 ms
  //     • Below 2 s : −5 %/turn  (PHASE2_SLOW_FACTOR = 0.95)
  //                   ~45 turns to descend from  2 000 ms → 200 ms
  //   Total Phase 2 runway: ~60 turns before hitting the 200 ms real-time floor.
  //   At 200 ms the `isRealtime` flag is set so the client shows the
  //   blinking timer.

  private updateTurnSpeed() {
    if (!this.allOccupied) {
      // Phase 1
      this.state.turnDurationMs = Math.max(
        PHASE1_MIN_MS,
        Math.round(this.state.turnDurationMs * 0.95), // 5 % faster per turn
      );
    } else {
      // Phase 2 — ease the decay rate once turns drop below the sweet spot
      const factor = this.state.turnDurationMs > PHASE2_SWEET_SPOT_MS
        ? PHASE2_FAST_FACTOR
        : PHASE2_SLOW_FACTOR;
      this.state.turnDurationMs = Math.max(
        REALTIME_MS,
        Math.round(this.state.turnDurationMs * factor),
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
      p.score = 0; p.captures = 0; p.ready = false; p.hasSubmitted = false; p.submittedColor = -1;
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
