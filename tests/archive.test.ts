import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { archiveFile, collectMachineArchive } from '../src/archive.ts';
import { archiveSettings, validateArchive, verifyArchive, type MachineArchive } from '../src/archive-schema.ts';
import { restoreMachineArchive } from '../src/restore.ts';
import type { PiHost } from '../src/pi.ts';

process.env.PRJCT_HOME = await mkdtemp(join(tmpdir(), 'pi-sync-machine-state-'));
const temp = (name: string) => mkdtemp(join(tmpdir(), `pi-sync-${name}-`));
async function put(root: string, path: string, content: string | Uint8Array) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
const minimal = (rules = 'source rules\n'): MachineArchive => ({ version: 1, kind: 'machine', files: [archiveFile('settings.json', '{}\n'), archiveFile('AGENTS.md', rules)] });
const host = (events: string[] = [], fail?: string): PiHost => ({
  pinPackage: async source => source.startsWith('npm:filtered') ? 'npm:filtered@2.0.0' : 'npm:tool@1.2.3',
  installPackage: async source => { events.push(source); if (fail) throw new Error(fail); },
  installLocalDependencies: async path => { events.push(`dependencies:${path}`); await put(path, 'node_modules/dependency/index.js', 'installed'); },
  applySettings: async (dir, settings) => put(dir, 'settings.json', `${JSON.stringify(settings, null, 2)}\n`),
  reloadSettings: async () => undefined,
});

async function sourceMachine() {
  const root = await temp('source-machine');
  const external = await temp('local-package');
  await put(external, 'package.json', JSON.stringify({ name: 'local-extension', dependencies: { dependency: '^1.0.0' } }));
  await put(external, 'index.ts', "export { value } from './src/helper.ts';\n");
  await put(external, 'src/helper.ts', 'export const value = 1;\n');
  await put(external, 'node_modules/private-data.txt', 'not uploaded');
  await put(external, '.env', 'LOCAL_SECRET=not-uploaded');
  await put(root, 'settings.json', JSON.stringify({
    theme: 'custom', deviceId: 'source-machine', sessionDir: '/source/sessions', npmCommand: ['/source/npm'],
    extensions: ['./extensions/live.ts', '-./extensions/disabled.ts'],
    packages: ['npm:tool', { source: 'npm:filtered@^2', extensions: ['index.ts'] }, external],
  }));
  await put(root, 'AGENTS.md', 'source instructions\n');
  await put(root, 'keybindings.json', '{}\n');
  await put(root, 'extensions/live.ts', 'export default () => {};\n');
  await put(root, 'extensions/disabled.ts', 'export default () => {};\n');
  await put(root, 'extensions/multi/index.js', 'export default () => {};\n');
  await put(root, 'extensions/multi/src/helper.js', 'export const helper = true;\n');
  await put(root, 'extensions/.env', 'THIS_MACHINE_ONLY=source');
  await put(root, 'skills/tool/SKILL.md', '# Tool\n');
  await put(root, 'skills/tool/run.sh', '#!/bin/sh\nprintf hello\n');
  await chmod(join(root, 'skills/tool/run.sh'), 0o700);
  await put(root, 'skills/tool/icon.png', new Uint8Array([0x89, 0xff, 0, 0x80]));
  await put(root, 'skills/tool/binary.dat', new Uint8Array([0, 1, 2, 3]));
  await put(root, 'prompts/review.md', 'Review the project.\n');
  await put(root, 'themes/custom.json', '{}\n');
  await put(root, 'instructions/testing.md', '# Testing\n');
  await put(root, 'mcp.json', JSON.stringify({ mcpServers: { example: { url: 'https://mcp.example', auth: 'source-secret', headers: { authorization: 'source-header' } } } }));
  await put(root, 'auth.json', 'private source login');
  await put(root, 'sessions/private.jsonl', 'private conversation');
  return { root, external };
}

