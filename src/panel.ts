/**
 * The /sync docked panel: connection status, what would change, and the one
 * action to take. The panel never edits anything itself; the command handler
 * fulfils the intent and reopens the panel.
 */
import { SYMBOL, type PanelAction, type PanelDetail, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
import type { FileReport } from './engine.ts';

export type SyncIntent =
  | { readonly action: 'login' }
  | { readonly action: 'sync'; readonly acceptCode: boolean }
  | { readonly action: 'logout' };

export type SyncOps = Readonly<{
  reload(): Promise<SyncSnapshot>;
  request(intent: SyncIntent): void;
}>;

export type SyncSnapshot = Readonly<{
  connected: boolean;
  connectedAt?: string;
  deviceName: string;
  serviceUrl: string;
  recentFiles: readonly FileReport[];
  pendingPackages: readonly string[];
  failedPackages: readonly string[];
}>;

export type SyncState = Readonly<{
  snap: SyncSnapshot;
  busy: boolean;
  notice: { readonly text: string; readonly tone: Tone } | undefined;
}>;

const FILE = 'file:';
const PKG = 'pkg:';
const FAILED = 'failed:';
const fileId = (path: string): string => `${FILE}${path}`;
const pkgId = (spec: string): string => `${PKG}${spec}`;
const failedId = (spec: string): string => `${FAILED}${spec}`;

/** What the panel reads, as one immutable value; every change replaces it. */
export function syncPanelSpec(ops: SyncOps, initial: SyncState): PanelSpec {
  const cell: { value: SyncState } = { value: initial };
  const listeners = new Set<() => void>();
  const publish = (next: SyncState): void => {
    cell.value = next;
    for (const listener of listeners) listener();
  };
  const reload = async (): Promise<void> => {
    try {
      publish({ snap: await ops.reload(), busy: false, notice: cell.value.notice });
    } catch (error) {
      publish({ snap: cell.value.snap, busy: false, notice: { text: `Could not read Pi: ${errorMessage(error)}`, tone: 'error' } });
    }
  };

  const ask = (intent: SyncIntent): void => ops.request(intent);

  const actions: PanelAction[] = [
    {
      key: 'l', label: 'Login', when: () => !cell.value.snap.connected, bulk: true,
      run: (_item, panel) => { panel.close(); ask({ action: 'login' }); },
    },
    {
      key: 'y', label: 'Sync (install new packages)', when: () => cell.value.snap.connected, bulk: true,
      run: (_item, panel) => { panel.close(); ask({ action: 'sync', acceptCode: true }); },
    },
    {
      key: 's', label: 'Sync (preview only)', when: () => cell.value.snap.connected, bulk: true,
      run: (_item, panel) => { panel.close(); ask({ action: 'sync', acceptCode: false }); },
    },
    {
      key: 'x', label: 'Logout', when: () => cell.value.snap.connected, bulk: true, confirm: true,
      run: (_item, panel) => { panel.close(); ask({ action: 'logout' }); },
    },
  ];

  return {
    title: 'Sync',
    summary: () => {
      const { connected, recentFiles, pendingPackages, failedPackages, deviceName } = cell.value.snap;
      const status = connected ? `connected as ${deviceName}` : 'not connected';
      const parts = [status];
      if (recentFiles.length) parts.push(`${recentFiles.length} files changed`);
      if (pendingPackages.length) parts.push(`${pendingPackages.length} packages to install`);
      if (failedPackages.length) parts.push(`${failedPackages.length} package errors`);
      return parts.join(' · ');
    },
    items: () => {
      const items: PanelItem[] = [];
      if (cell.value.snap.connected) {
        for (const file of cell.value.snap.recentFiles) {
          items.push({
            id: fileId(file.path), label: file.path, symbol: actionSymbol(file.action), tone: actionTone(file.action),
            meta: file.action, search: `${file.path} ${file.action}`,
          });
        }
        for (const spec of cell.value.snap.pendingPackages) {
          items.push({
            id: pkgId(spec), label: spec, symbol: SYMBOL.attention, tone: 'accent',
            meta: 'pending', search: `pending ${spec}`,
          });
        }
        for (const spec of cell.value.snap.failedPackages) {
          items.push({
            id: failedId(spec), label: spec, symbol: SYMBOL.error, tone: 'error',
            meta: 'failed', search: `failed ${spec}`,
          });
        }
        if (items.length === 0) items.push({ id: 'empty', label: 'In sync', symbol: SYMBOL.ok, tone: 'success', meta: 'no changes', search: 'in sync empty' });
      } else {
        items.push({ id: 'disconnected', label: 'Not connected', symbol: SYMBOL.idle, tone: 'dim', meta: 'press l to login', search: 'not connected' });
      }
      return items;
    },
    detail: item => detailFor(item, cell.value.snap),
    actions,
    empty: cell.value.busy ? 'Reading Pi…' : 'Press l to login.',
    initial: cell.value.snap.recentFiles[0] ? fileId(cell.value.snap.recentFiles[0].path) : (cell.value.snap.connected ? 'empty' : 'disconnected'),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

function detailFor(item: PanelItem, snap: SyncSnapshot): PanelDetail {
  if (item.id === 'disconnected') {
    return {
      title: 'Not connected',
      subtitle: snap.serviceUrl,
      fields: [{ label: 'device', value: snap.deviceName }, { label: 'service', value: snap.serviceUrl }],
      sections: [{ title: 'Press l to start login', lines: [`a short code and link appear in the editor`, `approve it on ${snap.serviceUrl} within 5 minutes`] }],
    };
  }
  if (item.id === 'empty') {
    return { title: 'In sync', subtitle: 'No changes from the service', fields: [{ label: 'device', value: snap.deviceName }] };
  }
  if (item.id.startsWith(FILE)) {
    const path = item.id.slice(FILE.length);
    const file = snap.recentFiles.find(f => f.path === path);
    if (!file) return { title: path };
    return {
      title: path,
      subtitle: file.action,
      fields: [
        { label: 'action', value: file.action, tone: actionTone(file.action) },
        ...(file.revision !== undefined ? [{ label: 'revision', value: String(file.revision) }] : []),
        ...(file.backup ? [{ label: 'backup', value: file.backup }] : []),
      ],
    };
  }
  if (item.id.startsWith(PKG)) {
    const spec = item.id.slice(PKG.length);
    return { title: spec, subtitle: 'pending install', fields: [{ label: 'spec', value: spec }], sections: [{ title: 'Press y to install', lines: ['the package is added to this Pi'] }] };
  }
  if (item.id.startsWith(FAILED)) {
    const spec = item.id.slice(FAILED.length);
    return { title: spec, subtitle: 'install failed', fields: [{ label: 'spec', value: spec, tone: 'error' }] };
  }
  return { title: item.label };
}

const actionSymbol = (action: string): string => {
  if (action.startsWith('pulled') || action === 'unchanged') return SYMBOL.ok;
  if (action.startsWith('pushed')) return SYMBOL.active;
  if (action.startsWith('merged')) return SYMBOL.active;
  if (action.startsWith('held')) return SYMBOL.attention;
  if (action.startsWith('conflict')) return SYMBOL.attention;
  if (action.startsWith('error') || action.startsWith('failed')) return SYMBOL.error;
  return SYMBOL.idle;
};
const actionTone = (action: string): Tone => {
  if (action.startsWith('pulled') || action === 'unchanged') return 'success';
  if (action.startsWith('pushed') || action.startsWith('merged')) return 'accent';
  if (action.startsWith('held') || action.startsWith('conflict')) return 'warning';
  if (action.startsWith('error') || action.startsWith('failed')) return 'error';
  return 'muted';
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
