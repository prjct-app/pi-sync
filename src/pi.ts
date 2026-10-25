// The only place pi-sync touches Pi itself: Pi's public SDK. Installs and settings go through the
// SDK's managers. Keys the SDK has a setter for are set through it; any other key is written
// atomically, before the manager loads, so one flush keeps both.
import { writeFile, rename, readFile, mkdir, cp, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { dependencyPlan } from "./archive-schema.ts";

export type PiHost = {
  installPackage(source: string): Promise<void>;
  pinPackage(source: string): Promise<string>;
  installLocalDependencies(packageDir: string): Promise<void>;
  applySettings(agentDir: string, incoming: Record<string, unknown>): Promise<void>;
  reloadSettings(): Promise<void>;
};

const SDK_KEYS = ["theme", "defaultThinkingLevel", "packages", "extensions"] as const;

async function installLocalDependencies(packageDir: string, npmCommand?: string[]): Promise<void> {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const { dependencies, optionalDependencies } = dependencyPlan(manifest, packageDir);
  const first = Object.entries({ ...dependencies, ...optionalDependencies })[0];
  if (!first) return;
  const temporary = await mkdtemp(join(packageDir, ".pi-sync-dependencies-"));
  try {
    const npmRoot = join(temporary, "npm");
    await mkdir(npmRoot, { recursive: true });
    await writeFile(join(npmRoot, "package.json"), JSON.stringify({ name: "pi-sync-restored-dependencies", private: true, dependencies, optionalDependencies }));
    await cp(join(packageDir, "package-lock.json"), join(npmRoot, "package-lock.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
    const manager = new DefaultPackageManager({ cwd: packageDir, agentDir: temporary, settingsManager: SettingsManager.inMemory({ npmCommand }) });
    await manager.install(`npm:${first[0]}@${first[1]}`);
    await rename(join(npmRoot, "node_modules"), join(packageDir, "node_modules"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function piHost(cwd: string, agentDir: string): PiHost {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  return {
    installPackage: (source) => packages.install(source),
    async pinPackage(source) {
      const installed = packages.getInstalledPath(source, "user");
      if (!installed) throw new Error(`Install ${source} on this machine before backing it up.`);
      if (source.startsWith("npm:")) {
        const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
        if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(manifest.name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error(`Cannot determine the installed version of ${source}.`);
        return `npm:${manifest.name}@${manifest.version}`;
      }
      const head = (await readFile(join(installed, ".git", "HEAD"), "utf8")).trim();
      const ref = head.startsWith("ref: ") ? head.slice(5) : undefined;
      if (ref && (!ref.startsWith("refs/") || ref.includes(".."))) throw new Error(`Invalid installed git reference: ${source}`);
      const revision = ref
        ? (await readFile(join(installed, ".git", ref), "utf8").catch(async () => {
          const packed = await readFile(join(installed, ".git", "packed-refs"), "utf8");
          return packed.split("\n").find(line => line.endsWith(` ${ref}`))?.split(" ")[0] ?? "";
        })).trim() : head;
      if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error(`Cannot determine the installed git revision of ${source}.`);
      return `${source.replace(/@[^/@]+$/, "")}@${revision}`;
    },
    installLocalDependencies: packageDir => installLocalDependencies(packageDir, settingsManager.getSettings().npmCommand),
    async applySettings(dir, incoming) {
      const path = join(dir, "settings.json");
      const current = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
      const rest = Object.fromEntries(
        Object.entries(incoming).filter(([key]) => !(SDK_KEYS as readonly string[]).includes(key)),
      );
      const raw = { ...current, ...rest };
      const tmp = `${path}.${process.pid}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, path);

      const manager = SettingsManager.create(cwd, dir);
      if (incoming.theme !== undefined) manager.setTheme(String(incoming.theme));
      if (incoming.defaultThinkingLevel !== undefined) manager.setDefaultThinkingLevel(incoming.defaultThinkingLevel as never);
      if (Array.isArray(incoming.packages)) manager.setPackages(incoming.packages as never);
      if (Array.isArray(incoming.extensions)) manager.setExtensionPaths(incoming.extensions as string[]);
      await manager.flush();
      const errors = manager.drainErrors();
      if (errors.length) throw errors[0]!.error;
    },
    reloadSettings: () => settingsManager.reload(),
  };
}
