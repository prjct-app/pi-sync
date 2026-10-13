# Changelog

## 0.1.0

- Bidirectional sync of Pi's portable config through the pi-sync service: `settings.json`, `AGENTS.md`, `mcp.json`, `models.json`, and live `extensions/*.ts`.
- Login by code approval (`/pi-sync login`), `sync`, and `logout` with server-side token revocation.
- Three-way merge per file. Newest side wins when both changed; the other side is kept in a backup. `settings.json` merges key by key.
- Refuses to send secrets: pattern and credential-key checks run before every upload.
- New code and new packages from another machine are held until `sync --accept-code`.
- Installs packages with Pi's SDK; only exact npm versions install from another machine.
- Disabled extensions and backup copies never leave the machine.
- Data lives in `~/.prjct/pi-sync/` (state, token, conflict backups by time).
