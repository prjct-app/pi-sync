# Deploying machine backups

This is a maintainer operation, not an extra step in the user's backup/restore flow. It requires explicit authorization to change the production database and service, plus Supabase administrative access. These commands have not been run by the local tests.

## 1. Apply the additive migration

From this repository, using an authenticated Supabase CLI:

```bash
supabase link --project-ref <project-ref>
supabase db push --linked --dry-run
supabase db push --linked
```

If another repository owns this project's migration history, apply the reviewed migration through that project's normal pipeline instead. Do not reset the database or repair migration history just to make this checkout deploy.

Review `supabase/migrations/20261025000000_machine_backups.sql` before applying it. It creates `pi_sync_backups` and its account/date index. It enables RLS, revokes all direct public/anon/authenticated access, and grants only select/insert/delete to the service role. Existing `pi_sync_files`, tokens, and device links are not modified or deleted.

A machine snapshot is one immutable row containing all files. Its machine ID, name, server timestamp, counts, and checksummed archive belong to the authenticated account. There is no update endpoint.

## 2. Deploy the function

```bash
supabase functions deploy pi-sync --no-verify-jwt
```

`--no-verify-jwt` is intentional: clients use opaque `pis_` device tokens, not Supabase JWTs. The function itself verifies token format, hash and product label before every backup operation. It derives the user ID from that token; no caller-supplied account ID is accepted. The service role key never reaches a client.

The function imports the shared runtime-neutral schema and secret checks from `src/`. Supabase bundles the complete relative module graph; deploy from this checkout rather than copying just the entry point elsewhere.

The existing environment variables still apply:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (provided to the Edge Function).
- `PI_SYNC_APPROVE_URL` if overriding the browser approval URL.

New endpoints:

| Method | Route | Meaning |
| --- | --- | --- |
| GET | `/backups` | Latest 100 summaries for this account. No file contents. |
| POST | `/backups` | Validate and atomically publish a complete machine snapshot. |
| GET | `/backups/<uuid>` | Download one account-owned snapshot. |
| DELETE | `/backups/<uuid>` | Delete only that account-owned snapshot. |

Every list/read/delete includes an account filter. The previous link, token and file APIs remain available for compatibility and earlier partial backups.

## 3. Publish or activate the extension

Deploying the backend does not replace an installed npm package. Publish an appropriately versioned package through the normal release process, or explicitly configure the reviewed local checkout for testing. Do not overwrite a user's package installation or change their settings implicitly.

The user experience is then only: `/sync` → Back up this machine; on another machine, `/sync` → select the dated backup → Restore → one confirmation. Packages install and Pi reloads automatically.

## Verification

Run `npm test`, `npm run check`, and `npm run check:package` before publishing. Tests exercise the actual Edge Function handler with an in-memory REST database, account isolation, complete upload/list/download/restore across two temporary machines, automatic installer calls, failure rollback, and protection of local credentials.

A production smoke check should begin with authenticated GET `/backups`. Do not upload or restore a real user's setup as an unannounced smoke test. A migration and deploy still need separate verification against the authorized target project; local mocked tests are not evidence that production was changed.

## Recovery and boundaries

A completed restore shows its previous-setup directory. It normally lives under `${PRJCT_HOME:-~/.prjct}/pi-sync/restores/`; if that directory is on another filesystem or cannot be written, the private hidden staging directory retains the previous files instead.

Ordinary failures during installation or the final swap restore the active roots. An abrupt process termination is different: do not blindly delete `.pi-sync-operation.lock` or `.pi-sync-restore-*`. Inspect the active roots and retained `previous/` files before retrying. Provider auth files and sessions are never part of the swap.

This migration backs up the user's Pi agent directory and configured local resources. It is not an operating-system image, a project-workspace backup, or an encrypted credential vault.
