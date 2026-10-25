import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient, SyncApiError } from '../src/client.ts';
import { archiveFile, collectMachineArchive } from '../src/archive.ts';
import type { BackupInfo, MachineArchive, MachineBackup } from '../src/archive-schema.ts';
import { restoreMachineArchive } from '../src/restore.ts';
import type { PiHost } from '../src/pi.ts';

process.env.PRJCT_HOME = await mkdtemp(join(tmpdir(), 'pi-sync-service-state-'));
const tokenA = `pis_${'1'.repeat(64)}`;
const tokenB = `pis_${'2'.repeat(64)}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const users = new Map([[hash(tokenA), 'account-a'], [hash(tokenB), 'account-b']]);
const captured: { handler?: (req: Request) => Promise<Response> | Response } = {};
const serviceEnv: Record<string, string> = { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' };
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (name: string) => serviceEnv[name] }, serve: (handler: typeof captured.handler) => { captured.handler = handler; } };
await import('../supabase/functions/pi-sync/index.ts');
const device = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Source laptop' };
const archive = (): MachineArchive => ({ version: 1, kind: 'machine', files: [archiveFile('settings.json', '{"packages":["npm:tool@1.2.3"]}'), archiveFile('AGENTS.md', 'source rules')] });
const fetcher: typeof fetch = async (input, init) => captured.handler!(new Request(input, init));
const apiA = () => createClient(tokenA, 'https://service.example/pi-sync', fetcher);
const apiB = () => createClient(tokenB, 'https://service.example/pi-sync', fetcher);

function database() {
  const rows = new Map<string, MachineBackup & { user: string }>();
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://db.example', 'never contact a real backend in tests');
    assert.equal(new Headers(init?.headers).get('apikey'), 'test-service-key');
    const table = url.pathname.split('/').at(-1)!;
    const project = ({ user: _user, archive, ...summary }: MachineBackup & { user: string }) => url.searchParams.get('select')?.includes('archive') ? { ...summary, archive } : summary;
    calls.push(`${init?.method ?? 'GET'} ${table}`);
    if (table === 'sync_tokens') {
      const user = users.get(url.searchParams.get('token_hash')!.slice(3));
      return Response.json(user ? [{ user_id: user }] : []);
    }
    if (table === 'pi_sync_files') return Response.json([]);
    assert.equal(table, 'pi_sync_backups');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const row: MachineBackup & { user: string } = { id: randomUUID(), user: body.user_id, deviceId: body.device_id, deviceName: body.device_name, createdAt: new Date(Date.now() + rows.size).toISOString(), fileCount: body.file_count, packageCount: body.package_count, totalBytes: body.total_bytes, archive: body.archive };
      rows.set(row.id, row);
      return Response.json([project(row)]);
    }
    const account = url.searchParams.get('user_id')?.slice(3);
    assert.ok(account, 'every list, read and delete must filter by the authenticated account');
    const id = url.searchParams.get('id')?.slice(3);
    const matching = [...rows.values()].filter(row => row.user === account && (!id || row.id === id));
    if (init?.method === 'DELETE') { for (const row of matching) rows.delete(row.id); return Response.json(matching.map(row => ({ id: row.id }))); }
    return Response.json(matching.map(project));
  };
  return { rows, calls, fetch };
}

test('snapshots are immutable dated versions per machine, isolated by signed-in account', async t => {
  const db = database();
  t.mock.method(globalThis, 'fetch', db.fetch);
  const first = await apiA().createBackup(device, archive());
  const second = await apiA().createBackup(device, archive());
  const other = await apiB().createBackup(device, archive());
  assert.notEqual(first.id, second.id);
  assert.equal(first.deviceId, second.deviceId);
  assert.equal(first.fileCount, 2);
  assert.equal(first.packageCount, 1);
  const summaries = await apiA().backups();
  assert.equal(summaries.length, 2);
  assert.equal('archive' in summaries[0]!, false, 'the machine list must not download private file contents');
  assert.deepEqual((await apiB().backups()).map(backup => backup.id), [other.id]);
  await assert.rejects(apiB().backup(first.id), (error: unknown) => error instanceof SyncApiError && error.status === 404);
  await assert.rejects(apiB().deleteBackup(first.id), (error: unknown) => error instanceof SyncApiError && error.status === 404);
  assert.equal(db.rows.size, 3);
  assert.equal((await apiA().backup(first.id)).archive.files[1]?.content, 'source rules');
});

test('an entire machine is published in one validated insert; bad paths, checksums and secrets publish nothing', async t => {
  const db = database();
  t.mock.method(globalThis, 'fetch', db.fetch);
  const cases = [
    { ...archive(), files: [archiveFile('settings.json', '{}'), archiveFile('../auth.json', 'secret')] },
    { ...archive(), files: [{ ...archive().files[0]!, sha256: '0'.repeat(64) }] },
    { ...archive(), files: [archiveFile('settings.json', '{}'), archiveFile('AGENTS.md', 'sk-ABCDEFGHIJKLMNOPQRSTUV')] },
    { ...archive(), files: [archiveFile('settings.json', '{}'), archiveFile('extensions/.env', 'secret')] },
  ];
  for (const invalid of cases) await assert.rejects(apiA().createBackup(device, invalid), (error: unknown) => error instanceof SyncApiError && error.status === 400);
  assert.equal(db.rows.size, 0);
  assert.ok(!db.calls.includes('POST pi_sync_backups'));
});

test('missing tokens and tokens for another product cannot access machine backups', async t => {
  const db = database();
  t.mock.method(globalThis, 'fetch', db.fetch);
  for (const token of [undefined, `pit_${'1'.repeat(64)}`]) {
    const client = createClient(token, 'https://service.example/pi-sync', fetcher);
    await assert.rejects(client.backups(), (error: unknown) => error instanceof SyncApiError && error.status === 401);
  }
  assert.deepEqual(db.calls, []);
});

test('deleting one snapshot preserves other backups and cannot update existing versions', async t => {
  const db = database();
  t.mock.method(globalThis, 'fetch', db.fetch);
  const first = await apiA().createBackup(device, archive());
  const second = await apiA().createBackup(device, archive());
  const update = await captured.handler!(new Request(`https://service.example/pi-sync/backups/${first.id}`, { method: 'PUT', headers: { authorization: `Bearer ${tokenA}` }, body: '{}' }));
  assert.equal(update.status, 404);
  await apiA().deleteBackup(first.id);
  assert.deepEqual((await apiA().backups()).map(backup => backup.id), [second.id]);
});

