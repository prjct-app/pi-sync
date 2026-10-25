// Capture one complete portable Pi installation. Installed dependencies are rebuilt on restore.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ARCHIVE_VERSION, MACHINE_SETTINGS, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES, PORTABLE_DIRS, PORTABLE_FILES, RESOURCE_KEYS, assertArchivePath, dependencyPlan, excludedName, packageSources, validateArchive, type ArchiveFile, type MachineArchive } from './archive-schema.ts';
import { scanForSecrets, stripSecretKeys } from './secrets.ts';
import type { PiHost } from './pi.ts';
import { withMachineLock } from './operation.ts';

export const hashBytes = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function archiveFile(path: string, content: string, executable = false): ArchiveFile {
  return { path, content, encoding: 'utf8', sha256: hashBytes(content), executable };
}
const posix = (path: string): string => path.split(sep).join('/');
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel); };
const remotePackage = (source: string): boolean => /^(npm:|git:|https?:\/\/|ssh:\/\/|git@)/.test(source);

export function collectMachineArchive(agentDir: string, host: Pick<PiHost, 'pinPackage'>, home = homedir()): Promise<MachineArchive> {
  return withMachineLock(agentDir, () => collectUnlocked(agentDir, host, home));
}

async function collectUnlocked(agentDir: string, host: Pick<PiHost, 'pinPackage'>, home: string): Promise<MachineArchive> {
  const root = resolve(agentDir);
  const files = new Map<string, ArchiveFile>();
  const size = { bytes: 0 };
  const add = (file: ArchiveFile): void => {
    assertArchivePath(file.path);
    scanForSecrets(file.path, file.encoding === 'utf8' ? file.content : Buffer.from(file.content, 'base64').toString('utf8'));
    const old = files.get(file.path);
    size.bytes += Buffer.byteLength(JSON.stringify(file)) - (old ? Buffer.byteLength(JSON.stringify(old)) : 0);
    if (size.bytes > MAX_ARCHIVE_BYTES || files.size >= MAX_ARCHIVE_FILES && !old) throw new Error('This Pi setup exceeds the 20 MiB / 5,000 file backup limit. No backup was uploaded.');
    files.set(file.path, file);
  };
  const walk = async (source: string, target: string, explicit = false): Promise<void> => {
    const info = await lstat(source).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) {
      if (!explicit) throw new Error(`Cannot safely back up symbolic link ${source}. Add its real resource directory to Pi settings.`);
      return walk(await realpath(source), target);
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(source)).sort()) if (!excludedName(name)) await walk(join(source, name), `${target}/${name}`);
      return;
    }
    if (!info.isFile()) throw new Error(`Not a regular portable file: ${source}`);
    if (info.size > 4 * 1024 * 1024) throw new Error(`Portable file exceeds 4 MiB: ${source}`);
    const bytes = await readFile(source);
    const text = (() => { try {
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return decoded.includes('\0') ? undefined : decoded;
    } catch { return undefined; } })();
    const sanitized = target === 'mcp.json' || target === 'models.json'
      ? `${JSON.stringify(stripSecretKeys(JSON.parse(text ?? '')), null, 2)}\n` : text;
    add(sanitized !== undefined
      ? archiveFile(target, sanitized, !!(info.mode & 0o111))
      : { path: target, content: bytes.toString('base64'), encoding: 'base64', sha256: hashBytes(bytes), executable: !!(info.mode & 0o111) });
  };
  // Enumerate actual spelling: AGENTS.md and AGENTS.MD are the same file on default macOS volumes.
  const present = new Set(await readdir(root).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error; }));
  for (const name of PORTABLE_FILES) if (name !== 'settings.json' && present.has(name)) await walk(join(root, name), name, true);
  for (const name of PORTABLE_DIRS) await walk(join(root, name), name, true);

  const settingsText = await readFile(join(root, 'settings.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; });
  const original = JSON.parse(settingsText);
  if (!original || Array.isArray(original) || typeof original !== 'object') throw new Error('settings.json must be an object.');
  const settings: Record<string, unknown> = Object.fromEntries(Object.entries(original).filter(([key]) => !(MACHINE_SETTINGS as readonly string[]).includes(key)));
  const portableRef = async (source: string): Promise<string> => {
    const sign = /^[!+-]/.test(source) ? source[0]! : '';
    const path = source.slice(sign.length);
    if (path.startsWith('builtin:')) return source;
    const absolute = resolve(root, path.startsWith('~/') ? join(home, path.slice(2)) : path);
    if (inside(root, absolute)) {
      const rel = posix(relative(root, absolute));
      if (!rel || ![...PORTABLE_DIRS].some(dir => rel === dir || rel.startsWith(`${dir}/`))) throw new Error(`Resource is outside Pi's portable directories: ${source}`);
      return `${sign}./${rel}`;
    }
    const wildcard = [...absolute].findIndex(char => '*?{['.includes(char));
    const prefix = wildcard < 0 ? absolute : absolute.slice(0, absolute.lastIndexOf(sep, wildcard));
    const info = await lstat(prefix).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) {
      if (sign === '-' || sign === '!') return `${sign}./packages/missing-${hashBytes(path).slice(0, 12)}`;
      throw new Error(`Configured Pi resource is missing: ${source}`);
    }
    const packageRoot = async (dir: string, original = dir, depth = 0): Promise<string> => {
      if (dir === home || dirname(dir) === dir || depth > 8) return original;
      if (await lstat(join(dir, 'package.json')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; })) return dir;
      return packageRoot(dirname(dir), original, depth + 1);
    };
    const base = info.isDirectory() ? prefix : await packageRoot(dirname(prefix));
    // A loose source file often imports siblings. Its containing resource directory travels with it.
    if (base === home || dirname(base) === base) throw new Error(`Use a dedicated resource directory instead of backing up ${base}.`);
    const target = `packages/local-${hashBytes(base).slice(0, 12)}`;
    await walk(base, target, true);
    return `${sign}./${target}${absolute === base ? '' : `/${posix(relative(base, absolute))}`}`;
  };
  if (settings.packages !== undefined) {
    const sources = packageSources(settings);
    const entries = settings.packages as Array<string | Record<string, unknown>>;
    settings.packages = await Promise.all(entries.map(async (entry, index) => {
      const source = sources[index]!;
      const portable = remotePackage(source) ? await host.pinPackage(source) : await portableRef(source);
      return typeof entry === 'string' ? portable : { ...entry, source: portable };
    }));
  }
  for (const key of RESOURCE_KEYS) {
    if (settings[key] === undefined) continue;
    if (!Array.isArray(settings[key]) || (settings[key] as unknown[]).some(entry => typeof entry !== 'string')) throw new Error(`settings.${key} must contain paths.`);
    settings[key] = await Promise.all((settings[key] as string[]).map(portableRef));
  }
  add(archiveFile('settings.json', `${JSON.stringify(settings, null, 2)}\n`));
  const manifests = [...files.values()].filter(file => file.path === 'package.json' || file.path.endsWith('/package.json'));
  for (const file of manifests.filter(file => !manifests.some(parent => dirname(parent.path) !== '.' && parent !== file && file.path.startsWith(`${dirname(parent.path)}/`)))) {
    if (file.encoding !== 'utf8') throw new Error(`Package manifest is not UTF-8: ${file.path}`);
    dependencyPlan(JSON.parse(file.content), file.path);
  }
  return validateArchive({ version: ARCHIVE_VERSION, kind: 'machine', files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) });
}
