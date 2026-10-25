import type { BackupInfo, MachineBackup } from './archive-schema.ts';
import { archiveBytes, archiveSettings, packageSources, verifyArchive } from './archive-schema.ts';
import { archiveFile } from './archive.ts';
import type { RemoteEntry, SyncClient } from './client.ts';
import { assertSafeRelativePath } from './sync.ts';

export function legacyBackupInfo(entries: readonly RemoteEntry[]): BackupInfo | undefined {
  const files = entries.filter(entry => {
    try { assertSafeRelativePath(entry.path); return !entry.deleted; } catch { return false; }
  });
  if (!files.length) return undefined;
  const names = new Set(files.map(file => file.device).filter(Boolean));
  return {
    id: 'legacy', deviceId: 'legacy', deviceName: names.size === 1 ? `${[...names][0]} (earlier partial backup)` : 'Earlier shared backup (partial)',
    createdAt: [...files].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]!.updated_at,
    fileCount: files.length, packageCount: 0, totalBytes: 0, legacy: true,
  };
}

export async function fetchMachineBackup(client: SyncClient, id: string): Promise<MachineBackup> {
  if (id !== 'legacy') {
    const backup = await client.backup(id);
    if (backup.id !== id) throw new Error('Service returned a different machine backup.');
    await verifyArchive(backup.archive);
    return backup;
  }
  const entries = await client.manifest();
  const info = legacyBackupInfo(entries);
  if (!info) throw new Error('The earlier file backup no longer exists.');
  const files = await Promise.all(entries.filter(entry => !entry.deleted).map(async entry => {
    assertSafeRelativePath(entry.path);
    const file = await client.file(entry.path);
    if (file.path !== entry.path || file.deleted) throw new Error('Earlier backup changed. Refresh and try again.');
    const archived = archiveFile(file.path, file.content);
    if (archived.sha256 !== file.sha256) throw new Error(`Backup checksum does not match: ${entry.path}`);
    return archived;
  }));
  const archive = await verifyArchive({ version: 1, kind: 'legacy', files });
  return { ...info, archive, packageCount: packageSources(archiveSettings(archive)).length, totalBytes: files.reduce((sum, file) => sum + archiveBytes(file).byteLength, 0) };
}
