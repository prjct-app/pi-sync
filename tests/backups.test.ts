import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RemoteFile } from "../src/client.ts";
import { saveBackupCopy } from "../src/backups.ts";

const content = "throw new Error('downloaded code must not execute');\n";
const backup: RemoteFile = {
  path: "extensions/example.ts", revision: 2, deleted: false, updated_at: "today",
  content, sha256: createHash("sha256").update(content).digest("hex"),
};

test("downloads are exact, private, non-executed copies and repeated downloads never overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-download-"));
  const first = await saveBackupCopy(backup, root);
  const second = await saveBackupCopy(backup, root);
  assert.notEqual(first, second);
  assert.ok(first.startsWith(root));
  assert.equal(await readFile(first, "utf8"), content);
  assert.equal(await readFile(second, "utf8"), content);
  assert.equal((await stat(first)).mode & 0o777, 0o600);
});

test("unsafe paths, deletions and corrupt content are refused before any copy is created", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-rejected-download-"));
  await assert.rejects(saveBackupCopy({ ...backup, path: "../AGENTS.md" }, root), /will not write/);
  await assert.rejects(saveBackupCopy({ ...backup, deleted: true }, root), /deleted/);
  await assert.rejects(saveBackupCopy({ ...backup, sha256: "wrong" }, root), /checksum/);
  assert.deepEqual(await readdir(root), []);
});
