import { Client } from "colyseus.js";

// ─── Lobby URL utilities ──────────────────────────────────────────────────────

/** Vite's BASE_URL (e.g. "/" or "/clicky-box/"), trailing slash stripped. */
const APP_BASE: string = (() => {
  const b = (import.meta as any).env?.BASE_URL ?? "/";
  return b.endsWith("/") ? b.slice(0, -1) : b;
})();

/** Extract and sanitise the lobby slug from the current URL path. */
function getLobbySlug(): string {
  let path = window.location.pathname;
  if (APP_BASE && path.startsWith(APP_BASE)) path = path.slice(APP_BASE.length);
  path = path.replace(/^\/+|\/+$/g, "");
  return sanitiseLobbySlug(path) || "global";
}

function sanitiseLobbySlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}

function randomLobbySlug(): string {
  const adj = [
    "swift",
    "neon",
    "pixel",
    "blaze",
    "nova",
    "echo",
    "stark",
    "crisp",
    "void",
    "cyan",
    "bolt",
    "iron",
  ];
  const noun = [
    "grid",
    "arena",
    "nexus",
    "field",
    "zone",
    "realm",
    "sector",
    "wave",
    "flux",
    "core",
    "tower",
    "loop",
  ];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = noun[Math.floor(Math.random() * noun.length)];
  const d = Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, "0");
  return `${a}-${n}-${d}`;
}

function getPathForSlug(slug: string): string {
  const clean = sanitiseLobbySlug(slug);
  // Keep "global" at the base route so URL can be blank.
  if (!clean || clean === "global") return APP_BASE || "/";
  return `${APP_BASE}/${clean}`;
}

function navigateToSlug(slug: string) {
  history.pushState(null, "", getPathForSlug(slug));
  refreshSlugDisplay();
}

function refreshSlugDisplay() {
  const slug = getLobbySlug();
  const el = document.getElementById("lobby-slug-display");
  if (el) el.textContent = slug;
  const clearBtn = document.getElementById(
    "clear-lobby-btn",
  ) as HTMLButtonElement | null;
  if (clearBtn) clearBtn.disabled = slug === "global";
  document.title = slug === "global" ? "Clicky Box" : `Clicky Box — ${slug}`;
}

function getShareUrl(): string {
  return `${window.location.origin}${getPathForSlug(getLobbySlug())}`;
}

// ─── Grid palettes ────────────────────────────────────────────────────────────

const GRID_COLORS_NORMAL = [
  "#E74C3C",
  "#3498DB",
  "#2ECC71",
  "#F39C12",
] as const;
const GRID_COLORS_CB = ["#D55E00", "#0072B2", "#009E73", "#F0E442"] as const;
const GRID_NAMES = ["Red", "Blue", "Green", "Orange"] as const;
const GRID_KEYS = ["Q", "W", "E", "R"] as const;
const GRID_KEY_CODES = ["q", "w", "e", "r"];

/** Fallback identity colours when a player hasn't picked one yet */
const PLAYER_COLORS = [
  "#9B59B6",
  "#1ABC9C",
  "#E91E63",
  "#F1C40F",
  "#00BCD4",
  "#FF5722",
  "#7F8C8D",
  "#795548",
] as const;

// ─── Player colour palette ─────────────────────────────────────────────────────────────────────

/** Convert HSL (h 0–360, s 0–1, l 0–1) to a #rrggbb hex string. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const hex2 = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** Player palette: 20 hues × 3 lightness rings, pre-filtered to ≥ 80 Euclidean from every grid colour.
 *  Mirrors the server-side PLAYER_PALETTE so auto-assigned colours appear in the picker. */
const PLAYER_PALETTE: ReadonlyArray<string> = (() => {
  const colours: string[] = [];
  const hues = Array.from({ length: 20 }, (_, i) => i * 18);
  // vivid (S=85 % L=45 %), pastel (S=70 % L=70 %), dark (S=80 % L=30 %)
  for (const [s, l] of [
    [0.85, 0.45],
    [0.7, 0.7],
    [0.8, 0.3],
  ] as [number, number][]) {
    for (const h of hues) {
      const c = hslToHex(h, s, l);
      if (passesContrastCheck(c)) colours.push(c);
    }
  }
  return colours;
})();

/**
 * Chebyshev colour-exclusion radius that scales with current player count — mirrors server logic.
 * Fewer players → larger band (forces clearly distinct colours).
 * More  players → smaller band (opens up the palette).
 */
function similarityThreshold(playerCount: number): number {
  const MAX_T = 80,
    MIN_T = 5,
    MAX_P = 8;
  const t = Math.max(0, Math.min(1, (playerCount - 2) / (MAX_P - 2)));
  return Math.round(MAX_T + (MIN_T - MAX_T) * t);
}

/** Border styles — only those that render cleanly at all cell sizes */
const BORDER_STYLES = [
  { id: "solid", label: "Solid", css: "3px solid", radius: "" },
  { id: "double", label: "Double", css: "5px double", radius: "" },
  { id: "rounded", label: "Round", css: "3px solid", radius: "7px" },
] as const;

const MIN_PLAYERS = 2;

// ─── Client state ─────────────────────────────────────────────────────────────

let colorblindMode = localStorage.getItem("cb") === "1";

// Grid render params — written every frame, read by the click handler
const gridParams = { offX: 0, offY: 0, cellSize: 1, W: 0, H: 0, GAP: 10 };

// Start-of-game zoom animation — triggered when phase transitions to "playing"
let startAnimState: { startTime: number; cellIdx: number } | null = null;

// Live score history (client-side, one snapshot per turn)
const liveScoreHistory = new Map<string, number[]>();
let liveLastTurn = -1;

// Lobby countdown tracking — one tick sound per decrement
let prevLobbyCountdown = -1;

// ─── Sound engine ─────────────────────────────────────────────────────────────
//
// All audio is synthesised via the Web Audio API — no external files required.
// The AudioContext is created lazily so it always follows a user gesture.

let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  try {
    if (!audioCtx)
      audioCtx = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function playTone(
  freq: number,
  durationSec: number,
  type: OscillatorType = "sine",
  gainPeak = 0.18,
) {
  const ac = getAudioCtx();
  if (!ac) return;
  const osc  = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime);
  gain.gain.setValueAtTime(gainPeak, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + durationSec);
  osc.start(ac.currentTime);
  osc.stop(ac.currentTime + durationSec);
}

/** Short tick for each lobby countdown beat.
 *  Pitches up on the final second to build urgency. */
function playCountdownTick(n: number) {
  const freq = n <= 1 ? 880 : 660;
  playTone(freq, 0.15, "sine", 0.22);
}

