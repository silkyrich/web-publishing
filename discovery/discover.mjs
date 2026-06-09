#!/usr/bin/env node
// discover.mjs — read discovery/tools.json, validate every tool BY ITS TYPE,
// compute an integration level (0-3), and publish status + a live narration to a
// pairing session so the dashboard lights up. One command replaces hand-discovery.
//
//   node discovery/discover.mjs <PAIRING-CODE> [--dry]
//   BASE=https://web-publishing.silkyrich.workers.dev  (override with env BASE)
//
// No secrets live here. Keys are read from process.env, or — for the credentials
// still scattered in other repos' .env files — from each tool's `keyFileNow`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
const CODE = positional[0];
const TOKEN = positional[1] || process.env.PAIR_TOKEN || "";   // write-token for locked rooms
const BASE = process.env.BASE || "https://web-publishing.silkyrich.workers.dev";

if (!CODE) {
  console.error("usage: node discovery/discover.mjs <PAIRING-CODE> [WRITE-TOKEN] [--dry]");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dir, "tools.json"), "utf8"));

// CF Access IdP type ↔ menu label
const IDP_TYPE = {
  "One-time PIN (email)": "onetimepin", "Google": "google", "Microsoft Entra ID": "azureAD",
  "GitHub": "github", "LinkedIn": "linkedin", "Facebook": "facebook", "Apple": "apple",
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Local-only map: KEY_NAME -> .env file currently holding it (gitignored, machine-specific).
const SOURCES = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dir, "sources.local.json"), "utf8")); }
  catch { return {}; }
})();

