import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { brand, openPanel, panelText } from '@prjct.app/pi-tui-kit';
import { hostname } from 'node:os';
import { createClient, SERVICE_URL, type SyncClient } from './src/client.ts';
import { ensureDevice, forgetAuth, readAuth, writeAuth, writeState } from './src/store.ts';
import { DEFAULT_AGENT_DIR } from './src/sync.ts';
import { piHost } from './src/pi.ts';
import { runSyncPanel, syncPanelSpec, type SyncIntent, type SyncResult } from './src/panel.ts';
import { loadSnapshot } from './src/snapshot.ts';
import { collectMachineArchive } from './src/archive.ts';
import { archiveSettings, isBackupId, packageSources } from './src/archive-schema.ts';
import { fetchMachineBackup } from './src/machine-backups.ts';
import { restoreMachineArchive } from './src/restore.ts';

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || DEFAULT_AGENT_DIR;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const USAGE = 'Usage: /sync (machine backups) · /sync backup · /sync restore <backup-id> · /sync report · /sync login · /sync logout';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export default function piSync(pi: ExtensionAPI) {
  const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const result = await dispatch(args, ctx).catch(error => ({ text: `Backup: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' as const }));
    if (!result) return;
    ctx.ui.notify(result.text, result.tone === 'error' ? 'error' : 'info');
    // Reload replaces the runtime. Never reopen a panel or reuse this context afterwards.
    if ('reload' in result && result.reload) return ctx.reload();
  };
  for (const name of ['sync', 'pi-sync']) pi.registerCommand(name, { description: brand('sync: back up this Pi setup or restore another machine, including extensions'), handler });
}

async function dispatch(args: string, ctx: ExtensionCommandContext): Promise<SyncResult | undefined> {
  const [verb, ...rest] = args.trim().split(/\s+/);
  if (!verb && ctx.hasUI && ctx.mode === 'tui') return runSyncPanel({
    reload: () => loadSnapshot(AGENT_DIR, hostname()), fulfil: intent => fulfil(ctx, intent),
  }, spec => openPanel(ctx, spec));
  if (!verb || verb === 'report' && !rest.length) {
    const snap = await loadSnapshot(AGENT_DIR, hostname());
    const spec = syncPanelSpec({ reload: async () => snap, request: () => undefined }, { snap, busy: false, notice: undefined });
    return { text: `${panelText(spec)}${snap.backups.length ? `\n\nBackup IDs:\n${snap.backups.map(backup => `${backup.id}  ${backup.deviceName}`).join('\n')}` : ''}`, tone: snap.remoteError ? 'warning' : 'accent' };
  }
  if (['help', '--help', '-h'].includes(verb)) return { text: USAGE, tone: 'accent' };
  if (['login', 'logout', 'backup', 'upload'].includes(verb) && !rest.length) return fulfil(ctx, { action: verb === 'upload' ? 'backup' : verb as 'login' | 'logout' | 'backup' });
  if (['restore', 'download', 'delete'].includes(verb) && (rest.length === 1 || rest.length === 2 && rest[1] === '--yes')) {
    const id = rest[0]!;
    if (id !== 'legacy' && !isBackupId(id)) return { text: 'Choose a backup in /sync, or copy its ID from /sync report.', tone: 'warning' };
    return fulfil(ctx, { action: verb === 'delete' ? 'delete' : 'restore', id }, rest[1] === '--yes');
  }
  return { text: `${verb === 'sync' ? 'Two-way file sync has been replaced by explicit machine backups and restores.\n' : ''}${USAGE}`, tone: 'warning' };
}

async function authenticated(): Promise<SyncClient> {
  const auth = await readAuth(AGENT_DIR);
  if (!auth) throw new Error('Log in first: open /sync and press Enter.');
  return createClient(auth.token, SERVICE_URL);
}

async function fulfil(ctx: ExtensionCommandContext, intent: SyncIntent, approved = false): Promise<SyncResult> {
  if (intent.action === 'login') return login(ctx);
  if (intent.action === 'logout') {
    const auth = await readAuth(AGENT_DIR);
    await forgetAuth(AGENT_DIR);
    const revoked = !auth || await createClient(auth.token, SERVICE_URL).revoke().then(() => true).catch(() => false);
    return { text: `Logged out. Your local setup and account backups were not deleted.${revoked ? '' : '\nService unreachable: the token was removed locally but may still be active on the service.'}`, tone: revoked ? 'accent' : 'warning' };
  }
  const client = await authenticated();
  if (intent.action === 'delete') {
    if (intent.id === 'legacy') throw new Error('Earlier file backups are kept separately and are not deleted here.');
    if (!approved && (!ctx.hasUI || !await ctx.ui.confirm('Delete this backup?', 'Only this saved snapshot will be deleted. No machine configuration will change.'))) return { text: 'Deletion cancelled.', tone: 'warning' };
    await client.deleteBackup(intent.id);
    return { text: 'Backup deleted. Other backups and machines were not changed.', tone: 'accent' };
  }
  if (intent.action === 'backup') {
    ctx.ui.notify('Preparing a complete backup of this Pi setup…', 'info');
    const device = await ensureDevice();
    const archive = await collectMachineArchive(AGENT_DIR, piHost(ctx.cwd, AGENT_DIR));
    ctx.ui.setStatus('pi-sync', 'Uploading machine backup…');
    try {
      const saved = await client.createBackup(device, archive);
      return { text: `Backed up ${device.name}: ${saved.fileCount} files and ${saved.packageCount} packages.\nOn another machine, log in to /sync and choose this backup.\nOlder backups were kept.`, tone: 'accent' };
    } finally { ctx.ui.setStatus('pi-sync', undefined); }
  }
  const backup = await fetchMachineBackup(client, intent.id);
  const packages = packageSources(archiveSettings(backup.archive)).length;
  if (!approved) {
    if (!ctx.hasUI) throw new Error('Restoring replaces local configuration and installs code. Use the interactive panel, or explicitly pass --yes.');
    const confirmed = await ctx.ui.confirm(`Restore ${backup.deviceName}?`, [
      `${backup.archive.files.length} files and ${packages} packages will be restored on ${hostname()}.`,
      'This replaces the backed-up configuration and automatically installs extension code and dependencies.',
      'Your current setup is saved locally first. Your logins, environment secrets, and sessions stay here.',
      ...(backup.legacy ? ['This older backup is partial: it may not include all local extensions or resources.'] : []),
      'Pi reloads automatically when the restore succeeds.',
    ].join('\n'));
    if (!confirmed) return { text: 'Restore cancelled. No configuration was changed.', tone: 'warning' };
  }
  ctx.ui.notify(`Restoring ${backup.deviceName}, including its extensions and packages…`, 'info');
  try {
    const restored = await restoreMachineArchive(AGENT_DIR, backup.archive, dir => piHost(ctx.cwd, dir), progress => ctx.ui.setStatus('pi-sync', progress));
    return { text: `Restored ${backup.deviceName}: ${restored.files} files and ${restored.packages} packages.\nPrevious setup: ${restored.recoveryDir}\nReloading Pi to activate the restored setup.`, tone: 'accent', reload: true };
  } finally { ctx.ui.setStatus('pi-sync', undefined); }
}

async function login(ctx: ExtensionCommandContext): Promise<SyncResult> {
  const client = createClient(undefined, SERVICE_URL);
  const link = await client.startLink();
  ctx.ui.notify(`Open ${link.url} and approve code ${link.code}. Waiting up to 5 minutes.`, 'info');
  const deadline = Date.now() + LOGIN_WINDOW_MS;
  while (Date.now() < deadline) {
    await sleep(3_000);
    const result = await client.claimLink(link.poll);
    if (result.status === 'ok' && result.token) {
      await writeState(AGENT_DIR, { bases: {}, installed: [] });
      await writeAuth(AGENT_DIR, { token: result.token, connectedAt: new Date().toISOString() });
      return { text: 'Connected. Back up this machine, or select a saved machine to restore here.', tone: 'accent' };
    }
    if (['expired', 'invalid'].includes(result.status)) return { text: `Login ${result.status}. Press Enter to try again.`, tone: 'warning' };
  }
  return { text: 'Login was not approved in 5 minutes. Press Enter to try again.', tone: 'warning' };
}
