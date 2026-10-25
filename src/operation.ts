import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Multiple Pi sessions share one agent directory. Never capture or replace it concurrently. */
export async function withMachineLock<T>(agentDir: string, operation: () => Promise<T>): Promise<T> {
  const info = await lstat(agentDir).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (info?.isSymbolicLink()) throw new Error('The Pi agent directory must not be a symbolic link.');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const path = join(agentDir, '.pi-sync-operation.lock');
  const handle = await open(path, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`Another backup or restore is running. Wait for it to finish. If its process stopped, inspect ${path} and any recovery folders before removing the lock.`);
    throw error;
  });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await operation();
  } finally {
    await handle.close();
    await rm(path, { force: true });
  }
}
