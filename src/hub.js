import { DurableObject } from 'cloudflare:workers';

const ROOMS = ['A', 'B', 'C', 'D'];
const ROOM_CAPACITY = 16;
const TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_CAP = 300;
// Drawings are 1-bit bitmaps, same size as the client's pad (stored at 2x).
const CANVAS_W = 464;
const CANVAS_H = 160;
const BITMAP_BYTES = (CANVAS_W * CANVAS_H) / 8;
const MIN_SEND_INTERVAL_MS = 1000;
// A dropped connection keeps its seat briefly so network blips don't spam enter/leave.
const RECONNECT_GRACE_MS = 10_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
// After a restart (every deploy), sockets vanish without close events. People get this long to
// reconnect before they're shown as leaving.
const RESTART_SWEEP_MS = 30_000;
// Cloudflare caps WebSocket messages at 1 MiB; ~40 drawings is ~500 KB.
const HISTORY_CHUNK = 40;
const COLOR_COUNT = 16;
const NAME_MAX = 10;
const ID_RE = /^[\w-]{8,64}$/;

function cleanName(v) {
  if (typeof v !== 'string') return 'Guest';
  const s = [...v.replace(/\p{C}/gu, '').trim()].slice(0, NAME_MAX).join('').trim();
  return s || 'Guest';
}

function cleanColor(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < COLOR_COUNT ? n : 0;
}

function validBits(bits) {
  if (typeof bits !== 'string' || bits.length > 16384) return false;
  let bin;
  try {
    bin = atob(bits);
  } catch {
    return false;
  }
  return bin.length === BITMAP_BYTES && /[^\0]/.test(bin);
}

function send(ws, obj) {
  try {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  } catch {}
}

