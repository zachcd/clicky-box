import { Room, Client } from "colyseus";
import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_TURN_MS         = 20_000;               // starting turn length (slower ramp-up)
const PHASE1_MIN_MS           = 3_000;   // Phase 1 floor — reached in ~14 turns from 20 s
const PHASE2_SWEET_SPOT_MS    = 2_000;  // decay rate eases below this threshold
const REALTIME_MS             = 400;                   // floor — "real-time" threshold

// Player-paced acceleration bounds.
// The decay factor each turn is interpolated between FAST (all submit instantly)
// and SLOW (slowest submitter used the full turn) via an outlier-amplifying
// curve.  Neutral midpoint (slowest fraction ≈ 0.5) reproduces the original
// fixed rates so ordinary play feels unchanged.
const PHASE1_FACTOR_FAST      = 0.77;   // Phase 1: everyone submits instantly  (−23 %/turn)
const PHASE1_FACTOR_SLOW      = 0.97;   // Phase 1: slowest waits till last moment (−3 %/turn)
// neutral ≈ (0.77+0.97)/2 = 0.87, matching former hard-coded 0.88

const PHASE2_FAST_FACTOR_MIN  = 0.82;   // Phase 2 above sweet-spot: fastest decay (−18 %/turn)
const PHASE2_FAST_FACTOR_MAX  = 0.97;   // Phase 2 above sweet-spot: slowest decay  (−3 %/turn)
// neutral ≈ 0.895, matching former PHASE2_FAST_FACTOR = 0.90

const PHASE2_SLOW_FACTOR_MIN  = 0.90;   // Phase 2 below sweet-spot: fastest decay (−10 %/turn)
const PHASE2_SLOW_FACTOR_MAX  = 0.99;   // Phase 2 below sweet-spot: slowest decay  (−1 %/turn)
// neutral ≈ 0.945, matching former PHASE2_SLOW_FACTOR = 0.95

const LOBBY_COUNTDOWN_SECONDS = 5;
const VOTE_KICK_GRACE_MS      = 30_000; // 30 s after joining before a player can be vote-kicked

// Early turn completion is phase-based — see selectColor handler.

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
  @type("boolean") kickEligible:  boolean = false;  // grace period has elapsed
  @type("uint8")   voteKickCount: number  = 0;       // votes currently cast to kick this player
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
  @type("string")        lobbyId:              string            = "global";
}

// ─── Room ─────────────────────────────────────────────────────────────────────

export class GameRoom extends Room<GameRoomState> {
  maxClients = 8;

