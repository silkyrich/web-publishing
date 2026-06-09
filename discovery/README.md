# discovery/

One command that checks which of your tools are wired up — **by integration type**,
with a confidence level *earned* from a live check (not a presence guess) — and lights
up the dashboard live.

```bash
node discovery/discover.mjs <PAIRING-CODE>      # read code off the page, then run
node discovery/discover.mjs <CODE> --dry        # validate + print, don't publish
BASE=http://localhost:8787 node discovery/discover.mjs <CODE>   # against local wrangler dev
```

## Files
- **`tools.json`** — the single source of truth. Capabilities → tools. Each tool declares its
  `type`, how to `setup`, and a `validate` spec. No secrets, no machine paths. The dashboard
  reads this too, so tiles and validators never drift.
- **`discover.mjs`** — reads the manifest, validates each tool by kind, computes a level 0–3,
  and POSTs status + a live activity log to the pairing session.
- **`sources.local.json`** — *gitignored, machine-specific.* Maps a key NAME → the `.env` file
  that currently holds it (bridge for the scattered-`.env` reality). Copy from
  `sources.local.example.json`. Prefer exporting keys into your environment instead.

## Integration types (`type`)
| type | what it is | set up by |
|---|---|---|
| `connector` | account-level OAuth (claude.ai connector) | authorize at claude.ai/customize/connectors |
| `local-mcp` | local MCP server reading an API key | install MCP + key in env/.env |
| `cli` | standalone CLI in its own config | `gh auth login`, `wrangler login` |
| `manual` | web tool, no API | link only |

## Validation kinds → level
- `cli` — run a command, match success string → **L2** / else **L0**
- `mcp` — server present & connected (`claude mcp list`) → **L2** / present-not-connected **L1** / absent **L0**
- `http-bearer` / `http-key` / `http-bearer-header` — try every candidate key (env + local sources);
  a live 200 → **L2**; key present but rejected → **L1**; no key → **L0**
- `manual` → always **L0** (link only)

Level meaning: **0** not set up · **1** connected, unverified · **2** validated by a live check ·
**3** integrated into the loop.
