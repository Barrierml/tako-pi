/**
 * Shared Tako auth for tako-pi extensions.
 *
 * Identity contract with the Tako CLI launcher (docs/models/PI-DEPENDENCY.md):
 * - When the launch env sets TAKO_API_KEY (even to ""), that is the chosen
 *   account. An empty value means "explicitly no credentials" — never fall
 *   back to a saved account.
 * - TAKO_BASE_URL, when set, is the only allowed gateway root. An invalid or
 *   non-http(s) value fails closed; it is never replaced by the official URL.
 * - Only when the env contract is absent do standalone runs read the legacy
 *   TAKO_HOME||~/.tako config.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const TAKO_BASE = "https://tako.shiroha.tech";

const env = typeof process !== "undefined" ? process.env : {};

function resolveTakoHome(): string {
  const home = typeof env.TAKO_HOME === "string" && env.TAKO_HOME.trim() ? env.TAKO_HOME : null;
  return home ?? join(homedir(), ".tako");
}

export const TAKO_CONFIG_PATH = join(resolveTakoHome(), "config.json");

export type TakoConfig = {
  apiKey?: string;
  apiId?: string;
  seenAnnouncementIds?: string[];
};

/**
 * Launch-scoped identity: null when the launch explicitly forbids credentials,
 * or when a TAKO_BASE_URL override cannot be used.
 */
export type TakoIdentity = {
  /** The only allowed gateway root. Never silently replaced by TAKO_BASE. */
  gatewayBaseUrl: string;
  /** Provider streaming endpoint (Anthropic Messages). */
  messagesBaseUrl: string;
  /** Model catalog endpoint (Codex-shaped response). */
  catalogUrl: string;
  /** Search endpoint. */
  searchUrl: string;
  /** Announcements endpoint. */
  announcementsUrl: string;
  /** Quota/telemetry endpoint root (apiStats). */
  apiStatsUrl: string;
  /** Key-id lookup endpoint for quota resolution. */
  keyIdUrl: string;
  apiKey: string;
  /** SHA-256(apiKey); safe to persist, never the raw key. */
  accountFingerprint: string;
};

export function accountFingerprintOf(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function deriveEndpoints(gatewayBaseUrl: string): Omit<TakoIdentity, "apiKey" | "accountFingerprint"> {
  const base = gatewayBaseUrl.replace(/\/+$/, "");
  return {
    gatewayBaseUrl: base,
    messagesBaseUrl: `${base}/api`,
    catalogUrl: `${base}/v1/models?client_version=tako-cli&api_type=claude`,
    searchUrl: `${base}/v1/search`,
    announcementsUrl: `${base}/v1/announcements/popup`,
    apiStatsUrl: `${base}/apiStats/api`,
    keyIdUrl: `${base}/apiStats/api/get-key-id`,
  };
}

function normalizeGatewayBase(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.hash || url.search) return null;
  const clean = url.toString().replace(/\/+$/, "");
  return clean;
}

export function readTakoConfig(): TakoConfig {
  try {
    return JSON.parse(readFileSync(TAKO_CONFIG_PATH, "utf-8")) as TakoConfig;
  } catch {
    return {};
  }
}

function legacyApiKey(): string | undefined {
  const key = readTakoConfig().apiKey;
  return typeof key === "string" && key ? key : undefined;
}

/**
 * Resolve the single launch identity. Returns null when the launch env
 * explicitly denies credentials (TAKO_API_KEY present but empty) or when
 * TAKO_BASE_URL is set but unusable — callers must not fall back to any other
 * account or route in those cases.
 */
export function getTakoIdentity(): TakoIdentity | null {
  const baseOverride = typeof env.TAKO_BASE_URL === "string" ? env.TAKO_BASE_URL : undefined;

  if (Object.hasOwn(env, "TAKO_API_KEY")) {
    const apiKey = typeof env.TAKO_API_KEY === "string" ? env.TAKO_API_KEY : "";
    if (!apiKey) return null;
    const gateway = baseOverride !== undefined ? normalizeGatewayBase(baseOverride) : TAKO_BASE;
    if (!gateway) return null;
    return { apiKey, accountFingerprint: accountFingerprintOf(apiKey), ...deriveEndpoints(gateway) };
  }

  // Standalone (no launch contract): keep legacy sources.
  if (baseOverride !== undefined) {
    const gateway = normalizeGatewayBase(baseOverride);
    if (!gateway) return null;
    const apiKey = legacyApiKey();
    if (!apiKey) return null;
    return { apiKey, accountFingerprint: accountFingerprintOf(apiKey), ...deriveEndpoints(gateway) };
  }

  const apiKey = legacyApiKey();
  if (!apiKey) return null;
  return { apiKey, accountFingerprint: accountFingerprintOf(apiKey), ...deriveEndpoints(TAKO_BASE) };
}

/**
 * Provider-config apiKey value. Returns the resolved identity key itself so
 * registration and catalog auth always come from the same source — never a
 * literal on disk, never an env placeholder that can resolve empty when the
 * identity came from the legacy config instead of TAKO_API_KEY.
 */
export function takoProviderApiKeyValue(identity: TakoIdentity): string {
  return identity.apiKey;
}

export function tryReadTakoApiKey(): string | undefined {
  return getTakoIdentity()?.apiKey;
}

export function readTakoApiKey(): string {
  const key = tryReadTakoApiKey();
  if (key) return key;
  throw new Error("tako-pi: no Tako credentials for this launch");
}

export function readTakoApiId(): string | undefined {
  const id = readTakoConfig().apiId;
  return typeof id === "string" && id ? id : undefined;
}

let resolvedNumericId: string | undefined;
let resolvedNumericIdFor: string | undefined;

export async function resolveTakoNumericApiId(): Promise<string | undefined> {
  const identity = getTakoIdentity();
  if (!identity) return undefined;
  if (resolvedNumericIdFor === identity.accountFingerprint && resolvedNumericId) {
    return resolvedNumericId;
  }
  try {
    const res = await fetch(identity.keyIdUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: identity.apiKey }),
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { success?: boolean; data?: { id?: string | number } };
    if (!json?.success || json.data?.id == null) return undefined;
    resolvedNumericId = String(json.data.id);
    resolvedNumericIdFor = identity.accountFingerprint;
    return resolvedNumericId;
  } catch {
    return undefined;
  }
}
