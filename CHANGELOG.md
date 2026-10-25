# Changelog

## 0.3.0

- Replace the file-by-file sync panel with two explicit machine-level actions: back up this Pi setup, or select a dated machine backup and restore it.
- Add immutable, account-scoped machine snapshots, persistent device identity, backup history, deletion, an additive database migration, and authenticated backup endpoints.
- Include complete portable resource trees, instructions, keybindings, local package sources, binary assets, executable permissions, and resource enable/disable preferences.
- Pin npm/git packages to their installed versions/revisions. Restore installs packages and local dependencies automatically, asks once before changing configuration, and reloads Pi without a separate accept-code step.
- Stage restores, preserve destination credentials and machine settings, keep the previous setup, roll back ordinary failures, and prevent concurrent operations or unsafe filesystem writes.
- Keep earlier shared file backups visible as partial backups without misrepresenting them as complete machines. Their files are not deleted by the migration.
- Preserve legacy state reports, fix portable settings normalization, broaden credential-field protection, and keep the `/pi-sync` alias.
- Document the production backend upgrade separately from the two-action user workflow; do not imply that updating the extension deploys the service.

## 0.2.1

- Add the English package cover to the README, npm archive, and Pi gallery metadata.
- Publish matching version tags through the package GitHub Actions workflow.


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