test('a full setup captures all portable resource trees, binaries, executable bits and disabled preferences', async () => {
  const { root } = await sourceMachine();
  const archive = await collectMachineArchive(root, host());
  await verifyArchive(archive);
  const settings = archiveSettings(archive);
  assert.deepEqual(settings.extensions, ['./extensions/live.ts', '-./extensions/disabled.ts']);
  assert.equal(settings.deviceId, undefined);
  assert.equal(settings.sessionDir, undefined);
  assert.equal(settings.npmCommand, undefined);
  assert.equal((settings.packages as unknown[])[0], 'npm:tool@1.2.3');
  assert.deepEqual((settings.packages as unknown[])[1], { source: 'npm:filtered@2.0.0', extensions: ['index.ts'] });
  assert.match(String((settings.packages as unknown[])[2]), /^\.\/packages\/local-/);
  for (const path of ['keybindings.json', 'extensions/multi/src/helper.js', 'instructions/testing.md', 'skills/tool/SKILL.md', 'prompts/review.md', 'themes/custom.json']) assert.ok(archive.files.some(file => file.path === path), path);
  assert.equal(archive.files.find(file => file.path === 'skills/tool/icon.png')?.encoding, 'base64');
  assert.equal(archive.files.find(file => file.path === 'skills/tool/binary.dat')?.encoding, 'base64', 'NUL bytes cannot be stored as PostgreSQL JSON text');
  assert.equal(archive.files.find(file => file.path === 'skills/tool/run.sh')?.executable, true);
  assert.ok(archive.files.some(file => /packages\/local-.*\/src\/helper.ts/.test(file.path)));
  assert.ok(!archive.files.some(file => /node_modules|auth.json|sessions|\.env/.test(file.path)));
  assert.doesNotMatch(JSON.stringify(archive), /source-secret|source-header|private conversation|private source login/);
});

test('restoring on a second machine installs packages and local dependencies, replaces the setup and keeps its credentials', async () => {
  const { root } = await sourceMachine();
  const archive = await collectMachineArchive(root, host());
  const target = await temp('target-machine');
  await put(target, 'AGENTS.md', 'previous target rules');
  await put(target, 'settings.json', JSON.stringify({ theme: 'old', deviceId: 'target-id', npmCommand: ['npm'], oldOnly: true }));
  await put(target, 'extensions/old.ts', 'old code');
  await put(target, 'extensions/.env', 'THIS_MACHINE_ONLY=target');
  await put(target, 'mcp.json', JSON.stringify({ mcpServers: { example: { url: 'old', auth: 'target-secret', headers: { authorization: 'target-header' } } } }));
  await put(target, 'auth.json', 'target login');
  await put(target, 'sessions/keep.jsonl', 'target session');
  const installed: string[] = [];
  const result = await restoreMachineArchive(target, archive, () => host(installed));
  assert.equal(result.packages, 3);
  assert.ok(installed.includes('npm:tool@1.2.3'));
  assert.ok(installed.includes('npm:filtered@2.0.0'));
  assert.ok(installed.some(event => event.startsWith('dependencies:')));
  assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), 'source instructions\n');
  await assert.rejects(lstat(join(target, 'extensions/old.ts')), { code: 'ENOENT' });
  assert.equal(await readFile(join(target, 'extensions/multi/src/helper.js'), 'utf8'), 'export const helper = true;\n');
  assert.equal(await readFile(join(target, 'extensions/.env'), 'utf8'), 'THIS_MACHINE_ONLY=target');
  assert.equal(await readFile(join(target, 'auth.json'), 'utf8'), 'target login');
  assert.equal(await readFile(join(target, 'sessions/keep.jsonl'), 'utf8'), 'target session');
  const mcp = JSON.parse(await readFile(join(target, 'mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.example.auth, 'target-secret');
  assert.equal(mcp.mcpServers.example.headers.authorization, 'target-header');
  assert.equal(mcp.mcpServers.example.url, 'https://mcp.example');
  const settings = JSON.parse(await readFile(join(target, 'settings.json'), 'utf8'));
  assert.equal(settings.deviceId, 'target-id');
  assert.deepEqual(settings.npmCommand, ['npm']);
  assert.equal(settings.oldOnly, undefined, 'a restore is not a newest-file merge');
  assert.equal((await lstat(join(target, 'skills/tool/run.sh'))).mode & 0o777, 0o700);
  assert.deepEqual([...await readFile(join(target, 'skills/tool/icon.png'))], [0x89, 0xff, 0, 0x80]);
  assert.deepEqual([...await readFile(join(target, 'skills/tool/binary.dat'))], [0, 1, 2, 3]);
  assert.equal(await readFile(join(result.recoveryDir, 'AGENTS.md'), 'utf8'), 'previous target rules');
  assert.equal(await readFile(join(result.recoveryDir, 'extensions/old.ts'), 'utf8'), 'old code');
});

test('a failed package install leaves active configuration and extensions unchanged', async () => {
  const target = await temp('failed-install');
  await put(target, 'AGENTS.md', 'target rules');
  await put(target, 'extensions/keep.ts', 'target extension');
  const archive: MachineArchive = { ...minimal(), files: [archiveFile('settings.json', JSON.stringify({ packages: ['npm:tool@1.2.3'] })), archiveFile('AGENTS.md', 'incoming')] };
  await assert.rejects(restoreMachineArchive(target, archive, () => host([], 'registry unavailable')), /registry unavailable.*Active Pi configuration was not changed/s);
  assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), 'target rules');
  assert.equal(await readFile(join(target, 'extensions/keep.ts'), 'utf8'), 'target extension');
  assert.ok(!(await readdir(target)).some(name => name.startsWith('.pi-sync-restore-')));
});

