import { Client } from "colyseus.js";

// ─── Grid palettes ────────────────────────────────────────────────────────────

const GRID_COLORS_NORMAL = ["#E74C3C", "#3498DB", "#2ECC71", "#F39C12"] as const;
const GRID_COLORS_CB     = ["#D55E00", "#0072B2", "#009E73", "#F0E442"] as const;
const GRID_NAMES         = ["Red",     "Blue",    "Green",   "Orange" ] as const;
const GRID_KEYS          = ["Q",       "W",       "E",       "R"      ] as const;
const GRID_KEY_CODES     = ["q",       "w",       "e",       "r"      ];

/** Fallback identity colours when a player hasn't picked one yet */
const PLAYER_COLORS = [
  "#9B59B6", "#1ABC9C", "#E91E63", "#F1C40F",
  "#00BCD4", "#FF5722", "#7F8C8D", "#795548",
] as const;

// ─── Player colour palette ─────────────────────────────────────────────────────────────────────

/** Convert HSL (h 0–360, s 0–1, l 0–1) to a #rrggbb hex string. */
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

/** Player palette: 20 hues × 3 lightness rings, pre-filtered to ≥ 80 Euclidean from every grid colour.
 *  Mirrors the server-side PLAYER_PALETTE so auto-assigned colours appear in the picker. */
