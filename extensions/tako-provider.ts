/**
 * Register Tako as a Pi provider with a live model catalog.
 *
 * Auth: the launch identity from ../lib/tako-auth.ts — the CLI passes
 * TAKO_API_KEY/TAKO_BASE_URL/TAKO_HOME in the child env; standalone runs use
 * the legacy TAKO_HOME||~/.tako config.
 *
 * Catalog: GET <gateway>/v1/models?client_version=tako-cli&api_type=claude,
 * cached per account+gateway in version-2
 * ~/.pi/agent/tako-models-cache-v2.json. This extension never writes
 * models.json: a user-defined provider config stays authoritative.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTakoIdentity, takoProviderApiKeyValue, TAKO_BASE, type TakoIdentity } from "../lib/tako-auth.ts";

const CACHE_PATH = join(homedir(), ".pi", "agent", "tako-models-cache-v2.json");
const TAKO_DEV_CACHE = join(homedir(), ".tako", "models-cache.json");
const DEFAULT_WINDOW = 128000;
const STALE_MS = 60 * 60 * 1000; // 1h; older or future-dated buckets lose catalog eligibility.
const FETCH_MS = 8000;

type ChatModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

type CodexModelDTO = {
  slug?: string;
  display_name?: string;
  context_window?: number | null;
  model_category?: string;
};

/** Per-account bucket. [] = the gateway answered with a complete empty list. */
type CacheBucket = { fetchedAt: number; models: ChatModel[] };
type CacheV2 = { version: 2; buckets: Record<string, CacheBucket> };

function bucketKey(identity: TakoIdentity): string {
  return `${identity.gatewayBaseUrl}#claude#${identity.accountFingerprint}`;
}

function toChatModel(slug: string, name: string, contextWindow: number): ChatModel {
  return {
    id: slug,
    name,
    reasoning: false,
    input: ["text"],
    contextWindow: contextWindow > 0 ? contextWindow : DEFAULT_WINDOW,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function loadDevWindows(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const takoHome = typeof process.env.TAKO_HOME === "string" && process.env.TAKO_HOME.trim()
      ? process.env.TAKO_HOME.trim()
      : join(homedir(), ".tako");
    const raw = JSON.parse(readFileSync(join(takoHome, "models-cache.json"), "utf-8"));
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    for (const e of entries) {
      if (typeof e?.id !== "string" || typeof e?.contextWindow !== "number" || e.contextWindow <= 0) continue;
      if (!map.has(e.id)) map.set(e.id, e.contextWindow);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function fillWindow(id: string, reported: number, fallback: Map<string, number>): number {
  if (reported > 0) return reported;
  return fallback.get(id) ?? DEFAULT_WINDOW;
}

function fromCodex(models: CodexModelDTO[], fallback: Map<string, number>): ChatModel[] {
  const out: ChatModel[] = [];
  for (const raw of models) {
    const id = raw?.slug;
    if (!id) continue;
    const category = raw.model_category || "chat";
    if (category !== "chat") continue;
    const reported = typeof raw.context_window === "number" ? raw.context_window : 0;
    out.push(toChatModel(id, raw.display_name || id, fillWindow(id, reported, fallback)));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Only a complete, well-formed response may overwrite a bucket — including
 * with [] (a genuinely empty account list). Anything else is a failure that
 * keeps the previous snapshot.
 */
function parseCompleteCatalog(json: unknown): ChatModel[] | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const data = json as Record<string, unknown>;
  // This catalog is unpaginated. Do not publish the first page of a different
  // protocol that advertises more, or guess its cursor semantics.
  if (data.has_more !== undefined && data.has_more !== false) return null;
  if (!Array.isArray(data.models)) return null;
  for (const row of data.models) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const id = (row as Record<string, unknown>).slug;
    if (typeof id !== "string" || !id.trim()) return null;
  }
  return fromCodex(data.models as CodexModelDTO[], loadDevWindows());
}

async function readSnapshot(): Promise<CacheV2> {
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, "utf-8"));
    if (raw?.version !== 2 || typeof raw.buckets !== "object" || raw.buckets === null) {
      return { version: 2, buckets: {} };
    }
    return raw as CacheV2;
  } catch {
    return { version: 2, buckets: {} };
  }
}

async function writeSnapshot(snap: CacheV2): Promise<void> {
  try {
    await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(snap) + "\n", { mode: 0o600 });
    await rename(tmp, CACHE_PATH);
  } catch {
    /* a failed write must not corrupt the previous file */
  }
}

