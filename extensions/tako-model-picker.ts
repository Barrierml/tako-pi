/**
 * After /model, show one list: catalog window + effort.
 * Current values are preselected. Enter applies, Esc keeps the new model as-is.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  getKeybindings,
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTakoIdentity } from "../lib/tako-auth.ts";

const PREFS_PATH = join(homedir(), ".pi", "agent", "tako-model-prefs.json");
const ENTRY_TYPE = "tako-model-pick";
const PROVIDER = "tako";
const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const WINDOW_PRESETS = [128_000, 256_000, 500_000, 1_000_000] as const;

type Prefs = {
  provider: string;
  modelId: string;
  contextWindow: number;
  thinkingLevel: ThinkingLevel;
};

type TuneKind = "window" | "effort";
type TuneItem =
  | { kind: "window"; tokens: number; label: string }
  | { kind: "effort"; id: ThinkingLevel; label: string };

type TuneResult = { contextWindow: number; thinkingLevel: ThinkingLevel };

type OverlayTheme = {
  fg: (token: string, text: string) => string;
  bold: (text: string) => string;
};

function formatK(n: number): string {
  if (n < 1000) return `${Math.max(0, Math.round(n))}`;
  const k = n / 1000;
  if (k < 10) return `${k.toFixed(1).replace(/\.0$/, "")}k`;
  if (k < 1000) return `${Math.round(k)}k`;
  const m = n / 1_000_000;
  return `${m.toFixed(m < 10 && n % 1_000_000 !== 0 ? 2 : 0).replace(/\.?0+$/, "")}M`;
}

function parseThinking(raw: string): ThinkingLevel | undefined {
  const s = raw.trim().toLowerCase();
  if ((THINKING_LEVELS as readonly string[]).includes(s)) return s as ThinkingLevel;
  if (s === "none" || s === "disable" || s === "minimal" || s === "min") return "off";
  if (s === "med") return "medium";
  if (s === "xhigh" || s === "xhi" || s === "x-high" || s === "max") return "high";
  return undefined;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function clampThinking(value: string | undefined): ThinkingLevel {
  return parseThinking(value ?? "") ?? "medium";
}

/**
 * The saved pick belongs to one account+gateway. Legacy single-object files
 * carry no identity, so they can never satisfy a scoped lookup.
 */