/** Ascending C5-E5-G5 triad burst played when the game begins. */
function playGameStart() {
  playTone(523, 0.20, "sine", 0.22);                       // C5
  setTimeout(() => playTone(659, 0.20, "sine", 0.22), 70);  // E5
  setTimeout(() => playTone(784, 0.35, "sine", 0.22), 140); // G5
}

/** Soft click on each new turn — always played regardless of turn speed. */
function playNewTurn() {
  playTone(440, 0.08, "sine", 0.10);
}

// ─── Ping probe ───────────────────────────────────────────────────────────────
// We send a timestamped message; the server echoes clientTs straight back.
// RTT = Date.now() - clientTs.  One-way latency ≈ RTT / 2.
// The one-way value is what matters: a command sent at time T arrives at the
// server at T + oneway, so the player must act while the bar still has at least
// (oneway / turnDurationMs) of its width remaining.
const pingHistory: number[] = [];   // last N raw RTT samples (ms)
let   pingMs       = 0;             // current median RTT; 0 = not yet measured
let   pingProbeId: ReturnType<typeof setInterval> | null = null;

function startPingProbe() {
  if (pingProbeId) clearInterval(pingProbeId);
  pingHistory.length = 0;
  pingMs = 0;
  const probe = () => room?.send("ping", { clientTs: Date.now() });
  probe(); // immediate first sample
  pingProbeId = setInterval(probe, 2_000);
}

function stopPingProbe() {
  if (pingProbeId) { clearInterval(pingProbeId); pingProbeId = null; }
  pingHistory.length = 0;
  pingMs = 0;
}

/**
 * Reposition the marker line and label under the timer bar.
 * Called every ~50 ms from updateGame() so the marker tracks turn-duration
 * changes in real time — as turns get shorter the marker drifts left,
 * consuming an ever-larger fraction of the visible bar.
 */
function updatePingIndicator(turnDurationMs: number) {
  const marker = $("ping-marker");
  const label  = $("ping-label");
  if (!marker || !label) return;

  if (!pingMs || !turnDurationMs) {
    marker.style.display = "none";
    label.style.display  = "none";
    return;
  }

  // One-way trip time is the meaningful deadline offset:
  // submit when the bar still has at least this fraction remaining.
  const oneway   = pingMs / 2;
  const leftPct  = (oneway / turnDurationMs) * 100;

  if (leftPct < 0.5) {
    // Ping negligible relative to turn length — not worth showing
    marker.style.display = "none";
    label.style.display  = "none";
    return;
  }

  const clampedPct = Math.min(50, leftPct); // never push marker past midpoint

  // Colour escalates as ping consumes a larger share of the turn
  const severity = oneway / turnDurationMs;
  const color = severity > 0.30 ? "#e74c3c"
              : severity > 0.15 ? "#f39c12"
              : "rgba(255,255,255,0.55)";
  document.documentElement.style.setProperty("--ping-marker-color", color);

  marker.style.display = "block";
  marker.style.left    = `${clampedPct}%`;
  label.style.display  = "block";
  label.style.left     = `${clampedPct}%`;
  label.textContent    = `~${pingMs}ms`;
}

// ─── Capture animations ───────────────────────────────────────────────────────

interface CaptureAnim {
  startTime: number;
  color: string;
}
const captureAnims = new Map<number, CaptureAnim>();

function triggerCaptureAnim(cellIdx: number, color: string) {
  captureAnims.set(cellIdx, { startTime: performance.now(), color });
}

// ─── Floating text popups ─────────────────────────────────────────────────────
//
// Spawned at turn boundaries to surface two kinds of events:
//   • ⚔ RACE  — two or more players chose the same colour this turn.
//               Every contestant gets their own popup at the centroid of their
//               gained cells showing "⚔ +N" (or "⚔ RACED" if they got nothing).
//   • +N      — a player made a large solo grab (≥ 4 % of the board or ≥ 5 cells).
//               Positioned at the centroid of the cells they actually captured.
//
// Per-turn state is accumulated from state-change events during the turn and
// consumed + cleared when the turn number increments.

interface FloatingText {
  text:      string;
  x:         number;   // canvas px — fixed at spawn
  y:         number;   // canvas px — base; drifts upward during render
  color:     string;
  startTime: number;   // performance.now() at spawn
  duration:  number;   // ms total lifetime
  fontSize:  number;   // px
  glow:      boolean;  // soft coloured shadow — used for contest popups
}

const floatingTexts: FloatingText[] = [];

// Per-turn tracking maps — populated during the turn, consumed at turn boundary
const currentTurnSubmissions = new Map<string, number>(); // sid → colorIndex submitted this turn
const prevTurnScores         = new Map<string, number>(); // sid → score at start of this turn
const turnGainedCells        = new Map<string, number[]>(); // sid → cell indices gained this turn

function spawnFloat(
  text: string, x: number, y: number, color: string,
  duration = 2000, fontSize = 20, glow = false,
) {
  floatingTexts.push({ text, x, y, color, startTime: performance.now(), duration, fontSize, glow });
}

/** Canvas centre-point of a grid cell index. */
function cellIdxToCanvas(idx: number): { x: number; y: number } {
  const { offX, offY, cellSize, W, GAP } = gridParams;
  const col = idx % W;
  const row = Math.floor(idx / W);
  return {
    x: offX + GAP + col * cellSize + (cellSize - GAP) * 0.5,
    y: offY + GAP + row * cellSize + (cellSize - GAP) * 0.5,
  };
}

/** Centroid of a list of cell indices in canvas space, or null if list is empty. */
function cellsCentroid(indices: number[]): { x: number; y: number } | null {
  if (!indices.length) return null;
  let sx = 0, sy = 0;
  for (const idx of indices) { const c = cellIdxToCanvas(idx); sx += c.x; sy += c.y; }
  return { x: sx / indices.length, y: sy / indices.length };
}

/** Centroid of all cells currently owned by sid — fallback spawn position. */
function playerTerritoryCentroid(state: any, sid: string): { x: number; y: number } | null {
  const owned: number[] = [];
  for (let i = 0; i < (state.cells?.length ?? 0); i++) {
    if (state.cells[i].ownerId === sid) owned.push(i);
  }
  return cellsCentroid(owned);
}

/**
 * Called once per turn boundary (after detectOwnerChanges has filled
 * turnGainedCells, before tracking maps are cleared).
 */
/**
 * Map a capture count to a font size scaled relative to the total board size.
 * Uses a square-root curve on the board-percentage so the same visual weight
 * applies regardless of map size (small 2-player map vs. large 8-player map).
 *   ~1 % of board  → ~26 px
 *   ~5 % of board  → ~31 px
 *  ~15 % of board  → ~38 px
 *  ~30 %+ of board → ~56 px (capped)
 */
