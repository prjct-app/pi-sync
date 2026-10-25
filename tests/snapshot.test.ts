import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSnapshot } from '../src/snapshot.ts';
import { forgetAuth, writeAuth } from '../src/store.ts';
import type { BackupInfo } from '../src/archive-schema.ts';
import type { Fetcher } from '../src/client.ts';

process.env.PRJCT_HOME = await mkdtemp(join(tmpdir(), 'pi-sync-inventory-'));
const token = `pis_${'a'.repeat(64)}`;
const backup: BackupInfo = { id: '11111111-1111-4111-8111-111111111111', deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceName: 'Laptop', createdAt: '2026-10-25T00:00:00Z', fileCount: 10, packageCount: 3, totalBytes: 1000 };
const respond = (status: number, body: unknown): Fetcher => async () => Response.json(body, { status });

test('opening while disconnected never contacts the service', async () => {
  await forgetAuth('');
  const snap = await loadSnapshot('', 'Desktop', 'https://sync.example', async () => assert.fail('not authenticated'));
  assert.equal(snap.connected, false);
  assert.deepEqual(snap.backups, []);
});

test('the inventory lists complete machines and preserved legacy backups using only authenticated GETs', async () => {
  await writeAuth('', { token, connectedAt: 'today' });
  const snap = await loadSnapshot('', 'Desktop', 'https://sync.example', async (input, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    const path = new URL(String(input)).pathname;
    return Response.json(path === '/backups' ? { backups: [backup] } : { files: [{ path: 'AGENTS.md', revision: 2, sha256: 'hash', deleted: false, updated_at: '2026-10-20T00:00:00Z' }] });
  });
  assert.equal(snap.serviceReady, true);
  assert.equal(snap.backups[0]?.id, backup.id);
  assert.equal(snap.backups[1]?.id, 'legacy');
  assert.equal(snap.backups[1]?.legacy, true);
});

test('an older service reports the deployment blocker, without pretending shared files are complete snapshots', async () => {
  await writeAuth('', { token, connectedAt: 'today' });
  const snap = await loadSnapshot('', 'Desktop', 'https://sync.example', async input => {
    if (String(input).endsWith('/backups')) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json({ files: [{ path: 'AGENTS.md', revision: 1, sha256: 'hash', deleted: false, updated_at: '2026-10-20T00:00:00Z' }] });
  });
  assert.equal(snap.serviceReady, false);
  assert.match(snap.remoteError!, /upgrade/);
  assert.equal(snap.backups[0]?.legacy, true);
});

test('expired logins and network errors are not shown as an empty successful account', async () => {
  await writeAuth('', { token, connectedAt: 'today' });
  const expired = await loadSnapshot('', 'Desktop', 'https://sync.example', respond(401, { error: 'not connected' }));
  assert.equal(expired.needsLogin, true);
  const failed = await loadSnapshot('', 'Desktop', 'https://sync.example', async () => { throw new Error('offline'); });
  assert.match(failed.remoteError!, /offline/);
  assert.equal(failed.serviceReady, false);
  const empty = await loadSnapshot('', 'Desktop', 'https://sync.example', async input => Response.json(String(input).endsWith('/backups') ? { backups: [] } : { files: [] }));
  assert.equal(empty.remoteError, undefined);
  assert.equal(empty.serviceReady, true);
  assert.deepEqual(empty.backups, []);
});