  private submissionOrder:      Array<{ playerId: string; colorIndex: number; receivedAt: number }> = [];
  private submittedThisTurn:    Set<string>                                     = new Set();
  private turnEnded:            boolean                                         = false;
  private turnStartTime:        number                                          = 0;
  private allOccupied:          boolean                                         = false; // Phase 2 flag
  private scoreHistory:         Map<string, number[]>                          = new Map();
  private turnIntervalRef:      ReturnType<typeof setInterval> | null           = null;
  private countdownIntervalRef: ReturnType<typeof setInterval> | null           = null;
  private resetTimerRef:        ReturnType<typeof setTimeout>  | null           = null;
  // Fraction of the last turn's time window used by the slowest active submitter
  // (0 = everyone submitted instantly, 1 = last submission arrived at the very end).
  // Defaults to 0.5 (neutral) so the first turn uses the baseline decay rate.
  private lastTurnSlowFraction: number                                          = 0.5;
  private kickGraceTimers:      Map<string, ReturnType<typeof setTimeout>>       = new Map();
  private voteKickVotes:        Map<string, Set<string>>                          = new Map(); // targetId → Set<voterId>

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onCreate(options: { lobbyId?: string } = {}) {
    this.setState(new GameRoomState());
    this.state.lobbyId = sanitiseLobbyId(options?.lobbyId);

    this.onMessage("setAppearance", (client: Client, data: { color?: string; borderStyle?: string }) => {
      if (this.state.phase !== "lobby") return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (typeof data.color === "string" && /^#[0-9a-fA-F]{6}$/.test(data.color)) {
        let conflict = false;
        const threshold = similarityThreshold(this.state.players.size);
        this.state.players.forEach((p: Player, sid: string) => {
          if (sid !== client.sessionId && p.playerColor
              && playerColorsTooSimilar(data.color!, p.playerColor, threshold))
            conflict = true;
        });
        if (conflict) { client.send("colorConflict"); return; }
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
        if (player.ready) {
          // Readying up cancels any active vote against this player
          this.voteKickVotes.delete(client.sessionId);
          player.voteKickCount = 0;
        }
        this.checkLobbyReady();
      }
    });

    this.onMessage("voteKick", (client: Client, data: { targetId: string }) => {
      if (this.state.phase !== "lobby") return;
      const targetId = data?.targetId;
      if (typeof targetId !== "string" || targetId === client.sessionId) return;

      const target = this.state.players.get(targetId);
      if (!target)              return;   // player not found
      if (!target.kickEligible) return;   // still within grace period
      if (target.ready)         return;   // can't kick a readied player

      const readyCount = [...this.state.players.values()].filter(p => p.ready).length;
      if (readyCount < 2)       return;   // activation condition not met

      if (!this.voteKickVotes.has(targetId)) this.voteKickVotes.set(targetId, new Set());
      const votes = this.voteKickVotes.get(targetId)!;

      // Toggle: clicking again retracts the vote
      if (votes.has(client.sessionId)) votes.delete(client.sessionId);
      else                              votes.add(client.sessionId);
      target.voteKickCount = votes.size;

      const threshold = Math.max(2, Math.ceil((this.state.players.size - 1) / 2));
      if (votes.size < threshold) return;

      // ─ Threshold reached: execute the kick ──────────────────────────────────
      const kickedName = target.name;
      // Delete from state first so onLeave becomes a no-op for this player
      this.voteKickVotes.delete(targetId);
      this.voteKickVotes.forEach(v => v.delete(targetId)); // retract votes they cast
      const gt = this.kickGraceTimers.get(targetId);
      if (gt) { clearTimeout(gt); this.kickGraceTimers.delete(targetId); }
      this.state.players.delete(targetId);
      this.checkLobbyReady();
      console.log(`[vote]  ${kickedName} removed by vote kick`);
      const kickClient = this.clients.find(c => c.sessionId === targetId);
      if (kickClient) {
        kickClient.send("kicked");
        setTimeout(() => kickClient.leave(4001), 100);
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
      this.submissionOrder.push({ playerId: client.sessionId, colorIndex: ci, receivedAt: Date.now() });
      player.hasSubmitted   = true;
      player.submittedColor = ci;

      // Allow skipping the timer while the board still has unowned cells (Phase 1).
      // Once all cells are occupied the full timer runs — every millisecond counts.
      if (!this.allOccupied) {
        const active = this.activePlayers();
        if (active.length > 0 && active.every(p => p.hasSubmitted)) this.endTurn();
      }
    });

    this.onMessage("playAgain", (client: Client) => {
      if (this.state.phase !== "gameover") return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.ready = true;
      // If all connected players have voted to return, reset immediately
      const connected = [...this.state.players.values()].filter(p => p.connected);
      if (connected.length > 0 && connected.every(p => p.ready)) {
        if (this.resetTimerRef) { clearTimeout(this.resetTimerRef); this.resetTimerRef = null; }
        this.resetToLobby();
      }
    });

    // Lightweight round-trip probe — client sends { clientTs }, we echo it straight
    // back.  The client measures RTT and derives one-way latency for the ping
    // indicator.  No server state is touched.
    this.onMessage("ping", (client: Client, data: { clientTs: number }) => {
      client.send("pong", { clientTs: data.clientTs });
    });
  }

  onJoin(client: Client, options: { name?: string; lobbyId?: string } = {}) {
    if (this.state.phase !== "lobby") {
      throw new Error("Game already in progress — please wait for the next lobby.");
    }
    const player       = new Player();
    player.sessionId   = client.sessionId;
    player.playerIndex = this.nextPlayerIndex();
    player.name        = sanitiseName(options?.name, player.playerIndex);
    player.connected   = true;
    const takenColors    = [...this.state.players.values()].map(p => p.playerColor).filter(Boolean);
  const joinThreshold  = similarityThreshold(this.state.players.size + 1); // +1 = this player
  player.playerColor   = PLAYER_PALETTE.find(c => takenColors.every(t => !playerColorsTooSimilar(c, t, joinThreshold)))
                         ?? PLAYER_PALETTE[player.playerIndex % PLAYER_PALETTE.length];
    player.borderStyle = "solid";
    this.state.players.set(client.sessionId, player);
    // Start the grace-period countdown; player can't be vote-kicked until it elapses
    const graceTimer = setTimeout(() => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.kickEligible = true;
      this.kickGraceTimers.delete(client.sessionId);
    }, VOTE_KICK_GRACE_MS);
    this.kickGraceTimers.set(client.sessionId, graceTimer);
    console.log(`[join]  ${player.name}  (${this.state.players.size} in lobby)`);
  }