function captureToFontSize(n: number, totalCells: number): number {
  const pct = totalCells > 0 ? (n / totalCells) * 100 : 0;
  return Math.round(Math.min(56, 22 + Math.sqrt(pct) * 4.8));
}

function spawnTurnFloats(state: any) {
  // Skip in real-time mode — turns are too fast for readable text
  if (state.isRealtime || gridParams.W === 0) return;

  const totalCells    = gridParams.W * gridParams.H;
  // Solo-gain threshold: ~4 % of the board, minimum 5 cells
  const gainThreshold = Math.max(5, Math.round(totalCells * 0.04));

  // ── Detect contested colours (≥ 2 players chose the same colour) ──────────
  const colorContestants = new Map<number, string[]>(); // colorIndex → [sid, …]
  currentTurnSubmissions.forEach((ci, sid) => {
    if (!colorContestants.has(ci)) colorContestants.set(ci, []);
    colorContestants.get(ci)!.push(sid);
  });
  const contestedColorSet = new Set<number>();
  colorContestants.forEach((sids, ci) => { if (sids.length >= 2) contestedColorSet.add(ci); });

  // ── One popup per player who submitted this turn ──────────────────────────
  state.players.forEach((player: any, sid: string) => {
    const colorPicked = currentTurnSubmissions.get(sid);
    if (colorPicked === undefined) return;            // did not submit — skip

    const gainedList  = turnGainedCells.get(sid) ?? [];
    const gainedCount = gainedList.length;
    const isContested = contestedColorSet.has(colorPicked);

    // Position: centroid of cells actually gained; fall back to territory centre
    const pos = cellsCentroid(gainedList) ?? playerTerritoryCentroid(state, sid);
    if (!pos) return;

    const pColor = getPlayerColor(player);

    if (isContested) {
      // Always show race popups — scale with cells actually won
      const text = gainedCount > 0 ? `\u2694 +${gainedCount}` : `\u2694 RACED`;
      const sz   = gainedCount > 0 ? captureToFontSize(gainedCount, totalCells) : 28;
      spawnFloat(text, pos.x, pos.y, pColor, 2600, sz, /*glow*/ true);
    } else if (gainedCount >= gainThreshold) {
      // Solo big-gain popup — size proportional to share of board taken
      spawnFloat(`+${gainedCount}`, pos.x, pos.y, pColor, 2200, captureToFontSize(gainedCount, totalCells), false);
    }
  });
}

function renderFloatingTexts() {
  if (!floatingTexts.length) return;
  const now = performance.now();

  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const ft  = floatingTexts[i];
    const t   = Math.min(1, (now - ft.startTime) / ft.duration);
    if (t >= 1) { floatingTexts.splice(i, 1); continue; }

    // Float upward with ease-out
    const rise  = Math.pow(t, 0.55) * ft.fontSize * 5;
    // Quick fade-in over first 15 %, ease-out over the rest
    const alpha = t < 0.15 ? t / 0.15 : Math.pow(1 - t, 0.75);

    ctx.save();
    ctx.globalAlpha  = Math.max(0, Math.min(1, alpha));
    ctx.font         = `bold ${ft.fontSize}px system-ui, sans-serif`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    const drawY = ft.y - rise;

    if (ft.glow) {
      ctx.shadowColor = ft.color;
      ctx.shadowBlur  = Math.round(ft.fontSize * 0.65);
    }
    // Dark outline for legibility over any background
    ctx.strokeStyle = "rgba(0,0,0,0.82)";
    ctx.lineWidth   = Math.max(3, ft.fontSize * 0.22);
    ctx.lineJoin    = "round";
    ctx.strokeText(ft.text, ft.x, drawY);
    ctx.fillStyle   = ft.color;
    ctx.fillText(ft.text, ft.x, drawY);
    ctx.restore();
  }
}

// Local submission guard — prevents state-patch race from re-enabling the colour
// buttons before the server has echoed back our selectColor confirmation.
let localHasSubmitted = false;
let lastTurnSeen = -1;

// Previous ownership map — used to detect which cells just changed hands
const prevOwners = new Map<number, string>();

function detectOwnerChanges(state: any) {
  if (!state.cells?.length || state.phase !== "playing") {
    if (state.phase !== "playing") {
      prevOwners.clear();
      captureAnims.clear();
      turnGainedCells.clear();
    }
    return;
  }
  for (let i = 0; i < state.cells.length; i++) {
    const curr: string = state.cells[i].ownerId ?? "";
    const prev = prevOwners.get(i);
    if (prev !== undefined && curr !== prev && curr !== "") {
      const owner = state.players.get(curr);
      if (owner) triggerCaptureAnim(i, getPlayerColor(owner));
      // Record which cells each player gained this turn
      if (!turnGainedCells.has(curr)) turnGainedCells.set(curr, []);
      turnGainedCells.get(curr)!.push(i);
    }
    prevOwners.set(i, curr);
  }
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const screens = {
  connect: $("screen-connect"),
  lobby: $("screen-lobby"),
  game: $("screen-game"),
  gameover: $("screen-gameover"),
};

const canvas = $<HTMLCanvasElement>("grid-canvas");
const ctx = canvas.getContext("2d")!;

// ─── Colyseus ─────────────────────────────────────────────────────────────────

let client: Client | null = null;
let room: any = null;
let mySessionId = "";
let prevPhase = "";
const myVoteKicks = new Set<string>(); // session IDs this client has voted to kick
let scoreHistoryData: {
  totalCells: number;
  players: Array<{ name: string; color: string; scores: number[] }>;
} | null = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  buildColorButtons();
  buildSwatches();
  buildBorderStyleButtons();
  applyCbToggle();
  refreshSlugDisplay();

  $("join-btn").addEventListener("click", joinGame);
  $("name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinGame();
  });
  $("ready-btn").addEventListener("click", () => room?.send("ready"));
  $("play-again-btn").addEventListener("click", () => room?.send("playAgain"));

  $("new-lobby-btn").addEventListener("click", () =>
    navigateToSlug(randomLobbySlug()),
  );
  $("clear-lobby-btn").addEventListener("click", () => navigateToSlug(""));

  $("copy-link-btn").addEventListener("click", () => {
    const url = getShareUrl();
    const btn = $("copy-link-btn");
    navigator.clipboard
      .writeText(url)
      .then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = "Copy Link";
        }, 2_000);
      })
      .catch(() => {
        // Fallback for older browsers
        const inp = $<HTMLInputElement>("share-url");
        inp.select();
        document.execCommand("copy");
      });
  });

  $("cb-toggle").addEventListener("click", () => {
    colorblindMode = !colorblindMode;
    localStorage.setItem("cb", colorblindMode ? "1" : "0");
    applyCbToggle();
    buildColorButtons();
  });

  $<HTMLInputElement>("custom-color").addEventListener("change", (e) => {
    const color = (e.target as HTMLInputElement).value;
    room?.send("setAppearance", { color });
  });

  window.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("click", onCanvasClick);
  window.addEventListener("resize", resizeCanvas);

  resizeCanvas();
  showScreen("connect");
  requestAnimationFrame(renderLoop);
});

