// The only place pi-sync touches Pi itself: Pi's public SDK. Installs and settings go through the
// SDK's managers. Keys the SDK has a setter for are set through it; any other key is written
// atomically, before the manager loads, so one flush keeps both.
import { writeFile, rename, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export type PiHost = {
  installPackage(source: string): Promise<void>;
  applySettings(agentDir: string, incoming: Record<string, unknown>): Promise<void>;
  reloadSettings(): Promise<void>;
};

const SDK_KEYS = ["theme", "defaultThinkingLevel", "packages", "extensions"] as const;

export function piHost(cwd: string, agentDir: string): PiHost {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  return {
    installPackage: (source) => packages.install(source),
    async applySettings(dir, incoming) {
      const path = join(dir, "settings.json");
      const current = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
      const rest = Object.fromEntries(
        Object.entries(incoming).filter(([key]) => !(SDK_KEYS as readonly string[]).includes(key)),
      );
      const raw = { ...current, ...rest };
      const tmp = `${path}.${process.pid}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`);
      await rename(tmp, path);

      const manager = SettingsManager.create(cwd, dir);
      if (incoming.theme !== undefined) manager.setTheme(String(incoming.theme));
      if (incoming.defaultThinkingLevel !== undefined) manager.setDefaultThinkingLevel(incoming.defaultThinkingLevel as never);
      if (Array.isArray(incoming.packages)) manager.setPackages(incoming.packages as never);
      if (Array.isArray(incoming.extensions)) manager.setExtensionPaths(incoming.extensions as string[]);
      await manager.flush();
    },
    reloadSettings: () => settingsManager.reload(),
  };
}
