// Stage and install everything first. Only then replace portable roots, keeping the previous setup.
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { MACHINE_SETTINGS, PORTABLE_DIRS, PORTABLE_FILES, RESOURCE_KEYS, archiveBytes, archiveSettings, assertArchivePath, packageSources, verifyArchive, type MachineArchive } from './archive-schema.ts';
import { isSecretKeyName, stripSecretKeys } from './secrets.ts';
import { syncHome } from './home.ts';
import type { PiHost } from './pi.ts';
import { withMachineLock } from './operation.ts';

export type RestoreResult = { files: number; packages: number; recoveryDir: string };
const exists = async (path: string) => lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });

function keepCredentials(incoming: unknown, local: unknown): unknown {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const own = local && typeof local === 'object' && !Array.isArray(local) ? local as Record<string, unknown> : {};
  const next = Object.fromEntries(Object.entries(incoming).map(([key, value]) => [key, keepCredentials(value, own[key])]));
  return { ...next, ...Object.fromEntries(Object.entries(own).filter(([key]) => isSecretKeyName(key))) };
}

function checkSettings(archive: MachineArchive, settings: Record<string, unknown>): void {
  const paths = archive.files.map(file => file.path);
  const portable = (entry: string, pattern = false): string => {
    const value = entry.replace(/^[!+-]/, '');
    if (value.startsWith('builtin:')) return value;
    const path = value.replace(/^\.\//, '');
    const sample = pattern ? path.replace(/[*?{}\[\]]/g, 'x') : path;
    assertArchivePath(sample.includes('/') ? sample : `${sample}/placeholder`);
    if (!pattern && !paths.some(file => file === path || file.startsWith(`${path}/`))) throw new Error(`Backup is missing the local package ${entry}. This may be an incomplete legacy backup.`);
    return path;
  };
  for (const source of packageSources(settings)) {
    if (source.startsWith('npm:')) {
      const spec = archive.kind === 'machine' ? /^npm:(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/ : /^npm:(@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[0-9A-Za-z.*^~+<>=| -]+)?$/;
      if (!spec.test(source)) throw new Error(`Invalid npm package in backup: ${source}`);
    } else if (/^(git:|https:\/\/|ssh:\/\/|git@)/.test(source)) {
      if (archive.kind === 'machine' && !/@[0-9a-f]{40,64}$/.test(source)) throw new Error(`Git package is not pinned to its backed-up revision: ${source}`);
    } else portable(source);
  }
  for (const key of RESOURCE_KEYS) for (const path of settings[key] as string[] ?? []) portable(path, true);
}

async function noSymlink(root: string, relative: string): Promise<void> {
  const parts = relative.split('/');
  for (const index of parts.keys()) {
    const path = join(root, ...parts.slice(0, index + 1));
    if ((await exists(path))?.isSymbolicLink()) throw new Error(`Refusing to restore through a symbolic link: ${path}`);
  }
}

async function preservePrivateFiles(source: string, target: string): Promise<void> {
  const info = await exists(source);
  if (!info?.isDirectory()) return;
  for (const name of await readdir(source)) {
    if (name === 'node_modules' || name === '.git') continue;
    const from = join(source, name);
    const to = join(target, name);
    const privateFile = name.startsWith('.env') || ['auth.json', 'credentials.json', 'tokens.json'].includes(name);
    const entry = await lstat(from);
    if (privateFile) {
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await cp(from, to, { recursive: true, dereference: false, force: false, errorOnExist: true });
    } else if (entry.isDirectory() && !name.startsWith('.')) await preservePrivateFiles(from, to);
  }
}

export async function restoreMachineArchive(
  agentDir: string,
  value: unknown,
  hostFactory: (stagedAgentDir: string) => PiHost,
  onProgress: (message: string) => void = () => undefined,
): Promise<RestoreResult> {
  const archive = await verifyArchive(value);
  checkSettings(archive, archiveSettings(archive));
  return withMachineLock(agentDir, () => restoreUnlocked(agentDir, archive, hostFactory, onProgress));
}

async function restoreUnlocked(agentDir: string, archive: MachineArchive, hostFactory: (dir: string) => PiHost, onProgress: (message: string) => void): Promise<RestoreResult> {
  const settings = archiveSettings(archive);
  checkSettings(archive, settings);
  if ((await exists(agentDir))?.isSymbolicLink()) throw new Error('The target Pi agent directory must not be a symbolic link.');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const managed = [...PORTABLE_FILES, ...PORTABLE_DIRS, 'npm', 'git', 'node_modules'];
  // All destination roots are checked before downloads, installs, or changes to active config.
  for (const root of managed) if ((await exists(join(agentDir, root)))?.isSymbolicLink()) throw new Error(`Portable root is a symbolic link: ${root}`);
  const work = await mkdtemp(join(agentDir, '.pi-sync-restore-'));
  const fresh = join(work, 'new');
  const saved = join(work, 'previous');
  const changes: Array<{ name: string; old: boolean; installed: boolean }> = [];
  const committing = { started: false };
  try {
    await mkdir(fresh, { mode: 0o700 });
    await mkdir(saved, { mode: 0o700 });
    await writeFile(join(work, 'case-probe'), '');
    const insensitive = !!await exists(join(work, 'CASE-PROBE'));
    await rm(join(work, 'case-probe'));
    const caseKey = (path: string): string => insensitive ? path.toLowerCase() : path;
    const roots = managed.filter((name, index) => managed.findIndex(other => caseKey(name) === caseKey(other)) === index);
    const spellings = new Map<string, string>();
    for (const file of archive.files) for (const [index] of file.path.split('/').entries()) {
      const path = file.path.split('/').slice(0, index + 1).join('/');
      const previous = spellings.get(caseKey(path));
      if (previous && previous !== path) throw new Error(`Backup paths collide on this filesystem: ${previous} and ${path}`);
      spellings.set(caseKey(path), path);
    }
    const affected = new Set(archive.files.map(file => caseKey(file.path.split('/')[0]!)));
    if (archive.kind === 'legacy') {
      for (const name of PORTABLE_DIRS) if (affected.has(caseKey(name)) && await exists(join(agentDir, name))) await cp(join(agentDir, name), join(fresh, name), {
        recursive: true, filter: path => !['node_modules', '.git'].includes(basename(path)),
      });
    }
    onProgress('Preparing configuration and local extensions…');
    for (const file of archive.files) {
      await noSymlink(fresh, file.path);
      const target = join(fresh, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const bytes = archiveBytes(file);
      const content = ['mcp.json', 'models.json', 'settings.json'].includes(file.path) ? (() => {
        const incoming = JSON.parse(new TextDecoder().decode(bytes));
        return incoming;
      })() : undefined;
      const own = content === undefined ? undefined : JSON.parse(await readFile(join(agentDir, file.path), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
      const protectedContent = content === undefined ? undefined : keepCredentials(file.path === 'settings.json' ? content : stripSecretKeys(content), own);
      await writeFile(target, protectedContent === undefined ? bytes : `${JSON.stringify(protectedContent, null, 2)}\n`, { mode: file.executable ? 0o700 : 0o600 });
    }
    if (archive.kind === 'machine') for (const root of PORTABLE_DIRS) await preservePrivateFiles(join(agentDir, root), join(fresh, root));
    if (affected.has('settings.json')) {
      const incoming = JSON.parse(await readFile(join(fresh, 'settings.json'), 'utf8'));
      const current = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
      const portable = Object.fromEntries(Object.entries(incoming).filter(([key]) => !(MACHINE_SETTINGS as readonly string[]).includes(key)));
      const local = Object.fromEntries(Object.entries(current).filter(([key]) => (MACHINE_SETTINGS as readonly string[]).includes(key)));
      await writeFile(join(fresh, 'settings.json'), `${JSON.stringify({ ...portable, ...local }, null, 2)}\n`, { mode: 0o600 });
    }
    const host = hostFactory(fresh);
    const sources = packageSources(settings);
    for (const [index, source] of sources.entries()) {
      onProgress(`Installing package ${index + 1}/${sources.length}: ${source}`);
      if (/^(npm:|git:|https:\/\/|ssh:\/\/|git@)/.test(source)) await host.installPackage(source);
      else await host.installPackage(resolve(fresh, source));
    }
    const manifests = new Set(archive.files.filter(file => file.path === 'package.json' || file.path.endsWith('/package.json')).map(file => dirname(file.path)));
    const localManifests = [...manifests].filter(path => ![...manifests].some(parent => parent !== '.' && parent !== path && path.startsWith(`${parent}/`)));
    for (const path of localManifests) {
      onProgress(`Installing local extension dependencies: ${path}`);
      await host.installLocalDependencies(join(fresh, path));
    }
    if (affected.has('settings.json')) await host.applySettings(fresh, JSON.parse(await readFile(join(fresh, 'settings.json'), 'utf8')));
    onProgress('Applying the restored setup…');
    committing.started = true;
    for (const name of roots.filter(name => name !== 'settings.json').concat('settings.json')) {
      if (archive.kind === 'legacy' && !affected.has(caseKey(name)) && !await exists(join(fresh, name))) continue;
      // An absent package store is removed for complete restores, but never touches auth or sessions.
      const change = { name, old: false, installed: false };
      changes.push(change);
      if (await exists(join(agentDir, name))) { await rename(join(agentDir, name), join(saved, name)); change.old = true; }
      if (await exists(join(fresh, name))) { await rename(join(fresh, name), join(agentDir, name)); change.installed = true; }
    }
  } catch (error) {
    const failures: string[] = [];
    if (committing.started) for (const change of [...changes].reverse()) {
      try {
        if (change.installed) await rm(join(agentDir, change.name), { recursive: true, force: true });
        if (change.old) await rename(join(saved, change.name), join(agentDir, change.name));
      } catch { failures.push(change.name); }
    }
    if (!failures.length) await rm(work, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}${failures.length ? ` Rollback needs attention (${failures.join(', ')}); previous files remain at ${saved}.` : ' Active Pi configuration was not changed.'}`);
  }
  await rm(fresh, { recursive: true, force: true }).catch(() => undefined);
  // Moving recovery data is best-effort after a successful commit; the safe fallback is never deleted.
  const recoveryDir = await (async () => {
    const history = join(syncHome(), 'restores');
    await mkdir(history, { recursive: true, mode: 0o700 });
    const destination = join(history, basename(work).replace('.pi-sync-restore-', ''));
    await rename(work, destination);
    return join(destination, 'previous');
  })().catch(() => saved);
  return { files: archive.files.length, packages: packageSources(settings).length, recoveryDir };
}