function readFromEnvFile(file, keyVar) {
  const p = file.replace(/^~/, os.homedir());
  try {
    const line = fs.readFileSync(p, "utf8").split("\n").find(l => l.startsWith(keyVar + "="));
    if (line) return line.slice(keyVar.length + 1).replace(/^["']|["']$/g, "").trim();
  } catch { /* no file */ }
  return null;
}

// Return ALL candidate keys (env first, then the local sources file), deduped. The
// validator tries each — so a stale env token doesn't mask a valid one in a .env.
function getKeys(spec) {
  const out = [];
  if (spec.keyVar && process.env[spec.keyVar]) out.push({ key: process.env[spec.keyVar].trim(), source: "env:" + spec.keyVar });
  if (spec.keyVar && SOURCES[spec.keyVar]) {
    const k = readFromEnvFile(SOURCES[spec.keyVar], spec.keyVar);
    if (k) out.push({ key: k, source: short(SOURCES[spec.keyVar]) });
  }
  const seen = new Set();
  return out.filter(c => c.key && !seen.has(c.key) && seen.add(c.key));
}

async function httpGet(url, headers) {
  try { const r = await fetch(url, { headers }); return { ok: r.ok, status: r.status, text: await r.text() }; }
  catch (e) { return { ok: false, status: 0, text: String(e) }; }
}

function cli(cmd) {
  try { return { ok: true, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || "") }; }
}

// ---- POST helpers (the pairing channel) ----
async function post(kind, body) {
  if (DRY) return;
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers["x-pair-token"] = TOKEN;
  try { await fetch(`${BASE}/api/session/${CODE}/${kind}`, { method: "POST", headers, body: JSON.stringify(body) }); }
  catch { /* offline; keep going */ }
}
const log = (text, level = "info") => { console.log(`[${level}] ${text}`); return post("log", { text, level }); };
const status = (o) => post("status", o);

// ---- validators by kind → { state, level, detail, extra? } ----
async function validate(tool) {
  const v = tool.validate || {};
  const fail0 = (detail) => ({ state: "off", level: 0, detail });
  const warn1 = (detail) => ({ state: "warn", level: 1, detail });
  const ok2 = (detail) => ({ state: "ok", level: 2, detail });

  if (v.kind === "manual") return { state: "off", level: 0, detail: tool.setup?.how || "Manual tool — no API." };

  if (v.kind === "cli") {
    const r = cli(v.run);
    const hit = (r.out || "").includes(v.ok);
    return hit ? ok2(firstLine(r.out, v.ok)) : fail0(`Not set up — \`${v.run}\` didn't confirm.`);
  }

  if (v.kind === "mcp") {
    const r = cli("claude mcp list");
    const line = (r.out || "").split("\n").find(l => l.includes(v.server));
    if (line && /✓|Connected/i.test(line)) return ok2(`Connected (${tool.type}).`);
    if (line) return warn1(`${v.server} present but not connected.`);
    return fail0(`${v.server} not installed.`);
  }

  if (v.kind === "http-bearer" || v.kind === "http-key" || v.kind === "http-bearer-header") {
    const cands = getKeys(v);
    if (!cands.length) return fail0("No API key found.");
    const want = v.ok && v.ok !== "200" ? v.ok : null;   // a real substring requirement, not just 200
    let lastStatus = 0;
    for (const c of cands) {
      let url = v.url, headers = {};
      if (v.kind === "http-bearer") headers = { authorization: `Bearer ${c.key}` };
      else if (v.kind === "http-bearer-header") headers = { [v.header]: c.key };
      else url = v.url.replace("{KEY}", encodeURIComponent(c.key));
      const r = await httpGet(url, headers);
      if (want ? (r.ok && r.text.includes(want)) : r.ok) return ok2(`Validated — live check passed (key from ${c.source}).`);
      lastStatus = r.status;
    }
    return warn1(`${cands.length} key(s) present but rejected (HTTP ${lastStatus}) — needs a fresh key.`);
  }

  return fail0("No validator.");
}

// Cloudflare-specific: read the real Access identity providers and tick the menu.
async function cloudflareIdps(tool) {
  const src = tool.extra?.idpSource; const menu = tool.extra?.idpMenu || [];
  if (!src) return null;
  for (const c of getKeys(src)) {
    const h = { authorization: `Bearer ${c.key}` };
    const acc = await httpGet("https://api.cloudflare.com/client/v4/accounts?per_page=1", h);
    const aid = (acc.text.match(/"id":"([0-9a-f]{32})"/) || [])[1];
    if (!aid) continue;
    const idp = await httpGet(src.url.replace("{account}", aid), h);
    try {
      const configured = new Set();
      for (const p of (JSON.parse(idp.text).result || [])) configured.add(p.type);
      return menu.map(name => ({ name, configured: configured.has(IDP_TYPE[name]) }));
    } catch { /* try next candidate */ }
  }
  return null;
}

function firstLine(s, near) { return (s.split("\n").find(l => l.includes(near)) || "").trim().replace(/^[✓\s-]+/, ""); }
function short(p) { return p.replace(os.homedir(), "~"); }

// ---- run ----
const tools = manifest.categories.flatMap(c => c.tools.map(t => ({ ...t, _cat: c.title })));
console.log(`Discovering ${tools.length} tools → ${DRY ? "(dry run)" : BASE + "/api/session/" + CODE}\n`);

await log("Reading the manifest, running discovery across your stack…", "work");
let okCount = 0;

for (const tool of tools) {
  await log(`${tool.name} → ${tool.validate?.kind || "?"} (${tool.type})`, "work");
  let res = await validate(tool);
  const extra = { level: res.level, levelName: manifest.levels[res.level] };

  if (tool.id === "cloudflare" && res.state === "ok") {
    const idps = await cloudflareIdps(tool);
    if (idps) { extra.idps = idps; const on = idps.filter(i => i.configured).map(i => i.name); res.detail += ` · logins: ${on.join(", ")}`; }
  }

  await status({ service: tool.id, state: res.state, detail: res.detail, url: tool.url, extra });
  const lvlTag = `L${res.level}`;
  if (res.state === "ok") { okCount++; await log(`✓ ${tool.name} — ${lvlTag} ${res.detail}`, "ok"); }
  else if (res.state === "warn") await log(`! ${tool.name} — ${lvlTag} ${res.detail}`, "warn");
  else await log(`· ${tool.name} — ${lvlTag} ${res.detail}`, "info");
  await sleep(120);
}

await log(`Discovery complete: ${okCount} of ${tools.length} validated.`, "ok");
console.log(`\nDone. ${okCount}/${tools.length} green.`);
