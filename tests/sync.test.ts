import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretFoundError, scanForSecrets, stripSecretKeys } from "../src/secrets.ts";
import { assertSafeRelativePath, disabledExtensionFiles, fromPortableSettings, isPinnedNpm, packagesFromSettings, toPortableSettings } from "../src/sync.ts";

test("stripSecretKeys removes credential keys, keeps token limits", () => {
  const out = stripSecretKeys({ a: { auth: "x", bearerTokenEnv: "T", maxTokens: 3, author: "me" } });
  assert.deepEqual(out, { a: { bearerTokenEnv: "T", maxTokens: 3, author: "me" } });
  assert.deepEqual(stripSecretKeys({ headers: { Authorization: "private", Cookie: "private", Accept: "application/json" } }), { headers: { Accept: "application/json" } });
});

test("scanForSecrets refuses a secret pattern and a literal credential value", () => {
  assert.throws(() => scanForSecrets("AGENTS.md", "token sk-ABCDEFGHIJKLMNOPQRSTUV"), SecretFoundError);
  assert.throws(() => scanForSecrets("models.json", JSON.stringify({ p: { apiKey: "literal-value" } })), SecretFoundError);
  assert.doesNotThrow(() => scanForSecrets("models.json", JSON.stringify({ p: { apiKey: "${PROVIDER_KEY}" } })));
  assert.doesNotThrow(() => scanForSecrets("models.json", JSON.stringify({ maxTokens: 4096, author: "me" })));
});

test("only config files and live extensions may be written", () => {
  assert.throws(() => assertSafeRelativePath("../evil.ts"));
  assert.throws(() => assertSafeRelativePath("auth.json"));
  assert.throws(() => assertSafeRelativePath("extensions/x.ts.bak"));
  assert.doesNotThrow(() => assertSafeRelativePath("extensions/x.ts"));
});

test("settings paths under this home travel as ~ and come back as the local home", () => {
  const local = JSON.stringify({ extensions: ["/Users/jj/.pi/agent/extensions/a.ts"], theme: "x" });
  const portable = toPortableSettings(local, "/Users/jj");
  assert.deepEqual(JSON.parse(portable).extensions, ["~/.pi/agent/extensions/a.ts"]);
  assert.deepEqual(JSON.parse(fromPortableSettings(portable, "/Users/other")).extensions, ["/Users/other/.pi/agent/extensions/a.ts"]);
});

test("packages are read from settings.json", () => {
  assert.deepEqual(packagesFromSettings(JSON.stringify({ packages: ["npm:a@1", 3] })), ["npm:a@1"]);
  assert.deepEqual(packagesFromSettings(undefined), []);
});

test("only exact npm versions are installable from another machine", () => {
  assert.ok(isPinnedNpm("npm:@prjct.app/pi-ui@0.1.4"));
  assert.ok(isPinnedNpm("npm:left-pad@1.3.0"));
  assert.ok(!isPinnedNpm("npm:@prjct.app/pi-ui@^0.1.4"));
  assert.ok(!isPinnedNpm("npm:@prjct.app/pi-ui"));
  assert.ok(!isPinnedNpm("/Users/jj/Apps/pi/pi-x"));
  assert.ok(!isPinnedNpm("git+https://github.com/x/y.git"));
  assert.ok(!isPinnedNpm("npm:pi-secrets-0.2.6-local.1"));
});

test("enabled extensions come back with this machine's home", () => {
  const portable = JSON.stringify({ extensions: ["~/.pi/agent/extensions/a.ts"] });
  assert.deepEqual(JSON.parse(fromPortableSettings(portable, "/Users/other")).extensions, ["/Users/other/.pi/agent/extensions/a.ts"]);
});

test("disabled entries and their files never leave the machine", () => {
  const local = JSON.stringify({ extensions: ["-/Users/jj/.pi/agent/extensions/t.ts", "/Users/jj/.pi/agent/extensions/a.ts"] });
  const portable = JSON.parse(toPortableSettings(local, "/Users/jj")).extensions;
  assert.deepEqual(portable, ["~/.pi/agent/extensions/a.ts"]);
  assert.deepEqual([...disabledExtensionFiles(local, "/Users/jj")], ["t.ts"]);
});
