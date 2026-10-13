import assert from "node:assert/strict";
import { test } from "node:test";
import { decideFile, mergeSettings } from "../src/merge.ts";

const side = (content: string, updatedAt: number) => ({ content, updatedAt });

test("nothing changed on either side", () => {
  assert.deepEqual(decideFile("a", side("a", 1), side("a", 2)), { action: "none" });
});

test("only remote changed: take remote", () => {
  assert.deepEqual(decideFile("a", side("a", 1), side("b", 2)), { action: "take-remote", content: "b" });
});

test("only local changed: take local", () => {
  assert.deepEqual(decideFile("a", side("c", 3), side("a", 2)), { action: "take-local", content: "c" });
});

test("both changed: newest wins and the other is backed up", () => {
  assert.deepEqual(decideFile("a", side("local", 5), side("remote", 2)), {
    action: "take-local", content: "local", backup: "remote",
  });
  assert.deepEqual(decideFile("a", side("local", 1), side("remote", 9)), {
    action: "take-remote", content: "remote", backup: "local",
  });
});

test("no base and both sides differ: newest wins", () => {
  assert.deepEqual(decideFile(undefined, side("x", 1), side("y", 2)), {
    action: "take-remote", content: "y", backup: "x",
  });
});

test("missing on one side is taken from the other", () => {
  assert.deepEqual(decideFile(undefined, undefined, side("r", 1)), { action: "take-remote", content: "r" });
  assert.deepEqual(decideFile(undefined, side("l", 1), undefined), { action: "take-local", content: "l" });
});

test("settings: different keys changed on each side both survive", () => {
  const base = JSON.stringify({ theme: "a", defaultModel: "m1" });
  const local = side(JSON.stringify({ theme: "b", defaultModel: "m1" }, null, 2) + "\n", 1);
  const remote = side(JSON.stringify({ theme: "a", defaultModel: "m2" }, null, 2) + "\n", 2);
  const out = mergeSettings(base, local, remote);
  assert.equal(out.action, "merged");
  assert.deepEqual(JSON.parse((out as { content: string }).content), { theme: "b", defaultModel: "m2" });
  assert.equal((out as { backup?: string }).backup, undefined);
});

test("settings: same key changed on both sides takes newest and backs up the other file", () => {
  const base = JSON.stringify({ theme: "a" });
  const local = side(JSON.stringify({ theme: "b" }, null, 2) + "\n", 1);
  const remote = side(JSON.stringify({ theme: "c" }, null, 2) + "\n", 9);
  const out = mergeSettings(base, local, remote) as { content: string; backup?: string };
  assert.equal(JSON.parse(out.content).theme, "c");
  assert.equal(out.backup, local.content);
});

test("settings that are not JSON objects fall back to whole-file newest wins", () => {
  const out = mergeSettings("x", side("not json", 1), side("also not", 2));
  assert.deepEqual(out, { action: "take-remote", content: "also not", backup: "not json" });
});
