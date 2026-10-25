import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { piHost } from "../src/pi.ts";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";

test("applySettings sets SDK-managed keys through Pi's SettingsManager and keeps other keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sync-sdk-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "old", custom: "keep-me" }));
  const host = piHost(dir, dir);
  await host.applySettings(dir, { theme: "new", custom: "from-remote", defaultThinkingLevel: "high" });
  const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  assert.equal(saved.theme, "new");
  assert.equal(saved.custom, "from-remote");
  assert.equal(saved.defaultThinkingLevel, "high");
  assert.equal((await stat(join(dir, "settings.json"))).mode & 0o777, 0o600);
});

test("backup pins unversioned npm packages to the version actually installed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sync-pin-"));
  const installed = join(dir, "installed");
  await mkdir(installed);
  await writeFile(join(installed, "package.json"), '{"name":"example","version":"1.2.3-beta.1+build"}');
  t.mock.method(DefaultPackageManager.prototype, "getInstalledPath", () => installed);
  assert.equal(await piHost(dir, dir).pinPackage("npm:example@^1"), "npm:example@1.2.3-beta.1+build");
});

test("git packages are pinned to the installed commit, including packed references", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sync-git-pin-"));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  const commit = "a".repeat(40);
  await writeFile(join(dir, ".git/packed-refs"), `${commit} refs/heads/main\n`);
  t.mock.method(DefaultPackageManager.prototype, "getInstalledPath", () => dir);
  assert.equal(await piHost(dir, dir).pinPackage("git:github.com/example/tool@main"), `git:github.com/example/tool@${commit}`);
});

test("local extension dependencies use Pi's installer and omit host-provided peers", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sync-local-deps-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "local", dependencies: { example: "1.0.0", "@earendil-works/pi-coding-agent": "*" }, peerDependencies: { typebox: "*" } }));
  await writeFile(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
  const calls: string[] = [];
  t.mock.method(DefaultPackageManager.prototype, "install", async function (this: DefaultPackageManager, source: string) {
    calls.push(source);
    const root = join((this as unknown as { agentDir: string }).agentDir, "npm");
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.deepEqual(manifest.dependencies, { example: "1.0.0" });
    assert.equal(manifest.scripts, undefined);
    assert.equal(await readFile(join(root, "package-lock.json"), "utf8"), '{"lockfileVersion":3}');
    await mkdir(join(root, "node_modules/example"), { recursive: true });
    await writeFile(join(root, "node_modules/example/index.js"), "installed dependency");
  });
  await piHost(dir, dir).installLocalDependencies(dir);
  assert.deepEqual(calls, ["npm:example@1.0.0"]);
  assert.equal(await readFile(join(dir, "node_modules/example/index.js"), "utf8"), "installed dependency");
  assert.ok(!(await readdir(dir)).some(name => name.startsWith(".pi-sync-dependencies-")));
});

test("unportable local dependency links fail explicitly instead of silently skipping installation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sync-bad-local-deps-"));
  await writeFile(join(dir, "package.json"), '{"dependencies":{"local":"file:../missing"}}');
  await assert.rejects(piHost(dir, dir).installLocalDependencies(dir), /local\/workspace dependency links cannot be restored/);
  assert.deepEqual(await readdir(dir), ["package.json"]);
});
