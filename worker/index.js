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
//   POST /api/session/:code/log      -> { ok }               (Claude posts {text, level}; appended + broadcast)
//   GET  /api/session/:code/state    -> { steps, services, logs } (plain poll fallback)
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

// High-entropy secret that authorizes WRITES to a room (status/log). The friendly
// code names the room; this token is the capability. ~10^29 space — not brute-forceable.
function makeToken() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

// Identity injected by Cloudflare Access once the page is behind SSO (empty otherwise).
function accessEmail(request) {
  return request.headers.get("cf-access-authenticated-user-email") || "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/session/new") {
      const code = makeCode();
      const token = makeToken();
      const id = env.SESSIONS.idFromName(code);
      await env.SESSIONS.get(id).fetch(new Request("https://do/register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, owner: accessEmail(request) }),
      }));
      return Response.json({ code, token }, { headers: { "cache-control": "no-store" } });
    }

    const m = url.pathname.match(/^\/api\/session\/([A-Za-z0-9-]+)\/(ws|step|state|status|log)$/);
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
    // additive migration: existing session DOs already have `services` without `extra`
    try { this.sql.exec(`ALTER TABLE services ADD COLUMN extra TEXT`); } catch { /* column already present */ }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, text TEXT, level TEXT)`);
  }

  snapshot() {
    const out = {};
    for (const row of this.sql.exec(`SELECT id, done FROM steps`)) out[row.id] = !!row.done;
    return out;
  }

  servicesSnapshot() {
    const out = {};
    for (const row of this.sql.exec(`SELECT id, state, detail, url, extra FROM services`)) {
      const o = { state: row.state, detail: row.detail, url: row.url };
      if (row.extra) { try { o.extra = JSON.parse(row.extra); } catch {} }
      out[row.id] = o;
    }
    return out;
  }

  logsSnapshot() {
    const rows = [...this.sql.exec(`SELECT ts, text, level FROM logs ORDER BY seq DESC LIMIT 60`)];
    return rows.reverse().map(r => ({ ts: r.ts, text: r.text, level: r.level }));
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch { /* dropped socket; ignore */ }
    }
  }

  // Arm a weekly clear-down the first time a room is used (and re-arm after each clear).
  async ensureLifecycle() {
    if ((await this.state.storage.getAlarm()) == null) {
      if (!(await this.state.storage.get("createdAt"))) await this.state.storage.put("createdAt", Date.now());
      await this.state.storage.setAlarm(Date.now() + 7 * 24 * 60 * 60 * 1000);   // +7 days
    }
  }

  // Fires ~weekly: wipe the session's state so nothing lingers. Owner binding (if any) is kept.
  async alarm() {
    this.sql.exec(`DELETE FROM steps`);
    this.sql.exec(`DELETE FROM services`);
    this.sql.exec(`DELETE FROM logs`);
    await this.state.storage.delete("createdAt");
    this.broadcast({ type: "cleared", reason: "weekly" });
  }

  // Writes (status/log) require the room's token once one is set. Rooms created
  // before tokens existed have none → still open (backward compatible).
  async writeAllowed(request) {
    const tok = await this.state.storage.get("token");
    if (!tok) return true;
    return request.headers.get("x-pair-token") === tok;
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.ensureLifecycle();

    // Bind the room's write-token + owner on creation (first registration wins).
    if (url.pathname.endsWith("/register") && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!(await this.state.storage.get("token"))) {
        if (b.token) await this.state.storage.put("token", b.token);
        if (b.owner) await this.state.storage.put("owner", b.owner);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith("/ws")) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);          // hibernation API
      server.send(JSON.stringify({ type: "snapshot", steps: this.snapshot(), services: this.servicesSnapshot(), logs: this.logsSnapshot() }));
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
      if (!(await this.writeAllowed(request))) return Response.json({ ok: false, error: "bad or missing token" }, { status: 403 });
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "bad json" }, { status: 400 }); }
      const service = String(body.service || body.id || "").trim();
      if (!service) return Response.json({ ok: false, error: "missing service" }, { status: 400 });
      const stateVal = String(body.state || "unknown");
      const detail = body.detail == null ? null : String(body.detail);
      const link = body.url == null ? null : String(body.url);
      // `extra` carries structured per-service data (e.g. Cloudflare's IdP tick-list)
      const extra = body.extra == null ? null : JSON.stringify(body.extra);
      this.sql.exec(
        `INSERT INTO services (id, state, detail, url, extra) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET state = ?, detail = ?, url = ?, extra = ?`,
        service, stateVal, detail, link, extra, stateVal, detail, link, extra,
      );
      this.broadcast({ type: "status", service, state: stateVal, detail, url: link, extra: body.extra ?? null });
      return Response.json({ ok: true, service, services: this.servicesSnapshot() });
    }

    if (url.pathname.endsWith("/log") && request.method === "POST") {
      if (!(await this.writeAllowed(request))) return Response.json({ ok: false, error: "bad or missing token" }, { status: 403 });
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "bad json" }, { status: 400 }); }
      const text = String(body.text || "").trim();
      if (!text) return Response.json({ ok: false, error: "missing text" }, { status: 400 });
      const level = String(body.level || "info");
      const ts = Date.now();
      this.sql.exec(`INSERT INTO logs (ts, text, level) VALUES (?, ?, ?)`, ts, text, level);
      // keep only the most recent ~200 lines
      this.sql.exec(`DELETE FROM logs WHERE seq <= (SELECT MAX(seq) FROM logs) - 200`);
      this.broadcast({ type: "log", ts, text, level });
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith("/state")) {
      return Response.json(
        { steps: this.snapshot(), services: this.servicesSnapshot(), logs: this.logsSnapshot() },
        { headers: { "cache-control": "no-store" } },
      );
    }

    return new Response("not found", { status: 404 });
  }

  // Page may ping to keep the socket warm; nothing else to handle.
  webSocketMessage() {}
  webSocketClose(ws) { try { ws.close(); } catch {} }
}
