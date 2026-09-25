# PictoChat

PictoChat from the Nintendo DS, on the web. No accounts: pick a name and one of the 16 DS colors (saved in a cookie), pick Chat Room A to D, draw or type, and hit SEND.

Runs on Cloudflare Workers + a Durable Object (free plan).

```bash
npm install
npm run dev      # http://localhost:8787, full local Worker + Durable Object
npm run deploy   # needs `npx wrangler login` once
```

## How it works

- `src/worker.js`: serves `public/` as static assets and forwards `/ws` to one Durable Object.
- `src/hub.js`: the `Hub` Durable Object runs everything: 4 rooms of up to 16 people, live messages, presence, and visitor counts. It uses the WebSocket Hibernation API, so it sleeps between messages. Each socket's identity lives in its attachment; history, visitors, and reconnect grace windows live in the object's SQLite storage. An alarm prunes anything older than 24 hours every hour.
- `public/`: vanilla HTML/CSS/JS, no build step. The whole DS is laid out at its native 256x192 resolution per screen and scaled to fit the window.
- Every message is a 1-bit bitmap stored at 2x (464x160, shown at 232x80). Typed text gets rasterized into the same bitmap using DotGothic16, so text and drawings are the same thing, just like on the DS.
- Room history is sent in chunks of 40 drawings, since Cloudflare caps WebSocket messages at 1 MiB.
- If you drop and reconnect within 10 seconds you keep your seat, so flaky connections don't spam "Now leaving".

## Controls

- Pencil / eraser, thick / thin on the left. Keyboard modes: ABC, accented, hiragana (SHIFT for katakana), symbols, and pictographs.
- Tap keys to type, or drag a key onto the canvas to drop it wherever you like.
- A physical keyboard works too: Enter for a new line, Cmd/Ctrl+Enter to send, arrow keys to scroll.
- Tap a message on the top screen to pick it, then COPY puts it on your canvas (with nothing picked, it copies the newest one).
- The DS buttons work: the D-pad scrolls and picks, A confirms (send, join, OK), B or Esc goes back, START goes home, and the slider on the right edge powers the DS off.