// ─── Colour buttons (game bar) ────────────────────────────────────────────────

function buildColorButtons() {
  const colors = colorblindMode ? GRID_COLORS_CB : GRID_COLORS_NORMAL;
  document
    .querySelectorAll<HTMLButtonElement>(".color-btn")
    .forEach((btn, i) => {
      btn.style.background = colors[i];
      btn.innerHTML = `<span class="btn-label">${GRID_NAMES[i]}</span><kbd>${GRID_KEYS[i]}</kbd>`;
      // Replace any previous listener by cloning, then attach fresh one
      const fresh = btn.cloneNode(true) as HTMLButtonElement;
      btn.replaceWith(fresh);
      fresh.addEventListener("click", () => onColorPick(i));
    });
}

// ─── Lobby appearance: colour swatches ───────────────────────────────────────

function buildSwatches() {
  const row = $("color-swatches");
  row.innerHTML = "";
  for (const color of PLAYER_PALETTE) {
    // palette is pre-filtered; every entry is safe
    const btn = document.createElement("button");
    btn.className = "swatch-btn";
    btn.style.background = color;
    btn.dataset.color = color;
    btn.title = color;
    btn.addEventListener("click", () => room?.send("setAppearance", { color }));
    row.appendChild(btn);
  }
}

// ─── Lobby appearance: border style buttons ───────────────────────────────────

function buildBorderStyleButtons(previewColor = "#9B59B6") {
  const row = $("border-style-row");
  row.innerHTML = "";
  for (const style of BORDER_STYLES) {
    const btn = document.createElement("button");
    btn.className = "bs-btn";
    btn.dataset.style = style.id;
    btn.title = style.label;
    btn.setAttribute("aria-label", style.label);

    const preview = document.createElement("div");
    preview.className = "bs-preview";
    preview.style.border = `${style.css} ${previewColor}`;
    preview.style.borderRadius = style.radius;

    btn.appendChild(preview);
    btn.addEventListener("click", () =>
      room?.send("setAppearance", { borderStyle: style.id }),
    );
    row.appendChild(btn);
  }
}

function updateAppearanceSelection(playerColor: string, bStyle: string) {
  const resolvedColor = playerColor || PLAYER_COLORS[0];

  // Highlight matching swatch
  document.querySelectorAll<HTMLButtonElement>(".swatch-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.color === playerColor);
  });

  // Sync custom colour picker
  $<HTMLInputElement>("custom-color").value = resolvedColor;

  // Update border style previews with current colour + highlight selection
  document.querySelectorAll<HTMLButtonElement>(".bs-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.style === bStyle);
    const preview = btn.querySelector(".bs-preview") as HTMLElement | null;
    const def = BORDER_STYLES.find((s) => s.id === btn.dataset.style);
    if (preview && def) {
      preview.style.border = `${def.css} ${resolvedColor}`;
      preview.style.borderRadius = def.radius;
    }
  });
}

// ─── Colorblind toggle ────────────────────────────────────────────────────────

function applyCbToggle() {
  const btn = $("cb-toggle");
  btn.classList.toggle("active", colorblindMode);
  btn.setAttribute("aria-pressed", String(colorblindMode));
  btn.title = colorblindMode ? "Colorblind mode: ON" : "Colorblind mode: OFF";
}

// ─── Screen management ────────────────────────────────────────────────────────

function showScreen(name: keyof typeof screens) {
  for (const [k, el] of Object.entries(screens))
    el.classList.toggle("hidden", k !== name);
  if (name === "game") resizeCanvas();
}

function resizeCanvas() {
  const wrap = $("canvas-wrap");
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}

// ─── Join ─────────────────────────────────────────────────────────────────────

async function joinGame() {
  const nameInput = $<HTMLInputElement>("name-input");
  const errorEl = $("connect-error");
  const name = nameInput.value.trim() || "Anonymous";
  const lobbySlug = getLobbySlug();
  errorEl.textContent = "";

  const serverUrl =
    (import.meta as any).env?.VITE_SERVER_URL ?? "ws://localhost:2567";
  try {
    client = new Client(serverUrl);
    room = await client.joinOrCreate("game", { name, lobbyId: lobbySlug });
    mySessionId = room.sessionId as string;
    prevPhase = "";
    myVoteKicks.clear();

    // Ensure the URL reflects the actual slug we joined
    history.replaceState(null, "", getPathForSlug(lobbySlug));
    refreshSlugDisplay();

    room.onStateChange((state: any) => {
      detectOwnerChanges(state);
      updateUI(state);
    });
    room.onError((_c: number, msg: string) =>
      console.error("Room error:", msg),
    );
    room.onLeave(() => {
      room = null;
      myVoteKicks.clear();
      stopPingProbe();
      showScreen("connect");
    });

    room.onMessage("kicked", () => {
      room = null;
      myVoteKicks.clear();
      stopPingProbe();
      showScreen("connect");
      $("connect-error").textContent = "You were removed from the lobby by a vote kick.";
    });
    room.onMessage("colorConflict", () => {
      const warn = $("color-warn");
      warn.style.display = "block";
      warn.textContent =
        "Too similar to another player’s colour — try something else.";
      const me = room?.state?.players?.get(mySessionId);
      if (me) $<HTMLInputElement>("custom-color").value = getPlayerColor(me);
      setTimeout(() => {
        warn.style.display = "none";
        warn.textContent = "";
      }, 3_000);
    });
    room.onMessage("scoreHistory", (data: typeof scoreHistoryData) => {
      scoreHistoryData = data;
      renderScoreChart();
    });

    // Echo-based RTT measurement — server bounces clientTs straight back
    room.onMessage("pong", (data: { clientTs: number }) => {
      const rtt = Date.now() - data.clientTs;
      pingHistory.push(rtt);
      if (pingHistory.length > 6) pingHistory.shift();
      // Median of recent samples for stability against outlier spikes
      const sorted = [...pingHistory].sort((a, b) => a - b);
      pingMs = sorted[Math.floor(sorted.length / 2)];
    });

    startPingProbe();

    showScreen("lobby");
  } catch (err: any) {
    errorEl.textContent = err?.message ?? "Could not connect to server.";
  }
}

// ─── Keyboard Q / W / E / R ───────────────────────────────────────────────────

function onKeyDown(e: KeyboardEvent) {
  if (!room) return;
  const state = room.state as any;
  if (state?.phase !== "playing") return;
  const me = state.players.get(mySessionId);
  if (!me || me.hasSubmitted) return;

  const idx = GRID_KEY_CODES.indexOf(e.key.toLowerCase());
  if (idx !== -1) {
    e.preventDefault();
    onColorPick(idx);
  }
}

