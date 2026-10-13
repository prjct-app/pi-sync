import assert from "node:assert/strict";
import { test } from "node:test";
import { syncPanelSpec, type SyncIntent, type SyncSnapshot, type SyncState } from "../src/panel.ts";
import type { FileReport } from "../src/engine.ts";

function makeState(snap: SyncSnapshot): SyncState {
  return { snap, busy: false, notice: undefined };
}

const DISCONNECTED: SyncSnapshot = {
  connected: false,
  deviceName: "test-host",
  serviceUrl: "https://sync.example",
  recentFiles: [],
  pendingPackages: [],
  failedPackages: [],
};

const CONNECTED_EMPTY: SyncSnapshot = {
  connected: true,
  connectedAt: "2026-10-12T00:00:00.000Z",
  deviceName: "test-host",
  serviceUrl: "https://sync.example",
  recentFiles: [],
  pendingPackages: [],
  failedPackages: [],
};

const SAMPLE_FILES: readonly FileReport[] = [
  { path: "settings.json", action: "pulled" },
  { path: "AGENTS.md", action: "merged" },
  { path: "extensions/foo.ts", action: "held" },
];

test("disconnected state shows a single 'Not connected' row and only the login action", () => {
  const spec = syncPanelSpec({ reload: async () => DISCONNECTED, request: () => undefined }, makeState(DISCONNECTED));
  const items = spec.items();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, "disconnected");
  const actions = spec.actions?.filter(a => a.when?.(undefined) ?? true).map(a => a.key) ?? [];
  assert.deepEqual(actions, ["l"]);
});

test("connected state lists every file and the right actions", () => {
  const snap: SyncSnapshot = { ...CONNECTED_EMPTY, recentFiles: SAMPLE_FILES };
  const spec = syncPanelSpec({ reload: async () => snap, request: () => undefined }, makeState(snap));
  const items = spec.items();
  assert.equal(items.length, SAMPLE_FILES.length, "every file is a row");
  const actions = spec.actions?.filter(a => a.when?.(undefined) ?? true).map(a => a.key) ?? [];
  assert.ok(actions.includes("s"), "preview sync");
  assert.ok(actions.includes("y"), "install sync");
  assert.ok(actions.includes("x"), "logout");
  assert.ok(!actions.includes("l"), "no login when connected");
});

test("pending and failed packages show as separate items when present", () => {
  const snap: SyncSnapshot = { ...CONNECTED_EMPTY, pendingPackages: ["npm:foo@1.0.0"], failedPackages: ["npm:bar@2.0.0"] };
  const spec = syncPanelSpec({ reload: async () => snap, request: () => undefined }, makeState(snap));
  const items = spec.items();
  assert.ok(items.some(i => i.id === "pkg:npm:foo@1.0.0"), "pending package shown");
  assert.ok(items.some(i => i.id === "failed:npm:bar@2.0.0"), "failed package shown");
});

test("connected state with no changes shows an 'in sync' row", () => {
  const spec = syncPanelSpec({ reload: async () => CONNECTED_EMPTY, request: () => undefined }, makeState(CONNECTED_EMPTY));
  const items = spec.items();
  assert.equal(items[0]?.id, "empty");
});

test("summary surfaces counts when there is something to act on", () => {
  const snap: SyncSnapshot = { ...CONNECTED_EMPTY, recentFiles: SAMPLE_FILES, pendingPackages: ["npm:foo@1.0.0"], failedPackages: ["npm:bar@2.0.0"] };
  const spec = syncPanelSpec({ reload: async () => snap, request: () => undefined }, makeState(snap));
  const summary = spec.summary?.() ?? "";
  assert.match(summary, /connected as test-host/, "device");
  assert.match(summary, /3 files changed/, "files count");
  assert.match(summary, /1 packages to install/, "pending count");
  assert.match(summary, /1 package errors/, "failed count");
});

test("actions send the right intents", () => {
  const intents: SyncIntent[] = [];
  const spec = syncPanelSpec({ reload: async () => DISCONNECTED, request: i => intents.push(i) }, makeState(DISCONNECTED));
  const find = (key: string) => spec.actions?.find(a => a.key === key);
  const close = () => undefined;
  const panel = { refresh() {}, notice() {}, select() {}, close };
  find("l")?.run(undefined, panel);
  assert.deepEqual(intents.at(-1), { action: "login" });
});

test("logout requires confirm", () => {
  const spec = syncPanelSpec({ reload: async () => CONNECTED_EMPTY, request: () => undefined }, makeState(CONNECTED_EMPTY));
  const logout = spec.actions?.find(a => a.key === "x");
  assert.equal(logout?.confirm, true);
});

test("sync preview and sync-with-install are two different actions", () => {
  const spec = syncPanelSpec({ reload: async () => CONNECTED_EMPTY, request: () => undefined }, makeState(CONNECTED_EMPTY));
  const preview = spec.actions?.find(a => a.key === "s");
  const install = spec.actions?.find(a => a.key === "y");
  assert.ok(preview);
  assert.ok(install);
  const intents: SyncIntent[] = [];
  const close = () => undefined;
  const panel = { refresh() {}, notice() {}, select() {}, close };
  preview?.run(undefined, { ...panel, close: () => { intents.push({ action: "sync", acceptCode: false }); } });
  install?.run(undefined, { ...panel, close: () => { intents.push({ action: "sync", acceptCode: true }); } });
  assert.deepEqual(intents, [
    { action: "sync", acceptCode: false },
    { action: "sync", acceptCode: true },
  ]);
});
