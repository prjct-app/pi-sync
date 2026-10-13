# Changelog

## 0.2.0

- `/sync` opens the shared docked panel: connection status, the last sync's file changes, pending and failed packages, and the one action to take. Press `l` to login, `s` to sync (preview only), `y` to sync and install new packages, `x` to logout. Login still uses the link+code flow, surfaced through a notice. Replaces the old `/pi-sync` text-only command.
- The last sync's report is kept in `state.json` so the panel can show it without re-running.
- State is one immutable value; every panel redraw replaces it.
- Added `@prjct.app/pi-tui-kit` as a runtime dep.

## 0.1.0

- Bidirectional sync of Pi's portable config through the pi-sync service: `settings.json`, `AGENTS.md`, `mcp.json`, `models.json`, and live `extensions/*.ts`.
- Login by code approval (`/pi-sync login`), `sync`, and `logout` with server-side token revocation.
- Three-way merge per file. Newest side wins when both changed; the other side is kept in a backup. `settings.json` merges key by key.
- Refuses to send secrets: pattern and credential-key checks run before every upload.
- New code and new packages from another machine are held until `sync --accept-code`.
- Installs packages with Pi's SDK; only exact npm versions install from another machine.
- Disabled extensions and backup copies never leave the machine.
- Data lives in `~/.prjct/pi-sync/` (state, token, conflict backups by time).