  onLeave(client: Client, _consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const sid = client.sessionId;
    // Clean up any votekick state for this player
    const gt = this.kickGraceTimers.get(sid);
    if (gt) { clearTimeout(gt); this.kickGraceTimers.delete(sid); }
    this.voteKickVotes.forEach((voters, targetId) => {
      if (voters.delete(sid)) {
        const t = this.state.players.get(targetId);
        if (t) t.voteKickCount = voters.size;
      }
    });
    this.voteKickVotes.delete(sid);
    if (this.state.phase === "lobby") {
      this.state.players.delete(sid);
      this.checkLobbyReady();
    } else if (this.state.phase === "playing") {
      player.connected = false;
    } else {
      this.state.players.delete(sid);
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

    this.scoreHistory = new Map();
    players.forEach(p => this.scoreHistory.set(p.sessionId, [1])); // seed with starting score

    this.state.phase               = "playing";
    this.state.currentTurn         = 0;
    this.state.winnerId            = "";
    this.state.turnDurationMs      = INITIAL_TURN_MS;
    this.state.isRealtime          = false;
    this.state.lobbyCountdownActive = false;
    this.state.lobbyCountdown      = 0;
    this.allOccupied               = false;
    this.lastTurnSlowFraction      = 0.5;

    this.lock();
    console.log(`[game]  started — ${n} players, ${W}×${H} grid (${W * H} cells), lobby: ${this.state.lobbyId}`);
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
    // Sorted ascending by receivedAt: the LAST player to submit a colour
    // wins any contested group — the most-recent input always prevails.
    this.submissionOrder.sort((a, b) => a.receivedAt - b.receivedAt);
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

    // Snapshot scores for the end-of-game chart
    this.state.players.forEach((p: Player, id: string) => {
      this.scoreHistory.get(id)?.push(p.score);
    });

    this.state.currentTurn++;

    // Measure how far through the turn the slowest active submitter was.
    // Used by updateTurnSpeed() to modulate the next turn's decay factor.
    this.lastTurnSlowFraction = this.computeSlowFraction();

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

    // ── Win conditions ─────────────────────────────────────────────────────
    const total = this.state.cells.length;
    let winnerId = "";

    // Classic: one player owns every single cell
    this.state.players.forEach((p: Player, id: string) => {
      if (p.score === total) winnerId = id;
    });

    // Elimination: all but one player has been reduced to 0 cells
    if (!winnerId) {
      const withCells = [...this.state.players.values()].filter(p => p.score > 0);
      if (withCells.length === 1) {
        winnerId = withCells[0].sessionId;
        console.log(`[game]  elimination — ${withCells[0].name} is last player standing`);
      }
    }

    if (winnerId) {
      this.endGame(winnerId);
    } else {
      this.beginTurn();
    }
  }

  // ── Speed progression ─────────────────────────────────────────────────────
  //
  // The timer always accelerates, but HOW FAST depends on when the slowest
  // active player submitted their move last turn.
  //
  // `lastTurnSlowFraction` (0 = submitted instantly, 1 = submitted at the very
  // last moment) is computed in endTurn() from `submissionOrder`.  Players who
  // never submitted this turn are excluded from the measurement.
  //
  // That fraction is fed through `outlierCurve()` which uses power > 1 on the
  // deviation from 0.5, so near-median timing barely changes the rate while
  // true outliers (everyone instantly vs. everyone waiting till the last tick)
  // produce large swings:
  //
  //   Phase 1 (unowned cells remain):
  //     • Instant submissions  → factor ≈ 0.77  (−23 %/turn, very aggressive)
  //     • Neutral  (frac ≈ 0.5) → factor ≈ 0.87  (matches former −12 %/turn)
  //     • Last-moment submit   → factor ≈ 0.97  (−3 %/turn, very gentle)
  //     • Floor: PHASE1_MIN_MS (3 000 ms)
  //
  //   Phase 2 (all cells occupied):
  //     Two-stage decay centred on PHASE2_SWEET_SPOT_MS (2 000 ms);
  //     both stages are player-paced.
  //     • Above 2 s: interpolate PHASE2_FAST_FACTOR_MIN..MAX (0.82..0.97)
  //     • Below 2 s: interpolate PHASE2_SLOW_FACTOR_MIN..MAX (0.90..0.99)
  //     • Floor: REALTIME_MS (200 ms) — sets `isRealtime` for client blink

  /** Map slowestFraction (0–1) through a curve that amplifies outliers.
   *  Large deviations from the neutral midpoint (0.5) are stretched
   *  disproportionately; small deviations have almost no effect. */
  private outlierCurve(x: number): number {
    const d    = x - 0.5;
    const sign = d >= 0 ? 1 : -1;
    // power = 1.7: flat near centre, steep at the extremes
    const curved = sign * Math.pow(Math.abs(d) * 2, 1.7) * 0.5;
    return Math.max(0, Math.min(1, 0.5 + curved));
  }

  /** Return the fraction of the turn's allotted time used by the slowest
   *  active submitter this turn.  Returns 0.5 (neutral) when nobody submitted. */
  private computeSlowFraction(): number {
    if (this.submissionOrder.length === 0) return 0.5;
    let maxFraction = 0;
    for (const sub of this.submissionOrder) {
      const frac = Math.min(
        1,
        (sub.receivedAt - this.turnStartTime) / this.state.turnDurationMs,
      );
      if (frac > maxFraction) maxFraction = frac;
    }
    return maxFraction;
  }

  private updateTurnSpeed() {
    const curved = this.outlierCurve(this.lastTurnSlowFraction);

    if (!this.allOccupied) {
      // Phase 1 — player-paced, floor at PHASE1_MIN_MS
      const factor = PHASE1_FACTOR_FAST + (PHASE1_FACTOR_SLOW - PHASE1_FACTOR_FAST) * curved;
      this.state.turnDurationMs = Math.max(
        PHASE1_MIN_MS,
        Math.round(this.state.turnDurationMs * factor),
      );
    } else {
      // Phase 2 — two-stage, both player-paced
      const [factorMin, factorMax] = this.state.turnDurationMs > PHASE2_SWEET_SPOT_MS
        ? [PHASE2_FAST_FACTOR_MIN, PHASE2_FAST_FACTOR_MAX]
        : [PHASE2_SLOW_FACTOR_MIN, PHASE2_SLOW_FACTOR_MAX];
      const factor = factorMin + (factorMax - factorMin) * curved;
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
      `  (slow-frac: ${this.lastTurnSlowFraction.toFixed(2)} → curved: ${curved.toFixed(2)})` +
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

    // Broadcast the per-turn score history so the client can draw the chart
    const histPlayers: Array<{ name: string; color: string; scores: number[] }> = [];
    this.state.players.forEach((p: Player, sid: string) => {
      histPlayers.push({ name: p.name, color: p.playerColor, scores: this.scoreHistory.get(sid) ?? [] });
    });
    this.broadcast("scoreHistory", {
      totalCells: this.state.gridWidth * this.state.gridHeight,
      players:    histPlayers,
    });

    this.resetTimerRef = setTimeout(() => { this.resetTimerRef = null; this.resetToLobby(); }, 10_000);
  }

  private resetToLobby() {
    const toRemove: string[] = [];
    this.state.players.forEach((_p: Player, id: string) => {
      if (!this.state.players.get(id)?.connected) toRemove.push(id);
    });
    for (const id of toRemove) this.state.players.delete(id);

    this.state.players.forEach((p: Player) => {
      p.score = 0; p.captures = 0; p.ready = false; p.hasSubmitted = false; p.submittedColor = -1;
      p.kickEligible = false; p.voteKickCount = 0;
    });
    this.scoreHistory = new Map();

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
    this.lastTurnSlowFraction      = 0.5;

    // Fresh votekick grace timers for all returning players
    this.kickGraceTimers.forEach(t => clearTimeout(t));
    this.kickGraceTimers.clear();
    this.voteKickVotes.clear();
    this.state.players.forEach((_p: Player, sid: string) => {
      const timer = setTimeout(() => {
        const p = this.state.players.get(sid);
        if (p) p.kickEligible = true;
        this.kickGraceTimers.delete(sid);
      }, VOTE_KICK_GRACE_MS);
      this.kickGraceTimers.set(sid, timer);
    });

    this.unlock();
    console.log("[game]  reset to lobby");
  }

  private clearTimers() {
    if (this.turnIntervalRef)      { clearInterval(this.turnIntervalRef);      this.turnIntervalRef = null; }
    if (this.countdownIntervalRef) { clearInterval(this.countdownIntervalRef); this.countdownIntervalRef = null; }
    if (this.resetTimerRef)        { clearTimeout(this.resetTimerRef);         this.resetTimerRef = null; }
    this.kickGraceTimers.forEach(t => clearTimeout(t));
    this.kickGraceTimers.clear();
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sanitiseLobbyId(raw: string | undefined): string {
  if (!raw) return "global";
  const s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  return s || "global";
}

function sanitiseName(raw: string | undefined, index: number): string {
  return (raw ?? "").trim().slice(0, 20) || `Player ${index + 1}`;
}

// ─── Player colour utilities ────────────────────────────────────────────────────────────────────────

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if      (h < 60)  { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  const hex2 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** Normal grid colours — player colours must stay ≥ 80 Euclidean distance away. */
const GRID_COLORS_HEX = ["#E74C3C", "#3498DB", "#2ECC71", "#F39C12"] as const;

function passesGridContrast(hex: string): boolean {
  const p = (h: string): [number, number, number] => [
    parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = p(hex);
  for (const base of GRID_COLORS_HEX) {
    const [r2, g2, b2] = p(base);
    if (Math.sqrt((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2) < 80) return false;
  }
  return true;
}

/** Player palette: 20 hues × 3 lightness rings, pre-filtered to ≥ 80 Euclidean from every grid colour. */
const PLAYER_PALETTE: ReadonlyArray<string> = (() => {
  const colours: string[] = [];
  const hues = Array.from({ length: 20 }, (_, i) => i * 18);
  for (const [s, l] of [[0.85, 0.45], [0.70, 0.70], [0.80, 0.30]] as [number, number][]) {
    for (const h of hues) {
      const c = hslToHex(h, s, l);
      if (passesGridContrast(c)) colours.push(c);
    }
  }
  return colours;
})();

/**
 * Chebyshev colour-exclusion radius that scales with current player count.
 * Fewer players → larger band (forces clearly distinct colours).
 * More  players → smaller band (opens up the palette).
 *
 *   2 players → threshold = 80   (same as grid-contrast floor)
 *   8 players → threshold =  5   (near-duplicate block only)
 *   counts in-between interpolate linearly.
 */
function similarityThreshold(playerCount: number): number {
  const MAX_T = 80, MIN_T = 5, MAX_P = 8;
  const t = Math.max(0, Math.min(1, (playerCount - 2) / (MAX_P - 2)));
  return Math.round(MAX_T + (MIN_T - MAX_T) * t);
}

function playerColorsTooSimilar(a: string, b: string, threshold: number): boolean {
  const p = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ] as const;
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2)) <= threshold;
}
