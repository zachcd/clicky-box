# Clicky Box

A real-time multiplayer colour-conquest game built with [Colyseus](https://colyseus.io/) (Node.js) and Vite (TypeScript client).

---

## Gameplay

- Players join a shared lobby and **ready up** to start.
- The board is a **2-D grid** whose size scales with the player count (`40 cells × players`, rounded to the nearest square).
- Every cell has one of **4 underlying colours** (Red, Blue, Green, Orange) assigned randomly at game start. Colours never change.
- Each **turn** is a **15-second countdown** shown as a colour-changing bar at the top of the screen.
- On your turn pick any one of the 4 colours. The server **flood-fills** outward from all of your territory, capturing every connected cell of that colour — **including cells already owned by other players**. Submission order matters: whoever hits the server first wins contested groups.
- Captured cells display their original colour with a **coloured outline** matching the capturing player.
- Your **starting cell** (a corner or edge midpoint) is shown as your player colour outline from turn 1.
- The game ends when every cell is owned **or** after 60 turns. Most cells wins.

---

## Project structure

```
clicky-box/
├── package.json          # npm workspaces root
│
├── server/               # Colyseus game server (Node.js + TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # HTTP + WebSocket server entry point
│       └── rooms/
│           └── GameRoom.ts       # All game logic + Colyseus Schema
│
└── client/               # Vite + TypeScript browser client
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.ts       # Colyseus client, UI, canvas renderer
        └── style.css
```

---

## Getting started

### 1 — Install dependencies

```bash
npm install          # installs both server and client workspaces
```

### 2 — Start the game server

```bash
npm run dev:server
# Server: ws://localhost:2567
```

### 3 — Start the client (in a second terminal)

```bash
npm run dev:client
# Client: http://localhost:5173
```

Open **two or more** browser tabs to `http://localhost:5173`, enter names, and ready up.

---

## Configuration

| Variable | Default | Where |
|---|---|---|
| `PORT` | `2567` | server env |
| `VITE_SERVER_URL` | `ws://localhost:2567` | client `.env` |

Create `client/.env` to point at a remote server:
```
VITE_SERVER_URL=wss://your-server.example.com
```

---

## Game constants (server/src/rooms/GameRoom.ts)

| Constant | Default | Description |
|---|---|---|
| `TURN_DURATION_SECONDS` | `15` | Seconds per turn |
| `LOBBY_COUNTDOWN_SECONDS` | `5` | Countdown before game starts |
| `MAX_TURNS` | `60` | Turn limit |
| `MIN_PLAYERS` | `2` | Min players to start |
| `CELLS_PER_PLAYER` | `40` | Grid area per player |
