import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { brand, openPanel, panelText } from '@prjct.app/pi-tui-kit';
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createClient, SERVICE_URL } from "./src/client.ts";
import { syncWithRetry, type FileReport } from "./src/engine.ts";
import { forgetAuth, readAuth, readState, writeAuth, writeState } from "./src/store.ts";
import { isPinnedNpm, packagesFromSettings, DEFAULT_AGENT_DIR } from "./src/sync.ts";
import { piHost } from "./src/pi.ts";
import { syncPanelSpec, type SyncIntent, type SyncSnapshot, type SyncState } from "./src/panel.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || DEFAULT_AGENT_DIR;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const POLL_MS = 3_000;
const USAGE = "Usage: /sync (open the panel) · /sync report (text)";
const deviceName = (): string => (process.env.HOSTNAME ?? "pi").slice(0, 60);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Ui = { ui: { notify(message: string, level: "info" | "error"): void } };

export default function piSync(pi: ExtensionAPI) {
  pi.registerCommand("sync", {
    description: brand("sync: keep Pi config in step across machines through the pi-sync service"),
    handler: async (args, ctx) => {
      const verb = args.trim().split(/\s+/)[0] ?? "";
      if (verb === "report") return report(ctx);
      if (verb === "help" || verb === "--help" || verb === "-h") return ctx.ui.notify(USAGE, "info");
      return openSyncPanel(ctx);
    },
  });
}

async function openSyncPanel(ctx: ExtensionCommandContext): Promise<void> {
  if (!(ctx.hasUI && ctx.mode === "tui")) {
    await report(ctx);
    return;
  }
  const initial = await loadSnapshot();
  const pending: { intent?: SyncIntent } = {};
  const ops = {
    reload: async () => loadSnapshot(),
    request: (intent: SyncIntent) => { pending.intent = intent; },
  };
  await openPanel(ctx, syncPanelSpec(ops, { snap: initial, busy: false, notice: undefined }));
  if (!pending.intent) return;
  const result = await fulfil(ctx, pending.intent).catch(error => ({
    text: `sync: ${(error as Error).message}`,
    tone: "error" as const,
  }));
  const refreshed = await loadSnapshot();
  await openPanel(ctx, syncPanelSpec(ops, { snap: refreshed, busy: false, notice: result }));
}

async function loadSnapshot(): Promise<SyncSnapshot> {
  const auth = await readAuth(AGENT_DIR);
  const state = await readState(AGENT_DIR);
  return {
    connected: !!auth,
    connectedAt: auth?.connectedAt,
    deviceName: deviceName(),
    serviceUrl: SERVICE_URL,
    recentFiles: state.lastReport?.files ?? [],
    pendingPackages: state.lastReport?.pendingPackages ?? [],
    failedPackages: state.lastReport?.failedPackages ?? [],
  };
}

async function fulfil(ctx: ExtensionCommandContext, intent: SyncIntent): Promise<{ text: string; tone: "accent" | "warning" | "error" }> {
  switch (intent.action) {
    case "login": return await login(ctx);
    case "sync": return await sync(ctx, intent.acceptCode);
    case "logout": return await logout();
  }
}

async function login(ctx: ExtensionCommandContext): Promise<{ text: string; tone: "accent" | "warning" | "error" }> {
  const client = createClient(undefined, SERVICE_URL);
  const link = await client.startLink();
  ctx.ui.notify(`sync: open ${link.url} and approve code ${link.code}. Waiting up to 5 minutes.`, "info");
  const deadline = Date.now() + LOGIN_WINDOW_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const result = await client.claimLink(link.poll);
    if (result.status === "ok" && result.token) {
      await writeAuth(AGENT_DIR, { token: result.token, connectedAt: new Date().toISOString() });
      return { text: `Connected. Press s or y to sync.`, tone: "accent" };
    }
    if (result.status === "expired" || result.status === "invalid") {
      return { text: `Login ${result.status}; press l to try again.`, tone: "warning" };
    }
  }
  return { text: `Login was not approved in 5 minutes; press l to try again.`, tone: "warning" };
}

async function sync(ctx: ExtensionCommandContext, acceptCode: boolean): Promise<{ text: string; tone: "accent" | "warning" | "error" }> {
  const auth = await readAuth(AGENT_DIR);
  if (!auth) return { text: `Not connected; press l to login.`, tone: "warning" };
  const client = createClient(auth.token, SERVICE_URL);
  const state = await readState(AGENT_DIR);
  const pi = piHost(process.cwd(), AGENT_DIR);
  const report = await syncWithRetry(AGENT_DIR, state, client, deviceName(), {
    acceptCode,
    applySettings: (settings) => pi.applySettings(AGENT_DIR, settings),
  });
  if (report.files.some((f) => f.path === "settings.json" && f.action !== "unchanged")) await pi.reloadSettings();

  const settings = await readFile(join(AGENT_DIR, "settings.json"), "utf8").catch(() => undefined);
  const pending: string[] = [];
  const failed: string[] = [];
  for (const spec of packagesFromSettings(settings)) {
    if (state.installed.includes(spec)) continue;
    if (!isPinnedNpm(spec)) {
      failed.push(`${spec}: not an exact npm version; pi-sync does not install it on another machine`);
      continue;
    }
    if (!acceptCode) {
      pending.push(spec);
      continue;
    }
    try {
      await pi.installPackage(spec);
      state.installed.push(spec);
    } catch (err) {
      failed.push(`${spec}: ${(err as Error).message}`);
    }
  }
  await writeState(AGENT_DIR, { ...state, lastReport: { files: report.files, pendingPackages: pending, failedPackages: failed } });

  const lines = report.files.filter((f) => f.action !== "unchanged").map((f) => `${f.action} ${f.path}${f.backup ? ` (backup: ${f.backup})` : ""}`);
  const summary = lines.length ? lines.join("\n") : "already in sync";
  const reloadHint = report.files.some((f) => f.path.endsWith(".ts") && f.action !== "unchanged" && !f.action.startsWith("held")) ? "\nrun /reload to load the synced extensions" : "";
  const failedHint = failed.length ? `\npackages not installed:\n${failed.join("\n")}` : "";
  const pendingHint = pending.length ? `\n${pending.length} package(s) pending: press y to install` : "";
  return { text: `${summary}${pendingHint}${failedHint}${reloadHint}`, tone: failed.length ? "error" : "accent" };
}

async function logout(): Promise<{ text: string; tone: "accent" | "warning" | "error" }> {
  const auth = await readAuth(AGENT_DIR);
  await forgetAuth(AGENT_DIR);
  if (auth) await createClient(auth.token, SERVICE_URL).revoke().catch(() => undefined);
  return { text: `Disconnected. The token is revoked on the service when the service is reachable. Local files were not changed.`, tone: "accent" };
}

async function report(ctx: Ui): Promise<void> {
  try {
    const snap = await loadSnapshot();
    const spec = syncPanelSpec({ reload: async () => snap, request: () => undefined }, { snap, busy: false, notice: undefined });
    ctx.ui.notify(panelText(spec), "info");
  } catch (error) {
    ctx.ui.notify(`sync: ${(error as Error).message}`, "error");
  }
}
