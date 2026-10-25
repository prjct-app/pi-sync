// Shared by Node and the Edge Function. No filesystem or runtime-specific imports.
export const ARCHIVE_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 5_000;
export const PORTABLE_FILES = [
  'settings.json', 'keybindings.json', 'mcp.json', 'models.json', 'package.json', 'package-lock.json',
  'AGENTS.md', 'AGENTS.MD', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.MD', 'SYSTEM.md', 'APPEND_SYSTEM.md',
] as const;
export const PORTABLE_DIRS = ['extensions', 'skills', 'prompts', 'themes', 'instructions', 'packages'] as const;
export const RESOURCE_KEYS = ['extensions', 'skills', 'prompts', 'themes'] as const;
export const MACHINE_SETTINGS = ['deviceId', 'trackingId', 'sessionDir', 'npmCommand', 'shellPath', 'httpProxy'] as const;

const HOST_PACKAGES = new Set(['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']);
export function dependencyPlan(manifest: Record<string, unknown>, label: string): { dependencies: Record<string, string>; optionalDependencies: Record<string, string> } {
  const portable = (value: unknown): Record<string, string> => {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid dependency manifest: ${label}`);
    return Object.fromEntries(Object.entries(value).filter(([name]) => !HOST_PACKAGES.has(name)).map(([name, version]) => {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || typeof version !== 'string' || /^(file:|link:|workspace:|[./~])/.test(version)) throw new Error(`Dependency ${name} in ${label} needs a portable npm version; local/workspace dependency links cannot be restored.`);
      return [name, version];
    }));
  };
  return { dependencies: portable(manifest.dependencies), optionalDependencies: portable(manifest.optionalDependencies) };
}

export type ArchiveFile = { path: string; content: string; encoding: 'utf8' | 'base64'; sha256: string; executable: boolean };
export type MachineArchive = { version: 1; kind: 'machine' | 'legacy'; files: ArchiveFile[] };
export type BackupInfo = { id: string; deviceId: string; deviceName: string; createdAt: string; fileCount: number; packageCount: number; totalBytes: number; legacy?: boolean };
export type MachineBackup = BackupInfo & { archive: MachineArchive };
export type BackupDevice = { id: string; name: string };

export const isBackupId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export const excludedName = (name: string): boolean =>
  name.startsWith('.') || ['node_modules', '__pycache__', 'auth.json', 'credentials.json', 'tokens.json', 'sessions'].includes(name);

export function assertArchivePath(path: string): void {
  const parts = path.split('/');
  const top = (PORTABLE_FILES as readonly string[]).includes(path);
  const resource = parts.length > 1 && (PORTABLE_DIRS as readonly string[]).includes(parts[0]!);
  if ((!top && !resource) || path.length > 512 || /[\\\x00-\x1f\x7f:]/.test(path) ||
    parts.some(part => !part || part === '.' || part === '..' || excludedName(part))) {
    throw new Error(`Backup path is not portable or allowed: ${path}`);
  }
}

export function archiveBytes(file: ArchiveFile): Uint8Array {
  if (file.encoding === 'utf8') return new TextEncoder().encode(file.content);
  const decoded = (() => { try { return atob(file.content); } catch { throw new Error(`Invalid base64: ${file.path}`); } })();
  if (btoa(decoded) !== file.content) throw new Error(`Invalid base64: ${file.path}`);
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

export function archiveSettings(archive: MachineArchive): Record<string, unknown> {
  const file = archive.files.find(file => file.path === 'settings.json');
  if (!file) return {};
  if (file.encoding !== 'utf8') throw new Error('settings.json must be UTF-8 JSON.');
  const settings = JSON.parse(file.content);
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('settings.json must be an object.');
  return settings;
}

export function packageSources(settings: Record<string, unknown>): string[] {
  if (settings.packages === undefined) return [];
  if (!Array.isArray(settings.packages)) throw new Error('settings.packages must be an array.');
  return settings.packages.map(entry => {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (typeof source !== 'string' || !source.trim()) throw new Error('Invalid package declaration in backup.');
    return source;
  });
}

export function validateArchive(value: unknown): MachineArchive {
  const archive = value as MachineArchive;
  if (!archive || archive.version !== ARCHIVE_VERSION || !['machine', 'legacy'].includes(archive.kind) || !Array.isArray(archive.files)) throw new Error('Unsupported machine backup format.');
  if (archive.files.length > MAX_ARCHIVE_FILES || new TextEncoder().encode(JSON.stringify(archive)).length > MAX_ARCHIVE_BYTES) throw new Error('Backup exceeds the 20 MiB / 5,000 file limit.');
  const paths = new Set<string>();
  for (const file of archive.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || !['utf8', 'base64'].includes(file.encoding) || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.executable !== 'boolean') throw new Error('Invalid file in machine backup.');
    assertArchivePath(file.path);
    if (file.encoding === 'utf8' && file.content.includes('\0')) throw new Error(`Binary file must use base64: ${file.path}`);
    if (paths.has(file.path)) throw new Error(`Duplicate backup file: ${file.path}`);
    paths.add(file.path);
  }
  for (const path of paths) {
    const parents = path.split('/').slice(0, -1);
    if (parents.some((_part, index) => paths.has(parents.slice(0, index + 1).join('/')))) throw new Error(`Backup file/directory collision: ${path}`);
  }
  if (archive.kind === 'machine' && !paths.has('settings.json')) throw new Error('A machine backup must include settings.json.');
  const settings = archiveSettings(archive);
  if (packageSources(settings).length > MAX_ARCHIVE_FILES) throw new Error('Too many packages in backup.');
  for (const key of RESOURCE_KEYS) if (settings[key] !== undefined && (!Array.isArray(settings[key]) || (settings[key] as unknown[]).some(value => typeof value !== 'string'))) throw new Error(`Invalid ${key} paths in settings.`);
  return archive;
}

export async function verifyArchive(value: unknown): Promise<MachineArchive> {
  const archive = validateArchive(value);
  for (const file of archive.files) {
    const bytes = archiveBytes(file);
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== file.sha256) throw new Error(`Backup checksum does not match: ${file.path}`);
  }
  return archive;
}
