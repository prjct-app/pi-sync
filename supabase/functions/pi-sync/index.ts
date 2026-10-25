// pi-sync service: device login, token auth and versioned config files.
// Runs as a Supabase Edge Function with the service role. Tables are not reachable
// from anon or authenticated; every read and write goes through this function.
// Tokens are "pis_" + 64 hex and labelled "pi-sync" in sync_tokens, so palette tokens
// ("pit_") are rejected here and pi-sync tokens are rejected by palette's endpoints.

declare const Deno: { env: { get(key: string): string | undefined }; serve(handler: (request: Request) => Response | Promise<Response>): void };
import { MAX_ARCHIVE_BYTES, archiveBytes, archiveSettings, isBackupId, packageSources, verifyArchive } from '../../../src/archive-schema.ts';
import { scanForSecrets } from '../../../src/secrets.ts';

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APPROVE_URL = Deno.env.get("PI_SYNC_APPROVE_URL") ?? "https://palette.prjct.app/link";
const CLIENT = "pi-sync";
const LINK_WINDOW_MS = 15 * 60 * 1000;
const PATH_RE = /^(settings\.json|AGENTS\.md|mcp\.json|models\.json|extensions\/[A-Za-z0-9._-]+\.ts)$/;
const MAX_CONTENT = 1_000_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const MAX_LINKS_PENDING = 500;
const MAX_BODY = 1_200_000;

// Responses never carry internal detail; they are safe to show to anyone who calls the function.
const SECURITY_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });

const fail = (status: number, error: string) => json({ error }, status);

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % 32]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

async function rest(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      ...(init.prefer ? { prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function authUser(req: Request): Promise<string | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!/^pis_[0-9a-f]{64}$/.test(token)) return null;
  const rows = await rest(
    `sync_tokens?select=user_id&label=eq.${CLIENT}&token_hash=eq.${await sha256Hex(token)}`,
  );
  return rows?.[0]?.user_id ?? null;
}

async function startLink() {
  const pending = await rest(`device_links?select=id&claimed_at=is.null&expires_at=gt.${new Date().toISOString()}&limit=${MAX_LINKS_PENDING}`);
  if (pending.length >= MAX_LINKS_PENDING) return fail(503, "too many pending logins, try again in a few minutes");
  const secret = randomHex(32);
  const rows = await rest("device_links?select=user_code,expires_at", {
    method: "POST",
    prefer: "return=representation",
    body: { user_code: randomCode(), poll_hash: await sha256Hex(secret), client: CLIENT },
  });
  const row = rows[0];
  const url = new URL(APPROVE_URL);
  url.searchParams.set("code", row.user_code);
  return json({ code: row.user_code, poll: secret, url: url.toString(), expiresAt: row.expires_at });
}

async function claimLink(body: { poll?: unknown }) {
  if (typeof body.poll !== "string" || !/^[0-9a-f]{64}$/.test(body.poll)) return json({ status: "invalid" });
  const rows = await rest(
    `device_links?select=id,user_id,approved_at,expires_at,client,claimed_at&poll_hash=eq.${await sha256Hex(body.poll)}`,
  );
  const link = rows?.[0];
  if (!link || link.claimed_at || link.client !== CLIENT) return json({ status: "invalid" });
  if (!link.approved_at) {
    return json({ status: new Date(link.expires_at) < new Date() ? "expired" : "pending" });
  }
  if (Date.now() - new Date(link.approved_at).getTime() > LINK_WINDOW_MS) return json({ status: "expired" });

  // Claim atomically: only one request can flip claimed_at from null.
  const claimed = await rest(`device_links?id=eq.${link.id}&claimed_at=is.null&select=id`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { claimed_at: new Date().toISOString() },
  });
  if (!claimed?.length) return json({ status: "invalid" });

  const token = `pis_${randomHex(32)}`;
  await rest("sync_tokens", {
    method: "POST",
    body: { user_id: link.user_id, token_hash: await sha256Hex(token), label: CLIENT },
  });
  return json({ status: "ok", token });
}

async function revokeToken(req: Request): Promise<Response> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  await rest(`sync_tokens?label=eq.${CLIENT}&token_hash=eq.${await sha256Hex(token)}`, { method: "DELETE" });
  return json({ ok: true });
}

async function readState(userId: string) {
  const files = await rest(
    `pi_sync_files?select=path,revision,sha256,content,device,updated_at&user_id=eq.${userId}&order=path.asc`,
  );
  return json({ files });
}

async function readManifest(userId: string) {
  const files = await rest(
    `pi_sync_files?select=path,revision,sha256,deleted,device,updated_at&user_id=eq.${userId}&order=path.asc`,
  );
  return json({ files });
}

async function readOneFile(userId: string, path: string | null) {
  if (!path || !PATH_RE.test(path)) return fail(400, "path not allowed");
  const rows = await rest(
    `pi_sync_files?select=path,revision,sha256,deleted,content,device,updated_at&user_id=eq.${userId}&path=eq.${encodeURIComponent(path)}`,
  );
  return rows?.[0] ? json(rows[0]) : fail(404, "not found");
}

const BACKUP_SELECT = 'id,deviceId:device_id,deviceName:device_name,createdAt:created_at,fileCount:file_count,packageCount:package_count,totalBytes:total_bytes';

async function listBackups(userId: string) {
  const backups = await rest(`pi_sync_backups?select=${BACKUP_SELECT}&user_id=eq.${userId}&order=created_at.desc&limit=100`);
  return json({ backups });
}

