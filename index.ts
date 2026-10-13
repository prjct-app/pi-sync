import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createClient, SERVICE_URL } from "./src/client.ts";
import { syncWithRetry } from "./src/engine.ts";
import { forgetAuth, readAuth, readState, writeAuth, writeState } from "./src/store.ts";
import { isPinnedNpm, packagesFromSettings, DEFAULT_AGENT_DIR } from "./src/sync.ts";
import { piHost } from "./src/pi.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || DEFAULT_AGENT_DIR;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const POLL_MS = 3_000;
const USAGE = "Usage: /pi-sync login | sync | logout";
const deviceName = () => (process.env.HOSTNAME ?? "pi").slice(0, 60);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Ui = { ui: { notify(message: string, level: "info" | "error"): void } };

export default function piSync(pi: ExtensionAPI) {
  pi.registerCommand("pi-sync", {
    description: "sync Pi config across machines through the pi-sync service (login, sync, logout)",
    handler: async (args, ctx) => {
      const verb = args.trim().split(/\s+/)[0] ?? "";
      try {
        if (verb === "login") return await login(ctx);
        if (verb === "sync") return await sync(ctx, args.includes("--accept-code"));
        if (verb === "logout") {
          const auth = await readAuth(AGENT_DIR);
          await forgetAuth(AGENT_DIR);
          if (auth) await createClient(auth.token, SERVICE_URL).revoke().catch(() => undefined);
          ctx.ui.notify("pi-sync: disconnected. The token is revoked on the service when the service is reachable. Local files were not changed.", "info");
          return;
        }
        ctx.ui.notify(USAGE, "info");
      } catch (err) {
        ctx.ui.notify(`pi-sync: ${(err as Error).message}`, "error");
      }
    },
  });
}

async function login(ctx: Ui) {
  const client = createClient(undefined, SERVICE_URL);
  const link = await client.startLink();
  ctx.ui.notify(`pi-sync: open ${link.url} and approve code ${link.code}. Waiting up to 5 minutes.`, "info");
  const deadline = Date.now() + LOGIN_WINDOW_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const result = await client.claimLink(link.poll);
    if (result.status === "ok" && result.token) {
      await writeAuth(AGENT_DIR, { token: result.token, connectedAt: new Date().toISOString() });
      ctx.ui.notify("pi-sync: connected. Run /pi-sync sync to start.", "info");
      return;
    }
    if (result.status === "expired" || result.status === "invalid") {
      throw new Error(`login ${result.status}; run /pi-sync login again`);
    }
  }
  throw new Error("login was not approved in 5 minutes; run /pi-sync login again");
}

async function sync(ctx: Ui, acceptCode: boolean) {
  const auth = await readAuth(AGENT_DIR);
  if (!auth) throw new Error("not connected; run /pi-sync login first");
  const client = createClient(auth.token, SERVICE_URL);
  const state = await readState(AGENT_DIR);
  const pi = piHost(process.cwd(), AGENT_DIR);
  const report = await syncWithRetry(AGENT_DIR, state, client, deviceName(), {
    acceptCode,
    applySettings: (settings) => pi.applySettings(AGENT_DIR, settings),
  });
  if (report.files.some((f) => f.path === "settings.json" && f.action !== "unchanged")) await pi.reloadSettings();

  // Like VS Code Settings Sync: packages listed in settings.json are installed here too.
  const settings = await readFile(join(AGENT_DIR, "settings.json"), "utf8").catch(() => undefined);
  const failures: string[] = [];
  for (const spec of packagesFromSettings(settings)) {
    if (state.installed.includes(spec)) continue;
    if (!isPinnedNpm(spec)) {
      failures.push(`${spec}: not an exact npm version; pi-sync does not install it on another machine`);
      continue;
    }
    if (!acceptCode) {
      failures.push(`${spec}: held until you run /pi-sync sync --accept-code`);
      continue;
    }
    try {
      await pi.installPackage(spec);
      state.installed.push(spec);
    } catch (err) {
      failures.push(`${spec}: ${(err as Error).message}`);
    }
  }
  await writeState(AGENT_DIR, state);

  const lines = report.files
    .filter((f) => f.action !== "unchanged")
    .map((f) => `${f.action} ${f.path}${f.backup ? ` (backup: ${f.backup})` : ""}`);
  const summary = lines.length ? lines.join("\n") : "already in sync";
  const reloadHint = report.files.some((f) => f.path.endsWith(".ts") && f.action !== "unchanged" && !f.action.startsWith("held"))
    ? "\nrun /reload to load the synced extensions"
    : "";
  const failed = failures.length ? `\npackages not installed:\n${failures.join("\n")}` : "";
  ctx.ui.notify(`pi-sync: ${summary}${failed}${reloadHint}`, failures.length ? "error" : "info");
}