// ─── Canvas click → pick colour of clicked cell ───────────────────────────────

function onCanvasClick(e: MouseEvent) {
  if (!room) return;
  const state = room.state as any;
  if (state?.phase !== "playing") return;
  const me = state.players.get(mySessionId);
  if (!me || me.hasSubmitted) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (e.clientX - rect.left) * scaleX;
  const cy = (e.clientY - rect.top) * scaleY;

  const { offX, offY, cellSize, W, H, GAP } = gridParams;
  const col = Math.floor((cx - offX - GAP) / cellSize);
  const row = Math.floor((cy - offY - GAP) / cellSize);
  if (col < 0 || col >= W || row < 0 || row >= H) return;

  const cellIdx = row * W + col;
  if (cellIdx >= 0 && cellIdx < state.cells.length) {
    onColorPick(state.cells[cellIdx].colorIndex as number);
  }
}

// ─── Colour pick (shared entry point) ────────────────────────────────────────

function onColorPick(colorIndex: number) {
  if (!room) return;
  if (localHasSubmitted) return; // already picked this turn
  localHasSubmitted = true; // optimistic lock — no re-enable until next turn
  setColorBtnsEnabled(false, colorIndex);
  room.send("selectColor", { colorIndex });
}

function setColorBtnsEnabled(enabled: boolean, chosenIdx = -1) {
  document
    .querySelectorAll<HTMLButtonElement>(".color-btn")
    .forEach((btn, i) => {
      btn.disabled = !enabled;
      btn.classList.toggle("chosen", !enabled && i === chosenIdx);
      btn.classList.toggle("unchosen", !enabled && i !== chosenIdx);
    });
}

// ─── Master UI update ─────────────────────────────────────────────────────────