async function oneBackup(userId: string, id: string, remove: boolean) {
  if (!isBackupId(id)) return fail(400, 'invalid backup id');
  const rows = await rest(`pi_sync_backups?select=${remove ? 'id' : `${BACKUP_SELECT},archive`}&user_id=eq.${userId}&id=eq.${id}`, remove ? { method: 'DELETE', prefer: 'return=representation' } : {});
  if (!rows?.length) return fail(404, 'backup not found');
  return json(remove ? { ok: true } : rows[0]);
}

async function boundedJson(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error('backup body required');
  const size = { bytes: 0 };
  const parts: string[] = [];
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size.bytes += chunk.value.byteLength;
    if (size.bytes > MAX_ARCHIVE_BYTES + 4096) { await reader.cancel(); throw new Error('backup exceeds 20 MiB'); }
    parts.push(decoder.decode(chunk.value, { stream: true }));
  }
  parts.push(decoder.decode());
  return JSON.parse(parts.join(''));
}

async function createBackup(userId: string, req: Request) {
  const prepared = await (async () => {
    const body = await boundedJson(req) as { device?: { id?: unknown; name?: unknown }; archive?: unknown };
    if (!body || typeof body.device?.id !== 'string' || !isBackupId(body.device.id) || typeof body.device.name !== 'string' || !body.device.name.trim() || body.device.name.length > 80 || /[\x00-\x1f\x7f]/.test(body.device.name)) throw new Error('valid device id and name required');
    const archive = await verifyArchive(body.archive);
    if (archive.kind !== 'machine') throw new Error('a complete machine backup is required');
    const lengths: number[] = [];
    for (const file of archive.files) {
      const bytes = archiveBytes(file);
      scanForSecrets(file.path, new TextDecoder().decode(bytes));
      lengths.push(bytes.byteLength);
    }
    return { user_id: userId, device_id: body.device.id, device_name: body.device.name.trim(), archive,
      file_count: archive.files.length, package_count: packageSources(archiveSettings(archive)).length, total_bytes: lengths.reduce((sum, count) => sum + count, 0) };
  })().catch(error => error instanceof Error ? error : new Error('invalid machine backup'));
  if (prepared instanceof Error) return fail(prepared.message.includes('exceeds') ? 413 : 400, prepared.message.startsWith('Unexpected') ? 'invalid backup JSON' : prepared.message);
  // One insert publishes the entire snapshot. There is never a partially uploaded machine.
  const rows = await rest(`pi_sync_backups?select=${BACKUP_SELECT}`, { method: 'POST', prefer: 'return=representation', body: prepared });
  return json(rows[0], 201);
}

async function writeFile(userId: string, body: Record<string, unknown>) {
  const { path, baseRevision, content, device, deleted } = body;
  if (typeof path !== "string" || !PATH_RE.test(path)) return fail(400, "path not allowed");
  if (typeof content !== "string" || content.length > MAX_CONTENT) return fail(400, "content missing or too large");
  if (deleted === true && content !== "") return fail(400, "a deletion carries no content");
  if (!Number.isInteger(baseRevision) || (baseRevision as number) < 0) return fail(400, "baseRevision required");
  const result = await rest("rpc/pi_sync_save", {
    method: "POST",
    body: {
      p_user: userId,
      p_path: path,
      p_base: baseRevision,
      p_content: content,
      p_sha: await sha256Hex(content),
      p_device: typeof device === "string" ? device.slice(0, 60) : null,
      p_deleted: deleted === true,
    },
  });
  return json(result, result.status === "conflict" ? 409 : 200);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/pi-sync/, "") || "/";
  try {
    if (req.method === "POST" && route === "/link") return await startLink();
    if (req.method === "POST" && route === "/link/claim") {
      const raw = await req.text();
      if (raw.length > 4_096) return fail(413, "request too large");
      return await claimLink((() => { try { return JSON.parse(raw); } catch { return {}; } })() as { poll?: unknown });
    }

    if (req.method === "DELETE" && route === "/token") {
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (!/^pis_[0-9a-f]{64}$/.test(token)) return fail(401, "not connected");
      return await revokeToken(req);
    }

    const userId = await authUser(req);
    if (!userId) return fail(401, "not connected");

    if (req.method === 'GET' && route === '/backups') return await listBackups(userId);
    if (req.method === 'POST' && route === '/backups') return await createBackup(userId, req);
    if (route.startsWith('/backups/') && (req.method === 'GET' || req.method === 'DELETE')) return await oneBackup(userId, route.slice('/backups/'.length), req.method === 'DELETE');
    if (req.method === "GET" && route === "/state") return await readState(userId);
    if (req.method === "GET" && route === "/manifest") return await readManifest(userId);
    if (req.method === "GET" && route === "/file") return await readOneFile(userId, url.searchParams.get("path"));
    if (req.method === "PUT" && route === "/file") {
      const raw = await req.text();
      if (raw.length > MAX_BODY) return fail(413, "request too large");
      const body = (() => { try { return JSON.parse(raw); } catch { return null; } })() as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return fail(400, "bad body");
      return await writeFile(userId, body);
    }
    return fail(404, "not found");
  } catch (err) {
    // The detail stays in the function logs; the caller gets no database text.
    console.error("pi-sync", (err as Error).message);
    return fail(500, "internal error");
  }
});
