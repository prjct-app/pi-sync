// Download exact account copies outside Pi. Code is never loaded and active config is never replaced.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RemoteFile } from "./client.ts";
import { syncHome } from "./home.ts";
import { assertSafeRelativePath } from "./sync.ts";

export async function saveBackupCopy(file: RemoteFile, root = join(syncHome(), "downloads")): Promise<string> {
  assertSafeRelativePath(file.path);
  if (file.deleted) throw new Error("Backup was deleted; refresh the account inventory.");
  const digest = createHash("sha256").update(file.content).digest("hex");
  if (digest !== file.sha256) throw new Error("Backup checksum does not match; no copy was saved.");

  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  const target = join(dir, file.path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, file.content, { mode: 0o600, flag: "wx" });
  return target;
}