/** Cached catalog for this identity only. Stale or future-dated buckets do not qualify. */
async function readCachedBucket(identity: TakoIdentity): Promise<ChatModel[] | null> {
  const snap = await readSnapshot();
  const bucket = snap.buckets[bucketKey(identity)];
  if (!bucket || typeof bucket.fetchedAt !== "number" || !Array.isArray(bucket.models)) return null;
  const age = Date.now() - bucket.fetchedAt;
  if (age < 0 || age >= STALE_MS) return null;
  return bucket.models;
}

/**
 * Persist a completed fetch for this identity. Read-modify-write keeps other
 * accounts' buckets intact; a failed write leaves the old file untouched.
 */
async function writeCachedBucket(identity: TakoIdentity, models: ChatModel[]): Promise<void> {
  const snap = await readSnapshot();
  snap.buckets[bucketKey(identity)] = { fetchedAt: Date.now(), models };
  await writeSnapshot(snap);
}

/**
 * Fetch the live catalog for the launch identity. Returns the model list to
 * register — including [] — or null on network/protocol failure. On failure a
 * still-fresh same-account snapshot may be returned instead.
 */
async function resolveCatalog(identity: TakoIdentity): Promise<ChatModel[] | null> {
  const cached = await readCachedBucket(identity);
  try {
    const res = await fetch(identity.catalogUrl, {
      headers: { Authorization: `Bearer ${identity.apiKey}` },
      signal: AbortSignal.timeout(FETCH_MS),
      redirect: "error",
    });
    if (!res.ok) return cached;
    const models = parseCompleteCatalog(await res.json());
    if (models === null) return cached;
    await writeCachedBucket(identity, models);
    return models;
  } catch {
    return cached;
  }
}

export default async function (pi: ExtensionAPI) {
  const identity = getTakoIdentity();
  const models = identity ? (await resolveCatalog(identity)) ?? [] : [];
  if (identity && models.length > 0) {
    pi.registerProvider("tako", {
      name: "Tako",
      baseUrl: identity.messagesBaseUrl,
      apiKey: takoProviderApiKeyValue(),
      authHeader: true,
      api: "anthropic-messages",
      models,
    });
  }

  // Tako/Grok overflow phrasing is not always in Pi's built-in list.
  // Rewrite so auto-compaction can compact-and-retry mid-turn.
  const TAKO_OVERFLOW =
    /input is too long|content_length_exceeds|context overflow|prompt too long|maximum prompt length|context window/i;
  // Premature Anthropic-compat drops near the window look like a retryable stream
  // error. After two retries Pi aborts the turn. Rewrite only when usage is already
  // at/over the compact threshold so official compact-and-retry can continue.
  const TAKO_STREAM_DROP = /stream ended without a stop reason/i;
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== "tako" && message.provider !== "tako-tiny32k" && ctx.model?.provider !== "tako" && ctx.model?.provider !== "tako-tiny32k") return;
    const errorMessage = message.errorMessage ?? "";
    if (/context_length_exceeded/i.test(errorMessage)) return;
    if (TAKO_OVERFLOW.test(errorMessage)) {
      return {
        message: {
          ...message,
          errorMessage: `context_length_exceeded: ${errorMessage}`,
        },
      };
    }
    if (!TAKO_STREAM_DROP.test(errorMessage)) return;
    const live = ctx.getContextUsage();
    const window = ctx.model?.contextWindow || live?.contextWindow || 0;
    if (window <= 0) return;
    const usage = message.usage;
    const reported = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const tokens = Math.max(reported, typeof live?.tokens === "number" ? live.tokens : 0);
    const reserve = 16384;
    if (tokens <= 0 || tokens + reserve < window) return;
    return {
      message: {
        ...message,
        errorMessage: `context_length_exceeded: ${errorMessage} (est. ${tokens} / ${window})`,
      },
    };
  });
}
