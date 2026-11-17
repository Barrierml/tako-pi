/**
 * Offline checks for the launch-env contract in lib/tako-auth.ts.
 *
 * Every scenario runs in an isolated child process with a throwaway HOME /
 * TAKO_HOME; keys are fixtures and never appear in output or on disk.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROBE = join(ROOT, "tests", "fixtures", "identity-probe.ts");
const ENV_KEY = "sk-test-launch-env";
const FILE_KEY = "sk-test-legacy-file";
const OFFICIAL_BASE = "https://tako.shiroha.tech";

const sandboxes: string[] = [];
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Fresh HOME plus a legacy TAKO_HOME/config.json holding FILE_KEY. */
function makeSandbox(): { home: string; takoHome: string } {
  const root = mkdtempSync(join(tmpdir(), "tako-auth-env-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const takoHome = join(root, "tako");
  mkdirSync(home, { recursive: true });
  mkdirSync(takoHome, { recursive: true });
  writeFileSync(join(takoHome, "config.json"), JSON.stringify({ apiKey: FILE_KEY }) + "\n");
  return { home, takoHome };
}

/** Strip ambient Tako/launch vars so the test host cannot leak into a scenario. */
function launchEnv(home: string, extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.TAKO_API_KEY;
  delete env.TAKO_BASE_URL;
  delete env.TAKO_HOME;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function probe(env: NodeJS.ProcessEnv): { stdout: string; stderr: string; parsed: Record<string, unknown> } {
  const stdout = execFileSync(process.execPath, [PROBE], { env, encoding: "utf8", timeout: 20000 });
  return { stdout, stderr: "", parsed: JSON.parse(stdout) };
}

test("TAKO_API_KEY wins over a different key in $TAKO_HOME/config.json", () => {
  const { home, takoHome } = makeSandbox();
  const result = probe(launchEnv(home, { TAKO_API_KEY: ENV_KEY, TAKO_HOME: takoHome }));
  assert.equal(result.parsed.hasIdentity, true);
  assert.equal(result.parsed.accountFingerprint, sha256(ENV_KEY));
  assert.equal(result.parsed.configPath, join(takoHome, "config.json"));
  assert.equal(result.parsed.gatewayBaseUrl, OFFICIAL_BASE);
  assert.ok(!result.stdout.includes(ENV_KEY), "key must never appear in output");
});

test("explicit empty TAKO_API_KEY fails closed instead of using config.json", () => {
  const { home, takoHome } = makeSandbox();
  const result = probe(launchEnv(home, { TAKO_API_KEY: "", TAKO_HOME: takoHome }));
  assert.equal(result.parsed.hasIdentity, false);
});

test("standalone run reads TAKO_HOME/config.json when TAKO_API_KEY is unset", () => {
  const { home, takoHome } = makeSandbox();
  const result = probe(launchEnv(home, { TAKO_HOME: takoHome }));
  assert.equal(result.parsed.hasIdentity, true);
  assert.equal(result.parsed.accountFingerprint, sha256(FILE_KEY));
});

test("standalone run falls back to $HOME/.tako/config.json when TAKO_HOME is unset", () => {
  const { home } = makeSandbox();
  mkdirSync(join(home, ".tako"), { recursive: true });
  writeFileSync(join(home, ".tako", "config.json"), JSON.stringify({ apiKey: FILE_KEY }) + "\n");
  const result = probe(launchEnv(home, {}));
  assert.equal(result.parsed.hasIdentity, true);
  assert.equal(result.parsed.accountFingerprint, sha256(FILE_KEY));
  assert.equal(result.parsed.configPath, join(home, ".tako", "config.json"));
});

test("TAKO_HOME whitespace is normalized before resolving config.json", () => {
  const { home, takoHome } = makeSandbox();
  const result = probe(launchEnv(home, { TAKO_HOME: `  ${takoHome}  ` }));
  assert.equal(result.parsed.configPath, join(takoHome, "config.json"));
  assert.equal(result.parsed.accountFingerprint, sha256(FILE_KEY));
});

test("TAKO_BASE_URL becomes the only gateway and derives endpoint paths", () => {
  const { home } = makeSandbox();
  const result = probe(
    launchEnv(home, {
      TAKO_API_KEY: ENV_KEY,
      TAKO_BASE_URL: "https://gateway.example.test/",
    }),
  );
  assert.equal(result.parsed.gatewayBaseUrl, "https://gateway.example.test");
  assert.equal(result.parsed.messagesBaseUrl, "https://gateway.example.test/api");
  assert.equal(
    result.parsed.catalogUrl,
    "https://gateway.example.test/v1/models?client_version=tako-cli&api_type=claude",
  );
});

test("invalid or empty TAKO_BASE_URL fails closed without falling back to the official host", () => {
  const { home } = makeSandbox();
  for (const base of ["", "   ", "ftp://gateway.example.test", "https://user:pass@gateway.example.test", "https://gateway.example.test?#x"]) {
    const result = probe(launchEnv(home, { TAKO_API_KEY: ENV_KEY, TAKO_BASE_URL: base }));
    assert.equal(result.parsed.hasIdentity, false, `base override ${JSON.stringify(base)} must fail closed`);
  }
});

test("launch mode leaves the legacy config untouched and logs no key", () => {
  const { home, takoHome } = makeSandbox();
  const configPath = join(takoHome, "config.json");
  const before = readFileSync(configPath, "utf8");
  const beforeEntries = readdirSync(takoHome).sort();

  const result = probe(launchEnv(home, { TAKO_API_KEY: ENV_KEY, TAKO_HOME: takoHome }));

  assert.equal(readFileSync(configPath, "utf8"), before, "legacy config must not change");
  assert.deepEqual(readdirSync(takoHome).sort(), beforeEntries, "no files may be written");
  assert.ok(!result.stdout.includes(ENV_KEY), "key must not be logged");
});
