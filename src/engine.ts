// Bidirectional sync for one machine. The base of each file is the last content this machine
// agreed with the service, so a three-way decision can tell which side changed.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { syncHome } from "./home.ts";
import { decideFile, mergeSettings, type FileDecision, type Side } from "./merge.ts";
import type { SyncClient } from "./client.ts";
import { assertSafeRelativePath, disabledExtensionFiles, fromPortableSettings, jsonText, toPortableSettings } from "./sync.ts";
import { scanForSecrets, stripSecretKeys, isSecretKeyName } from "./secrets.ts";

const TOP_LEVEL = ["settings.json", "AGENTS.md", "mcp.json", "models.json"];
const MAX_ATTEMPTS = 3;

export type Base = { revision: number; content: string };
export type SyncState = { bases: Record<string, Base> };

export type FileReport = { path: string; action: string; revision?: number; backup?: string };
export type SyncReport = { files: FileReport[]; backupDir?: string };

export async function localFiles(agentDir: string): Promise<Map<string, Side>> {
  const out = new Map<string, Side>();
  for (const name of TOP_LEVEL) {
    const side = await readSide(join(agentDir, name));
    if (side) out.set(name, side);
  }
  const disabled = disabledExtensionFiles(await readOptional(join(agentDir, "settings.json")));
  const names = (await readdir(join(agentDir, "extensions")).catch(() => [] as string[]))
    .filter((n) => n.endsWith(".ts") && !/\.(bak|off)/.test(n) && !disabled.has(n));
  for (const name of names) {
    const side = await readSide(join(agentDir, "extensions", name));
    if (side) out.set(`extensions/${name}`, side);
  }
  return out;
}

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

async function readSide(path: string): Promise<Side | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const content = path.endsWith("mcp.json")
    ? jsonText(stripSecretKeys(JSON.parse(raw)))
    : basename(path) === "settings.json" ? toPortableSettings(raw) : raw;
  return { content, updatedAt: (await stat(path)).mtimeMs };
}

// Write through a temporary file and rename, so a crash never leaves half a config.
async function writeAtomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

// Conflict backups live outside Pi's folder, so Pi does not grow with copies of its own config.
export function syncBackupRoot(): string {
  return process.env.PI_SYNC_BACKUPS ?? syncHome();
}

