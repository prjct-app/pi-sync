/** One machine per backup. Back up this machine, or select another setup and restore it. */
import { SYMBOL, type PanelAction, type PanelDetail, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
import type { BackupInfo } from './archive-schema.ts';

export type SyncIntent =
  | { readonly action: 'login' }
  | { readonly action: 'logout' }
  | { readonly action: 'backup' }
  | { readonly action: 'restore'; readonly id: string }
  | { readonly action: 'delete'; readonly id: string };
export type SyncSnapshot = Readonly<{
  connected: boolean;
  needsLogin?: boolean;
  deviceName: string;
  deviceId?: string;
  serviceUrl: string;
  serviceReady: boolean;
  backups: readonly BackupInfo[];
  remoteError?: string;
}>;
export type SyncNotice = { readonly text: string; readonly tone: Tone };
export type SyncResult = SyncNotice & { readonly reload?: boolean };
export type SyncState = Readonly<{ snap: SyncSnapshot; busy: boolean; notice: SyncNotice | undefined }>;
export type SyncOps = Readonly<{ reload(): Promise<SyncSnapshot>; request(intent: SyncIntent): void }>;

/** Reopened panels get a fresh intent; a completed restore exits before Pi replaces the runtime. */
export async function runSyncPanel(
  ops: Omit<SyncOps, 'request'> & { fulfil(intent: SyncIntent): Promise<SyncResult> },
  open: (spec: PanelSpec) => Promise<void>,
): Promise<SyncResult | undefined> {
  const session: { notice?: SyncNotice } = {};
  for (;;) {
    const pending: { intent?: SyncIntent } = {};
    const snap = await ops.reload();
    await open(syncPanelSpec({ reload: ops.reload, request: intent => { pending.intent = intent; } }, { snap, busy: false, notice: session.notice }));
    if (!pending.intent) return;
    const result = await ops.fulfil(pending.intent).catch(error => ({ text: `Backup failed: ${message(error)}`, tone: 'error' as const }));
    if ('reload' in result && result.reload) return result;
    session.notice = result;
  }
}

export function syncPanelSpec(ops: SyncOps, initial: SyncState): PanelSpec {
  const cell = { value: initial };
  const listeners = new Set<() => void>();
  const publish = (state: SyncState): void => { cell.value = state; for (const listener of listeners) listener(); };
  const connected = (): boolean => cell.value.snap.connected && !cell.value.snap.needsLogin;
  const backupFor = (item: PanelItem | undefined): BackupInfo | undefined => cell.value.snap.backups.find(backup => item?.id === `backup:${backup.id}`);
  const request = (intent: SyncIntent, close: () => void): void => { ops.request(intent); close(); };
  const actions: PanelAction[] = [
    { key: 'l', label: 'Log in', when: () => !connected(), bulk: true, run: (_item, panel) => request({ action: 'login' }, panel.close) },
    { key: 'b', label: 'Back up this machine', when: () => connected() && cell.value.snap.serviceReady && !cell.value.busy, bulk: true, run: (_item, panel) => request({ action: 'backup' }, panel.close) },
    { key: 'r', label: 'Restore', when: item => connected() && !!backupFor(item) && !cell.value.busy, run: (item, panel) => {
      const backup = backupFor(item);
      if (backup) request({ action: 'restore', id: backup.id }, panel.close);
    } },
    { key: 'f', label: 'Refresh', when: () => connected() && !cell.value.busy, bulk: true, run: async () => {
      publish({ ...cell.value, busy: true });
      try { publish({ snap: await ops.reload(), busy: false, notice: undefined }); }
      catch (error) { publish({ ...cell.value, busy: false, notice: { text: message(error), tone: 'error' } }); }
    } },
    { key: 'd', label: 'Delete backup', when: item => connected() && !!backupFor(item) && !backupFor(item)?.legacy && !cell.value.busy, run: (item, panel) => {
      const backup = backupFor(item);
      if (backup) request({ action: 'delete', id: backup.id }, panel.close);
    } },
    { key: 'x', label: 'Log out', when: () => cell.value.snap.connected && !cell.value.busy, bulk: true, confirm: true, run: (_item, panel) => request({ action: 'logout' }, panel.close) },
  ];
  return {
    title: 'Machine backups',
    summary: () => `${cell.value.snap.deviceName} · ${connected() ? `${cell.value.snap.backups.length} backups in your account` : 'log in to see your machines'}`,
    items: () => {
      const { snap, notice } = cell.value;
      const items: PanelItem[] = [];
      if (notice) items.push({ id: 'notice', label: notice.text.split('\n')[0]!, meta: 'last action', symbol: notice.tone === 'error' ? SYMBOL.error : SYMBOL.ok, tone: notice.tone });
      if (!connected()) return [...items, { id: 'login', label: snap.needsLogin ? 'Log in again' : 'Log in to your backups', symbol: SYMBOL.idle, meta: 'Enter to connect' }];
      items.push({ id: 'this-machine', label: 'Back up this machine', symbol: SYMBOL.active, tone: 'accent', meta: snap.serviceReady ? snap.deviceName : 'service update needed' });
      if (snap.remoteError) items.push({ id: 'error', label: 'Backup service needs attention', symbol: SYMBOL.error, tone: 'error', meta: snap.remoteError });
      for (const backup of snap.backups) items.push({
        id: `backup:${backup.id}`, label: backup.deviceName, symbol: SYMBOL.ok, tone: backup.legacy ? 'warning' : 'success',
        meta: `${date(backup.createdAt)} · ${backup.legacy ? 'partial' : `${backup.fileCount} files`}`,
        search: `${backup.deviceName} ${backup.createdAt} ${backup.deviceId === snap.deviceId ? 'this machine' : 'other machine'}`,
      });
      if (!snap.backups.length && !snap.remoteError) items.push({ id: 'empty', label: 'No backups yet', meta: 'Back up this machine to get started', tone: 'muted' });
      return items;
    },
    detail: item => detailFor(item, cell.value),
    activate: {
      label: item => item?.id === 'login' ? 'Log in' : item?.id === 'this-machine' ? 'Back up this machine' : 'Restore this backup',
      when: item => !cell.value.busy && (item?.id === 'login' || connected() && (item?.id === 'this-machine' && cell.value.snap.serviceReady || !!backupFor(item))),
      run: (item, panel) => {
        if (item?.id === 'login') request({ action: 'login' }, panel.close);
        else if (item?.id === 'this-machine') request({ action: 'backup' }, panel.close);
        else {
          const backup = backupFor(item);
          if (backup) request({ action: 'restore', id: backup.id }, panel.close);
        }
      },
    },
    actions,
    initial: initial.notice ? 'notice' : connected() ? 'this-machine' : 'login',
    empty: 'Reading your machine backups…',
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

function detailFor(item: PanelItem, { snap, notice }: SyncState): PanelDetail {
  if (item.id === 'notice') return { title: 'Last action', sections: [{ title: 'Result', lines: notice?.text.split('\n') ?? [] }] };
  if (item.id === 'login') return { title: 'Your machines, one account', sections: [{ title: 'Get started', lines: ['Press Enter to log in. Approve the short code in your browser.', 'Then back up this Pi setup, or choose another machine’s backup to restore it here.'] }] };
  if (item.id === 'error') return { title: 'Backup service needs attention', sections: [{ title: 'Service', lines: [snap.remoteError ?? '', 'No setup has been changed. Earlier file backups are marked partial.'] }] };
  if (item.id === 'this-machine' || item.id === 'empty') return {
    title: `Back up ${snap.deviceName}`, subtitle: 'Save this complete portable Pi setup to your account.',
    sections: [
      { title: 'One action', lines: ['Press Enter or b. A new dated backup is created; older backups are kept.', 'On another machine: log in, choose this backup, and press Enter to restore.'] },
      { title: 'Included', lines: ['Settings, instructions, keybindings, MCP/model definitions, extensions, skills, prompts, and themes.', 'Npm/git packages are recorded at their installed versions. Local extension sources travel with the backup.'] },
      { title: 'Kept private', lines: ['Logins, tokens, environment files, sessions, and caches are not uploaded.'] },
    ],
  };
  const backup = snap.backups.find(backup => item.id === `backup:${backup.id}`);
  if (!backup) return { title: item.label };
  return {
    title: backup.deviceName, subtitle: backup.legacy ? 'Earlier file backup — not a complete machine setup' : 'Restore this Pi setup on the current machine',
    fields: [{ label: 'created', value: date(backup.createdAt) }, { label: 'files', value: String(backup.fileCount) },
      ...(!backup.legacy ? [{ label: 'packages', value: String(backup.packageCount) }] : []), { label: 'target machine', value: snap.deviceName }],
    sections: [
      { title: 'Press Enter or r to restore', lines: ['Downloads and restores the whole backed-up setup, not a two-way merge.', 'Installs the required extensions, packages, and local dependencies automatically.', 'Asks once before replacing configuration. Saves your current setup locally and reloads Pi when done.'] },
      { title: 'Your credentials stay here', lines: ['Existing logins, environment secrets, and sessions are not replaced. You may need to log in to providers on a new machine.'] },
      ...(backup.legacy ? [{ title: 'Partial backup', lines: ['Only the files saved by the earlier sync service are available. Missing local extension sources cannot be recreated.', 'Create a new complete backup on the source machine for reliable migration.'] }] : []),
      { title: 'Backup ID', lines: [backup.id] },
    ],
  };
}
const date = (value: string): string => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
