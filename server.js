// USA Tank Battle - Render-ready WebSocket + Static Hosting
// Deploy as a Render "Web Service". Render provides PORT via process.env.PORT.
// This server:
// - Serves the HTML game at /
// - Accepts WebSocket connections on the same origin (wss://your-app.onrender.com)

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// --- Matchmaking state ---
const clients = new Map();        // ws -> {id, tier, tankName, roomId}
const waitingByTier = new Map();  // tier -> ws
const rooms = new Map();          // roomId -> {hostWs, clientWs, tier}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function cleanup(ws) {
  const c = clients.get(ws);
  if (!c) return;

  if (c.tier != null) {
    const w = waitingByTier.get(c.tier);
    if (w === ws) waitingByTier.delete(c.tier);
  }

  if (c.roomId && rooms.has(c.roomId)) {
    const room = rooms.get(c.roomId);
    const other = (room.hostWs === ws) ? room.clientWs : room.hostWs;
    send(other, { type: "info", text: "Opponent disconnected." });
    try { other.close(); } catch (_) {}
    rooms.delete(c.roomId);
  }

  clients.delete(ws);
}

// --- HTTP server (serves the game) ---
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    try {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Missing public/index.html");
    }
    return;
  }

  // Static files if you add assets later
  const safePath = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = ext === ".js" ? "text/javascript"
             : ext === ".css" ? "text/css"
             : ext === ".png" ? "image/png"
             : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
             : "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct });
    res.end(data);
  });
});

// --- WebSocket server on SAME port ---
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  const id = uid();
  clients.set(ws, { id, tier: null, tankName: null, roomId: null });
  send(ws, { type: "welcome", id });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString("utf8")); } catch (_) { return; }
    const c = clients.get(ws);
    if (!c) return;

    if (msg.type === "join") {
      c.tier = Number(msg.tier || 1);
      c.tankName = String(msg.tankName || "Tank");

      const waiting = waitingByTier.get(c.tier);
      if (waiting && waiting !== ws && clients.has(waiting)) {
        waitingByTier.delete(c.tier);

        const roomId = uid();
        const hostWs = waiting;
        const clientWs = ws;

        const host = clients.get(hostWs);
        const client = clients.get(clientWs);

        host.roomId = roomId;
        client.roomId = roomId;

        rooms.set(roomId, { hostWs, clientWs, tier: c.tier });

        send(hostWs,   { type: "matched", roomId, hostId: host.id, peerId: client.id });
        send(clientWs, { type: "matched", roomId, hostId: host.id, peerId: host.id });

        send(hostWs, { type: "hostStart" });
        send(clientWs, { type: "info", text: "Waiting for host to start…" });
      } else {
        waitingByTier.set(c.tier, ws);
        send(ws, { type: "info", text: "Searching for opponent (same tier)..." });
      }
      return;
    }

    if (msg.type === "input") {
      if (!c.roomId) return;
      const room = rooms.get(c.roomId);
      if (!room) return;
      if (room.hostWs !== ws) {
        send(room.hostWs, { type: "input", payload: msg.payload || {} });
      }
      return;
    }

    if (msg.type === "init" || msg.type === "snapshot") {
      if (!c.roomId) return;
      const room = rooms.get(c.roomId);
      if (!room) return;
      if (room.hostWs === ws) {
        send(room.clientWs, { type: msg.type, payload: msg.payload || {} });
      }
      return;
    }
  });

  ws.on("close", () => cleanup(ws));
  ws.on("error", () => cleanup(ws));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Web + WebSocket server listening on port ${PORT}`);
});