/**
 * One Durable Object runs the whole app: every socket, all four rooms, and their history.
 *
 * Sockets use the Hibernation API, so the object can sleep between messages. Anything a
 * socket needs to remember (who it is, which room it's in) lives in its attachment; shared
 * state (history, visitors, who is in which room) lives in SQLite.
 *
 * Room membership is the `presence` table, not the live sockets, so it survives restarts: a
 * reconnect from someone already listed is a silent rejoin, never a second "Now entering".
 */
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS entries_room ON entries (room, seq)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS visitors (vid TEXT PRIMARY KEY, ts INTEGER NOT NULL)');
    // Who is in each room. `expires` is NULL while connected; once they drop it's the end of
    // their reconnect grace window, after which they're announced as leaving.
    this.sql.exec('DROP TABLE IF EXISTS grace');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS presence (
      id TEXT PRIMARY KEY, room TEXT NOT NULL, name TEXT NOT NULL, color INTEGER NOT NULL, expires INTEGER)`);

    // Heartbeats are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    // If anyone is listed as connected but has no socket, we just restarted: sweep them soon.
    ctx.blockConcurrencyWhile(async () => {
      const live = new Set(ctx.getWebSockets().map((ws) => ws.deserializeAttachment()?.id));
      const orphaned = this.sql
        .exec('SELECT id FROM presence WHERE expires IS NULL')
        .toArray()
        .some((r) => !live.has(r.id));
      if (orphaned) await this.scheduleAlarm(Date.now() + RESTART_SWEEP_MS);
    });
  }

  // ---------- connection lifecycle ----------

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), vid: null, name: 'Guest', color: 0, hello: false, room: null, lastSend: 0 });
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    const a = ws.deserializeAttachment();
    switch (d?.t) {
      case 'visit':
        if (!a.vid && typeof d.vid === 'string' && ID_RE.test(d.vid)) {
          a.vid = d.vid;
          ws.serializeAttachment(a);
          this.touchVisitor(a.vid);
          this.broadcastStats();
        } else {
          send(ws, this.stats());
        }
        send(ws, { t: 'lobby', rooms: this.lobbySnapshot() });
        break;
      case 'hello':
        if (typeof d.id === 'string' && ID_RE.test(d.id)) a.id = d.id;
        a.name = cleanName(d.name);
        a.color = cleanColor(d.color);
        a.hello = true;
        ws.serializeAttachment(a);
        break;
      case 'join':
        await this.join(ws, a, d.room);
        break;
      case 'leave':
        this.leave(ws, a);
        break;
      case 'msg':
        this.post(ws, a, d.bits);
        break;
    }
  }

  async webSocketClose(ws) {
    await this.dropped(ws);
  }

  async webSocketError(ws) {
    await this.dropped(ws);
  }

  async dropped(ws) {
    const a = ws.deserializeAttachment();
    if (a.vid) this.touchVisitor(a.vid);
    if (a.room && !this.otherSocketInRoom(a.id, a.room, ws)) {
      const expires = Date.now() + RECONNECT_GRACE_MS;
      this.sql.exec('UPDATE presence SET expires = ? WHERE id = ? AND room = ?', expires, a.id, a.room);
      await this.scheduleAlarm(expires);
    }
    this.broadcastStats(ws);
  }

  // Runs when a grace window ends, after restarts, and hourly to prune anything over a day old.
  async alarm() {
    const now = Date.now();

    // Listed as connected but no socket: they were lost in a restart. Start their grace window.
    const live = new Set(this.openSockets().map((ws) => ws.deserializeAttachment().id));
    for (const p of this.sql.exec('SELECT id FROM presence WHERE expires IS NULL').toArray()) {
      if (!live.has(p.id)) this.sql.exec('UPDATE presence SET expires = ? WHERE id = ?', now + RECONNECT_GRACE_MS, p.id);
    }

    const expired = this.sql.exec('SELECT * FROM presence WHERE expires <= ?', now).toArray();
    for (const p of expired) {
      this.sql.exec('DELETE FROM presence WHERE id = ?', p.id);
      this.announce(p.room, 'out', p.name, p.color);
    }
    if (expired.length) this.broadcastLobby();

    const cutoff = now - TTL_MS;
    for (const ws of this.ctx.getWebSockets()) {
      const { vid } = ws.deserializeAttachment();
      if (vid) this.touchVisitor(vid);
    }
    this.sql.exec('DELETE FROM entries WHERE ts < ?', cutoff);
    const before = this.visitorCount();
    this.sql.exec('DELETE FROM visitors WHERE ts < ?', cutoff);
    if (this.visitorCount() !== before) this.broadcastStats();

    const next = this.sql.exec('SELECT MIN(expires) AS e FROM presence').one().e;
    await this.ctx.storage.setAlarm(Math.min(next ?? Infinity, now + PRUNE_EVERY_MS));
  }

  async scheduleAlarm(at) {
    const current = await this.ctx.storage.getAlarm();
    if (current == null || at < current) await this.ctx.storage.setAlarm(at);
  }

  // ---------- rooms ----------

  async join(ws, a, room) {
    if (!ROOMS.includes(room) || !a.hello) return;
    if (a.room && a.room !== room) this.leave(ws, a);

    const seat = this.sql.exec('SELECT * FROM presence WHERE id = ?', a.id).toArray()[0];
    if (seat && seat.room !== room) {
      // They dropped from one room and came back to another: finish the old leave now.
      this.sql.exec('DELETE FROM presence WHERE id = ?', a.id);
      this.announce(seat.room, 'out', seat.name, seat.color);
    }

    // Already in this room (reconnect, reload, restart, second tab): take the seat back silently.
    if (seat && seat.room === room) {
      this.sql.exec('UPDATE presence SET expires = NULL, name = ?, color = ? WHERE id = ?', a.name, a.color, a.id);
      a.room = room;
      ws.serializeAttachment(a);
      this.sendHistory(ws, room, true);
      this.broadcastLobby();
      return;
    }

    if (this.members(room).size >= ROOM_CAPACITY) return send(ws, { t: 'error', reason: 'full' });

    this.sql.exec('INSERT INTO presence (id, room, name, color, expires) VALUES (?, ?, ?, ?, NULL)', a.id, room, a.name, a.color);
    a.room = room;
    ws.serializeAttachment(a);
    const entry = this.record(room, { k: 'in', name: a.name, color: a.color, ts: Date.now() });
    this.sendHistory(ws, room, false);
    this.toRoom(room, { t: 'entry', e: entry }, { skip: ws });
    this.broadcastLobby();
  }

  leave(ws, a) {
    if (!a.room) return;
    const room = a.room;
    a.room = null;
    ws.serializeAttachment(a);
    if (this.otherSocketInRoom(a.id, room, ws)) return;
    this.sql.exec('DELETE FROM presence WHERE id = ?', a.id);
    this.announce(room, 'out', a.name, a.color);
    this.broadcastLobby();
  }

  post(ws, a, bits) {
    if (!a.room) return;
    const now = Date.now();
    if (now - a.lastSend < MIN_SEND_INTERVAL_MS) return send(ws, { t: 'error', reason: 'slow' });
    if (!validBits(bits)) return;
    a.lastSend = now;
    ws.serializeAttachment(a);
    const entry = this.record(a.room, { k: 'msg', id: crypto.randomUUID(), name: a.name, color: a.color, bits, ts: now });
    this.toRoom(a.room, { t: 'entry', e: entry }, { self: ws });
  }

  announce(room, kind, name, color) {
    const entry = this.record(room, { k: kind, name, color, ts: Date.now() });
    this.toRoom(room, { t: 'entry', e: entry });
  }

  sendHistory(ws, room, rejoin) {
    const cutoff = Date.now() - TTL_MS;
    const history = this.sql
      .exec('SELECT data FROM entries WHERE room = ? AND ts >= ? ORDER BY seq', room, cutoff)
      .toArray()
      .map((r) => JSON.parse(r.data));
    send(ws, { t: 'joined', room, rejoin, history: history.slice(0, HISTORY_CHUNK) });
    for (let i = HISTORY_CHUNK; i < history.length; i += HISTORY_CHUNK) {
      send(ws, { t: 'history', room, entries: history.slice(i, i + HISTORY_CHUNK) });
    }
  }

  record(room, entry) {
    this.sql.exec('INSERT INTO entries (room, ts, data) VALUES (?, ?, ?)', room, entry.ts, JSON.stringify(entry));
    this.sql.exec(
      `DELETE FROM entries WHERE room = ? AND seq NOT IN
        (SELECT seq FROM entries WHERE room = ? ORDER BY seq DESC LIMIT ?)`,
      room, room, HISTORY_CAP,
    );
    return entry;
  }

  // ---------- presence ----------

  openSockets(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === 1);
  }

  otherSocketInRoom(id, room, except) {
    return this.openSockets(except).some((ws) => {
      const a = ws.deserializeAttachment();
      return a.id === id && a.room === room;
    });
  }

  // Everyone in a room, including anyone inside their reconnect grace window.
  members(room) {
    const roster = new Map();
    for (const p of this.sql.exec('SELECT id, name, color FROM presence WHERE room = ?', room)) {
      roster.set(p.id, { name: p.name, color: p.color });
    }
    return roster;
  }

  lobbySnapshot() {
    return Object.fromEntries(ROOMS.map((r) => [r, [...this.members(r).values()]]));
  }

  toRoom(room, obj, { self, skip } = {}) {
    const plain = JSON.stringify(obj);
    const mine = self ? JSON.stringify({ ...obj, mine: true }) : null;
    for (const ws of this.openSockets(skip)) {
      if (ws.deserializeAttachment().room !== room) continue;
      send(ws, ws === self ? mine : plain);
    }
  }

  broadcastLobby() {
    const s = JSON.stringify({ t: 'lobby', rooms: this.lobbySnapshot() });
    for (const ws of this.openSockets()) send(ws, s);
  }

  // ---------- visitor stats ----------

  touchVisitor(vid) {
    this.sql.exec('INSERT OR REPLACE INTO visitors (vid, ts) VALUES (?, ?)', vid, Date.now());
  }

  visitorCount() {
    return this.sql.exec('SELECT COUNT(*) AS n FROM visitors').one().n;
  }

  stats(except) {
    const online = new Set();
    for (const ws of this.openSockets(except)) {
      const { vid } = ws.deserializeAttachment();
      if (vid) online.add(vid);
    }
    return { t: 'stats', online: online.size, today: this.visitorCount() };
  }

  broadcastStats(except) {
    const s = JSON.stringify(this.stats(except));
    for (const ws of this.openSockets(except)) send(ws, s);
  }
}
