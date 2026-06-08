// web-publishing Worker
// - Serves the static guide (index.html / index.md) via the ASSETS binding.
// - Adds a tiny pairing API so a visitor's page and a Claude Code instance can
//   share live progress through a short pairing code (e.g. WAVE-7321).
//
// Routes:
//   GET  /api/session/new            -> { code }            (mint a fresh code)
//   GET  /api/session/:code/ws       -> WebSocket           (page subscribes; gets snapshot + live updates)
//   POST /api/session/:code/step     -> { ok, steps }       (Claude posts {step, done}; broadcast to subscribers)
//   POST /api/session/:code/status   -> { ok, services }    (Claude posts {service,state,detail,url}; broadcast)
//   GET  /api/session/:code/state    -> { steps, services } (plain poll fallback)
//
// State lives in one SQLite-backed Durable Object per code — the right primitive
// for "one live coordinator per visitor". Free-plan friendly.

const WORDS = [
  "WAVE", "ECHO", "LARK", "FERN", "DUSK", "MICA", "JADE", "REEF",
  "PINE", "VOLT", "HALO", "NOVA", "KILN", "SAGE", "OPAL", "FLUX",
];

function randInt(n) {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] % n;
}

function makeCode() {
  const word = WORDS[randInt(WORDS.length)];
  const num = String(randInt(10000)).padStart(4, "0");
  return `${word}-${num}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/session/new") {
      return Response.json({ code: makeCode() }, { headers: { "cache-control": "no-store" } });
    }

    const m = url.pathname.match(/^\/api\/session\/([A-Za-z0-9-]+)\/(ws|step|state|status)$/);
    if (m) {
      const code = m[1].toUpperCase();
      const id = env.SESSIONS.idFromName(code);
      return env.SESSIONS.get(id).fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("not found", { status: 404 });
    }

    // Everything else: the static guide.
    return env.ASSETS.fetch(request);
  },
};

export class SessionRoom {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, done INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, state TEXT, detail TEXT, url TEXT)`);
  }

  snapshot() {
    const out = {};
    for (const row of this.sql.exec(`SELECT id, done FROM steps`)) out[row.id] = !!row.done;
    return out;
  }

  servicesSnapshot() {
    const out = {};
    for (const row of this.sql.exec(`SELECT id, state, detail, url FROM services`)) {
      out[row.id] = { state: row.state, detail: row.detail, url: row.url };
    }
    return out;
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch { /* dropped socket; ignore */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);          // hibernation API
      server.send(JSON.stringify({ type: "snapshot", steps: this.snapshot(), services: this.servicesSnapshot() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/step") && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "bad json" }, { status: 400 }); }
      const step = String(body.step || "").trim();
      if (!step) return Response.json({ ok: false, error: "missing step" }, { status: 400 });
      const done = body.done === false ? 0 : 1;
      this.sql.exec(
        `INSERT INTO steps (id, done) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET done = ?`,
        step, done, done,
      );
      this.broadcast({ type: "update", step, done: !!done });
      return Response.json({ ok: true, step, done: !!done, steps: this.snapshot() });
    }

    if (url.pathname.endsWith("/status") && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "bad json" }, { status: 400 }); }
      const service = String(body.service || body.id || "").trim();
      if (!service) return Response.json({ ok: false, error: "missing service" }, { status: 400 });
      const stateVal = String(body.state || "unknown");
      const detail = body.detail == null ? null : String(body.detail);
      const link = body.url == null ? null : String(body.url);
      this.sql.exec(
        `INSERT INTO services (id, state, detail, url) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET state = ?, detail = ?, url = ?`,
        service, stateVal, detail, link, stateVal, detail, link,
      );
      this.broadcast({ type: "status", service, state: stateVal, detail, url: link });
      return Response.json({ ok: true, service, services: this.servicesSnapshot() });
    }

    if (url.pathname.endsWith("/state")) {
      return Response.json(
        { steps: this.snapshot(), services: this.servicesSnapshot() },
        { headers: { "cache-control": "no-store" } },
      );
    }

    return new Response("not found", { status: 404 });
  }

  // Page may ping to keep the socket warm; nothing else to handle.
  webSocketMessage() {}
  webSocketClose(ws) { try { ws.close(); } catch {} }
}
