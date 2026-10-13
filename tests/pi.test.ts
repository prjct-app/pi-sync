import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { piHost } from "../src/pi.ts";

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
});