const PLAYER_PALETTE: ReadonlyArray<string> = (() => {
  const colours: string[] = [];
  const hues = Array.from({ length: 20 }, (_, i) => i * 18);
  // vivid (S=85 % L=45 %), pastel (S=70 % L=70 %), dark (S=80 % L=30 %)
  for (const [s, l] of [[0.85, 0.45], [0.70, 0.70], [0.80, 0.30]] as [number, number][]) {
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
  const MAX_T = 80, MIN_T = 5, MAX_P = 8;
  const t = Math.max(0, Math.min(1, (playerCount - 2) / (MAX_P - 2)));
  return Math.round(MAX_T + (MIN_T - MAX_T) * t);
}

/** Border styles — only those that render cleanly at all cell sizes */
const BORDER_STYLES = [
  { id: "solid",   label: "Solid",  css: "3px solid",  radius: ""    },
  { id: "double",  label: "Double", css: "5px double", radius: ""    },
  { id: "rounded", label: "Round",  css: "3px solid",  radius: "7px" },
] as const;

const MIN_PLAYERS = 2;

// ─── Client state ─────────────────────────────────────────────────────────────

let colorblindMode = localStorage.getItem("cb") === "1";

// Grid render params — written every frame, read by the click handler
const gridParams = { offX: 0, offY: 0, cellSize: 1, W: 0, H: 0, GAP: 10 };

// ─── Capture animations ───────────────────────────────────────────────────────

interface CaptureAnim { startTime: number; color: string; }
const captureAnims = new Map<number, CaptureAnim>();

function triggerCaptureAnim(cellIdx: number, color: string) {
  captureAnims.set(cellIdx, { startTime: performance.now(), color });
}

// Local submission guard — prevents state-patch race from re-enabling the colour
// buttons before the server has echoed back our selectColor confirmation.
let localHasSubmitted = false;
let lastTurnSeen      = -1;

// Previous ownership map — used to detect which cells just changed hands
const prevOwners = new Map<number, string>();

function detectOwnerChanges(state: any) {
  if (!state.cells?.length || state.phase !== "playing") {
    if (state.phase !== "playing") {
      prevOwners.clear();
      captureAnims.clear();
    }
    return;
  }
  for (let i = 0; i < state.cells.length; i++) {
    const curr: string = state.cells[i].ownerId ?? "";
    const prev = prevOwners.get(i);
    if (prev !== undefined && curr !== prev && curr !== "") {
      const owner = state.players.get(curr);
      if (owner) triggerCaptureAnim(i, getPlayerColor(owner));
    }
    prevOwners.set(i, curr);
  }
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const screens = {
  connect:  $("screen-connect"),
  lobby:    $("screen-lobby"),
  game:     $("screen-game"),
  gameover: $("screen-gameover"),
};

const canvas = $<HTMLCanvasElement>("grid-canvas");
const ctx    = canvas.getContext("2d")!;

// ─── Colyseus ─────────────────────────────────────────────────────────────────

let client: Client | null = null;
let room:   any           = null;
let mySessionId           = "";
let prevPhase             = "";

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  buildColorButtons();
  buildSwatches();
  buildBorderStyleButtons();
  applyCbToggle();

  $("join-btn").addEventListener("click", joinGame);
  $("name-input").addEventListener("keydown", e => { if (e.key === "Enter") joinGame(); });
  $("ready-btn").addEventListener("click", () => room?.send("ready"));
  $("play-again-btn").addEventListener("click", () => room?.send("playAgain"));

  $("cb-toggle").addEventListener("click", () => {
    colorblindMode = !colorblindMode;
    localStorage.setItem("cb", colorblindMode ? "1" : "0");
    applyCbToggle();
    buildColorButtons();
  });

  $<HTMLInputElement>("custom-color").addEventListener("change", e => {
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
  document.querySelectorAll<HTMLButtonElement>(".color-btn").forEach((btn, i) => {
    btn.style.background = colors[i];
    btn.innerHTML =
      `<span class="btn-label">${GRID_NAMES[i]}</span><kbd>${GRID_KEYS[i]}</kbd>`;
  });
}

// ─── Lobby appearance: colour swatches ───────────────────────────────────────

function buildSwatches() {
  const row = $("color-swatches");
  row.innerHTML = "";
  for (const color of PLAYER_PALETTE) {   // palette is pre-filtered; every entry is safe
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
    preview.style.border       = `${style.css} ${previewColor}`;
    preview.style.borderRadius = style.radius;

    btn.appendChild(preview);
    btn.addEventListener("click", () => room?.send("setAppearance", { borderStyle: style.id }));
    row.appendChild(btn);
  }
}

function updateAppearanceSelection(playerColor: string, bStyle: string) {
  const resolvedColor = playerColor || PLAYER_COLORS[0];

  // Highlight matching swatch
  document.querySelectorAll<HTMLButtonElement>(".swatch-btn").forEach(btn => {
    btn.classList.toggle("selected", btn.dataset.color === playerColor);
  });

  // Sync custom colour picker
  $<HTMLInputElement>("custom-color").value = resolvedColor;

  // Update border style previews with current colour + highlight selection
  document.querySelectorAll<HTMLButtonElement>(".bs-btn").forEach(btn => {
    btn.classList.toggle("selected", btn.dataset.style === bStyle);
    const preview = btn.querySelector(".bs-preview") as HTMLElement | null;
    const def     = BORDER_STYLES.find(s => s.id === btn.dataset.style);
    if (preview && def) {
      preview.style.border       = `${def.css} ${resolvedColor}`;
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
  for (const [k, el] of Object.entries(screens)) el.classList.toggle("hidden", k !== name);
  if (name === "game") resizeCanvas();
}

function resizeCanvas() {
  const wrap  = $("canvas-wrap");
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}

// ─── Join ─────────────────────────────────────────────────────────────────────

async function joinGame() {
  const nameInput = $<HTMLInputElement>("name-input");
  const errorEl   = $("connect-error");
  const name      = nameInput.value.trim() || "Anonymous";
  errorEl.textContent = "";

  const serverUrl = (import.meta as any).env?.VITE_SERVER_URL ?? "ws://localhost:2567";
  try {
    client      = new Client(serverUrl);
    room        = await client.joinOrCreate("game", { name });
    mySessionId = room.sessionId as string;
    prevPhase   = "";

    room.onStateChange((state: any) => {
      detectOwnerChanges(state);
      updateUI(state);
    });
    room.onError((_c: number, msg: string) => console.error("Room error:", msg));
    room.onLeave(() => { room = null; showScreen("connect"); });
    room.onMessage("colorConflict", () => {
      const warn = $("color-warn");
      warn.style.display = "block";
      warn.textContent   = "Too similar to another player’s colour — try something else.";
      const me = room?.state?.players?.get(mySessionId);
      if (me) $<HTMLInputElement>("custom-color").value = getPlayerColor(me);
      setTimeout(() => { warn.style.display = "none"; warn.textContent = ""; }, 3_000);
    });

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
  if (idx !== -1) { e.preventDefault(); onColorPick(idx); }
}

// ─── Canvas click → pick colour of clicked cell ───────────────────────────────

function onCanvasClick(e: MouseEvent) {
  if (!room) return;
  const state = room.state as any;
  if (state?.phase !== "playing") return;
  const me = state.players.get(mySessionId);
  if (!me || me.hasSubmitted) return;

  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx     = (e.clientX - rect.left) * scaleX;
  const cy     = (e.clientY - rect.top)  * scaleY;

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
  if (localHasSubmitted) return;   // already picked this turn
  localHasSubmitted = true;        // optimistic lock — no re-enable until next turn
  setColorBtnsEnabled(false, colorIndex);
  room.send("selectColor", { colorIndex });
}

function setColorBtnsEnabled(enabled: boolean, chosenIdx = -1) {
  document.querySelectorAll<HTMLButtonElement>(".color-btn").forEach((btn, i) => {
    btn.disabled = !enabled;
    btn.classList.toggle("chosen",   !enabled && i === chosenIdx);
    btn.classList.toggle("unchosen", !enabled && i !== chosenIdx);
  });
}

// ─── Master UI update ─────────────────────────────────────────────────────────

function updateUI(state: any) {
  if (!state) return;
  const { phase } = state;

  if (phase !== prevPhase) {
    prevPhase = phase;
    if      (phase === "lobby")    showScreen("lobby");
    else if (phase === "playing")  {
      showScreen("game");
      localHasSubmitted = false;  // fresh game — clear any leftover lock
      lastTurnSeen      = -1;
      setColorBtnsEnabled(true);
    }
    else if (phase === "gameover") showScreen("gameover");
  }

  if (phase === "lobby")    updateLobby(state);
  if (phase === "playing")  updateGame(state);
  if (phase === "gameover") updateGameover(state);
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

function updateLobby(state: any) {
  const listEl = $("player-list");
  listEl.innerHTML = "";

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
    statusEl.className   = "lobby-status countdown";
  } else {
    const nReady = [...state.players.values()].filter((p: any) => p.ready).length;
    statusEl.textContent = `${nReady} / ${state.players.size} ready  ·  need ${MIN_PLAYERS} to start`;
    statusEl.className   = "lobby-status";
  }
}

// ─── Game HUD ─────────────────────────────────────────────────────────────────

function updateGame(state: any) {
  $("turn-counter").textContent = `Turn ${state.currentTurn + 1}`;

  const pct  = Math.max(0, Math.min(1, state.turnTimeLeft)) * 100;
  const fill = $("timer-fill");
  fill.style.width      = `${pct}%`;
  fill.style.background = pct > 50 ? "#2ecc71" : pct > 25 ? "#f39c12" : "#e74c3c";
  $("hud").classList.toggle("realtime", !!state.isRealtime);

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
      const gc = (colorblindMode ? GRID_COLORS_CB : GRID_COLORS_NORMAL)[p.submittedColor];
      sub = `<span class="sub-dot" style="background:${gc}">✓</span>`;
    }
    div.innerHTML =
      `<span class="dot" style="background:${getPlayerColor(p)}"></span>` +
      `<span class="pname">${esc(p.name)}</span>` +
      `<span class="pts">${p.captures} captures</span>${sub}`;
    scoreEl.appendChild(div);
  }

  // Reset local submission guard when a new turn starts
  if (state.currentTurn !== lastTurnSeen) {
    lastTurnSeen     = state.currentTurn;
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
  document.querySelectorAll<HTMLButtonElement>(".color-btn").forEach((btn, i) => {
    btn.style.background = colors[i];
  });
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
      `<span class="medal">${medals[i] ?? (i + 1) + "."}</span>` +
      `<span class="dot" style="background:${getPlayerColor(p)}"></span>` +
      `<span class="pname">${esc(p.name)}</span>` +
      `<span class="pts">${p.captures} captures</span>`;
    scoresEl.appendChild(div);
  });
  $("gameover-note").textContent = "Lobby resets automatically in 10 s";
}

// ─── Canvas render loop ───────────────────────────────────────────────────────

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
  const W = state.gridWidth  as number;
  const H = state.gridHeight as number;
  if (!W || !H || !state.cells?.length) return;

  const GAP      = 10;  // wider gap → crisper grid lines

  // cellSize must exceed GAP so cell content stays positive
  const cellSize = Math.max(GAP + 4, Math.min(
    Math.floor((canvas.width  - GAP) / W),
    Math.floor((canvas.height - GAP) / H),
  ));

  const totalW = cellSize * W + GAP;
  const totalH = cellSize * H + GAP;
  const offX   = Math.floor((canvas.width  - totalW) / 2);
  const offY   = Math.floor((canvas.height - totalH) / 2);

  Object.assign(gridParams, { offX, offY, cellSize, W, H, GAP });

  ctx.fillStyle = "#0f0f1a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#050509";          // very dark gap / grid-line colour
  ctx.fillRect(offX, offY, totalW, totalH);

  // Border covers ~50 % of the cell’s visual area (each side ≈ 15 % of content width)

  // 10 % corner radius for all cells
  const cornerR = Math.max(2, Math.round((cellSize - GAP) * 0.1));
  const colors  = colorblindMode ? GRID_COLORS_CB : GRID_COLORS_NORMAL;
  const showSym = colorblindMode && cellSize >= 14;

  for (let i = 0; i < state.cells.length; i++) {
    const cell = state.cells[i];
    const col  = i % W;
    const row  = Math.floor(i / W);

    const x = offX + GAP + col * cellSize;
    const y = offY + GAP + row * cellSize;
    const w = cellSize - GAP;
    const h = cellSize - GAP;

    if (cell.ownerId) {
      const owner  = state.players.get(cell.ownerId as string);
      const gColor = colors[cell.colorIndex as number] ?? "#888";

      if (owner) {
        const pColor = getPlayerColor(owner);
        const bStyle = (owner.borderStyle as string) || "solid";

        // Border fill-width: 20 % of the shorter side on each edge.
        // Player colour ~64 % of total area; grid colour visible in centre ~36 %.
        const bw = Math.max(2, Math.round(Math.min(w, h) * 0.20));
        const iw = Math.max(4, w - 2 * bw);
        const ih = Math.max(4, h - 2 * bw);
        const ix = x + bw;
        const iy = y + bw;
        const ir = bStyle === "rounded"
          ? Math.round(Math.min(iw, ih) * 0.4)
          : Math.max(1, Math.round(Math.min(iw, ih) * 0.1));

        // Outer fill: player colour
        ctx.fillStyle = pColor;
        ctx.beginPath(); roundedRectPath(x, y, w, h, cornerR); ctx.fill();

        // Inner cutout: original grid colour
        ctx.fillStyle = gColor;
        ctx.beginPath(); roundedRectPath(ix, iy, iw, ih, ir); ctx.fill();

        // Double: thin accent ring at inner boundary
        if (bStyle === "double" && iw > 8) {
          const aw = Math.max(1, Math.round(bw * 0.18));
          ctx.strokeStyle = pColor;
          ctx.lineWidth   = aw;
          ctx.setLineDash([]);
          ctx.beginPath();
          roundedRectPath(ix + aw / 2, iy + aw / 2, iw - aw, ih - aw, Math.max(0, ir - aw / 2));
          ctx.stroke();
        }

        if (showSym) drawCBSymbol(ctx, cell.colorIndex as number, ix, iy, iw, ih);
      } else {
        // Owner not yet synced
        ctx.fillStyle = gColor;
        ctx.beginPath(); roundedRectPath(x, y, w, h, cornerR); ctx.fill();
        if (showSym) drawCBSymbol(ctx, cell.colorIndex as number, x, y, w, h);
      }
    } else {
      // Unowned: darkened grid colour
      ctx.fillStyle = colors[cell.colorIndex as number] ?? "#888";
      ctx.beginPath(); roundedRectPath(x, y, w, h, cornerR); ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath(); roundedRectPath(x, y, w, h, cornerR); ctx.fill();
      if (showSym) drawCBSymbol(ctx, cell.colorIndex as number, x, y, w, h);
    }
  }

  // Capture animations drawn on top
  renderCaptureAnims(W);
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h,     x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y,         x + r, y);
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
    if (t >= 1) { captureAnims.delete(cellIdx); continue; }

    const col = cellIdx % W;
    const row = Math.floor(cellIdx / W);
    const x   = offX + GAP + col * cellSize;
    const y   = offY + GAP + row * cellSize;
    const w   = cellSize - GAP;
    const h   = cellSize - GAP;

    ctx.save();

    // ── Instant ring: appears immediately at cell edge, fades in first half ──
    const ringAlpha = Math.max(0, 1 - t * 2.2) * 0.9;
    if (ringAlpha > 0) {
      ctx.globalAlpha = ringAlpha;
      ctx.strokeStyle = anim.color;
      ctx.lineWidth   = Math.max(2, Math.round(GAP * 0.4)); // ~40 % of gap width
      // draw ring just outside the cell border so it's clearly visible over the gap
      const pad = Math.round(GAP * 0.3);
      ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    }

    // ── Inner block blink/fade: cosine wave decays with envelope ──
    // cos starts at 1 (immediate full flash), oscillates ~2×, fades out
    const blinkAlpha = Math.abs(Math.cos(t * Math.PI * 2.2)) * Math.pow(1 - t, 1.4) * 0.65;
    ctx.globalAlpha = blinkAlpha;
    ctx.fillStyle   = anim.color;
    ctx.fillRect(x, y, w, h);

    ctx.restore();
  }
}

// ─── Colorblind shape overlays ────────────────────────────────────────────────

function drawCBSymbol(
  ctx: CanvasRenderingContext2D,
  colorIndex: number,
  x: number, y: number, w: number, h: number,
) {
  const cx = x + w / 2, cy = y + h / 2;
  const sz = Math.min(w, h) * 0.3;

  ctx.beginPath();
  switch (colorIndex) {
    case 0: ctx.arc(cx, cy, sz, 0, Math.PI * 2); break;        // ● circle
    case 1:                                                     // ◆ diamond
      ctx.moveTo(cx, cy - sz); ctx.lineTo(cx + sz, cy);
      ctx.lineTo(cx, cy + sz); ctx.lineTo(cx - sz, cy);
      ctx.closePath(); break;
    case 2:                                                     // ▲ triangle
      ctx.moveTo(cx, cy - sz);
      ctx.lineTo(cx + sz * 0.866, cy + sz * 0.5);
      ctx.lineTo(cx - sz * 0.866, cy + sz * 0.5);
      ctx.closePath(); break;
    case 3:                                                     // ■ square
      ctx.rect(cx - sz * 0.75, cy - sz * 0.75, sz * 1.5, sz * 1.5); break;
  }
  ctx.fillStyle   = "rgba(255,255,255,0.72)";
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth   = 1;
  ctx.fill();
  ctx.stroke();
}

// ─── Colour / style helpers ───────────────────────────────────────────────────

function getPlayerColor(p: any): string {
  return p?.playerColor || PLAYER_COLORS[(p?.playerIndex ?? 0) % PLAYER_COLORS.length];
}

function getBorderRadius(p: any): string {
  return (p?.borderStyle === "rounded") ? "50%" : "50%"; // dot is always circular
}

function darkenColor(hex: string, f: number): string {
  const [r, g, b] = parseHexColor(hex);
  return toHexColor(Math.round(r*(1-f)), Math.round(g*(1-f)), Math.round(b*(1-f)));
}
function lightenColor(hex: string, f: number): string {
  const [r, g, b] = parseHexColor(hex);
  return toHexColor(
    Math.min(255, Math.round(r + (255-r)*f)),
    Math.min(255, Math.round(g + (255-g)*f)),
    Math.min(255, Math.round(b + (255-b)*f)),
  );
}
function parseHexColor(hex: string): [number,number,number] {
  const n = parseInt(hex.replace("#",""), 16) || 0;
  return [(n>>16)&0xff, (n>>8)&0xff, n&0xff];
}
function toHexColor(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`;
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
    if (Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) < 80) return false;
  }
  return true;
}

/** True when two player colours are within `threshold` on every RGB channel (Chebyshev). */
function colorsTooSimilar(a: string, b: string, threshold: number): boolean {
  const [r1, g1, b1] = parseHexColor(a);
  const [r2, g2, b2] = parseHexColor(b);
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2)) <= threshold;
}

/** Disable / grey-out swatches that fall within the player-count-scaled threshold of another player's colour. */
function markTakenSwatches(state: any) {
  const myColor      = state.players.get(mySessionId)?.playerColor ?? "";
  const otherColors: string[] = [];
  state.players.forEach((p: any, sid: string) => {
    if (sid !== mySessionId && p.playerColor) otherColors.push(p.playerColor);
  });
  const threshold = similarityThreshold(state.players.size);
  document.querySelectorAll<HTMLButtonElement>(".swatch-btn").forEach(btn => {
    const c     = btn.dataset.color!;
    const taken = c !== myColor && otherColors.some(oc => colorsTooSimilar(c, oc, threshold));
    btn.classList.toggle("taken", taken);
    btn.disabled = taken;
    btn.title    = taken ? "Taken by another player" : c;
  });
}

function esc(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
