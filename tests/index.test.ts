import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DefaultPackageManager, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { forgetAuth, readAuth, readDevice, readState, writeAuth, writeState } from '../src/store.ts';
import { archiveFile } from '../src/archive.ts';
import type { MachineBackup } from '../src/archive-schema.ts';

process.env.PRJCT_HOME = await mkdtemp(join(tmpdir(), 'pi-sync-command-home-'));
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'pi-sync-command-agent-'));
const agentDir = process.env.PI_CODING_AGENT_DIR;
const { default: piSync } = await import('../index.ts');
const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
piSync({ registerCommand: (name: string, command: Parameters<ExtensionAPI['registerCommand']>[1]) => commands.set(name, command) } as unknown as ExtensionAPI);
const token = `pis_${'c'.repeat(64)}`;
const backup: MachineBackup = {
  id: '11111111-1111-4111-8111-111111111111', deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceName: 'My laptop', createdAt: '2026-10-25T12:00:00Z', fileCount: 3, packageCount: 1, totalBytes: 100,
  archive: { version: 1, kind: 'machine', files: [archiveFile('settings.json', '{"theme":"dark","packages":["npm:tool@1.2.3"]}'), archiveFile('AGENTS.md', 'laptop rules\n'), archiveFile('extensions/restored.ts', 'export default () => {};\n')] },
};
function context(approved = true, hasUI = true) {
  const cell = { notes: [] as string[], questions: [] as string[], reloads: 0 };
  const ctx = { hasUI, mode: hasUI ? 'tui' : 'print', cwd: agentDir,
    reload: async () => { cell.reloads++; },
    ui: { notify: (text: string) => cell.notes.push(text), setStatus() {}, confirm: async (title: string, body: string) => { cell.questions.push(`${title}\n${body}`); return approved; }, custom: () => assert.fail('explicit subcommand must execute, not just open a panel') },
  } as unknown as ExtensionCommandContext;
  return { ctx, cell };
}
async function put(path: string, content: string) { await mkdir(dirname(join(agentDir, path)), { recursive: true }); await writeFile(join(agentDir, path), content); }


test('the current command and legacy alias expose the same simple machine workflow', () => {
  assert.ok(commands.has('sync'));
  assert.equal(commands.get('sync')?.handler, commands.get('pi-sync')?.handler);
});

test('backing up requires login and never silently starts a two-way sync', async () => {
  await forgetAuth(agentDir);
  const { ctx, cell } = context();
  await commands.get('sync')!.handler('backup', ctx);
  assert.match(cell.notes.at(-1)!, /Log in first/);
});

test('login replaces the previous account baseline without changing machine identity', async t => {
  await writeState(agentDir, { bases: { 'AGENTS.md': { revision: 1, content: 'old' } }, installed: [] });
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo) => String(input).endsWith('/link')
    ? Response.json({ code: 'ABCD-EFGH', poll: 'poll', url: 'https://sync.example/approve' })
    : Response.json({ status: 'ok', token }));
  const { ctx, cell } = context();
  await commands.get('pi-sync')!.handler('login', ctx);
  assert.equal((await readAuth(agentDir))?.token, token);
  assert.deepEqual(await readState(agentDir), { bases: {}, installed: [] });
  assert.match(cell.notes.at(-1)!, /Connected.*Back up this machine/);
});

test('one backup action uploads one complete immutable machine snapshot, without changing local files', async t => {
  await writeAuth(agentDir, { token, connectedAt: 'today' });
  await put('settings.json', '{"theme":"dark","packages":[]}');
  await put('AGENTS.md', 'desktop instructions');
  await put('extensions/local/index.ts', 'export default () => {};');
  await put('extensions/local/src/helper.ts', 'export const helper = 1;');
  const uploads: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.match(String(input), /\/backups$/);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    const body = JSON.parse(String(init?.body));
    uploads.push(body);
    assert.ok(body.archive.files.some((file: { path: string }) => file.path === 'extensions/local/src/helper.ts'));
    return Response.json({ ...backup, deviceId: body.device.id, deviceName: body.device.name, fileCount: body.archive.files.length, packageCount: 0 }, { status: 201 });
  });
  const { ctx, cell } = context();
  await commands.get('sync')!.handler('backup', ctx);
  assert.equal(uploads.length, 1);
  assert.ok(await readDevice());
  assert.match(cell.notes.at(-1)!, /Backed up/);
  assert.equal(cell.questions.length, 0, 'upload does not need restore-style permissions');
  assert.equal(await readFile(join(agentDir, 'AGENTS.md'), 'utf8'), 'desktop instructions');
});