function updateUI(state: any) {
  if (!state) return;
  const { phase } = state;

  if (phase !== prevPhase) {
    prevPhase = phase;
    if (phase === "lobby") {
      showScreen("lobby");
      prevLobbyCountdown = -1; // reset so ticks fire fresh on the next countdown
    } else if (phase === "playing") {
      playGameStart();
      showScreen("game");
      localHasSubmitted = false; // fresh game — clear any leftover lock
      lastTurnSeen = -1;
      scoreHistoryData = null;
      liveScoreHistory.clear();
      liveLastTurn = -1;
      myVoteKicks.clear();
      floatingTexts.length = 0;
      currentTurnSubmissions.clear();
      turnGainedCells.clear();
      prevTurnScores.clear();
      // Seed prevTurnScores so the first turn's gains are measured from game-start scores
      state.players?.forEach((p: any, sid: string) => { prevTurnScores.set(sid, p.score ?? 0); });
      // Find this player's starting cell and trigger the zoom-out animation
      if (state?.cells) {
        for (let i = 0; i < state.cells.length; i++) {
          if (state.cells[i].ownerId === mySessionId) {
            startAnimState = { startTime: performance.now(), cellIdx: i };
            break;
          }
        }
      }
      setColorBtnsEnabled(true);
    } else if (phase === "gameover") showScreen("gameover");
  }

  if (phase === "lobby") updateLobby(state);
  if (phase === "playing") updateGame(state);
  if (phase === "gameover") updateGameover(state);
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

function updateLobby(state: any) {
  const listEl = $("player-list");
  listEl.innerHTML = "";

  const readyCount = [...state.players.values()].filter((p: any) => p.ready).length;
  const threshold  = Math.max(2, Math.ceil((state.players.size - 1) / 2));
  const kickActive = readyCount >= 2;

  state.players.forEach((p: any, sid: string) => {
    const li = document.createElement("li");
    li.className = `player-entry${sid === mySessionId ? " me" : ""}`;
    li.innerHTML =
      `<span class="dot" style="background:${getPlayerColor(p)};` +
      `outline:2px solid ${getPlayerColor(p)};outline-offset:2px;` +
      `border-radius:${getBorderRadius(p)};"></span>` +
      `<span class="pname">${esc(p.name)}</span>` +
      (p.ready
        ? `<span class="badge ready">READY</span>`
        : `<span class="badge waiting">waiting</span>`);

    // Vote-kick button: shown for non-me, non-ready, grace-period-passed players
    // when at least 2 players are already ready
    if (sid !== mySessionId && !p.ready && p.kickEligible && kickActive) {
      const voted   = myVoteKicks.has(sid);
      const kickBtn = document.createElement("button");
      kickBtn.className = `kick-btn${voted ? " voted" : ""}`;
      kickBtn.textContent = `Kick ${p.voteKickCount}/${threshold}`;
      kickBtn.title = voted ? "Retract vote" : "Vote to kick";
      kickBtn.addEventListener("click", () => {
        if (!room) return;
        myVoteKicks.has(sid) ? myVoteKicks.delete(sid) : myVoteKicks.add(sid);
        room.send("voteKick", { targetId: sid });
      });
      li.appendChild(kickBtn);
    }
    listEl.appendChild(li);
  });

  const me = state.players.get(mySessionId);
  const readyBtn = $<HTMLButtonElement>("ready-btn");
  if (me) {
    readyBtn.textContent = me.ready ? "Cancel" : "Ready Up";
    readyBtn.classList.toggle("is-ready", me.ready);
    updateAppearanceSelection(me.playerColor, me.borderStyle);
  }
  markTakenSwatches(state);

  const statusEl = $("lobby-status");
  if (state.lobbyCountdownActive) {
    statusEl.textContent = `Starting in ${state.lobbyCountdown}…`;
    statusEl.className = "lobby-status countdown";
    // Fire one tick sound per decrement (skip the 0 — game-start sound covers that)
    if (state.lobbyCountdown !== prevLobbyCountdown && state.lobbyCountdown > 0) {
      playCountdownTick(state.lobbyCountdown as number);
    }
    prevLobbyCountdown = state.lobbyCountdown as number;
  } else {
    prevLobbyCountdown = -1;
    const nReady = [...state.players.values()].filter(
      (p: any) => p.ready,
    ).length;
    statusEl.textContent = `${nReady} / ${state.players.size} ready  ·  need ${MIN_PLAYERS} to start`;
    statusEl.className = "lobby-status";
  }

  // Keep the share-link input up to date
  const shareEl = $<HTMLInputElement>("share-url");
  if (shareEl) shareEl.value = getShareUrl();
}

// ─── Game HUD ─────────────────────────────────────────────────────────────────

function updateGame(state: any) {
  snapshotScores(state);
  updateSidebar(state);

  $("turn-counter").textContent = `Turn ${state.currentTurn + 1}`;

  const pct = Math.max(0, Math.min(1, state.turnTimeLeft)) * 100;
  const fill = $("timer-fill");
  fill.style.width = `${pct}%`;
  fill.style.background =
    pct > 50 ? "#2ecc71" : pct > 25 ? "#f39c12" : "#e74c3c";
  $('hud').classList.toggle("realtime", !!state.isRealtime);
  updatePingIndicator(state.turnDurationMs as number);

  const scoreEl = $("score-board");
  scoreEl.innerHTML = "";
  const arr: any[] = [];
  state.players.forEach((p: any) => arr.push(p));
  arr.sort((a: any, b: any) => b.captures - a.captures);

  for (const p of arr) {
    const div = document.createElement("div");
    div.className = `score-entry${p.sessionId === mySessionId ? " me" : ""}`;
    let sub = "";
    if (p.hasSubmitted && p.submittedColor >= 0) {
      const gc = (colorblindMode ? GRID_COLORS_CB : GRID_COLORS_NORMAL)[
        p.submittedColor
      ];
      sub = `<span class="sub-dot" style="background:${gc}">✓</span>`;
    }
    div.innerHTML =
      `<span class="dot" style="background:${getPlayerColor(p)}"></span>` +
      `<span class="pname">${esc(p.name)}</span>` +
      `<span class="pts">${p.captures} captures</span>${sub}`;
    scoreEl.appendChild(div);
  }

  // Capture each player's submitted colour while it is still visible in state.
  // The server resets submittedColor to -1 at the start of the next turn, so
  // we must record it here before it disappears from the state patch.
  state.players.forEach((p: any, sid: string) => {
    if (p.hasSubmitted && p.submittedColor >= 0) {
      currentTurnSubmissions.set(sid, p.submittedColor);
    }
  });

  // At each turn boundary: spawn popups, then reset per-turn tracking
  if (state.currentTurn !== lastTurnSeen) {
    spawnTurnFloats(state);
    // Play a new-turn sound — silenced automatically once turns become very rapid
    if (lastTurnSeen !== -1) playNewTurn();
    turnGainedCells.clear();
    currentTurnSubmissions.clear();
    state.players.forEach((p: any, sid: string) => { prevTurnScores.set(sid, p.score); });
    lastTurnSeen      = state.currentTurn;
    localHasSubmitted = false;
  }

  const me = state.players.get(mySessionId);
  if (me) {
    if (me.hasSubmitted) {
      // Server confirmed — show which colour was chosen
      setColorBtnsEnabled(false, me.submittedColor);
    } else if (!localHasSubmitted) {
      // No pending local submission — buttons should be active
      setColorBtnsEnabled(true);
    }
    // If localHasSubmitted but server hasn't echoed yet: leave buttons as-is
    // (disabled from the optimistic lock in onColorPick)
  }

  const colors = colorblindMode ? GRID_COLORS_CB : GRID_COLORS_NORMAL;
  document
    .querySelectorAll<HTMLButtonElement>(".color-btn")
    .forEach((btn, i) => {
      btn.style.background = colors[i];
    });
}

function snapshotScores(state: any) {
  if (state.phase !== "playing" || state.currentTurn === liveLastTurn) return;
  liveLastTurn = state.currentTurn;
  state.players.forEach((p: any, sid: string) => {
    if (!liveScoreHistory.has(sid)) liveScoreHistory.set(sid, []);
    liveScoreHistory.get(sid)!.push(p.score as number);
  });
}

function updateSidebar(state: any) {
  const sidebar = $("sidebar");
  const scoresEl = $("sidebar-scores");
  if (!sidebar || !scoresEl) return;

  scoresEl.innerHTML = "";
  const arr: any[] = [];
  state.players.forEach((p: any) => arr.push(p));
  arr.sort((a: any, b: any) => b.score - a.score);
  for (const p of arr) {
    const div = document.createElement("div");
    div.className = `sb-entry${p.sessionId === mySessionId ? " me" : ""}`;
    div.innerHTML =
      `<span class="dot" style="background:${getPlayerColor(p)}"></span>` +
      `<span class="pname">${esc(p.name)}</span>` +
      `<span class="sb-score">${p.score}</span>`;
    scoresEl.appendChild(div);
  }
  renderLiveChart(state);
}

function renderLiveChart(state: any) {
  const canvas = $("live-chart") as HTMLCanvasElement | null;
  if (!canvas) return;
  const totalCells = (state.gridWidth as number) * (state.gridHeight as number);
  if (!totalCells) return;

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 150;
  const H = canvas.offsetHeight || 100;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx2 = canvas.getContext("2d")!;
  ctx2.scale(dpr, dpr);

  const PAD = { top: 4, right: 4, bottom: 4, left: 4 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  ctx2.fillStyle = "rgba(0,0,0,0.35)";
  ctx2.fillRect(0, 0, W, H);

  const entries: Array<{ color: string; scores: number[] }> = [];
  state.players.forEach((p: any, sid: string) => {
    const scores = liveScoreHistory.get(sid);
    if (scores?.length) entries.push({ color: getPlayerColor(p), scores });
  });
  if (!entries.length) return;

  const maxLen = Math.max(...entries.map((e) => e.scores.length), 2);
  for (const e of entries) {
    if (e.scores.length < 2) continue;
    ctx2.strokeStyle = e.color;
    ctx2.lineWidth = 1.5;
    ctx2.lineJoin = "round";
    ctx2.beginPath();
    e.scores.forEach((score, i) => {
      const x = PAD.left + (i / (maxLen - 1)) * cW;
      const y = PAD.top + cH * (1 - score / totalCells);
      i === 0 ? ctx2.moveTo(x, y) : ctx2.lineTo(x, y);
    });
    ctx2.stroke();
  }
}

// ─── Game over ────────────────────────────────────────────────────────────────

function updateGameover(state: any) {
  const winner = state.players.get(state.winnerId);
  $("winner-line").innerHTML = winner
    ? `🏆 <span style="color:${getPlayerColor(winner)}">${esc(winner.name)}</span> wins!`
    : "It's a draw!";

  const scoresEl = $("final-scores");
  scoresEl.innerHTML = "";
  const arr: any[] = [];
  state.players.forEach((p: any) => arr.push(p));
  arr.sort((a: any, b: any) => b.captures - a.captures);

  const medals = ["🥇", "🥈", "🥉"];
  arr.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = `fs-entry${p.sessionId === mySessionId ? " me" : ""}`;
    div.innerHTML =
      `<span class="medal">${medals[i] ?? i + 1 + "."}</span>` +
      `<span class="dot" style="background:${getPlayerColor(p)}"></span>` +
      `<span class="pname">${esc(p.name)}</span>` +
      `<span class="pts">${p.captures} captures</span>`;
    scoresEl.appendChild(div);
  });
  $("gameover-note").textContent = "Lobby resets automatically in 10 s";
  renderScoreChart();
}

