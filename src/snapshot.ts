// Inventory only: opening the panel never uploads or restores a setup.
import { createClient, SERVICE_URL, SyncApiError, type Fetcher } from './client.ts';
import { readAuth, readDevice } from './store.ts';
import { legacyBackupInfo } from './machine-backups.ts';
import type { SyncSnapshot } from './panel.ts';

export async function loadSnapshot(agentDir: string, deviceName: string, serviceUrl = SERVICE_URL, fetcher: Fetcher = fetch): Promise<SyncSnapshot> {
  const auth = await readAuth(agentDir);
  const device = await readDevice();
  const snap: SyncSnapshot = { connected: !!auth, deviceName, deviceId: device?.id, serviceUrl, serviceReady: false, backups: [] };
  if (!auth) return snap;
  const client = createClient(auth.token, serviceUrl, fetcher);
  const [machines, legacy] = await Promise.allSettled([client.backups(), client.manifest()]);
  const errors = [machines, legacy].filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.some(error => error instanceof SyncApiError && error.status === 401)) return { ...snap, needsLogin: true, remoteError: 'Login expired or revoked. Press Enter to reconnect.' };
  const older = legacy.status === 'fulfilled' ? legacyBackupInfo(legacy.value) : undefined;
  const backups = [...(machines.status === 'fulfilled' ? machines.value : []), ...(older ? [older] : [])];
  const serviceReady = machines.status === 'fulfilled';
  const remoteError = machines.status === 'rejected'
    ? machines.reason instanceof SyncApiError && machines.reason.status === 404
      ? 'The service needs the machine-backup upgrade before it can store complete setups. Existing file backups remain available below.'
      : `Could not load machine backups: ${machines.reason instanceof Error ? machines.reason.message : String(machines.reason)}`
    : legacy.status === 'rejected' && !(legacy.reason instanceof SyncApiError && legacy.reason.status === 404)
      ? 'Machine backups loaded, but earlier file backups could not be checked. Refresh to retry.' : undefined;
  return { ...snap, backups, serviceReady, remoteError };
}
