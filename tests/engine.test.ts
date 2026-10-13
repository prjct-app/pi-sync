import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { SyncClient } from "../src/client.ts";
import { emptyState, syncWithRetry, type SyncState } from "../src/engine.ts";

process.env.PI_SYNC_BACKUPS = await mkdtemp(join(tmpdir(), "pi-sync-backups-"));

// In-memory service with the same revision rules as pi_sync_save: a save must name the current revision.
function fakeService(clock: { now: number }) {
  const files = new Map<string, { revision: number; content: string; updated_at: string; deleted: boolean }>();
  const fetched: string[] = [];
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const client = {
    async manifest() {
      return [...files].map(([path, f]) => ({ path, revision: f.revision, sha256: hash(f.content), deleted: f.deleted, updated_at: f.updated_at }));
    },
    async file(path: string) {
      fetched.push(path);
      const f = files.get(path)!;
      return { path, revision: f.revision, sha256: hash(f.content), deleted: f.deleted, updated_at: f.updated_at, content: f.content };
    },
    async save(path: string, baseRevision: number, content: string, _device?: string, deleted = false) {
      const cur = files.get(path);
      const currentRevision = cur?.revision ?? 0;
      if (baseRevision !== currentRevision) return { status: "conflict" as const, revision: currentRevision };
      const revision = currentRevision + 1;
      files.set(path, { revision, content, updated_at: new Date(clock.now).toISOString(), deleted });
      return { status: "ok" as const, revision };
    },
  };
  return { client: client as unknown as SyncClient, files, fetched };
}

async function machine(name: string) {
  const agentDir = await mkdtemp(join(tmpdir(), `pi-sync-${name}-`));
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  return { agentDir, state: emptyState() as SyncState };
}

