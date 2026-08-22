/**
 * Mid-turn auto-compact via official overflow compact-and-retry.
 *
 * After a tool-bearing turn crosses the trigger (default 85% of the window):
 *   1. wrap the current provider's streamSimple
 *   2. inject one synthetic `context_length_exceeded` on the next LLM call
 *   3. Pi writes a real `compaction` entry and continues the same turn
 *
 * Summarizer follows the current model id. A shrunk test window
 * (`tako-tiny32k`) still summarizes on the catalog `tako/<id>` window.
 * No auto-compact.json. No hardcoded compaction model.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  compact,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getApiProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai/compat";

const PREFS_PATH = join(homedir(), ".pi", "agent", "tako-autocompact.json");
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const DEFAULT_RESERVE = 16_384;
const DEFAULT_KEEP = 20_000;
const DEFAULT_TRIGGER_RATIO = 0.85;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Prefs = { enabled: boolean; triggerRatio: number };

type CompactBudget = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
};

type Armed = {
  api: Api;
  provider: string;
  model: string;
  tokens: number;
  threshold: number;
  toolCallIds: string[];
};

type RuntimeProviderStream = NonNullable<
  Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]
>;

function clampRatio(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TRIGGER_RATIO;
  const ratio = n > 1 ? n / 100 : n;
  return Math.min(0.95, Math.max(0.5, ratio));
}

function readPrefs(): Prefs {
  try {
    if (!existsSync(PREFS_PATH)) return { enabled: true, triggerRatio: DEFAULT_TRIGGER_RATIO };
    const raw = JSON.parse(readFileSync(PREFS_PATH, "utf-8")) as Partial<Prefs>;
    return {
      enabled: raw.enabled !== false,
      triggerRatio: clampRatio(raw.triggerRatio ?? DEFAULT_TRIGGER_RATIO),
    };
  } catch {
    return { enabled: true, triggerRatio: DEFAULT_TRIGGER_RATIO };
  }
}

function writePrefs(prefs: Prefs): void {
  writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2) + "\n");
}

function readBudget(): CompactBudget {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as {
      compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
    };
    return {
      enabled: raw.compaction?.enabled !== false,
      reserveTokens:
        typeof raw.compaction?.reserveTokens === "number" && raw.compaction.reserveTokens > 0
          ? raw.compaction.reserveTokens
          : DEFAULT_RESERVE,
      keepRecentTokens:
        typeof raw.compaction?.keepRecentTokens === "number" && raw.compaction.keepRecentTokens > 0
          ? raw.compaction.keepRecentTokens
          : DEFAULT_KEEP,
    };
  } catch {
    return { enabled: true, reserveTokens: DEFAULT_RESERVE, keepRecentTokens: DEFAULT_KEEP };
  }
}

function formatK(n: number): string {
  if (n < 1000) return `${n}`;
  return `${Math.round(n / 1000)}k`;
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function catalogModel(ctx: ExtensionContext, current: Model<Api>): Model<Api> {
  const catalog = ctx.modelRegistry.find("tako", current.id) ?? ctx.modelRegistry.find(current.provider, current.id);
  if (!catalog) return current;
  if ((current.contextWindow || 0) >= (catalog.contextWindow || 0)) return current;
  return { ...catalog, id: current.id };
}

function overflowError(tokens: number, threshold: number): string {
  return `context_length_exceeded: mid-turn auto-compact (est. ${formatK(tokens)} > ${formatK(threshold)})`;
}

function syntheticOverflow(model: Model<Api>, tokens: number, threshold: number) {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage: overflowError(tokens, threshold),
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}

function isArmedRequest(model: Model<Api>, context: Context, armed: Armed): boolean {
  if (model.api !== armed.api || model.provider !== armed.provider || model.id !== armed.model) return false;
  const included = new Set(
    context.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
  );
  return armed.toolCallIds.every((id) => included.has(id));
}

export default function (pi: ExtensionAPI) {
  let prefs = readPrefs();
  let armed: Armed | undefined;
  let lastError: string | undefined;
  let lastTrigger: string | undefined;
  let lastCompactAt: number | undefined;
  let compactCount = 0;
  let interceptCount = 0;
  let lastInstallError: string | undefined;
  let awaitingOfficial = false;
  const wrapped = new Map<string, Api>();

  function snapshot(ctx: ExtensionContext) {
    const usage = ctx.getContextUsage();
    const window = ctx.model?.contextWindow || usage?.contextWindow || 128000;
    const settings = readBudget();
    const official = Math.max(1, window - settings.reserveTokens);
    const threshold = Math.max(1, Math.floor(window * prefs.triggerRatio));
    const usedRatio = usage?.tokens != null && window > 0 ? usage.tokens / window : null;
    return {
      tokens: usage?.tokens ?? null,
      usedRatio,
      window,
      threshold,
      official,
      nativeOn: settings.enabled,
      keepRecentTokens: settings.keepRecentTokens,
      reserveTokens: settings.reserveTokens,
    };
  }

  function maybeIntercept(model: Model<Api>, context: Context) {
    if (!armed) return undefined;
    if (!isArmedRequest(model, context, armed)) return undefined;
    const request = armed;
    armed = undefined;
    interceptCount += 1;
    awaitingOfficial = true;
    lastTrigger = `${request.provider}/${request.model} ${formatK(request.tokens)} > ${formatK(request.threshold)}`;
    return syntheticOverflow(model, request.tokens, request.threshold);
  }

  function wrapProvider(model: Model<Api>): boolean {
    if (wrapped.get(model.provider) === model.api) return true;
    const upstream = getApiProvider(model.api);
    if (!upstream) {
      lastInstallError = `no API provider for ${model.api}`;
      return false;
    }
    const streamSimple: RuntimeProviderStream = (requestModel, context, options) =>
      maybeIntercept(requestModel, context) ?? upstream.streamSimple(requestModel, context, options);
    try {
      // Merge-only: do not pass models, or the live Tako catalog is wiped.
      pi.registerProvider(model.provider, { api: model.api, streamSimple });
      wrapped.set(model.provider, model.api);
      lastInstallError = undefined;
      return true;
    } catch (err) {
      lastInstallError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  function arm(ctx: ExtensionContext, toolCallIds: string[], reason: string): boolean {
    if (!prefs.enabled) return false;
    const model = ctx.model;
    if (!model) {
      lastError = "no model";
      return false;
    }
    const { tokens, threshold, nativeOn, keepRecentTokens, window } = snapshot(ctx);
    if (!nativeOn) {
      lastError = "native compaction off";
      return false;
    }
    if (tokens == null) {
      lastError = "usage unknown";
      return false;
    }
    if (tokens <= threshold) {
      lastError = `${formatPct(tokens / window)} <= ${formatPct(prefs.triggerRatio)} (${formatK(tokens)} / ${formatK(window)})`;
      return false;
    }
    if (window <= keepRecentTokens) {
      lastError = `window ${formatK(window)} <= keep ${formatK(keepRecentTokens)}; official compact will refuse`;
      return false;
    }
    if (!wrapProvider(model)) {
      lastError = lastInstallError ?? "wrap failed";
      return false;
    }
    armed = {
      api: model.api,
      provider: model.provider,
      model: model.id,
      tokens,
      threshold,
      toolCallIds,
    };
    lastError = undefined;
    lastTrigger = `${reason}: armed ${model.provider}/${model.id} ${formatPct(tokens / window)} > ${formatPct(prefs.triggerRatio)}`;
    return true;
  }

  pi.registerCommand("tcompact", {
    description: "Mid-turn auto-compact (on|off|now|50-95)",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();
      if (cmd === "on" || cmd === "off") {
        prefs = { ...prefs, enabled: cmd === "on" };
        writePrefs(prefs);
        if (!prefs.enabled) armed = undefined;
        ctx.ui.notify(`mid-turn auto-compact ${prefs.enabled ? "on" : "off"}`, "info");
        return;
      }
      if (cmd === "now") {
        const ok = arm(ctx, [], "manual");
        ctx.ui.notify(ok ? lastTrigger ?? "armed" : lastError ?? "nothing to compact", ok ? "info" : "warning");
        return;
      }
      if (/^\d{1,3}%?$/.test(cmd) || /^0\.\d+$/.test(cmd)) {
        prefs = { ...prefs, triggerRatio: clampRatio(cmd.replace("%", "")) };
        writePrefs(prefs);
        armed = undefined;
        ctx.ui.notify(`mid-turn trigger ${formatPct(prefs.triggerRatio)} of window`, "info");
        return;
      }
      const { tokens, usedRatio, window, threshold, official, nativeOn, keepRecentTokens } = snapshot(ctx);
      const summarizer = ctx.model ? catalogModel(ctx, ctx.model) : undefined;
      const nowText =
        tokens == null || usedRatio == null
          ? "?"
          : `${formatPct(usedRatio)} ${formatK(tokens)}/${formatK(window)}`;
      const lines = [
        `enabled: ${prefs.enabled ? "on" : "off"}`,
        `trigger: ${formatPct(prefs.triggerRatio)} of window → ${formatK(threshold)}`,
        `native compaction: ${nativeOn ? "on" : "off"}  official edge: ${formatK(official)}`,
        `now: ${nowText}  keep: ${formatK(keepRecentTokens)}`,
        `summarizer: ${summarizer ? `${summarizer.provider}/${summarizer.id} ${formatK(summarizer.contextWindow)}` : "none"}`,
        `armed: ${armed ? `${armed.provider}/${armed.model} ${formatK(armed.tokens)}` : "no"}`,
        `wraps: ${wrapped.size}  intercepts: ${interceptCount}  official: ${compactCount}${lastCompactAt ? ` @ ${new Date(lastCompactAt).toISOString()}` : ""}`,
      ];
      if (lastTrigger) lines.push(`last: ${lastTrigger}`);
      if (lastError) lines.push(`error: ${lastError}`);
      if (lastInstallError) lines.push(`wrap: ${lastInstallError}`);
      ctx.ui.notify(lines.join("\n"), lastError || lastInstallError ? "warning" : "info");
    },
  });

  pi.on("turn_end", (event, ctx) => {
    if (event.toolResults.length === 0) return;
    arm(
      ctx,
      event.toolResults.map((result) => result.toolCallId),
      "turn",
    );
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const current = ctx.model;
    if (!current) return;
    const summarizer = catalogModel(ctx, current);
    if (summarizer.contextWindow <= (current.contextWindow || 0) && summarizer.provider === current.provider) {
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(summarizer);
    if (!auth.ok) {
      lastError = auth.error;
      return;
    }
    const provider = getApiProvider(summarizer.api);
    if (!provider) {
      lastError = `no API provider for ${summarizer.api}`;
      return;
    }
    const headers: Record<string, string> = {};
    if (auth.headers) {
      for (const [name, value] of Object.entries(auth.headers)) {
        if (value != null) headers[name] = value;
      }
    }
    try {
      const result = await compact(
        event.preparation,
        summarizer,
        auth.apiKey,
        Object.keys(headers).length > 0 ? headers : undefined,
        event.customInstructions,
        event.signal,
        "off",
        provider.streamSimple.bind(provider),
        auth.env,
      );
      lastTrigger = `summary via ${summarizer.provider}/${summarizer.id} ${formatK(summarizer.contextWindow)}`;
      return { compaction: result };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      return;
    }
  });

  pi.on("session_compact", (event) => {
    armed = undefined;
    if (awaitingOfficial && event.reason === "overflow" && event.willRetry) {
      compactCount += 1;
      lastCompactAt = Date.now();
      lastError = undefined;
    }
    awaitingOfficial = false;
  });

  pi.on("model_select", () => {
    armed = undefined;
  });
  pi.on("agent_end", () => {
    armed = undefined;
  });
}