test('the service rejects malformed backup bodies and invalid device IDs without database writes', async t => {
  const db = database();
  t.mock.method(globalThis, 'fetch', db.fetch);
  for (const body of ['null', '{invalid', JSON.stringify({ device: { id: 'bad', name: 'bad' }, archive: archive() })]) {
    const response = await captured.handler!(new Request('https://service.example/pi-sync/backups', { method: 'POST', headers: { authorization: `Bearer ${tokenA}` }, body }));
    assert.equal(response.status, 400);
  }
  assert.equal(db.rows.size, 0);
});

test('end to end: machine A uploads, machine B on the same account lists, downloads and restores with automatic installation', async t => {
  const db = database();
  t.mock.method(globalThis, 'fetch', db.fetch);
  const source = await mkdtemp(join(tmpdir(), 'pi-sync-e2e-source-'));
  const target = await mkdtemp(join(tmpdir(), 'pi-sync-e2e-target-'));
  await mkdir(join(source, 'extensions'), { recursive: true });
  await writeFile(join(source, 'settings.json'), '{"packages":["npm:tool"],"theme":"dark"}');
  await writeFile(join(source, 'AGENTS.md'), 'machine A rules');
  await writeFile(join(source, 'extensions/tool.ts'), 'export default () => {};');
  await writeFile(join(target, 'AGENTS.md'), 'machine B previous rules');
  const installs: string[] = [];
  const host: PiHost = {
    pinPackage: async () => 'npm:tool@1.2.3', installPackage: async source => { installs.push(source); }, installLocalDependencies: async () => undefined,
    applySettings: async (dir, settings) => { await writeFile(join(dir, 'settings.json'), JSON.stringify(settings)); }, reloadSettings: async () => undefined,
  };
  const content = await collectMachineArchive(source, host);
  const saved = await apiA().createBackup(device, content);
  const machineB = apiA();
  assert.equal((await machineB.backups())[0]?.id, saved.id);
  const downloaded = await machineB.backup(saved.id);
  const restored = await restoreMachineArchive(target, downloaded.archive, () => host);
  assert.deepEqual(installs, ['npm:tool@1.2.3']);
  assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), 'machine A rules');
  assert.equal(await readFile(join(target, 'extensions/tool.ts'), 'utf8'), 'export default () => {};');
  assert.equal(await readFile(join(restored.recoveryDir, 'AGENTS.md'), 'utf8'), 'machine B previous rules');
  assert.equal(await readFile(join(source, 'AGENTS.md'), 'utf8'), 'machine A rules');
  assert.equal(db.rows.size, 1, 'restore never uploads machine B over machine A');
});
