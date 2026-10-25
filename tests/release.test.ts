import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const verify = (ref: string) => spawnSync(process.execPath, ['.github/scripts/release-source.mjs'], {
  env: { ...process.env, GITHUB_REF: ref }, encoding: 'utf8',
});

test('publication accepts the main branch used after a merge', () => {
  assert.equal(verify('refs/heads/main').status, 0);
});

test('publication rejects tags, feature branches, pull requests, and missing refs', () => {
  for (const ref of ['refs/tags/v0.3.0', 'refs/heads/feature', 'refs/pull/1/merge', '']) {
    const result = verify(ref);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Publish only from main/);
  }
});
