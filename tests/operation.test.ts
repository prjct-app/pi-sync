import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withMachineLock } from '../src/operation.ts';

test('concurrent backup/restore operations cannot interleave one machine configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-sync-operation-'));
  await withMachineLock(root, async () => {
    await assert.rejects(withMachineLock(root, async () => assert.fail('must be locked')), /Another backup or restore is running/);
  });
  assert.equal(await withMachineLock(root, async () => 42), 42);
  assert.deepEqual(await readdir(root), []);
});

test('failed operations release their own lock so retrying is possible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-sync-operation-failed-'));
  await assert.rejects(withMachineLock(root, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await withMachineLock(root, async () => 'retry'), 'retry');
});