// ─── Canvas render loop ───────────────────────────────────────────────────────

function renderScoreChart() {
  const canvas = $<HTMLCanvasElement>("score-chart");
  if (!canvas || !scoreHistoryData) return;

  const { totalCells, players } = scoreHistoryData;
  if (!players.length || totalCells === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 380;
  const H = canvas.offsetHeight || 160;
  canvas.width = W * dpr;
  canvas.height = H * dpr;

  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  const PAD = { top: 12, right: 16, bottom: 26, left: 40 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  const maxTurns = Math.max(...players.map((p) => p.scores.length), 2);

  // Background
  ctx.fillStyle = "#0a0a14";
  ctx.fillRect(0, 0, W, H);

  // Horizontal grid lines + Y-axis labels
  ctx.font = "9px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + cH * (1 - i / 4);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + cW, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.30)";
    ctx.fillText(String(Math.round((totalCells * i) / 4)), PAD.left - 5, y);
  }

  // X-axis label
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillText("turn", PAD.left + cW / 2, H - 4);

  // One line per player, coloured with their player colour
  for (const p of players) {
    if (p.scores.length < 2) continue;
    ctx.strokeStyle = p.color || "#888888";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    p.scores.forEach((score, i) => {
      const x = PAD.left + (i / (maxTurns - 1)) * cW;
      const y = PAD.top + cH * (1 - score / totalCells);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function renderLoop() {
  const state = room?.state as any;
  if (state?.phase === "playing" && state.gridWidth > 0) {
    renderGrid(state);
    canvas.style.cursor = "crosshair";
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.cursor = "default";
  }
  requestAnimationFrame(renderLoop);
}

function renderGrid(state: any) {
  const W = state.gridWidth as number;
  const H = state.gridHeight as number;
  if (!W || !H || !state.cells?.length) return;

  const GAP = 10; // wider gap → crisper grid lines

  // cellSize must exceed GAP so cell content stays positive
  const cellSize = Math.max(
    GAP + 4,
    Math.min(
      Math.floor((canvas.width - GAP) / W),
      Math.floor((canvas.height - GAP) / H),
    ),
  );

  const totalW = cellSize * W + GAP;
  const totalH = cellSize * H + GAP;
  const offX = Math.floor((canvas.width - totalW) / 2);
  const offY = Math.floor((canvas.height - totalH) / 2);

  Object.assign(gridParams, { offX, offY, cellSize, W, H, GAP });

  ctx.fillStyle = "#0f0f1a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Zoom-out start animation: find player's cell, scale 6× → 1× over 1.8 s
  const animNow = performance.now();
  let zoomed = false;
  if (startAnimState) {
    const t = Math.min(1, (animNow - startAnimState.startTime) / 1800);
    if (t < 1) {
      const ease = 1 - Math.pow(1 - t, 2.5);
      const scale = 6 - 5 * ease; // 6× → 1×
      const col = startAnimState.cellIdx % W;
      const row = Math.floor(startAnimState.cellIdx / W);
      const cx = offX + GAP + col * cellSize + (cellSize - GAP) / 2;
      const cy = offY + GAP + row * cellSize + (cellSize - GAP) / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
      zoomed = true;
    } else {
      startAnimState = null;
    }
  }

  ctx.fillStyle = "#050509"; // very dark gap / grid-line colour
  ctx.fillRect(offX, offY, totalW, totalH);

  // Border covers ~50 % of the cell’s visual area (each side ≈ 15 % of content width)

  // 10 % corner radius for all cells
  const cornerR = Math.max(2, Math.round((cellSize - GAP) * 0.1));
  const colors = colorblindMode ? GRID_COLORS_CB : GRID_COLORS_NORMAL;
  const showSym = colorblindMode && cellSize >= 14;

  for (let i = 0; i < state.cells.length; i++) {
    const cell = state.cells[i];
    const col = i % W;
    const row = Math.floor(i / W);

    const x = offX + GAP + col * cellSize;
    const y = offY + GAP + row * cellSize;
    const w = cellSize - GAP;
    const h = cellSize - GAP;

    if (cell.ownerId) {
      const owner = state.players.get(cell.ownerId as string);
      const gColor = colors[cell.colorIndex as number] ?? "#888";

      if (owner) {
        const pColor = getPlayerColor(owner);
        const bStyle = (owner.borderStyle as string) || "solid";

        // Border fill-width: 20 % of the shorter side on each edge.
        // Player colour ~64 % of total area; grid colour visible in centre ~36 %.
        const bw = Math.max(2, Math.round(Math.min(w, h) * 0.2));
        const iw = Math.max(4, w - 2 * bw);
        const ih = Math.max(4, h - 2 * bw);
        const ix = x + bw;
        const iy = y + bw;
        const ir =
          bStyle === "rounded"
            ? Math.round(Math.min(iw, ih) * 0.4)
            : Math.max(1, Math.round(Math.min(iw, ih) * 0.1));

        // Outer fill: player colour
        ctx.fillStyle = pColor;
        ctx.beginPath();
        roundedRectPath(x, y, w, h, cornerR);
        ctx.fill();

        // Inner cutout: original grid colour
        ctx.fillStyle = gColor;
        ctx.beginPath();
        roundedRectPath(ix, iy, iw, ih, ir);
        ctx.fill();

        // Double: thin accent ring at inner boundary
        if (bStyle === "double" && iw > 8) {
          const aw = Math.max(1, Math.round(bw * 0.18));
          ctx.strokeStyle = pColor;
          ctx.lineWidth = aw;
          ctx.setLineDash([]);
          ctx.beginPath();
          roundedRectPath(
            ix + aw / 2,
            iy + aw / 2,
            iw - aw,
            ih - aw,
            Math.max(0, ir - aw / 2),
          );
          ctx.stroke();
        }

        if (showSym)
          drawCBSymbol(ctx, cell.colorIndex as number, ix, iy, iw, ih);
      } else {
        // Owner not yet synced
        ctx.fillStyle = gColor;
        ctx.beginPath();
        roundedRectPath(x, y, w, h, cornerR);
        ctx.fill();
        if (showSym) drawCBSymbol(ctx, cell.colorIndex as number, x, y, w, h);
      }
    } else {
      // Unowned: darkened grid colour
      ctx.fillStyle = colors[cell.colorIndex as number] ?? "#888";
      ctx.beginPath();
      roundedRectPath(x, y, w, h, cornerR);
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      roundedRectPath(x, y, w, h, cornerR);
      ctx.fill();
      if (showSym) drawCBSymbol(ctx, cell.colorIndex as number, x, y, w, h);
    }
  }

  // Capture animations and floating text drawn on top
  renderCaptureAnims(W);
  renderFloatingTexts();

  // Pulsing "you start here" ring — shown for the first 2.5 s of the game
  if (startAnimState) {
    const t = Math.min(1, (animNow - startAnimState.startTime) / 2500);
    const pulse = Math.abs(Math.sin(t * Math.PI * 9)) * Math.pow(1 - t, 0.7);
    if (pulse > 0.02) {
      const col = startAnimState.cellIdx % W;
      const row = Math.floor(startAnimState.cellIdx / W);
      const x = offX + GAP + col * cellSize - 3;
      const y = offY + GAP + row * cellSize - 3;
      const sz = cellSize - GAP + 6;
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${(pulse * 0.9).toFixed(3)})`;
      ctx.lineWidth = Math.max(2, cellSize * 0.07);
      ctx.setLineDash([]);
      ctx.beginPath();
      roundedRectPath(x, y, sz, sz, 5);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (zoomed) ctx.restore();
}

function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Capture animations ───────────────────────────────────────────────────────
//
// Each captured cell plays:
//  • Phase 0 – 40 %  : colour fill fades from 65 % alpha → 0   (flash)
//  • Phase 0 – 100 % : expanding ellipse ring fades out          (ripple)

function renderCaptureAnims(W: number) {
  if (!captureAnims.size) return;
  const now = performance.now();
  const DURATION = 320; // short & snappy
  const { offX, offY, cellSize, GAP } = gridParams;

  for (const [cellIdx, anim] of captureAnims) {
    const t = (now - anim.startTime) / DURATION;
    if (t >= 1) {
      captureAnims.delete(cellIdx);
      continue;
    }

    const col = cellIdx % W;
    const row = Math.floor(cellIdx / W);
    const x = offX + GAP + col * cellSize;
    const y = offY + GAP + row * cellSize;
    const w = cellSize - GAP;
    const h = cellSize - GAP;

    ctx.save();

    // ── Instant ring: appears immediately at cell edge, fades in first half ──
    const ringAlpha = Math.max(0, 1 - t * 2.2) * 0.9;
    if (ringAlpha > 0) {
      ctx.globalAlpha = ringAlpha;
      ctx.strokeStyle = anim.color;
      ctx.lineWidth = Math.max(2, Math.round(GAP * 0.4)); // ~40 % of gap width
      // draw ring just outside the cell border so it's clearly visible over the gap
      const pad = Math.round(GAP * 0.3);
      ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    }

    // ── Inner block blink/fade: cosine wave decays with envelope ──
    // cos starts at 1 (immediate full flash), oscillates ~2×, fades out
    const blinkAlpha =
      Math.abs(Math.cos(t * Math.PI * 2.2)) * Math.pow(1 - t, 1.4) * 0.65;
    ctx.globalAlpha = blinkAlpha;
    ctx.fillStyle = anim.color;
    ctx.fillRect(x, y, w, h);

    ctx.restore();
  }
}

// ─── Colorblind shape overlays ────────────────────────────────────────────────

function drawCBSymbol(
  ctx: CanvasRenderingContext2D,
  colorIndex: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const cx = x + w / 2,
    cy = y + h / 2;
  const sz = Math.min(w, h) * 0.3;

  ctx.beginPath();
  switch (colorIndex) {
    case 0:
      ctx.arc(cx, cy, sz, 0, Math.PI * 2);
      break; // ● circle
    case 1: // ◆ diamond
      ctx.moveTo(cx, cy - sz);
      ctx.lineTo(cx + sz, cy);
      ctx.lineTo(cx, cy + sz);
      ctx.lineTo(cx - sz, cy);
      ctx.closePath();
      break;
    case 2: // ▲ triangle
      ctx.moveTo(cx, cy - sz);
      ctx.lineTo(cx + sz * 0.866, cy + sz * 0.5);
      ctx.lineTo(cx - sz * 0.866, cy + sz * 0.5);
      ctx.closePath();
      break;
    case 3: // ■ square
      ctx.rect(cx - sz * 0.75, cy - sz * 0.75, sz * 1.5, sz * 1.5);
      break;
  }
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
}

// ─── Colour / style helpers ───────────────────────────────────────────────────

function getPlayerColor(p: any): string {
  return (
    p?.playerColor ||
    PLAYER_COLORS[(p?.playerIndex ?? 0) % PLAYER_COLORS.length]
  );
}

function getBorderRadius(p: any): string {
  return p?.borderStyle === "rounded" ? "50%" : "50%"; // dot is always circular
}

function darkenColor(hex: string, f: number): string {
  const [r, g, b] = parseHexColor(hex);
  return toHexColor(
    Math.round(r * (1 - f)),
    Math.round(g * (1 - f)),
    Math.round(b * (1 - f)),
  );
}
function lightenColor(hex: string, f: number): string {
  const [r, g, b] = parseHexColor(hex);
  return toHexColor(
    Math.min(255, Math.round(r + (255 - r) * f)),
    Math.min(255, Math.round(g + (255 - g) * f)),
    Math.min(255, Math.round(b + (255 - b) * f)),
  );
}
function parseHexColor(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16) || 0;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function toHexColor(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Returns true if `hex` is visually distinct from every grid base colour.
 * Uses Euclidean RGB distance; threshold = 80 (out of ~441 max).
 * Colours that are too close to Red, Blue, Green, or Orange will be disabled in the picker.
 */
function passesContrastCheck(hex: string): boolean {
  const [r1, g1, b1] = parseHexColor(hex);
  for (const base of GRID_COLORS_NORMAL) {
    const [r2, g2, b2] = parseHexColor(base);
    if (Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) < 80)
      return false;
  }
  return true;
}

/** True when two player colours are within `threshold` on every RGB channel (Chebyshev). */
function colorsTooSimilar(a: string, b: string, threshold: number): boolean {
  const [r1, g1, b1] = parseHexColor(a);
  const [r2, g2, b2] = parseHexColor(b);
  return (
    Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2)) <=
    threshold
  );
}

/** Disable / grey-out swatches that fall within the player-count-scaled threshold of another player's colour. */
function markTakenSwatches(state: any) {
  const myColor = state.players.get(mySessionId)?.playerColor ?? "";
  const otherColors: string[] = [];
  state.players.forEach((p: any, sid: string) => {
    if (sid !== mySessionId && p.playerColor) otherColors.push(p.playerColor);
  });
  const threshold = similarityThreshold(state.players.size);
  document.querySelectorAll<HTMLButtonElement>(".swatch-btn").forEach((btn) => {
    const c = btn.dataset.color!;
    const taken =
      c !== myColor &&
      otherColors.some((oc) => colorsTooSimilar(c, oc, threshold));
    btn.classList.toggle("taken", taken);
    btn.disabled = taken;
    btn.title = taken ? "Taken by another player" : c;
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
