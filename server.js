const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // roomName -> Set(ws)
const rid = () => Math.random().toString(36).slice(2, 10);

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { (rooms.get(room) || []).forEach(c => send(c, obj)); }
function sendPeers(room) {
  const list = [...(rooms.get(room) || [])].map(c => ({ peer: c.id, name: c.pname }));
  broadcast(room, { t: 'peers', list });
}

wss.on('connection', ws => {
  ws.id = rid(); ws.room = null; ws.pname = '';
  ws.on('message', raw => {
    if (raw.length > 8192) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && typeof m.room === 'string' && /^[a-z0-9]{1,20}$/.test(m.room) && !ws.room) {
      ws.room = m.room;
      if (!rooms.has(m.room)) rooms.set(m.room, new Set());
      rooms.get(m.room).add(ws);
      send(ws, { t: 'hello', peer: ws.id });
      sendPeers(m.room);
    } else if (m.t === 'presence' && ws.room) {
      ws.pname = String(m.name || '').slice(0, 16);
      sendPeers(ws.room);
    } else if (m.t === 'emit' && ws.room && /^[a-z]{1,20}$/.test(m.topic)) {
      broadcast(ws.room, { t: 'msg', topic: m.topic, data: m.data, peer: ws.id });
    }
  });
  ws.on('close', () => {
    if (!ws.room) return;
    const set = rooms.get(ws.room);
    set.delete(ws);
    if (set.size === 0) rooms.delete(ws.room); else sendPeers(ws.room);
  });
});

server.listen(PORT, () => console.log('Game running on port ' + PORT));