test('report lists dated machine backups and IDs without downloading or restoring their content', async t => {
  await writeAuth(agentDir, { token, connectedAt: 'today' });
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(init?.method, 'GET');
    return Response.json(String(input).endsWith('/backups') ? { backups: [backup] } : { files: [] });
  });
  const { ctx, cell } = context();
  await commands.get('sync')!.handler('report', ctx);
  assert.match(cell.notes[0]!, /My laptop/);
  assert.match(cell.notes[0]!, new RegExp(backup.id));
  assert.equal(cell.questions.length, 0);
  assert.equal(cell.reloads, 0);
});

test('restore asks once, automatically installs extensions and reloads Pi without accept-code flags', async t => {
  await writeAuth(agentDir, { token, connectedAt: 'today' });
  await put('auth.json', 'target credentials');
  await put('AGENTS.md', 'desktop instructions');
  const installations: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(init?.method, 'GET', 'restoring must never upload local changes');
    assert.match(String(input), new RegExp(`/backups/${backup.id}$`));
    return Response.json(backup);
  });
  t.mock.method(DefaultPackageManager.prototype, 'install', async function (source: string) { installations.push(source); });
  const { ctx, cell } = context();
  await commands.get('sync')!.handler(`restore ${backup.id}`, ctx);
  assert.equal(cell.questions.length, 1);
  assert.match(cell.questions[0]!, /automatically installs/);
  assert.deepEqual(installations, ['npm:tool@1.2.3']);
  assert.equal(await readFile(join(agentDir, 'AGENTS.md'), 'utf8'), 'laptop rules\n');
  assert.equal(await readFile(join(agentDir, 'extensions/restored.ts'), 'utf8'), 'export default () => {};\n');
  assert.equal(await readFile(join(agentDir, 'auth.json'), 'utf8'), 'target credentials');
  assert.equal(cell.reloads, 1);
  assert.match(cell.notes.at(-1)!, /Previous setup:/);
});

test('cancelling restore never changes configuration, installs packages or reloads', async t => {
  await writeAuth(agentDir, { token, connectedAt: 'today' });
  await put('AGENTS.md', 'keep this setup');
  t.mock.method(globalThis, 'fetch', async () => Response.json(backup));
  t.mock.method(DefaultPackageManager.prototype, 'install', async () => assert.fail('cancelled'));
  const { ctx, cell } = context(false);
  await commands.get('sync')!.handler(`restore ${backup.id}`, ctx);
  assert.equal(await readFile(join(agentDir, 'AGENTS.md'), 'utf8'), 'keep this setup');
  assert.equal(cell.questions.length, 1);
  assert.equal(cell.reloads, 0);
  assert.match(cell.notes.at(-1)!, /cancelled/);
});

test('failed automatic installation reports failure and keeps the active setup', async t => {
  await writeAuth(agentDir, { token, connectedAt: 'today' });
  await put('AGENTS.md', 'keep this setup');
  t.mock.method(globalThis, 'fetch', async () => Response.json(backup));
  t.mock.method(DefaultPackageManager.prototype, 'install', async () => { throw new Error('registry offline'); });
  const { ctx, cell } = context();
  await commands.get('sync')!.handler(`restore ${backup.id}`, ctx);
  assert.match(cell.notes.at(-1)!, /registry offline.*configuration was not changed/s);
  assert.equal(cell.reloads, 0);
  assert.equal(await readFile(join(agentDir, 'AGENTS.md'), 'utf8'), 'keep this setup');
});

test('non-interactive restoration requires explicit approval rather than silently replacing a machine', async t => {
  await writeAuth(agentDir, { token, connectedAt: 'today' });
  t.mock.method(globalThis, 'fetch', async () => Response.json(backup));
  const { ctx, cell } = context(true, false);
  await commands.get('sync')!.handler(`restore ${backup.id}`, ctx);
  assert.match(cell.notes.at(-1)!, /explicitly pass --yes/);
  assert.equal(cell.reloads, 0);
});

test('deletion has one confirmation and only deletes the chosen account snapshot', async t => {
  await writeAuth(agentDir, { token, connectedAt: 'today' });
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.match(String(input), new RegExp(`/backups/${backup.id}$`));
    assert.equal(init?.method, 'DELETE');
    return Response.json({ ok: true });
  });
  const { ctx, cell } = context();
  await commands.get('sync')!.handler(`delete ${backup.id}`, ctx);
  assert.equal(cell.questions.length, 1);
  assert.equal(cell.reloads, 0);
  assert.match(cell.notes.at(-1)!, /Backup deleted/);
});
