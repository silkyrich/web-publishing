# Trick — live two-way sync between a web page and an outside agent (no login)

A page in someone's browser and an *outside writer* (Claude Code, a CLI script, another
device) share **live state** through a short **room code**, with no accounts and no polling.
Whoever holds the code can read and write; every change is **broadcast** to all open pages
instantly. It survives reloads, sleeps cheaply, and degrades to local-only when offline.

This is the engine behind the "Give Claude its tools" dashboard — the lights/log you see appear
because Claude POSTs to the room and the page is pushed the update over a WebSocket. It's the
**device-pairing pattern** (like signing a TV into a streaming app), built on one Cloudflare
**Durable Object per room**.

## Why it's nice
- **No database, no login, no polling.** One Durable Object = one tiny live coordinator per code.
- **Two-way.** Page edits mirror up (POST); agent writes push down (WebSocket broadcast).
- **Durable + cheap.** SQLite in the DO survives reloads/redeploys; WebSocket *hibernation* lets
  it sleep when idle. Free-plan friendly.
- **Graceful fallback.** Before any backend exists, the page just uses `localStorage`; live sync
  lights up later for free.

## Minimal recipe

**Worker (`wrangler.jsonc`: `main` + a `SESSIONS` Durable Object bound to `Room`, sqlite migration):**
```js
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/new") return Response.json({ room: crypto.randomUUID().slice(0, 8) });
    const m = url.pathname.match(/^\/api\/([\w-]+)\/(ws|state)$/);
    if (m) return env.SESSIONS.get(env.SESSIONS.idFromName(m[1])).fetch(req);
    return env.ASSETS.fetch(req);                       // static page
  },
};

export class Room {
  constructor(state) { this.state = state; this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`); }
  snap() { const o = {}; for (const r of this.sql.exec(`SELECT k,v FROM kv`)) o[r.k] = JSON.parse(r.v); return o; }
  send(msg) { for (const ws of this.state.getWebSockets()) try { ws.send(JSON.stringify(msg)); } catch {} }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/ws")) {                 // page subscribes
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);               // hibernation API
      server.send(JSON.stringify({ type: "snapshot", state: this.snap() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method === "POST") {                         // anyone with the code writes
      const { k, v } = await req.json();
      this.sql.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=?`, k, JSON.stringify(v), JSON.stringify(v));
      this.send({ type: "set", k, v });                  // broadcast to every open page
      return Response.json({ ok: true });
    }
    return Response.json({ state: this.snap() });        // poll fallback
  }
  webSocketMessage() {}  webSocketClose(ws) { try { ws.close(); } catch {} }
}
```

**Page (subscribe + render + write-back):**
```js
const room = localStorage.room ?? (localStorage.room = (await (await fetch("/api/new")).json()).room);
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/${room}/state`.replace("/state", "/ws"));
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.type === "snapshot") for (const [k, v] of Object.entries(m.state)) render(k, v);
  if (m.type === "set") render(m.k, m.v);                // pushed live, no refresh
};
// write-back (the "two-way"): when the user changes something locally, mirror it up
function change(k, v) { fetch(`/api/${room}/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ k, v }) }); }
```

Outside agent (Claude / a script) writes the same way: `POST /api/<room>/state {k, v}` → every open page updates.

## Productionising (all proven in this repo)
- **Lock it:** put the page behind Cloudflare Access, bypass the write path, and require a
  high-entropy **write-token** header so the code can't be brute-forced. See [[access-lock]].
- **Expire it:** arm a Durable Object **alarm** (`setAlarm`) to wipe the room on a TTL (weekly here).
- **Carry structure:** send `{type, ...}` messages for status/logs/HTML, not just k/v — the
  dashboard streams service status + an activity log over the same socket.

Full, hardened implementation: `worker/index.js` (the `SessionRoom` class) + `index.html`.
