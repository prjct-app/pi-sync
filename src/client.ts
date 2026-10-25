// HTTP client for the pi-sync service. Tokens travel only over HTTPS (localhost allowed for development).

import type { BackupDevice, BackupInfo, MachineArchive, MachineBackup } from './archive-schema.ts';

export const SERVICE_URL = (process.env.PI_SYNC_URL ?? "https://xayyxxjykgfvjqjafgkp.supabase.co/functions/v1/pi-sync").replace(/\/+$/, "");

export type RemoteEntry = { path: string; revision: number; sha256: string; deleted: boolean; updated_at: string; device?: string | null };
export type RemoteFile = RemoteEntry & { content: string; device?: string | null };
export type SaveResult =
  | { status: "ok"; revision: number }
  | { status: "conflict"; revision: number; content?: string; sha256?: string };

export class SyncApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Fetcher = typeof fetch;

export function assertSecureUrl(url: string): URL {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error(`Refusing to send credentials to ${parsed.origin}: use https`);
  }
  return parsed;
}

export function createClient(token: string | undefined, base = SERVICE_URL, fetcher: Fetcher = fetch) {
  const origin = assertSecureUrl(base);
  const call = async <T>(method: string, path: string, body?: unknown, auth = true, timeout = 15_000): Promise<T> => {
    const res = await fetcher(new URL(`${origin.pathname.replace(/\/$/, "")}${path}`, origin), {
      method,
      headers: {
        "content-type": "application/json",
        "user-agent": "pi-sync/0.1.0",
        ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    const parsed = (() => { try { return text ? JSON.parse(text) : {}; } catch { return undefined; } })();
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    if (!res.ok && !(res.status === 409 && method === 'PUT' && path === '/file')) throw new SyncApiError(res.status, typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
    if (!data) throw new SyncApiError(res.status, 'Invalid JSON response from the backup service.');
    return data as T;
  };
  return {
    backups: async (): Promise<BackupInfo[]> => {
      const data = await call<{ backups: BackupInfo[] }>('GET', '/backups');
      if (!Array.isArray(data.backups)) throw new Error('Invalid machine backup list from the service.');
      return data.backups;
    },
    backup: (id: string) => call<MachineBackup>('GET', `/backups/${encodeURIComponent(id)}`, undefined, true, 120_000),
    createBackup: (device: BackupDevice, archive: MachineArchive) => call<BackupInfo>('POST', '/backups', { device, archive }, true, 120_000),
    deleteBackup: (id: string) => call<{ ok: boolean }>('DELETE', `/backups/${encodeURIComponent(id)}`),
    startLink: () => call<{ code: string; poll: string; url: string; expiresAt: string }>("POST", "/link", { client: "pi-sync" }, false),
    claimLink: (poll: string) => call<{ status: string; token?: string }>("POST", "/link/claim", { poll }, false),
    // Hashes only; content is fetched per file, and only when this machine does not already have it.
    manifest: async (): Promise<RemoteEntry[]> => {
      const data = await call<{ files: RemoteEntry[] }>("GET", "/manifest");
      if (!Array.isArray(data.files)) throw new Error("Invalid legacy file list from the service.");
      return data.files;
    },
    file: (path: string) => call<RemoteFile>("GET", `/file?path=${encodeURIComponent(path)}`),
    revoke: () => call<{ ok: boolean }>("DELETE", "/token"),
    save: (path: string, baseRevision: number, content: string, device: string, deleted = false) =>
      call<SaveResult>("PUT", "/file", { path, baseRevision, content, device, deleted }),
  };
}

export type SyncClient = ReturnType<typeof createClient>;
