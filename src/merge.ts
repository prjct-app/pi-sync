// Three-way decision for one file, using the last synced content as the base.
// Rule agreed with the owner: when both sides changed, keep the newest and keep the other as a backup.

export type Side = { content: string; updatedAt: number };

export type FileDecision =
  | { action: "none" }
  | { action: "take-remote"; content: string; backup?: string }
  | { action: "take-local"; content: string; backup?: string }
  | { action: "merged"; content: string; backup?: string };

export function decideFile(base: string | undefined, local: Side | undefined, remote: Side | undefined): FileDecision {
  if (!remote && !local) return { action: "none" };
  if (!remote) return { action: "take-local", content: local!.content };
  if (!local) return { action: "take-remote", content: remote.content };
  if (local.content === remote.content) return { action: "none" };
  if (base === local.content) return { action: "take-remote", content: remote.content };
  if (base === remote.content) return { action: "take-local", content: local.content };

  // Both sides changed (or there is no base): newest wins, the other is backed up.
  const newest = local.updatedAt >= remote.updatedAt ? local : remote;
  const loser = newest === local ? remote : local;
  return newest === local
    ? { action: "take-local", content: local.content, backup: loser.content }
    : { action: "take-remote", content: remote.content, backup: loser.content };
}

// settings.json: merge top-level keys so changes to different keys both survive.
// A key changed on both sides takes the newest value; the other full file is kept as a backup.
export function mergeSettings(base: string | undefined, local: Side, remote: Side): FileDecision {
  const b = parseObject(base);
  const l = parseObject(local.content);
  const r = parseObject(remote.content);
  if (!l || !r) return decideFile(base, local, remote);
  const newest = local.updatedAt >= remote.updatedAt ? "local" : "remote";
  const keys = new Set([...Object.keys(b ?? {}), ...Object.keys(l), ...Object.keys(r)]);
  const plans = [...keys].map((key) => {
    const bv = JSON.stringify(b?.[key]);
    const lv = JSON.stringify(l[key]);
    const rv = JSON.stringify(r[key]);
    if (lv === rv) return { key, value: l[key], conflict: false };
    if (bv === lv) return { key, value: r[key], conflict: false };
    if (bv === rv) return { key, value: l[key], conflict: false };
    return { key, value: newest === "local" ? l[key] : r[key], conflict: true };
  });
  const merged = Object.fromEntries(plans.filter((p) => p.value !== undefined).map((p) => [p.key, p.value]));
  const bothChanged = plans.some((p) => p.conflict);
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  if (bothChanged) {
    // A conflicting key was resolved by recency, so the losing file is kept whole.
    const loser = newest === "local" ? remote.content : local.content;
    return { action: "merged", content, backup: loser };
  }
  if (content === local.content) return { action: "none" };
  if (content === remote.content) return { action: "take-remote", content };
  return { action: "merged", content };
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
