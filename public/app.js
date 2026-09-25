// ---------- constants ----------

// Bitmaps are stored at 2x (464x160) and displayed at 232x80, so typed text can be
// as fine as the keyboard labels while pen strokes keep their chunky DS look.
const S = 2;
const W = 232 * S;
const H = 80 * S;
const LINE = 16 * S;
const LINES = H / LINE;
const BYTES = (W * H) / 8;
const TTL = 24 * 60 * 60 * 1000;
const ROOMS = ['A', 'B', 'C', 'D'];
const CAPACITY = 16;
const NAME_MAX = 10;

// The 16 DS favorite colors.
const COLORS = [
  '#61829a', '#ba4900', '#fb0018', '#fb8afb', '#fb9200', '#f3e300', '#aafb00', '#00fb00',
  '#00a238', '#49db8a', '#30baf3', '#0059f3', '#000092', '#8a00d3', '#d300eb', '#fb0092',
];
const INK = [24, 24, 31];
const GLYPH_FONT = `${12 * S}px "DotGothic16"`;
const TAG_FONT = '12px "DotGothic16"';

// Each mode is 5 rows of 12, 10, 9, 10, 6 characters; the fn keys fill the rest.
const KB = {
  latin: {
    rows: ['1234567890-=', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm,./', ";'`[]\\"],
    shift: ['!@#$%^&*()_+', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM<>?', ':"~{}|'],
  },
  accent: { rows: ['àáâäèéêëìíîï', 'òóôöœùúûüç', 'ñøåæßÿ¡¿€', 'ãõčšžłřęąś', '«»„“”‘'] },
  kana: { rows: ['あいうえおかきくけこさし', 'すせそたちつてとなに', 'ぬねのはひふへほま', 'みむめもやゆよらりる', 'れろわをんー'] },
  symbol: { rows: ['!?&"\'~:;@#%*', '/\\()[]{}<>', '=+-_^|$£¥', '©®™°§¶…•·←', '→↑↓※♂♀'] },
  emoji: { rows: ['☺☻☹♥♡♦♣♠★☆♪♫', '☀☁☂☃✈☎✉✂✎✓', '✗♨☯☮✿❀✦◆◇', '●○■□▲△▼▽◀▶', '✚∞♯♭◎✧'] },
};

// ---------- tiny utils ----------

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const cookie = {
  get(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
  },
  set(name, value) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  },
};

function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#18181f' : '#ffffff';
}

function makeTag(name, color, tagEl = el('span', 'tag')) {
  tagEl.textContent = name;
  tagEl.style.setProperty('--c', COLORS[color]);
  tagEl.style.setProperty('--tc', textColorFor(COLORS[color]));
  return tagEl;
}

const mctx = document.createElement('canvas').getContext('2d');
function tagWidth(name) {
  mctx.font = TAG_FONT;
  return Math.ceil(mctx.measureText(name).width) + 10;
}

// ---------- state ----------

function validProfile(p) {
  return p && typeof p.name === 'string' && p.name.trim() && Number.isInteger(p.color) && p.color >= 0 && p.color < 16;
}

const state = {
  profile: validProfile(cookie.get('pc_profile')) ? cookie.get('pc_profile') : null,
  muted: cookie.get('pc_muted') === true,
  screen: 'boot',
  room: null,
  lobby: Object.fromEntries(ROOMS.map((r) => [r, []])),
  selectedRoom: null,
  tool: 'pen',
  size: 'thick',
  mode: 'latin',
  shift: false,
  caps: false,
  connected: false,
  scale: 1,
};

function randomId() {
  return (
    (crypto.randomUUID && crypto.randomUUID()) ||
    Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2)
  );
}

// Anonymous per-browser id, only used to count visitors. Survives reloads.
const visitorId = (() => {
  const v = cookie.get('pc_vid');
  if (typeof v === 'string' && /^[\w-]{8,64}$/.test(v)) return v;
  const id = randomId();
  cookie.set('pc_vid', id);
  return id;
})();

// Identifies this tab to the server. Kept for the life of the tab (sessionStorage), so a reload
// or a phone waking the page back up rejoins silently instead of "entering" again.
const clientId = (() => {
  try {
    const saved = sessionStorage.getItem('pc.client');
    if (saved && /^[\w-]{8,64}$/.test(saved)) return saved;
    const id = randomId();
    sessionStorage.setItem('pc.client', id);
    return id;
  } catch {
    return randomId();
  }
})();

function show(screen) {
  state.screen = screen;
  document.body.dataset.screen = screen;
}

let toastTimer;
function toast(text, ms = 1800) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- sound (synthesized, no assets) ----------

let actx = null;
const isOff = () => document.body.classList.contains('powered-off');

function audio() {
  if (state.muted || isOff()) return null;
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  } catch {
    return null;
  }
}
function beep(freq, dur, { type = 'square', vol = 0.04, at = 0, to = null } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
const arp = (notes, step, opts) => notes.forEach((f, i) => beep(f, 0.1, { type: 'triangle', vol: 0.07, at: i * step, ...opts }));
const sfx = {
  key: () => beep(1500, 0.035, { vol: 0.02 }),
  tap: () => beep(950, 0.04, { vol: 0.025 }),
  error: () => { beep(220, 0.08, { vol: 0.04 }); beep(175, 0.12, { vol: 0.04, at: 0.09 }); },
  send: () => beep(520, 0.18, { type: 'triangle', vol: 0.09, to: 1600 }),
  recv: () => { beep(1175, 0.09, { type: 'triangle', vol: 0.1 }); beep(1568, 0.18, { type: 'triangle', vol: 0.1, at: 0.09 }); },
  enter: () => arp([523, 659, 784, 1047], 0.07),
  leave: () => arp([1047, 784, 659, 523], 0.07),
  someone: () => beep(880, 0.08, { type: 'triangle', vol: 0.05 }),
};

// ---------- bitmaps ----------

function pack(bmp) {
  const out = new Uint8Array(BYTES);
  for (let i = 0; i < W * H; i++) if (bmp[i]) out[i >> 3] |= 128 >> (i & 7);
  let s = '';
  for (const b of out) s += String.fromCharCode(b);
  return btoa(s);
}

function unpack(b64) {
  const s = atob(b64);
  const bmp = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (s.charCodeAt(i >> 3) & (128 >> (i & 7))) bmp[i] = 1;
  return bmp;
}

// Base64 length for exactly BYTES bytes; older-resolution messages are skipped.
const B64_LEN = Math.ceil(BYTES / 3) * 4;
const validEntry = (e) => e.k !== 'msg' || e.bits?.length === B64_LEN;

function paint(canvas, bmp) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    if (!bmp[i]) continue;
    const j = i * 4;
    img.data[j] = INK[0];
    img.data[j + 1] = INK[1];
    img.data[j + 2] = INK[2];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Text is rasterized to 1-bit glyphs so typed text and drawings are the same thing.
const gcan = document.createElement('canvas');
gcan.width = 48 * S;
gcan.height = LINE;
const gctx = gcan.getContext('2d', { willReadFrequently: true });
const glyphCache = new Map();
function glyph(ch) {
  let g = glyphCache.get(ch);
  if (g) return g;
  gctx.font = GLYPH_FONT;
  const w = Math.max(2, Math.min(gcan.width - 8, Math.round(gctx.measureText(ch).width)));
  gctx.clearRect(0, 0, gcan.width, LINE);
  gctx.fillStyle = '#000';
  gctx.textBaseline = 'alphabetic';
  gctx.fillText(ch, 0, 12 * S);
  const d = gctx.getImageData(0, 0, w, LINE).data;
  const px = new Uint8Array(w * LINE);
  for (let i = 0; i < px.length; i++) px[i] = d[i * 4 + 3] > 110 ? 1 : 0;
  g = { w, px };
  glyphCache.set(ch, g);
  return g;
}

// ---------- the drawing pad ----------

const pad = {
  canvas: $('#draw'),
  bmp: new Uint8Array(W * H),
  tagW: 0,
  cx: 0,
  cy: 0,
  typed: [], // stack of { prev: {cx, cy}, snap: [index, oldValue, ...] } for backspace
};

const inTag = (x, y, tagW = pad.tagW) => y < LINE && x < tagW;

function resetCursor() {
  pad.cy = 0;
  pad.cx = pad.tagW + 2 * S;
}

function setPx(x, y, v) {
  if (x < 0 || y < 0 || x >= W || y >= H || inTag(x, y)) return;
  pad.bmp[y * W + x] = v;
}

function brush(x, y) {
  const erase = state.tool === 'eraser';
  const r = S * (erase ? (state.size === 'thick' ? 8 : 4) : state.size === 'thick' ? 2 : 1);
  const o = Math.floor(r / 2);
  for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) setPx(x - o + dx, y - o + dy, erase ? 0 : 1);
}

function stroke(x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    brush(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

let redrawQueued = false;
function redraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  queueMicrotask(() => {
    redrawQueued = false;
    paint(pad.canvas, pad.bmp);
    const caret = $('#caret');
    caret.hidden = pad.cy >= LINES;
    caret.style.left = pad.cx / S + 'px';
    caret.style.top = (pad.cy * LINE) / S + 2 + 'px';
  });
}

function padPoint(e) {
  const r = pad.canvas.getBoundingClientRect();
  return [Math.floor(((e.clientX - r.left) / r.width) * W), Math.floor(((e.clientY - r.top) / r.height) * H)];
}

function overPad(e) {
  const r = pad.canvas.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
}

let drawing = null;
pad.canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  pad.canvas.setPointerCapture(e.pointerId);
  const p = padPoint(e);
  drawing = { id: e.pointerId, last: p };
  stroke(...p, ...p);
  redraw();
});
pad.canvas.addEventListener('pointermove', (e) => {
  if (!drawing || e.pointerId !== drawing.id) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) {
    const p = padPoint(ev);
    stroke(...drawing.last, ...p);
    drawing.last = p;
  }
  redraw();
});
const endDraw = (e) => { if (drawing?.id === e.pointerId) drawing = null; };
pad.canvas.addEventListener('pointerup', endDraw);
pad.canvas.addEventListener('pointercancel', endDraw);

function stamp(g, x0, y0) {
  const snap = [];
  for (let y = 0; y < LINE; y++) {
    for (let x = 0; x < g.w; x++) {
      if (!g.px[y * g.w + x]) continue;
      const X = x0 + x, Y = y0 + y;
      if (X < 0 || Y < 0 || X >= W || Y >= H || inTag(X, Y)) continue;
      const i = Y * W + X;
      snap.push(i, pad.bmp[i]);
      pad.bmp[i] = 1;
    }
  }
  return snap;
}

function typeChar(ch) {
  const g = glyph(ch);
  const prev = { cx: pad.cx, cy: pad.cy };
  let { cx, cy } = pad;
  if (cx + g.w > W) { cy++; cx = S; }
  if (cy >= LINES) return sfx.error();
  pad.typed.push({ prev, snap: stamp(g, cx, cy * LINE) });
  pad.cx = cx + g.w;
  pad.cy = cy;
  sfx.key();
  redraw();
}

function dropChar(ch, [x, y]) {
  const g = glyph(ch);
  pad.typed.push({ prev: { cx: pad.cx, cy: pad.cy }, snap: stamp(g, x - (g.w >> 1), y - 8) });
  sfx.key();
  redraw();
}

function newline() {
  if (pad.cy + 1 >= LINES) return sfx.error();
  pad.typed.push({ prev: { cx: pad.cx, cy: pad.cy }, snap: [] });
  pad.cy++;
  pad.cx = S;
  sfx.key();
  redraw();
}

function backspace() {
  const t = pad.typed.pop();
  if (!t) return sfx.error();
  for (let i = 0; i < t.snap.length; i += 2) pad.bmp[t.snap[i]] = t.snap[i + 1];
  pad.cx = t.prev.cx;
  pad.cy = t.prev.cy;
  sfx.key();
  redraw();
}

function clearPad() {
  pad.bmp.fill(0);
  pad.typed = [];
  resetCursor();
  redraw();
}

function copyToPad(entry) {
  const src = unpack(entry.bits);
  pad.bmp.fill(0);
  let lastRow = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!src[y * W + x] || inTag(x, y)) continue;
      pad.bmp[y * W + x] = 1;
      lastRow = y;
    }
  }
  pad.typed = [];
  pad.cy = lastRow < 0 ? 0 : Math.ceil((lastRow + 1) / LINE);
  pad.cx = pad.cy === 0 ? pad.tagW + 2 * S : S;
  redraw();
}

function doSend() {
  if (!pad.bmp.some((v) => v)) return sfx.error();
  if (!state.connected) { toast('Not connected'); return sfx.error(); }
  wsSend({ t: 'msg', bits: pack(pad.bmp) });
  sfx.send();
  clearPad();
}

// ---------- keyboard ----------

const kbd = $('#kbd');
const KEY_LAYOUT = [
  [...Array(12)].map((_, i) => ({ r: 0, i, span: 2 })),
  [...[...Array(10)].map((_, i) => ({ r: 1, i, span: 2 })), { act: 'bksp', span: 4 }],
  [{ act: 'caps', span: 3 }, ...[...Array(9)].map((_, i) => ({ r: 2, i, span: 2 })), { act: 'enter', span: 3 }],
  [{ act: 'shift', span: 4 }, ...[...Array(10)].map((_, i) => ({ r: 3, i, span: 2 }))],
  [...[0, 1, 2].map((i) => ({ r: 4, i, span: 2 })), { act: 'space', span: 12 }, ...[3, 4, 5].map((i) => ({ r: 4, i, span: 2 }))],
];

// Pixel-art icons for the function keys, drawn as ascii grids ('#' = ink).
const FN_ICONS = {
  shift: ['....#....', '...#.#...', '..#...#..', '.#.....#.', '###...###', '..#...#..', '..#...#..', '..#####..'],
  caps: ['....#....', '...###...', '..#####..', '.#######.', '...###...', '...###...', '.........', '..#####..'],
  bksp: ['...#.....', '..##.....', '.#########', '##########', '.#########', '..##.....', '...#.....'],
  enter: ['........##', '........##', '...#....##', '..##....##', '.#########', '##########', '.#########', '..##......', '...#......'],
  space: ['#.............#', '#.............#', '#.............#', '###############'],
};

function pixelIcon(rows) {
  const w = rows[0].length, h = rows.length;
  let d = '';
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') d += `M${x} ${y}h1v1h-1z`; }));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.innerHTML = `<path d="${d}"/>`;
  return svg;
}

const FN_TITLES = { shift: 'Shift', caps: 'Caps Lock', bksp: 'Backspace', enter: 'New line', space: 'Space' };

for (const row of KEY_LAYOUT) {
  for (const k of row) {
    const b = el('button', 'btn key' + (k.act ? ' fn' : ''));
    b.style.gridColumn = `span ${k.span}`;
    if (k.act) {
      b.append(pixelIcon(FN_ICONS[k.act]));
      b.title = FN_TITLES[k.act];
      b.setAttribute('aria-label', FN_TITLES[k.act]);
    }
    if (k.act) b.dataset.act = k.act;
    else { b.dataset.r = k.r; b.dataset.i = k.i; }
    kbd.append(b);
  }
}

const toKatakana = (c) => {
  const n = c.charCodeAt(0);
  return n >= 0x3041 && n <= 0x3096 ? String.fromCharCode(n + 0x60) : c;
};

function keyChar(r, i) {
  const m = KB[state.mode];
  const base = [...m.rows[r]][i];
  const upper = state.shift !== state.caps;
  switch (state.mode) {
    case 'latin': {
      if (/[a-z]/.test(base)) return upper ? base.toUpperCase() : base;
      return state.shift ? [...m.shift[r]][i] : base;
    }
    case 'accent': {
      const up = base.toUpperCase();
      return upper && [...up].length === 1 ? up : base;
    }
    case 'kana':
      return upper ? toKatakana(base) : base;
    case 'emoji':
      return base + '︎';
    default:
      return base;
  }
}

function renderKeys() {
  kbd.className = 'kbd ' + state.mode;
  for (const b of kbd.children) {
    if (b.dataset.act) {
      b.classList.toggle('on', (b.dataset.act === 'shift' && state.shift) || (b.dataset.act === 'caps' && state.caps));
    } else {
      b.textContent = keyChar(+b.dataset.r, +b.dataset.i).replace('︎', '');
    }
  }
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === state.mode);
}

function pressKey(b) {
  switch (b.dataset.act) {
    case 'bksp': return backspace();
    case 'enter': return newline();
    case 'space': return typeChar(' ');
    case 'shift': state.shift = !state.shift; sfx.tap(); return renderKeys();
    case 'caps': state.caps = !state.caps; sfx.tap(); return renderKeys();
  }
  typeChar(keyChar(+b.dataset.r, +b.dataset.i));
  if (state.shift) { state.shift = false; renderKeys(); }
}

// Keys can be tapped, or dragged onto the pad to drop a character anywhere.
const ghost = $('#ghost');
let pressed = null;
kbd.addEventListener('pointerdown', (e) => {
  const key = e.target.closest('.key');
  if (!key) return;
  e.preventDefault();
  pressed = { key, id: e.pointerId, x: e.clientX, y: e.clientY, dragging: false };
  key.classList.add('down');
});
addEventListener('pointermove', (e) => {
  if (!pressed || e.pointerId !== pressed.id) return;
  const { key } = pressed;
  if (!pressed.dragging && key.dataset.r != null && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 8) {
    pressed.dragging = true;
    pressed.char = keyChar(+key.dataset.r, +key.dataset.i);
    ghost.textContent = pressed.char.replace('︎', '');
    ghost.style.fontSize = 12 * state.scale + 'px';
    ghost.hidden = false;
  }
  if (pressed.dragging) {
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
  }
});
addEventListener('pointerup', (e) => {
  if (!pressed || e.pointerId !== pressed.id) return;
  const p = pressed;
  pressed = null;
  p.key.classList.remove('down');
  ghost.hidden = true;
  if (p.dragging) {
    if (overPad(e)) {
      dropChar(p.char, padPoint(e));
      if (state.shift) { state.shift = false; renderKeys(); }
    }
    return;
  }
  const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.key');
  if (under === p.key) pressKey(p.key);
});
addEventListener('pointercancel', () => {
  if (!pressed) return;
  pressed.key.classList.remove('down');
  pressed = null;
  ghost.hidden = true;
});

addEventListener('keydown', (e) => {
  if (state.screen !== 'room' || e.isComposing) return;
  if (e.target.closest?.('input, textarea')) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); return doSend(); }
  if (e.metaKey || e.ctrlKey) return;
  if (e.key === 'Backspace') { e.preventDefault(); return backspace(); }
  if (e.key === 'Enter') { e.preventDefault(); return newline(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); return moveSelection(-1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); return moveSelection(1); }
  if ([...e.key].length === 1) { e.preventDefault(); typeChar(e.key); }
});

// ---------- tools & actions ----------

$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('.btn');
  if (!b) return;
  if (b.dataset.tool) state.tool = b.dataset.tool;
  if (b.dataset.size) state.size = b.dataset.size;
  if (b.dataset.mode) { state.mode = b.dataset.mode; state.shift = false; state.caps = false; renderKeys(); }
  if (b.dataset.act === 'exit') return leaveRoom();
  if (b.dataset.act === 'up') return moveSelection(-1);
  if (b.dataset.act === 'down') return moveSelection(1);
  for (const t of document.querySelectorAll('[data-tool]')) t.classList.toggle('on', t.dataset.tool === state.tool);
  for (const t of document.querySelectorAll('[data-size]')) t.classList.toggle('on', t.dataset.size === state.size);
  sfx.tap();
});

$('#send').addEventListener('click', doSend);
$('#clear').addEventListener('click', () => { clearPad(); sfx.tap(); });
$('#copy').addEventListener('click', () => {
  const target = copyTarget();
  if (!target) return sfx.error();
  copyToPad(target);
  sfx.tap();
});

// ---------- the log (top screen) ----------

const log = $('#log');
const msgs = new Map();
let selectedId = null;

function copyTarget() {
  if (selectedId && msgs.has(selectedId)) return msgs.get(selectedId);
  return [...msgs.values()].at(-1) ?? null;
}

// The highlighted message is what COPY grabs. With nothing highlighted, COPY takes the newest.
function select(id) {
  selectedId = id;
  let picked = null;
  for (const c of log.querySelectorAll('.card')) {
    c.classList.toggle('selected', c.dataset.id === id);
    if (c.dataset.id === id) picked = c;
  }
  if (picked) revealCard(picked);
  sfx.tap();
}

// Scroll just enough to bring a card fully into view.
function revealCard(card) {
  const top = card.offsetTop - 2;
  const bottom = card.offsetTop + card.offsetHeight + 2 - log.clientHeight;
  if (log.scrollTop > top) log.scrollTo({ top, behavior: 'smooth' });
  else if (log.scrollTop < bottom) log.scrollTo({ top: bottom, behavior: 'smooth' });
}

// ▲/▼ step the highlight through messages like on the DS. The first press lands on the newest.
function moveSelection(dir) {
  const cards = [...log.querySelectorAll('.card')];
  if (!cards.length) return sfx.error();
  const i = cards.findIndex((c) => c.dataset.id === selectedId);
  const next = i < 0 ? cards.length - 1 : i + dir;
  if (next < 0 || next >= cards.length) return sfx.error();
  select(cards[next].dataset.id);
}

function renderEntry(e) {
  if (e.k === 'msg') {
    const card = el('div', 'card');
    card.style.setProperty('--c', COLORS[e.color]);
    card.dataset.id = e.id;
    card.dataset.ts = e.ts;
    const c = el('canvas');
    c.width = W;
    c.height = H;
    paint(c, unpack(e.bits));
    const tag = makeTag(e.name, e.color);
    tag.style.width = tagWidth(e.name) + 'px';
    card.append(c, tag);
    card.addEventListener('click', () => select(e.id));
    msgs.set(e.id, e);
    return card;
  }
  const row = el('div', 'sys');
  row.dataset.ts = e.ts;
  row.append(el('span', null, e.k === 'in' ? '▶ Now entering' : '◀ Now leaving'), makeTag(e.name, e.color));
  return row;
}

const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 30;

function appendEntry(e, { live = false, mine = false } = {}) {
  const stick = nearBottom() || mine;
  log.append(renderEntry(e));
  if (stick) log.scrollTop = log.scrollHeight;
  updateThumb();
  if (!live || mine) return;
  if (e.k === 'msg') sfx.recv();
  else sfx.someone();
}

function updateThumb() {
  const thumb = $('#thumb');
  const { scrollHeight: sh, clientHeight: ch, scrollTop: st } = log;
  if (sh <= ch) { thumb.style.top = '1px'; thumb.style.height = 'calc(100% - 2px)'; return; }
  const h = Math.max(12, (ch / sh) * (ch - 2));
  thumb.style.height = h + 'px';
  thumb.style.top = 1 + (st / (sh - ch)) * (ch - 2 - h) + 'px';
}
log.addEventListener('scroll', updateThumb, { passive: true });

// Messages quietly disappear once they're a day old.
setInterval(() => {
  const cutoff = Date.now() - TTL;
  for (const n of [...log.children]) {
    if (+n.dataset.ts >= cutoff) continue;
    if (n.dataset.id) msgs.delete(n.dataset.id);
    n.remove();
  }
  updateThumb();
}, 30_000);

// ---------- profile ----------

const nameInput = $('#name-input');
let draftColor = state.profile?.color ?? Math.floor(Math.random() * 16);

const swatches = $('#swatches');
COLORS.forEach((c, i) => {
  const b = el('button', 'swatch');
  b.style.setProperty('--c', c);
  b.setAttribute('aria-label', `Color ${i + 1}`);
  b.addEventListener('click', () => { draftColor = i; renderProfile(); sfx.tap(); });
  swatches.append(b);
});

const previewCanvas = $('#profile-preview canvas');
function renderProfile() {
  const name = nameInput.value.trim() || 'Your name';
  [...swatches.children].forEach((b, i) => b.classList.toggle('on', i === draftColor));
  const card = $('#profile-preview');
  card.style.setProperty('--c', COLORS[draftColor]);
  const tag = makeTag(name, draftColor, card.querySelector('.tag'));
  const tw = tagWidth(name);
  tag.style.width = tw + 'px';
  // Pre-write a greeting on the sample card, the same way the pad renders text.
  const bmp = new Uint8Array(W * H);
  let x = tw * S + 2 * S;
  for (const ch of 'Hello!') {
    const g = glyph(ch);
    for (let y = 0; y < LINE; y++) for (let gx = 0; gx < g.w; gx++) if (g.px[y * g.w + gx]) bmp[y * W + x + gx] = 1;
    x += g.w;
  }
  paint(previewCanvas, bmp);
}
nameInput.addEventListener('input', renderProfile);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveProfile(); });

function openProfile() {
  nameInput.value = state.profile?.name ?? '';
  draftColor = state.profile?.color ?? draftColor;
  renderProfile();
  show('profile');
}

function saveProfile() {
  const name = [...nameInput.value.replace(/\p{C}/gu, '').trim()].slice(0, NAME_MAX).join('').trim();
  if (!name) { nameInput.focus(); return sfx.error(); }
  state.profile = { name, color: draftColor };
  cookie.set('pc_profile', state.profile);
  nameInput.blur();
  hello();
  sfx.enter();
  enterLobby();
}
$('#profile-ok').addEventListener('click', saveProfile);

// ---------- lobby ----------

const roomsEl = $('#rooms');
for (const r of ROOMS) {
  const b = el('button', 'btn room');
  b.dataset.room = r;
  const dots = el('span', 'dots');
  for (let i = 0; i < CAPACITY; i++) dots.append(el('i'));
  b.append(el('span', 'letter', r), el('span', null, `Chat Room ${r}`), dots, el('span', 'count'));
  b.addEventListener('click', () => {
    if (state.selectedRoom === r) return joinRoom();
    state.selectedRoom = r;
    renderLobby();
    sfx.tap();
  });
  roomsEl.append(b);
}

function renderLobby() {
  for (const b of roomsEl.children) {
    const people = state.lobby[b.dataset.room] ?? [];
    b.classList.toggle('on', b.dataset.room === state.selectedRoom);
    b.querySelector('.count').textContent = `${people.length}/${CAPACITY}`;
    [...b.querySelector('.dots').children].forEach((d, i) => d.classList.toggle('on', i < people.length));
  }
  $('#join').disabled = !state.selectedRoom;

  const info = $('#lobby-info');
  info.replaceChildren();
  if (!state.selectedRoom) {
    const hint = el('div', 'hint');
    hint.append(`Hi, `, makeTag(state.profile.name, state.profile.color), `!`);
    hint.append(el('br'), "Tap a room to see who's there");
    hint.querySelector('.tag').style.cssText += 'position:static;display:inline-block;border-radius:3px';
    info.append(hint);
    return;
  }
  const people = state.lobby[state.selectedRoom];
  info.append(el('h2', null, `Chat Room ${state.selectedRoom}: ${people.length ? people.length + ' here' : 'empty'}`));
  const list = el('div', 'members');
  for (const p of people) list.append(makeTag(p.name, p.color));
  info.append(list);
}

$('#join').addEventListener('click', joinRoom);
$('#edit-profile').addEventListener('click', () => { sfx.tap(); openProfile(); });
const soundBtn = $('#sound-toggle');
const renderSound = () => (soundBtn.textContent = state.muted ? 'Sound off' : 'Sound on');
soundBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  cookie.set('pc_muted', state.muted);
  renderSound();
  sfx.tap();
});

function enterLobby() {
  state.room = null;
  renderLobby();
  show('lobby');
}

function joinRoom() {
  if (!state.selectedRoom) return;
  if (!state.connected) { toast('Connecting…'); return sfx.error(); }
  wsSend({ t: 'join', room: state.selectedRoom });
}

function leaveRoom() {
  wsSend({ t: 'leave' });
  state.room = null;
  sfx.leave();
  enterLobby();
}

function onJoined({ room, history, rejoin }) {
  const wasHere = state.room === room;
  state.room = room;
  $('#room-letter').textContent = room;
  // A silent reconnect keeps the log we already have; otherwise rebuild it from history.
  state.acceptHistory = !wasHere || !rejoin;
  // Show the room before filling the log: a hidden log can't be scrolled to the newest message.
  show('room');
  if (state.acceptHistory) {
    log.replaceChildren();
    msgs.clear();
    selectedId = null;
    appendHistory(history);
    const tw = tagWidth(state.profile.name);
    pad.tagW = tw * S;
    makeTag(state.profile.name, state.profile.color, $('#mytag')).style.width = tw + 'px';
    $('#pad').style.setProperty('--c', COLORS[state.profile.color]);
    clearPad();
    sfx.enter();
  }
  renderRoomCount();
}

function appendHistory(entries) {
  const cutoff = Date.now() - TTL;
  for (const e of entries) if (e.ts >= cutoff && validEntry(e)) log.append(renderEntry(e));
  log.scrollTop = log.scrollHeight;
  updateThumb();
}

function renderRoomCount() {
  if (state.room) $('#room-count').textContent = state.lobby[state.room]?.length ?? '';
}

function renderStats({ online, today }) {
  $('#online-count').textContent = online;
  $('#today-count').textContent = today;
  $('#online-label').textContent = online === 1 ? 'person online' : 'people online';
  $('#today-label').textContent = today === 1 ? 'visitor today' : 'visitors today';
  $('#presence').hidden = false;
}

// ---------- network ----------

let ws = null;
let backoff = 500;
let reconnectTimer = null;
// Heartbeat: the server answers "ping" with "pong" without waking up. If a pong doesn't come
// back in time the connection is dead (common on phones) and gets replaced right away.
const PING_EVERY_MS = 25_000;
const PONG_TIMEOUT_MS = 8_000;
let pingSentAt = 0;

function wsSend(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

function hello() {
  if (state.profile) wsSend({ t: 'hello', id: clientId, ...state.profile });
}

function setConnected(on) {
  state.connected = on;
  $('#signal').classList.toggle('on', on);
}

function scheduleReconnect(delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

// Drop the current socket without waiting for a close handshake that may never come.
function abandonSocket() {
  const old = ws;
  ws = null;
  pingSentAt = 0;
  setConnected(false);
  try { old?.close(); } catch {}
}

setInterval(() => {
  if (ws?.readyState !== 1) return;
  if (pingSentAt && Date.now() - pingSentAt > PONG_TIMEOUT_MS) {
    abandonSocket();
    return connect();
  }
  if (!pingSentAt) {
    pingSentAt = Date.now();
    ws.send('ping');
  }
}, PING_EVERY_MS / 5);

// Coming back to the tab: reconnect now instead of waiting out the backoff.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!ws || ws.readyState > 1) {
    backoff = 500;
    scheduleReconnect(0);
  } else if (ws.readyState === 1 && !pingSentAt) {
    pingSentAt = Date.now();
    ws.send('ping');
  }
});

function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  sock.addEventListener('open', () => {
    if (sock !== ws) return sock.close(); // superseded while connecting
    backoff = 500;
    setConnected(true);
    $('#toast').hidden = true;
    wsSend({ t: 'visit', vid: visitorId });
    hello();
    if (state.room) wsSend({ t: 'join', room: state.room });
  });
  sock.addEventListener('message', (ev) => {
    if (sock !== ws) return;
    if (ev.data === 'pong') {
      pingSentAt = 0;
      return;
    }
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    switch (d.t) {
      case 'lobby':
        state.lobby = d.rooms;
        if (state.screen === 'lobby') renderLobby();
        renderRoomCount();
        break;
      case 'stats':
        renderStats(d);
        break;
      case 'joined':
        onJoined(d);
        break;
      case 'history':
        // Older history arrives in chunks after 'joined' (WebSocket messages are size-capped).
        if (state.room === d.room && state.acceptHistory) appendHistory(d.entries);
        break;
      case 'entry':
        if (state.room && validEntry(d.e)) appendEntry(d.e, { live: true, mine: d.mine });
        break;
      case 'error':
        sfx.error();
        if (d.reason === 'full') {
          toast('That room is full!');
          if (state.screen !== 'lobby') enterLobby();
        } else if (d.reason === 'slow') toast('Slow down a little!');
        break;
    }
  });
  sock.addEventListener('close', () => {
    if (sock !== ws) return; // already replaced
    ws = null;
    pingSentAt = 0;
    setConnected(false);
    if (state.screen === 'room') toast('Reconnecting…', 0);
    scheduleReconnect(backoff);
    backoff = Math.min(backoff * 2, 8000);
  });
}

// ---------- hardware buttons ----------

function moveRoom(dir) {
  const i = ROOMS.indexOf(state.selectedRoom);
  state.selectedRoom = ROOMS[i < 0 ? 0 : (i + dir + ROOMS.length) % ROOMS.length];
  renderLobby();
  sfx.tap();
}

function moveColor(dir) {
  draftColor = (draftColor + dir + COLORS.length) % COLORS.length;
  renderProfile();
  sfx.tap();
}

// START always goes home to the room list.
function goHome() {
  if (state.screen === 'room') return leaveRoom();
  if (state.screen === 'profile' && !state.profile) return sfx.error(); // need a name tag first
  state.selectedRoom = null;
  nameInput.blur();
  sfx.tap();
  enterLobby();
}

// A confirms, B goes back, START goes home.
const PAD_ACTIONS = {
  room: { up: () => moveSelection(-1), down: () => moveSelection(1), a: doSend, b: goHome, start: goHome },
  lobby: { up: () => moveRoom(-1), down: () => moveRoom(1), a: () => (state.selectedRoom ? joinRoom() : moveRoom(0)), b: goHome, start: goHome },
  profile: { left: () => moveColor(-1), right: () => moveColor(1), up: () => moveColor(-8), down: () => moveColor(8), a: saveProfile, b: goHome, start: goHome },
};

// ---------- easter egg: up up, down down, left right, left right swaps the DS Lite colorway ----------

const KONAMI = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right'];
const SHELLS = [
  { id: 'white', name: 'Polar White' },
  { id: 'black', name: 'Jet Black' },
  { id: 'pink', name: 'Coral Pink' },
  { id: 'crimson', name: 'Crimson & Black' },
];
let konami = 0;

function applyShell(id) {
  const ds = $('#ds');
  if (id && id !== 'white') ds.dataset.shell = id;
  else delete ds.dataset.shell;
}

function nextShell() {
  const cur = SHELLS.findIndex((s) => s.id === ($('#ds').dataset.shell ?? 'white'));
  const next = SHELLS[(cur + 1) % SHELLS.length];
  applyShell(next.id);
  cookie.set('pc_shell', next.id);
  toast(`★ Secret unlocked: ${next.name}! ★`, 2600);
  arp([784, 988, 1175, 1568, 1976], 0.06, { vol: 0.08 });
}

// Feeds one button into the code. Returns true when that press completed it,
// so the final press doesn't also do its normal job.
function konamiStep(btn) {
  if (btn === KONAMI[konami]) {
    konami++;
    if (konami < KONAMI.length) return false;
    konami = 0;
    nextShell();
    return true;
  }
  // Mashing extra ups at the start still counts, like on the real thing.
  konami = btn === 'up' ? (konami === 2 ? 2 : 1) : 0;
  return false;
}

// New visitors get Polar White; a colorway unlocked with the secret code is remembered.
{
  const saved = cookie.get('pc_shell');
  if (SHELLS.some((s) => s.id === saved)) applyShell(saved);
}

// ---------- power switch ----------

// The green light's power-on flash. Restarting the class restarts the animation.
let bootTimer;
function bootFlash() {
  document.body.classList.remove('booting');
  void document.body.offsetWidth;
  document.body.classList.add('booting');
  clearTimeout(bootTimer);
  bootTimer = setTimeout(() => document.body.classList.remove('booting'), 800);
}
bootFlash();

$('#power').addEventListener('click', () => {
  if (isOff()) {
    document.body.classList.remove('powered-off');
    bootFlash();
    arp([523, 784, 1047], 0.08, { vol: 0.06 });
  } else {
    beep(700, 0.25, { type: 'triangle', vol: 0.07, to: 120 });
    document.body.classList.add('powered-off');
  }
});

function pressPad(btn) {
  if (isOff()) return;
  if (konamiStep(btn)) return sfx.tap();
  const fn = PAD_ACTIONS[state.screen]?.[btn];
  if (fn) fn();
  else sfx.tap();
}

for (const b of document.querySelectorAll('[data-pad]')) {
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus where it is
  b.addEventListener('click', () => pressPad(b.dataset.pad));
}

// A real keyboard can drive the buttons too: arrows are the D-pad, Esc is B.
const KEY_TO_PAD = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
addEventListener(
  'keydown',
  (e) => {
    // While off, swallow keys so nothing types or navigates (browser shortcuts still work).
    if (isOff()) return e.stopImmediatePropagation();
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea')) return;
    const btn = KEY_TO_PAD[e.key];
    if (btn && konamiStep(btn)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return sfx.tap();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      return goHome();
    }
    // Outside a room there's no text to type, so the arrows and Enter act like the D-pad and A.
    if (state.screen === 'lobby' || state.screen === 'profile') {
      const fn = PAD_ACTIONS[state.screen][e.key === 'Enter' ? 'a' : KEY_TO_PAD[e.key]];
      if (fn) {
        e.preventDefault();
        fn();
      }
    }
  },
  { capture: true },
);

// ---------- layout ----------

// The layout viewport, not innerWidth/innerHeight: those change if iOS pinch-zooms the page.
const viewport = () => ({ vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight });
const CREDIT_H = 28; // room at the bottom for the credit line

function layout() {
  const ds = $('#ds');
  const fit = $('#fit');
  const { vw, vh } = viewport();
  const availH = vh - CREDIT_H;
  ds.style.transform = 'none';
  const w = ds.offsetWidth, h = ds.offsetHeight;
  fit.style.marginBottom = CREDIT_H + 'px';

  // Big screens: show the whole DS.
  let s = Math.min((vw - 32) / w, (availH - 32) / h);
  if (s >= 1.1) {
    if (s >= 2) s = Math.floor(s * 4) / 4;
    state.scale = s;
    ds.style.transform = `scale(${s})`;
    fit.style.width = w * s + 'px';
    fit.style.height = h * s + 'px';
    return;
  }

  // Phones: zoom in until the two screens fill the view and let the shell run off the edges,
  // like a close-up of the DS.
  const d = ds.getBoundingClientRect();
  const [top, bottom] = [...ds.querySelectorAll('.bezel')].map((b) => b.getBoundingClientRect());
  const x0 = top.left - d.left, x1 = top.right - d.left;
  const y0 = top.top - d.top, y1 = bottom.bottom - d.top;
  const pad = 10; // a sliver of shell stays visible around the screens
  s = Math.min((vw - 2 * pad) / (x1 - x0), (availH - 2 * pad) / (y1 - y0));
  const tx = vw / 2 - (s * (x0 + x1)) / 2;
  const ty = availH / 2 - (s * (y0 + y1)) / 2;
  state.scale = s;
  ds.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  fit.style.width = vw + 'px';
  fit.style.height = availH + 'px';
}
addEventListener('resize', layout);

// ---------- boot ----------

// Size the DS right away; the font wait below can take a few seconds on slow connections.
layout();

try {
  await Promise.race([
    Promise.all([document.fonts.load(GLYPH_FONT, 'Aあ'), document.fonts.load(TAG_FONT, 'A')]),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
} catch {}

layout();
renderKeys();
renderSound();
if (state.profile) enterLobby();
else openProfile();
connect();
