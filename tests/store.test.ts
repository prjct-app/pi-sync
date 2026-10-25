import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureDevice, forgetAuth, readDevice, readState, writeState, type StoredState } from "../src/store.ts";

process.env.PRJCT_HOME = await mkdtemp(join(tmpdir(), "pi-sync-store-"));

test("the last sync report survives a state write and read", async () => {
  const state: StoredState = {
    bases: { "AGENTS.md": { revision: 2, content: "rules\n" } },
    installed: ["npm:example@1.0.0"],
    lastReport: {
      files: [{ path: "AGENTS.md", action: "pulled", revision: 2 }],
      pendingPackages: ["npm:pending@2.0.0"],
      failedPackages: ["npm:failed@3.0.0: install failed"],
    },
  };
  await writeState("unused", state);
  assert.deepEqual(await readState("unused"), state);
});

test("machine identity stays stable across logout and hostname changes", async () => {
  const first = await ensureDevice("Laptop");
  await forgetAuth("unused");
  const renamed = await ensureDevice("Renamed laptop");
  assert.equal(renamed.id, first.id);
  assert.equal(renamed.name, "Renamed laptop");
  assert.deepEqual(await readDevice(), renamed);
});
