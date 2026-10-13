// One place for everything that decides whether a value may leave the machine.
// Patterns name what matched and never echo the value.

// Key names that carry credentials, matched on the key with separators removed.
// "maxTokens" and "bearerTokenEnv" do not match: they are limits and env var names.
const SECRET_KEY_END = /(auth|secret|password|passwd|bearer|apikey|token)$/;

export const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["openai-style key", /sk-[A-Za-z0-9_-]{16,}/],
  ["xai key", /xai-[A-Za-z0-9]{16,}/],
  ["github token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["aws access key", /(AKIA|ASIA)[0-9A-Z]{16}/],
  ["google api key", /AIza[0-9A-Za-z_-]{35}/],
  ["slack token", /xox[abposr]-[A-Za-z0-9-]{10,}/],
  ["stripe key", /(sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["bearer header", /Bearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["connection string with password", /[a-z]+:\/\/[^\s/:@]+:[^\s/@]{4,}@/i],
];

export class SecretFoundError extends Error {
  constructor(readonly file: string, readonly kind: string) {
    super(`refusing to send ${file}: it looks like it contains a ${kind}. Remove it from the file, then retry.`);
  }
}

const isSecretKey = (key: string) => SECRET_KEY_END.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""));

// A credential-named key with a literal string value is refused. An env var reference is not a secret.
function secretKeyValue(value: unknown, file: string): void {
  if (Array.isArray(value)) return value.forEach((v) => secretKeyValue(v, file));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key) && typeof child === "string" && child.length > 0 && !/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(child)) {
      throw new SecretFoundError(file, `literal value under "${key}"`);
    }
    secretKeyValue(child, file);
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export function scanForSecrets(file: string, content: string): void {
  const hit = SECRET_PATTERNS.find(([, pattern]) => pattern.test(content));
  if (hit) throw new SecretFoundError(file, hit[0]);
  if (file.endsWith(".json")) secretKeyValue(parseJson(content), file);
}

// Removes credential-named keys at any depth (used for mcp.json, which keeps its server definitions).
export function stripSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSecretKey(key))
        .map(([key, child]) => [key, stripSecretKeys(child)]),
    );
  }
  return value;
}

export const isSecretKeyName = isSecretKey;
