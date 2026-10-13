// Local state for the pi-sync service: the login token and the last agreed base of each file.
// Lives in ~/.prjct/pi-sync, outside Pi's folder. Written privately (0600), folder 0700.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SyncState } from "./engine.ts";
import { emptyState } from "./engine.ts";
import { syncHome } from "./home.ts";
import { jsonText } from "./sync.ts";

export type Auth = { token: string; connectedAt: string };
/** A snapshot of the last sync run, kept so the panel can show what changed without re-running. */
export type LastReport = { readonly files: ReadonlyArray<import("./engine.ts").FileReport>; readonly pendingPackages: readonly string[]; readonly failedPackages: readonly string[] };
export type StoredState = SyncState & { installed: string[]; lastReport?: LastReport };

export const storeDir = (_agentDir: string) => syncHome();

export async function readAuth(agentDir: string): Promise<Auth | undefined> {
  const text = await readFile(join(storeDir(agentDir), "auth.json"), "utf8").catch(() => undefined);
  if (!text) return undefined;
  const data = JSON.parse(text) as Partial<Auth>;
  return typeof data.token === "string" && /^pis_[0-9a-f]{64}$/.test(data.token)
    ? { token: data.token, connectedAt: data.connectedAt ?? "" }
    : undefined;
}

export async function writeAuth(agentDir: string, auth: Auth) {
  await writePrivate(join(storeDir(agentDir), "auth.json"), jsonText(auth));
}

export async function forgetAuth(agentDir: string) {
  await rm(join(storeDir(agentDir), "auth.json"), { force: true });
}

export async function readState(agentDir: string): Promise<StoredState> {
  const text = await readFile(join(storeDir(agentDir), "state.json"), "utf8").catch(() => undefined);
  if (!text) return { ...emptyState(), installed: [] };
  const data = JSON.parse(text) as Partial<StoredState>;
  return { bases: data.bases ?? {}, installed: data.installed ?? [] };
}

export async function writeState(agentDir: string, state: StoredState) {
  await writePrivate(join(storeDir(agentDir), "state.json"), jsonText(state));
}

async function writePrivate(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await chmod(join(path, ".."), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
