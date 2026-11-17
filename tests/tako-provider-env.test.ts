/**
 * End-to-end check that the provider extension registers the launch env
 * identity (not the legacy config account) and never persists the raw key.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROBE = join(ROOT, "tests", "fixtures", "provider-probe.ts");
const ENV_KEY = "sk-test-provider-env";
const FILE_KEY = "sk-test-provider-file";
const GATEWAY = "https://gateway.example.test";

const sandboxes: string[] = [];
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeSandbox(): { home: string; takoHome: string } {
  const root = mkdtempSync(join(tmpdir(), "tako-provider-env-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const takoHome = join(root, "tako");
  mkdirSync(home, { recursive: true });
  mkdirSync(takoHome, { recursive: true });
  writeFileSync(join(takoHome, "config.json"), JSON.stringify({ apiKey: FILE_KEY }) + "\n");
  return { home, takoHome };
}

test("provider registration uses TAKO_API_KEY and TAKO_BASE_URL, and writes no raw key", () => {
  const { home, takoHome } = makeSandbox();
  const configPath = join(takoHome, "config.json");
  const before = readFileSync(configPath, "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TAKO_API_KEY: ENV_KEY,
    TAKO_BASE_URL: `${GATEWAY}/`,
    TAKO_HOME: takoHome,
  };
  const stdout = execFileSync(process.execPath, [PROBE], { env, encoding: "utf8", timeout: 20000 });
  const { registered } = JSON.parse(stdout) as {
    registered: { name: string; baseUrl: string; apiKeySha256: string | null; modelIds: string[] }[];
  };

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "tako");
  assert.equal(registered[0].baseUrl, `${GATEWAY}/api`);
  assert.equal(registered[0].apiKeySha256, sha256(ENV_KEY), "registration must use the launch key");
  assert.notEqual(registered[0].apiKeySha256, sha256(FILE_KEY), "legacy key must not win");
  assert.deepEqual(registered[0].modelIds, ["fixture-chat"]);

  assert.equal(readFileSync(configPath, "utf8"), before, "legacy config must not change");
  assert.ok(!stdout.includes(ENV_KEY), "key must not be logged");

  const cachePath = join(home, ".pi", "agent", "tako-models-cache-v2.json");
  assert.ok(existsSync(cachePath), "catalog snapshot should be written under the isolated HOME");
  const cache = readFileSync(cachePath, "utf8");
  assert.ok(!cache.includes(ENV_KEY), "raw key must never be written to the catalog cache");
  assert.ok(cache.includes(sha256(ENV_KEY)), "cache bucket must be scoped by key fingerprint");
});
