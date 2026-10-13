// pi-sync data must never reach a model. These checks fail if a model-facing API is added.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const FORBIDDEN = [
  "registerTool", "sendMessage", "sendUserMessage", "appendEntry", "before_agent_start",
  "systemPrompt", "pi.on(", "\"context\"", "'context'", "setModel", "complete(",
  // Pi is reached only through its SDK: no spawning its CLI, no shell.
  "child_process", "execFile", "spawn(", "exec(",
];
// A URL on a model provider host. Labels such as "openai-style key" are not calls.
const MODEL_CALLS = /https?:\/\/[^"'\s]*(anthropic|openai|googleapis|x\.ai|xiaomi)/i;

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(full)));
    else if (/\.(ts|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

test("extension registers only a command and never a model-facing hook or tool", async () => {
  const root = join(import.meta.dirname, "..");
  const files = [join(root, "index.ts"), ...(await sources(join(root, "src"))), ...(await sources(join(root, "supabase")))];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const token of FORBIDDEN) {
      assert.ok(!text.includes(token), `${file} uses ${token}, which would expose sync data to a model`);
    }
    assert.ok(!MODEL_CALLS.test(text), `${file} calls a model provider`);
  }
});