export type SyncOptions = {
  acceptCode?: boolean;
  now?: () => string;
  // Writes settings.json through Pi's SDK when provided; otherwise an atomic file write.
  applySettings?: (settings: Record<string, unknown>) => Promise<void>;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Only extension files follow a deletion across machines. Pi's own config files are never removed.
const deletable = (path: string) => path.startsWith("extensions/");

export async function syncOnce(
  agentDir: string,
  state: SyncState,
  client: SyncClient,
  device: string,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const now = options.now ?? (() => new Date().toISOString().replace(/[:.]/g, "-"));
  const acceptCode = options.acceptCode === true;
  const writeLocal = (path: string, content: string) =>
    path === "settings.json" && options.applySettings
      ? options.applySettings(JSON.parse(content))
      : writeAtomic(join(agentDir, path), content);
  const report: SyncReport = { files: [] };
  const backupDir = join(syncBackupRoot(), `${now()}`);
  // The manifest carries hashes only; content crosses the network just for files that differ.
  const manifest = new Map((await client.manifest()).map((entry) => [entry.path, entry]));
  const local = await localFiles(agentDir);
  const paths = [...new Set([...local.keys(), ...manifest.keys()])].sort();

  for (const path of paths) {
    // Remote paths are checked again here: the service is trusted for its data, not for file names.
    if (manifest.has(path)) {
      try {
        assertSafeRelativePath(path);
      } catch {
        report.files.push({ path, action: "rejected: path not allowed" });
        continue;
      }
    }
    const base = state.bases[path];
    const localSide = local.get(path);
    const entry = manifest.get(path);

    // Deleted on another machine.
    if (entry?.deleted) {
      if (!localSide) {
        delete state.bases[path];
        report.files.push({ path, action: "unchanged" });
        continue;
      }
      const editedHere = base === undefined || localSide.content !== base.content;
      const newerHere = localSide.updatedAt > Date.parse(entry.updated_at);
      if (!deletable(path) || (editedHere && newerHere)) {
        scanForSecrets(path, localSide.content);
        const pushed = await pushFile(client, state, path, localSide.content, device, entry.revision);
        report.files.push({ path, action: "pushed", revision: pushed.revision });
        continue;
      }
      await writeAtomic(join(backupDir, path), localSide.content);
      await rm(join(agentDir, path), { force: true });
      delete state.bases[path];
      report.files.push({ path, action: "deleted", backup: join(backupDir, path) });
      continue;
    }

    // Deleted here, and nobody changed it remotely since: tell the other machines.
    if (!localSide && base && entry && deletable(path) && entry.sha256 === sha256(base.content)) {
      const result = await client.save(path, entry.revision, "", device, true);
      if (result.status === "conflict") throw new ConflictError(path);
      delete state.bases[path];
      report.files.push({ path, action: "deleted remotely", revision: result.revision });
      continue;
    }

    // Same content on both sides: nothing to fetch, nothing to write.
    if (entry && localSide && sha256(localSide.content) === entry.sha256) {
      state.bases[path] = { revision: entry.revision, content: localSide.content };
      report.files.push({ path, action: "unchanged" });
      continue;
    }

    // The remote side is the base when its hash matches; only otherwise is its content downloaded.
    const remoteSide = !entry
      ? undefined
      : base && sha256(base.content) === entry.sha256
        ? { content: base.content, updatedAt: Date.parse(entry.updated_at) }
        : await client.file(path).then((file) => ({ content: file.content, updatedAt: Date.parse(file.updated_at) }));
    const decision: FileDecision = path === "settings.json" && localSide && remoteSide
      ? mergeSettings(base?.content, localSide, remoteSide)
      : decideFile(base?.content, localSide, remoteSide);

    if (decision.action === "none") {
      if (entry && remoteSide) state.bases[path] = { revision: entry.revision, content: remoteSide.content };
      report.files.push({ path, action: "unchanged" });
      continue;
    }
    // Code from another machine is held until you accept it: Pi loads extensions at startup.
    const writesCode = path.endsWith(".ts") && (decision.action === "take-remote" || decision.action === "merged");
    if (writesCode && !acceptCode) {
      report.files.push({ path, action: "held: new code from another machine, press y or run /sync sync --accept-code" });
      continue;
    }
    if (decision.action === "take-remote") {
      if (decision.backup !== undefined && localSide) {
        await writeAtomic(join(backupDir, path), decision.backup);
      }
      const incoming = path === "settings.json" ? fromPortableSettings(decision.content) : decision.content;
      await writeLocal(path, restoreLocalSecrets(path, incoming, await readOptional(join(agentDir, path))));
      state.bases[path] = { revision: entry!.revision, content: decision.content };
      report.files.push({ path, action: "pulled", revision: entry!.revision, backup: decision.backup !== undefined ? join(backupDir, path) : undefined });
      continue;
    }

    // take-local or merged: write locally if needed, then push on top of the revision the decision used.
    if (decision.action === "merged") {
      if (decision.backup !== undefined) await writeAtomic(join(backupDir, path), decision.backup);
      const incoming = path === "settings.json" ? fromPortableSettings(decision.content) : decision.content;
      await writeLocal(path, restoreLocalSecrets(path, incoming, await readOptional(join(agentDir, path))));
    }
    if (decision.action === "take-local" && decision.backup !== undefined) {
      await writeAtomic(join(backupDir, path), decision.backup);
    }
    scanForSecrets(path, decision.content);
    const pushed = await pushFile(client, state, path, decision.content, device, entry?.revision ?? 0);
    report.files.push({
      path,
      action: decision.action === "merged" ? "merged+pushed" : "pushed",
      revision: pushed.revision,
      backup: decision.backup !== undefined ? join(backupDir, path) : undefined,
    });
  }
  if (report.files.some((f) => f.backup)) report.backupDir = backupDir;
  return report;
}

export class ConflictError extends Error {
  constructor(readonly path: string) {
    super(`${path}: another machine saved first`);
  }
}

// A push that loses the race stops the run; syncWithRetry starts over from a fresh remote listing.
// The push must name the revision the decision was made against, not the last one this machine saw.
async function pushFile(client: SyncClient, state: SyncState, path: string, content: string, device: string, baseRevision: number) {
  const result = await client.save(path, baseRevision, content, device);
  if (result.status === "conflict") throw new ConflictError(path);
  state.bases[path] = { revision: result.revision, content };
  return { revision: result.revision };
}

export async function syncWithRetry(
  agentDir: string,
  state: SyncState,
  client: SyncClient,
  device: string,
  options: SyncOptions = {},
  attempt = 1,
): Promise<SyncReport> {
  try {
    return await syncOnce(agentDir, state, client, device, options);
  } catch (err) {
    if (!(err instanceof ConflictError) || attempt >= MAX_ATTEMPTS) throw err;
    return syncWithRetry(agentDir, state, client, device, options, attempt + 1);
  }
}

export function emptyState(): SyncState {
  return { bases: {} };
}

// mcp.json leaves the machine without credential fields, so pulled content keeps this machine's own.
export function restoreLocalSecrets(path: string, incoming: string, localText: string | undefined): string {
  if (path !== "mcp.json" || localText === undefined) return incoming;
  try {
    const next = JSON.parse(incoming);
    const local = JSON.parse(localText);
    for (const [name, server] of Object.entries(next.mcpServers ?? {}) as Array<[string, Record<string, unknown>]>) {
      const own = local.mcpServers?.[name] ?? {};
      for (const [key, value] of Object.entries(own)) {
        if (isSecretKeyName(key) && !(key in server)) server[key] = value;
      }
    }
    return `${JSON.stringify(next, null, 2)}\n`;
  } catch {
    return incoming;
  }
}