async function setFile(dir: string, path: string, content: string, mtimeMs: number) {
  const full = join(dir, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
  const t = new Date(mtimeMs);
  await utimes(full, t, t);
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");

test("a file created on one machine appears on the other", async () => {
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  const b = await machine("b");
  await setFile(a.agentDir, "AGENTS.md", "rules from A\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  await syncWithRetry(b.agentDir, b.state, service.client, "b");
  assert.equal(await read(b.agentDir, "AGENTS.md"), "rules from A\n");
});

test("different settings keys changed on each machine both survive", async () => {
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  const b = await machine("b");
  await setFile(a.agentDir, "settings.json", JSON.stringify({ theme: "x", defaultModel: "m1" }) + "\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  await syncWithRetry(b.agentDir, b.state, service.client, "b");
  clock.now = 2_000;
  await setFile(a.agentDir, "settings.json", JSON.stringify({ theme: "y", defaultModel: "m1" }) + "\n", 2_000);
  await setFile(b.agentDir, "settings.json", JSON.stringify({ theme: "x", defaultModel: "m2" }) + "\n", 2_500);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  await syncWithRetry(b.agentDir, b.state, service.client, "b");
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  const merged = JSON.parse(await read(a.agentDir, "settings.json"));
  assert.deepEqual(merged, { theme: "y", defaultModel: "m2" });
  assert.deepEqual(JSON.parse(await read(b.agentDir, "settings.json")), merged);
});

test("same file changed on both machines: newest wins, the other is kept in backup", async () => {
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  const b = await machine("b");
  await setFile(a.agentDir, "AGENTS.md", "v1\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  await syncWithRetry(b.agentDir, b.state, service.client, "b");

  clock.now = 2_000;
  await setFile(a.agentDir, "AGENTS.md", "from A\n", 2_000);
  clock.now = 3_000;
  await setFile(b.agentDir, "AGENTS.md", "from B\n", 3_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  const report = await syncWithRetry(b.agentDir, b.state, service.client, "b");

  assert.equal(await read(b.agentDir, "AGENTS.md"), "from B\n");
  assert.equal(service.files.get("AGENTS.md")?.content, "from B\n");
  const entry = report.files.find((f) => f.path === "AGENTS.md");
  assert.ok(entry?.backup, "the losing side must be recorded as a backup");
});

test("a conflict where the remote is newer keeps the remote content and backs up the local one", async () => {
  process.env.PI_SYNC_BACKUPS = await mkdtemp(join(tmpdir(), "pi-sync-backups-"));
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  const b = await machine("b");
  await setFile(a.agentDir, "AGENTS.md", "v1\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  await syncWithRetry(b.agentDir, b.state, service.client, "b");

  clock.now = 5_000;
  await setFile(a.agentDir, "AGENTS.md", "from A later\n", 5_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");

  await setFile(b.agentDir, "AGENTS.md", "from B earlier\n", 2_000);
  const report = await syncWithRetry(b.agentDir, b.state, service.client, "b");
  assert.equal(await read(b.agentDir, "AGENTS.md"), "from A later\n");
  const backupDirs = await readdir(process.env.PI_SYNC_BACKUPS!);
  assert.equal(backupDirs.length, 1);
  assert.ok(report.files.find((f) => f.path === "AGENTS.md")?.backup);
});

test("a file already in sync is reported as unchanged and a second run changes nothing", async () => {
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  await setFile(a.agentDir, "models.json", "{}\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  const again = await syncWithRetry(a.agentDir, a.state, service.client, "a");
  assert.ok(again.files.every((f) => f.action === "unchanged"));
  assert.equal(service.files.get("models.json")?.revision, 1);
});

test("pulled mcp.json keeps this machine's credentials", async () => {
  const { restoreLocalSecrets } = await import("../src/engine.ts");
  const incoming = JSON.stringify({ mcpServers: { jira: { url: "u" } } });
  const local = JSON.stringify({ mcpServers: { jira: { url: "old", auth: "oauth-token" } } });
  const out = JSON.parse(restoreLocalSecrets("mcp.json", incoming, local));
  assert.deepEqual(out.mcpServers.jira, { url: "u", auth: "oauth-token" });
});

test("a file with a secret value is refused before it is pushed", async () => {
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  await setFile(a.agentDir, "AGENTS.md", "key sk-ABCDEFGHIJKLMNOPQRSTUV\n", 1_000);
  await assert.rejects(syncWithRetry(a.agentDir, a.state, service.client, "a"), /contains a openai-style key|openai-style key/);
  assert.equal(service.files.size, 0);
});

test("code pulled from another machine is held until accepted", async () => {
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  const b = await machine("b");
  await setFile(a.agentDir, "extensions/tool.ts", "export default () => {};\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");

  const held = await syncWithRetry(b.agentDir, b.state, service.client, "b");
  assert.ok(held.files.find((f) => f.path === "extensions/tool.ts")?.action.startsWith("held"));
  await assert.rejects(readFile(join(b.agentDir, "extensions", "tool.ts"), "utf8"));

  await syncWithRetry(b.agentDir, b.state, service.client, "b", { acceptCode: true });
  assert.equal(await read(b.agentDir, "extensions/tool.ts"), "export default () => {};\n");
});

test("a remote path outside the allowed set is rejected, not written", async () => {
  const service = fakeService({ now: 1_000 });
  await service.client.save("../../evil.ts", 0, "x", "a");
  const b = await machine("b");
  const report = await syncWithRetry(b.agentDir, b.state, service.client, "b", { acceptCode: true });
  assert.ok(report.files.find((f) => f.path === "../../evil.ts")?.action.startsWith("rejected"));
});

test("settings.json from another machine goes through the applySettings writer", async () => {
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  const b = await machine("b");
  await setFile(a.agentDir, "settings.json", JSON.stringify({ theme: "x" }) + "\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  const seen: Record<string, unknown>[] = [];
  await syncWithRetry(b.agentDir, b.state, service.client, "b", {
    applySettings: async (settings) => { seen.push(settings); },
  });
  assert.deepEqual(seen, [{ theme: "x" }]);
});

test("an unchanged file is not downloaded again", async () => {
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  await setFile(a.agentDir, "AGENTS.md", "rules\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  assert.deepEqual(service.fetched, []);
});

test("an extension deleted on one machine is deleted on the other, with a backup", async () => {
  process.env.PI_SYNC_BACKUPS = await mkdtemp(join(tmpdir(), "pi-sync-backups-"));
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  const b = await machine("b");
  await setFile(a.agentDir, "extensions/tool.ts", "export default () => {};\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  await syncWithRetry(b.agentDir, b.state, service.client, "b", { acceptCode: true });
  assert.equal(await read(b.agentDir, "extensions/tool.ts"), "export default () => {};\n");

  await rm(join(a.agentDir, "extensions", "tool.ts"));
  clock.now = 2_000;
  const removed = await syncWithRetry(a.agentDir, a.state, service.client, "a");
  assert.equal(removed.files.find((f) => f.path === "extensions/tool.ts")?.action, "deleted remotely");

  const report = await syncWithRetry(b.agentDir, b.state, service.client, "b");
  assert.equal(report.files.find((f) => f.path === "extensions/tool.ts")?.action, "deleted");
  await assert.rejects(readFile(join(b.agentDir, "extensions", "tool.ts")));
});

test("Pi's own config files never follow a deletion", async () => {
  const clock = { now: 1_000 };
  const service = fakeService(clock);
  const a = await machine("a");
  await setFile(a.agentDir, "AGENTS.md", "rules\n", 1_000);
  await syncWithRetry(a.agentDir, a.state, service.client, "a");
  await rm(join(a.agentDir, "AGENTS.md"));
  const report = await syncWithRetry(a.agentDir, a.state, service.client, "a");
  assert.equal(service.files.get("AGENTS.md")?.deleted, false);
  assert.equal(report.files.find((f) => f.path === "AGENTS.md")?.action, "pulled");
});
