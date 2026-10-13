// Shared helpers for the synced config files. Secret rules live in secrets.ts, transport in
// client.ts, the engine in engine.ts, and every touch of Pi itself in pi.ts.
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";

export { scanForSecrets, stripSecretKeys, SecretFoundError } from "./secrets.ts";

export const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");

const TOP_LEVEL_FILES = ["settings.json", "AGENTS.md", "mcp.json", "models.json"] as const;
const EXTENSION_DIR = "extensions";
const isLiveExtension = (name: string) => name.endsWith(".ts") && !/\.(bak|off)/.test(name);

// Only the allowed shapes may be written: top-level config files and extensions/*.ts.
export function assertSafeRelativePath(path: string): void {
  const normalized = normalize(path);
  const allowed =
    (TOP_LEVEL_FILES as readonly string[]).includes(path) ||
    (path.startsWith(`${EXTENSION_DIR}/`) && !normalized.includes("..") && isLiveExtension(path.slice(EXTENSION_DIR.length + 1)));
  if (!allowed || normalized.startsWith(sep) || normalized !== path) {
    throw new Error(`path pi-sync will not write: ${path}`);
  }
}

export function packagesFromSettings(settingsText: string | undefined): string[] {
  if (!settingsText) return [];
  const settings = JSON.parse(settingsText);
  return Array.isArray(settings.packages) ? settings.packages.filter((p: unknown) => typeof p === "string") : [];
}

// Only exact npm versions install from another machine. Local paths, git and URLs would run
// code that this sync never reviewed, so they are reported and left alone.
const PINNED_NPM = /^npm:(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const isPinnedNpm = (spec: string) => PINNED_NPM.test(spec);

// settings.json can hold absolute paths to this machine's home. They travel as "~/..." and come back
// as this machine's home, so one settings file works on each computer.
// A leading "-" marks an extension that is disabled. Inactive things never leave the machine,
// so disabled entries are dropped from the portable form.
export function toPortableSettings(text: string, home = homedir()): string {
  const settings = JSON.parse(text);
  if (!Array.isArray(settings.extensions)) return text;
  const extensions = settings.extensions
    .filter((e: unknown) => !(typeof e === "string" && e.startsWith("-")))
    .map((e: unknown) => {
      if (typeof e !== "string") return e;
      return e.startsWith(`${home}/`) ? `~/${e.slice(home.length + 1)}` : e;
    });
  return jsonText({ ...settings, extensions });
}

// Extension files that settings.json marks as disabled on this machine. They are not synced.
export function disabledExtensionFiles(settingsText: string | undefined, home = homedir()): Set<string> {
  if (!settingsText) return new Set();
  const settings = JSON.parse(settingsText);
  const entries: unknown[] = Array.isArray(settings.extensions) ? settings.extensions : [];
  return new Set(
    entries
      .filter((e): e is string => typeof e === "string" && e.startsWith("-"))
      .map((e) => e.slice(1))
      .filter((p) => /\/extensions\/[^/]+\.ts$/.test(p))
      .map((p) => p.split("/").pop()!),
  );
}

export function fromPortableSettings(text: string, home = homedir()): string {
  const settings = JSON.parse(text);
  if (!Array.isArray(settings.extensions)) return text;
  const extensions = settings.extensions.map((e: unknown) => {
    if (typeof e !== "string") return e;
    const sign = e.startsWith("-") ? "-" : "";
    const path = e.slice(sign.length);
    return path.startsWith("~/") ? `${sign}${home}/${path.slice(2)}` : e;
  });
  return jsonText({ ...settings, extensions });
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
