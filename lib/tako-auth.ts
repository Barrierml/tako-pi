/**
 * Shared Tako auth for tako-pi extensions.
 * Key source: ~/.tako/config.json apiKey (same as Tako CLI). Never write the key.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const TAKO_BASE = "https://tako.shiroha.tech";
export const TAKO_CONFIG_PATH = join(homedir(), ".tako", "config.json");

export type TakoConfig = {
  apiKey?: string;
  apiId?: string;
  seenAnnouncementIds?: string[];
};

export function readTakoConfig(): TakoConfig {
  try {
    return JSON.parse(readFileSync(TAKO_CONFIG_PATH, "utf-8")) as TakoConfig;
  } catch {
    return {};
  }
}

export function tryReadTakoApiKey(): string | undefined {
  const key = readTakoConfig().apiKey;
  return typeof key === "string" && key ? key : undefined;
}

export function readTakoApiKey(): string {
  const key = tryReadTakoApiKey();
  if (key) return key;
  throw new Error("tako-pi: missing ~/.tako/config.json apiKey");
}

export function readTakoApiId(): string | undefined {
  const id = readTakoConfig().apiId;
  return typeof id === "string" && id ? id : undefined;
}

let resolvedNumericId: string | undefined;

export async function resolveTakoNumericApiId(): Promise<string | undefined> {
  if (resolvedNumericId) return resolvedNumericId;
  const apiKey = readTakoApiKey();
  try {
    const res = await fetch(`${TAKO_BASE}/apiStats/api/get-key-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { success?: boolean; data?: { id?: string | number } };
    if (!json?.success || json.data?.id == null) return undefined;
    resolvedNumericId = String(json.data.id);
    return resolvedNumericId;
  } catch {
    return undefined;
  }
}