function readPrefs(): Prefs | null {
  try {
    const identity = getTakoIdentity();
    if (!identity) return null;
    const raw = JSON.parse(readFileSync(PREFS_PATH, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const scoped = (raw as Record<string, unknown>).byIdentity;
    if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) return null;
    const entry = (scoped as Record<string, unknown>)[identity.accountFingerprint];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (e.gatewayBaseUrl !== identity.gatewayBaseUrl) return null;
    if (typeof e.modelId !== "string" || !e.modelId) return null;
    if (typeof e.contextWindow !== "number" || e.contextWindow <= 0) return null;
    const thinkingLevel = parseThinking(e.thinkingLevel as string);
    if (!thinkingLevel) return null;
    return {
      provider: typeof e.provider === "string" && e.provider ? e.provider : PROVIDER,
      modelId: e.modelId,
      contextWindow: Math.round(e.contextWindow),
      thinkingLevel,
    };
  } catch {
    return null;
  }
}

function writePrefs(prefs: Prefs): void {
  try {
    const identity = getTakoIdentity();
    if (!identity) return;
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    let byIdentity: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(readFileSync(PREFS_PATH, "utf-8"));
      const scoped = raw?.byIdentity;
      if (scoped && typeof scoped === "object" && !Array.isArray(scoped)) {
        byIdentity = { ...(scoped as Record<string, unknown>) };
      }
    } catch {
      /* start fresh */
    }
    byIdentity[identity.accountFingerprint] = {
      gatewayBaseUrl: identity.gatewayBaseUrl,
      provider: prefs.provider,
      modelId: prefs.modelId,
      contextWindow: prefs.contextWindow,
      thinkingLevel: prefs.thinkingLevel,
    };
    writeFileSync(PREFS_PATH, JSON.stringify({ version: 2, byIdentity }, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

function catalogWindow(model?: Model<any> | null): number {
  const n = model?.contextWindow;
  return typeof n === "number" && n > 0 ? n : 128_000;
}

function windowItems(model: Model<any>): TuneItem[] {
  const cap = catalogWindow(model);
  const seen = new Set<number>();
  const out: TuneItem[] = [];
  const add = (tokens: number) => {
    if (!Number.isFinite(tokens) || tokens <= 0 || tokens > cap || seen.has(tokens)) return;
    seen.add(tokens);
    out.push({ kind: "window", tokens, label: formatK(tokens) });
  };
  for (const p of WINDOW_PRESETS) add(p);
  add(cap);
  out.sort((a, b) => (a.kind === "window" && b.kind === "window" ? a.tokens - b.tokens : 0));
  if (out.length === 0) add(cap);
  return out;
}

function effortItems(): TuneItem[] {
  return [
    { kind: "effort", id: "off", label: "💤 Off" },
    { kind: "effort", id: "low", label: "🌱 Low" },
    { kind: "effort", id: "medium", label: "⚡ Medium" },
    { kind: "effort", id: "high", label: "🔥 High" },
  ];
}

function cloneWithPick(base: Model<any>, contextWindow: number, thinkingLevel: ThinkingLevel): Model<any> {
  const reasoning = thinkingLevel !== "off";
  return {
    ...base,
    contextWindow,
    reasoning,
    thinkingLevelMap: reasoning
      ? {
          off: "off",
          minimal: "off",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "high",
          max: "high",
        }
      : base.thinkingLevelMap,
  };
}

function isNavUp(keyData: string): boolean {
  const kb = getKeybindings();
  return matchesKey(keyData, "up") || matchesKey(keyData, "k") || kb.matches(keyData, "tui.select.up");
}

function isNavDown(keyData: string): boolean {
  const kb = getKeybindings();
  return matchesKey(keyData, "down") || matchesKey(keyData, "j") || kb.matches(keyData, "tui.select.down");
}

class TuneList implements Component, Focusable {
  focused = true;
  private section: TuneKind;
  private windowIndex: number;
  private effortIndex: number;
  private windows: TuneItem[];
  private efforts: TuneItem[];
  private closed = false;

  constructor(
    private tui: { requestRender: () => void },
    private theme: OverlayTheme,
    private model: Model<any>,
    currentWindow: number,
    currentEffort: ThinkingLevel,
    private done: (result: TuneResult | null) => void,
  ) {
    this.windows = windowItems(model);
    this.efforts = effortItems();
    const cap = catalogWindow(model);
    const wIdx = this.windows.findIndex((w) => w.kind === "window" && w.tokens === currentWindow);
    this.windowIndex = wIdx >= 0 ? wIdx : Math.max(0, this.windows.findIndex((w) => w.kind === "window" && w.tokens === cap));
    const eIdx = this.efforts.findIndex((e) => e.kind === "effort" && e.id === currentEffort);
    this.effortIndex = eIdx >= 0 ? eIdx : 0;
    this.section = "window";
  }

  private currentWindow(): number {
    const item = this.windows[this.windowIndex];
    return item?.kind === "window" ? item.tokens : catalogWindow(this.model);
  }

  private currentEffort(): ThinkingLevel {
    const item = this.efforts[this.effortIndex];
    return item?.kind === "effort" ? item.id : "medium";
  }

  private submit(): void {
    if (this.closed) return;
    this.closed = true;
    this.done({ contextWindow: this.currentWindow(), thinkingLevel: this.currentEffort() });
  }

  private cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.done(null);
  }

  private move(dir: 1 | -1): void {
    if (this.section === "window") {
      this.windowIndex = (this.windowIndex + dir + this.windows.length) % this.windows.length;
    } else {
      this.effortIndex = (this.effortIndex + dir + this.efforts.length) % this.efforts.length;
    }
  }

  invalidate(): void {}

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.cancel")) {
      this.cancel();
      return;
    }
    if (kb.matches(keyData, "tui.select.confirm")) {
      this.submit();
      return;
    }
    if (isNavUp(keyData)) {
      this.section = this.section === "effort" ? "window" : "effort";
      this.tui.requestRender();
      return;
    }
    if (isNavDown(keyData)) {
      this.section = this.section === "window" ? "effort" : "window";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(keyData, "left")) {
      this.move(-1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(keyData, "right")) {
      this.move(1);
      this.tui.requestRender();
    }
  }

  private chips(items: TuneItem[], selected: number, active: boolean): string {
    const theme = this.theme;
    return items
      .map((item, i) => {
        const text = item.label;
        if (i === selected && active) return theme.fg("accent", `▌${text}▐`);
        if (i === selected) return theme.fg("success", ` ${text} `);
        return theme.fg("dim", ` ${text} `);
      })
      .join("  ");
  }

  render(width: number): string[] {
    const theme = this.theme;
    const box = new Container();
    const winOn = this.section === "window";
    const windowLabel = winOn ? theme.fg("accent", "🪟 Context ") : theme.fg("dim", "🪟 Context ");
    const effortLabel = !winOn ? theme.fg("accent", "🧠 Effort ") : theme.fg("dim", "🧠 Effort ");
    box.addChild(new Text(`${windowLabel}${this.chips(this.windows, this.windowIndex, winOn)}`));
    box.addChild(new Text(`${effortLabel}${this.chips(this.efforts, this.effortIndex, !winOn)}`));
    box.addChild(new Text(theme.fg("dim", "↑↓ switch row   ←→ change   enter apply   esc skip")));
    void width;
    return box.render(width);
  }
}

function showTuneList(
  ctx: ExtensionContext,
  model: Model<any>,
  currentWindow: number,
  currentEffort: ThinkingLevel,
): Promise<TuneResult | null> {
  return ctx.ui.custom<TuneResult | null>(
    (tui, theme, _kb, done) => new TuneList(tui, theme, model, currentWindow, currentEffort, done),
  );
}

export default function (pi: ExtensionAPI) {
  let applying = false;

  async function applyPick(
    ctx: ExtensionContext,
    base: Model<any>,
    contextWindow: number,
    thinkingLevel: ThinkingLevel,
    notify: boolean,
  ): Promise<boolean> {
    applying = true;
    try {
      const next = cloneWithPick(base, contextWindow, thinkingLevel);
      const ok = await pi.setModel(next);
      if (!ok) {
        ctx.ui.notify(`No API key for ${base.provider}/${base.id}`, "error");
        return false;
      }
      pi.setThinkingLevel(thinkingLevel);
      writePrefs({
        provider: base.provider,
        modelId: base.id,
        contextWindow,
        thinkingLevel,
      });
      pi.appendEntry(ENTRY_TYPE, {
        provider: base.provider,
        modelId: base.id,
        contextWindow,
        thinkingLevel,
      });
      if (notify) {
        ctx.ui.notify(`${base.id} · ${formatK(contextWindow)} · ${thinkingLevel}`, "info");
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(message, "error");
      return false;
    } finally {
      applying = false;
    }
  }

  async function tuneModel(ctx: ExtensionContext, model: Model<any>): Promise<void> {
    if (!ctx.hasUI) return;
    const currentWindow = ctx.model?.id === model.id ? catalogWindow(ctx.model) : catalogWindow(model);
    const currentEffort = clampThinking(pi.getThinkingLevel());
    const picked = await showTuneList(ctx, model, currentWindow, currentEffort);
    if (!picked) return;
    await applyPick(ctx, model, picked.contextWindow, picked.thinkingLevel, true);
  }

  function restoreFromSession(ctx: ExtensionContext): Prefs | null {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; customType?: string; data?: Prefs };
      if (e.type === "custom" && e.customType === ENTRY_TYPE && e.data?.modelId) {
        const thinkingLevel = parseThinking(e.data.thinkingLevel);
        if (typeof e.data.contextWindow === "number" && thinkingLevel) {
          return {
            provider: e.data.provider || PROVIDER,
            modelId: e.data.modelId,
            contextWindow: e.data.contextWindow,
            thinkingLevel,
          };
        }
      }
    }
    return null;
  }

  pi.registerCommand("tmodel", {
    description: "Tune context window and thinking effort for the current model",
    handler: async (_args, ctx) => {
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }
      await tuneModel(ctx, ctx.model);
    },
  });

  pi.registerCommand("effort", {
    description: "Set thinking effort: off, low, medium, high",
    getArgumentCompletions: (prefix) => {
      const token = prefix.trim().toLowerCase();
      const items = THINKING_LEVELS.filter((l) => l.startsWith(token));
      return items.length > 0 ? items.map((l) => ({ value: l, label: l })) : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        if (!ctx.model) {
          ctx.ui.notify("No model selected", "error");
          return;
        }
        await tuneModel(ctx, ctx.model);
        return;
      }
      const effort = parseThinking(raw);
      if (!effort) {
        ctx.ui.notify(`Unknown effort "${raw}". Use: ${THINKING_LEVELS.join(", ")}`, "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }
      await applyPick(ctx, ctx.model, catalogWindow(ctx.model), effort, true);
    },
  });

  pi.on("model_select", async (event, ctx) => {
    if (applying) return;
    if (event.source !== "set") return;
    // Compaction / provider refresh can replace a user-shrunk clone with the
    // catalog cap. Put the saved window back instead of popping the tuner.
    const saved = restoreFromSession(ctx) ?? readPrefs();
    if (
      saved &&
      event.model.provider === saved.provider &&
      event.model.id === saved.modelId &&
      event.model.contextWindow !== saved.contextWindow
    ) {
      await applyPick(ctx, event.model, saved.contextWindow, saved.thinkingLevel, false);
      return;
    }
    if (!ctx.hasUI) return;
    await tuneModel(ctx, event.model);
  });

  pi.on("session_start", async (_event, ctx) => {
    const saved = restoreFromSession(ctx) ?? readPrefs();
    if (!saved) return;
    const current = ctx.model;
    if (!current || current.provider !== saved.provider || current.id !== saved.modelId) return;
    const already =
      current.contextWindow === saved.contextWindow && clampThinking(pi.getThinkingLevel()) === saved.thinkingLevel;
    if (already && (saved.thinkingLevel === "off" || current.reasoning)) return;
    const catalog = ctx.modelRegistry.find(saved.provider, saved.modelId) ?? current;
    await applyPick(ctx, catalog, saved.contextWindow, saved.thinkingLevel, false);
  });
}
