# pi-sync

Keeps Pi's portable configuration the same on every machine you use: settings, `AGENTS.md`, MCP and model config, and the extensions that are on. It also installs the packages listed in `settings.json`.

## Commands

| Command | What it does |
| --- | --- |
| `/pi-sync login` | Shows a code. Approve it in the browser; the token is stored locally. |
| `/pi-sync sync` | Sends what changed here and receives what changed elsewhere. |
| `/pi-sync sync --accept-code` | Also loads new extension code and installs new packages from another machine. |
| `/pi-sync logout` | Revokes this machine's token on the service and forgets it locally. |

## What is synced, and what is not

- Synced: `settings.json`, `AGENTS.md`, `mcp.json` (credential fields removed), `models.json`, and extensions that are loaded.
- Not synced: disabled extensions (`-` entries) and their files, backup copies, auth files, sessions, and packages that are not in `settings.json`.
- Packages travel as exact npm versions. Local paths, git sources, and URLs are reported and not installed.

## When both machines changed the same file

The newest change wins. The other version is kept in `~/.prjct/pi-sync/<time>/`. In `settings.json`, changes to different keys are both kept.

## Security

- Secrets are checked before every upload. Credential fields in `mcp.json` are removed, and each machine keeps its own.
- Code from another machine is held until you accept it, because Pi loads extensions at startup.
- Pulled file names are checked against an allowlist before anything is written.
- Traffic goes over HTTPS only; tokens never travel in a URL.
- The service stores your config as plain text. Protection is in transit and in access control, not end to end.

## Where things live

All data is under `${PRJCT_HOME:-~/.prjct}/pi-sync/`, outside Pi.

- `~/.prjct/pi-sync/` holds the login token (0600) and the last agreed state.
- Conflict backups are in `~/.prjct/pi-sync/<time>/`.

## Development

```bash
npm test
npm run check
```

Tests use an in-memory service and temporary folders. They never touch your real Pi or `~/.prjct`.
