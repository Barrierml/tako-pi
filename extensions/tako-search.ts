/**
 * Tako web_search for Pi.
 *
 * POST https://tako.shiroha.tech/v1/search
 * Auth: ~/.tako/config.json apiKey
 * Default family: kab (groq can 413 on longer queries).
 *
 * This is the Tako-native replacement for pi-web-access search providers
 * (Brave/Tavily/…). Fetch/PDF/YouTube from that package are not included.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readTakoApiKey, TAKO_BASE } from "../lib/tako-auth.ts";

const SEARCH_URL = `${TAKO_BASE}/v1/search`;
const SEARCH_TIMEOUT_MS = 20_000;
const PROVIDERS = ["kab", "groq", "grok", "grok_x"] as const;
type TakoSearchProvider = (typeof PROVIDERS)[number];

type SearchHit = {
  title: string;
  url: string;
  snippet: string;
};

type SearchEnvelope = {
  query?: unknown;
  provider?: unknown;
  answer?: unknown;
  results?: unknown;
};

function normalizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(Math.floor(value), 20));
}

function normalizeProvider(value: unknown): TakoSearchProvider {
  if (typeof value === "string") {
    const n = value.trim().toLowerCase();
    if ((PROVIDERS as readonly string[]).includes(n)) return n as TakoSearchProvider;
  }
  return "kab";
}

function asHits(value: unknown): SearchHit[] {
  if (!Array.isArray(value)) return [];
  const out: SearchHit[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url) continue;
    out.push({
      title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : url,
      url,
      snippet: typeof row.snippet === "string" ? row.snippet : "",
    });
  }
  return out;
}

function formatResult(query: string, provider: string, answer: string, results: SearchHit[]): string {
  const lines = [`Tako search (${provider})`, "", `Query: ${query}`];
  if (answer) {
    lines.push("", answer.trim());
  }
  if (results.length > 0) {
    lines.push("", "Sources:");
    for (const [i, hit] of results.entries()) {
      lines.push(`${i + 1}. ${hit.title}`, `   ${hit.url}`);
      if (hit.snippet) lines.push(`   ${hit.snippet}`);
    }
  } else if (!answer) {
    lines.push("", "(no answer and no sources)");
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via Tako POST /v1/search. Uses ~/.tako/config.json. Default provider is kab (returns source URLs). Optional provider: kab, groq, grok, grok_x. Groq may return only an answer. Cite results[].url when present.",
    promptSnippet:
      "Use web_search for live web facts. Prefer citing returned source URLs. Do not invent other search APIs.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Result count (default 5, max 20)" })),
      provider: Type.Optional(
        Type.String({ description: "Tako search family: kab (default), groq, grok, grok_x" }),
      ),
    }),

    async execute(_callId, params, signal) {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) {
        return {
          content: [{ type: "text" as const, text: "Error: query is required." }],
          details: { error: "No query provided" },
        };
      }

      const count = normalizeCount(params.count);
      const provider = normalizeProvider(params.provider);
      let apiKey: string;
      try {
        apiKey = readTakoApiKey();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { error: message },
        };
      }

      const body = { query, count, provider };
      let response: Response;
      try {
        response = await fetch(SEARCH_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), signal])
            : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const lower = message.toLowerCase();
        const text = lower.includes("abort")
          ? "Tako search aborted."
          : `Tako search network error: ${message}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { error: message, provider },
        };
      }

      const rawText = await response.text();
      if (response.status === 401 || response.status === 403) {
        return {
          content: [{ type: "text" as const, text: `Tako search auth failed (HTTP ${response.status}). Check ~/.tako/config.json apiKey.` }],
          details: { error: `HTTP ${response.status}`, provider },
        };
      }
      if (response.status === 402) {
        return {
          content: [{ type: "text" as const, text: "Tako search billing required (HTTP 402)." }],
          details: { error: "HTTP 402", provider },
        };
      }
      if (response.status === 429) {
        return {
          content: [{ type: "text" as const, text: "Tako search rate limited (HTTP 429). Retry once." }],
          details: { error: "HTTP 429", provider },
        };
      }
      if (!response.ok) {
        return {
          content: [{ type: "text" as const, text: `Tako search failed (HTTP ${response.status}).` }],
          details: { error: `HTTP ${response.status}`, provider },
        };
      }

      let json: SearchEnvelope;
      try {
        json = JSON.parse(rawText) as SearchEnvelope;
      } catch {
        return {
          content: [{ type: "text" as const, text: "Tako search returned invalid JSON." }],
          details: { error: "invalid-json", provider },
        };
      }

      const usedProvider = typeof json.provider === "string" && json.provider ? json.provider : provider;
      const answer = typeof json.answer === "string" ? json.answer : "";
      const results = asHits(json.results);
      return {
        content: [{ type: "text" as const, text: formatResult(query, usedProvider, answer, results) }],
        details: {
          query,
          provider: usedProvider,
          resultCount: results.length,
          results,
        },
      };
    },
  });
}