test('a failure during the final swap rolls already-replaced roots back', async () => {
  const target = await temp('rollback');
  await put(target, 'settings.json', '{"theme":"previous"}');
  await put(target, 'AGENTS.md', 'target rules');
  await put(target, 'extensions/keep.ts', 'target code');
  const fake = host();
  await assert.rejects(restoreMachineArchive(target, minimal(), () => ({ ...fake, applySettings: async (dir, settings) => {
    await fake.applySettings(dir, settings);
    await mkdir(join(dirname(dir), 'previous/settings.json'));
  } })), /Active Pi configuration was not changed/);
  assert.equal(await readFile(join(target, 'settings.json'), 'utf8'), '{"theme":"previous"}');
  assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), 'target rules');
  assert.equal(await readFile(join(target, 'extensions/keep.ts'), 'utf8'), 'target code');
});

test('bad checksums, escaping paths, duplicate paths and file/directory collisions fail before staging', async () => {
  const target = await temp('invalid-archive');
  const archive = minimal();
  const malicious = [
    { ...archive, files: [...archive.files, archiveFile('../escape.ts', 'bad')] },
    { ...archive, files: [...archive.files, archiveFile('extensions/../auth.json', 'bad')] },
    { ...archive, files: [...archive.files, archiveFile('extensions/.env', 'bad')] },
    { ...archive, files: [...archive.files, archive.files[0]!] },
    { ...archive, files: [...archive.files, archiveFile('extensions/thing', 'file'), archiveFile('extensions/thing/child.ts', 'child')] },
    { ...archive, files: [{ ...archive.files[0]!, sha256: '0'.repeat(64) }] },
  ];
  for (const value of malicious) await assert.rejects(restoreMachineArchive(target, value, () => assert.fail('must validate first')));
  assert.deepEqual(await readdir(target), []);
});

test('symbolic links cannot redirect a restore outside the target directory', async () => {
  const target = await temp('symlink-target');
  const outside = await temp('outside');
  await put(outside, 'keep.ts', 'not modified');
  await symlink(outside, join(target, 'extensions'));
  await assert.rejects(restoreMachineArchive(target, minimal(), () => host()), /symbolic link/);
  assert.equal(await readFile(join(outside, 'keep.ts'), 'utf8'), 'not modified');
});

