/**
 * Register Tako as a Pi provider with a live model catalog.
 *
 * Auth: ~/.tako/config.json apiKey (same source Tako CLI uses).
 * Catalog: GET https://tako.shiroha.tech/v1/models?client_version=tako-cli&api_type=claude
 * Fallback: ~/.pi/agent/tako-models-cache.json, then ~/.pi/agent/models.json.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tryReadTakoApiKey, TAKO_BASE } from "../lib/tako-auth.ts";

const TAKO_MESSAGES_BASE = `${TAKO_BASE}/api`;
const MODELS_URL = `${TAKO_BASE}/v1/models?client_version=tako-cli&api_type=claude`;
const CACHE_PATH = join(homedir(), ".pi", "agent", "tako-models-cache.json");
const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");
const TAKO_DEV_CACHE = join(homedir(), ".tako", "models-cache.json");
const DEFAULT_WINDOW = 128000;

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
    if (!existsSync(TAKO_DEV_CACHE)) return map;
    const raw = JSON.parse(readFileSync(TAKO_DEV_CACHE, "utf-8"));
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

async function writeCache(models: ChatModel[]): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
    await fs.writeFile(
      CACHE_PATH,
      JSON.stringify({ fetchedAt: Date.now(), models }, null, 2) + "\n",
    );
    await fs.writeFile(
      MODELS_JSON_PATH,
      JSON.stringify(
        {
          providers: {
            tako: {
              name: "Tako",
              baseUrl: TAKO_MESSAGES_BASE,
              api: "anthropic-messages",
              apiKey: "!node -p \"require(require('os').homedir() + '/.tako/config.json').apiKey\"",
              models: models.map(({ id, name, contextWindow, reasoning }) => ({
                id,
                name,
                contextWindow,
                reasoning,
              })),
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
  } catch {
    /* ignore */
  }
}

async function readCache(): Promise<ChatModel[] | null> {
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, "utf-8"));
    if (Array.isArray(raw?.models) && raw.models.length > 0) return raw.models as ChatModel[];
  } catch {
    /* ignore */
  }
  try {
    const raw = JSON.parse(await readFile(MODELS_JSON_PATH, "utf-8"));
    const models = raw?.providers?.tako?.models;
    if (Array.isArray(models) && models.length > 0) {
      return models.map((m: { id: string; name?: string; contextWindow?: number }) =>
        toChatModel(m.id, m.name || m.id, fillWindow(m.id, m.contextWindow || 0, loadDevWindows())),
      );
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function fetchLiveCatalog(apiKey: string): Promise<ChatModel[] | null> {
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: CodexModelDTO[] };
    const models = fromCodex(json.models ?? [], loadDevWindows());
    if (models.length === 0) return null;
    await writeCache(models);
    return models;
  } catch {
    return null;
  }
}

export default async function (pi: ExtensionAPI) {
  const apiKey = tryReadTakoApiKey();
  const models = (apiKey ? await fetchLiveCatalog(apiKey) : null) ?? (await readCache()) ?? [];
  if (models.length > 0) {
    pi.registerProvider("tako", {
      name: "Tako",
      baseUrl: TAKO_MESSAGES_BASE,
      apiKey: "!node -p \"require(require('os').homedir() + '/.tako/config.json').apiKey\"",
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