test('a legacy partial backup does not erase unrelated portable resources', async () => {
  const target = await temp('legacy-restore');
  await put(target, 'extensions/keep.ts', 'keep');
  await put(target, 'skills/keep/SKILL.md', 'keep skill');
  await put(target, 'settings.json', '{"theme":"keep"}');
  await restoreMachineArchive(target, { version: 1, kind: 'legacy', files: [archiveFile('AGENTS.md', 'older rules')] }, () => host());
  assert.equal(await readFile(join(target, 'extensions/keep.ts'), 'utf8'), 'keep');
  assert.equal(await readFile(join(target, 'skills/keep/SKILL.md'), 'utf8'), 'keep skill');
  assert.equal(await readFile(join(target, 'settings.json'), 'utf8'), '{"theme":"keep"}');
});

test('a literal secret blocks collection rather than uploading it in a complete snapshot', async () => {
  const root = await temp('secret-source');
  await put(root, 'AGENTS.md', 'sk-ABCDEFGHIJKLMNOPQRSTUV');
  await assert.rejects(collectMachineArchive(root, host()), /refusing to send/);
});

test('unsupported or missing local package sources fail before changing the target', async () => {
  const target = await temp('incomplete');
  await put(target, 'AGENTS.md', 'keep');
  const archive = { ...minimal(), files: [archiveFile('settings.json', '{"packages":["/source/missing-extension"]}')] };
  await assert.rejects(restoreMachineArchive(target, archive, () => assert.fail('must not install')), /not portable|not allowed/);
  assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), 'keep');
  assert.throws(() => validateArchive({ version: 99, files: [] }), /Unsupported/);
});

test('external single-file extensions include the enclosing package and sibling helper sources', async () => {
  const { root, external } = await sourceMachine();
  await put(external, 'src/tool.ts', "import './helper.ts'; export default () => {};\n");
  await put(root, 'settings.json', JSON.stringify({ extensions: [join(external, 'src/tool.ts')] }));
  const archive = await collectMachineArchive(root, host());
  assert.match(String((archiveSettings(archive).extensions as string[])[0]), /^\.\/packages\/local-.*\/src\/tool.ts$/);
  assert.ok(archive.files.some(file => /packages\/local-.*\/package.json/.test(file.path)));
  assert.ok(archive.files.some(file => /packages\/local-.*\/src\/helper.ts/.test(file.path)));
});

test('unportable dependency links are caught before a supposedly complete backup can be uploaded', async () => {
  const root = await temp('unportable-source');
  await put(root, 'extensions/local/package.json', '{"dependencies":{"sibling":"workspace:*"}}');
  await assert.rejects(collectMachineArchive(root, host()), /local\/workspace dependency links cannot be restored/);
});

test('restoration detects case collisions on the destination filesystem instead of losing files', async () => {
  const target = await temp('case-sensitive-restore');
  await put(target, 'case-probe', 'probe');
  await put(target, 'AGENTS.md', 'keep until validated');
  const insensitive = await lstat(join(target, 'CASE-PROBE')).then(() => true).catch(() => false);
  const archive = { ...minimal(), files: [...minimal().files, archiveFile('extensions/Tool.ts', 'upper'), archiveFile('extensions/tool.ts', 'lower')] };
  if (insensitive) {
    await assert.rejects(restoreMachineArchive(target, archive, () => host()), /collide on this filesystem/);
    assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), 'keep until validated');
  } else {
    await restoreMachineArchive(target, archive, () => host());
    assert.equal(await readFile(join(target, 'extensions/Tool.ts'), 'utf8'), 'upper');
    assert.equal(await readFile(join(target, 'extensions/tool.ts'), 'utf8'), 'lower');
  }
});
