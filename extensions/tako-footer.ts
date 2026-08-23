/**
 * Tako-style Pi footer.
 *
 * 📁 ~/path │ 🌿 main │ 🤖 grok-4.6
 * ⚡ ████████░░ 98% 10k/500k │ 💰 5h 0% · 7d 100% │ 🐙 Tako
 *
 * `/tfooter bar` 切换进度条：blocks / braille / off
 */
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fetchTakoQuota, formatQuotaFooter, type TakoQuota } from "../lib/tako-quota.ts";

const PREFS = join(homedir(), ".pi", "agent", "tako-footer.json");
const STYLES = ["blocks", "braille", "off"] as const;
type BarStyle = (typeof STYLES)[number];

type ThemeFg = { fg: (token: string, text: string) => string };

function tildePath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

function formatK(n: number): string {
  if (n < 1000) return `${Math.max(0, Math.round(n))}`;
  const k = n / 1000;
  if (k < 10) return `${k.toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(k)}k`;
}

function remainPct(used: number, window: number): number {
  if (window <= 0) return 100;
  return Math.max(0, Math.min(100, 100 - Math.round((used / window) * 100)));
}

function remainColor(remain: number, theme: ThemeFg, text: string): string {
  if (remain <= 20) return theme.fg("error", text);
  if (remain <= 50) return theme.fg("warning", text);
  return theme.fg("success", text);
}

function lastValidTokens(ctx: ExtensionContext, live: ReturnType<ExtensionContext["getContextUsage"]>): number | null {
  if (typeof live?.tokens === "number" && live.tokens > 0) return live.tokens;
  let used: number | null = null;
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type !== "message" || e.message.role !== "assistant") continue;
    const m = e.message as AssistantMessage;
    if (m.stopReason === "aborted" || m.stopReason === "error") continue;
    const tokens = m.usage.totalTokens || m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite;
    if (tokens > 0) used = tokens;
  }
  return used;
}

function readStyle(): BarStyle {
  try {
    const raw = JSON.parse(readFileSync(PREFS, "utf8")) as { bar?: string };
    if (raw.bar === "braille" || raw.bar === "off" || raw.bar === "blocks") return raw.bar;
  } catch {
    /* default */
  }
  return "blocks";
}

function writeStyle(bar: BarStyle): void {
  mkdirSync(dirname(PREFS), { recursive: true });
  writeFileSync(PREFS, JSON.stringify({ bar }, null, 2) + "\n");
}

function parseStyle(raw: string): BarStyle | undefined {
  const text = raw.trim().toLowerCase();
  if (text === "block" || text === "blocks" || text === "bar" || text === "on") return "blocks";
  if (text === "braille" || text === "dots" || text === "smooth") return "braille";
  if (text === "off" || text === "none" || text === "text") return "off";
  return undefined;
}

function nextStyle(current: BarStyle): BarStyle {
  return STYLES[(STYLES.indexOf(current) + 1) % STYLES.length];
}

function barGlyphs(style: BarStyle): { full: string; empty: string; fracs: string[] } {
  if (style === "braille") {
    return { full: "⣿", empty: "⣀", fracs: ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] };
  }
  return { full: "█", empty: "░", fracs: ["░", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] };
}

function contextBar(remain: number, width: number, style: BarStyle): string {
  const { full, empty, fracs } = barGlyphs(style);
  const cells = Math.max(6, Math.min(18, width));
  const filled = (remain / 100) * cells;
  const whole = Math.min(cells, Math.floor(filled));
  const frac = filled - whole;
  let out = full.repeat(whole);
  if (whole < cells) {
    const idx = Math.min(fracs.length - 1, Math.round(frac * (fracs.length - 1)));
    out += fracs[idx];
    out += empty.repeat(Math.max(0, cells - whole - 1));
  }
  return out;
}

function joinParts(parts: Array<string | null | undefined>, sep: string): string {
  return parts.filter((part): part is string => Boolean(part)).join(sep);
}

function fitLine(parts: Array<string | null | undefined>, sep: string, width: number): string {
  const items = parts.filter((part): part is string => Boolean(part));
  if (items.length === 0) return "";
  let line = items.join(sep);
  if (visibleWidth(line) <= width) return line;
  const shrinkable = items[0];
  const rest = items.slice(1);
  const restWidth = rest.length === 0 ? 0 : visibleWidth(sep + rest.join(sep));
  const keep = Math.max(4, width - restWidth);
  return truncateToWidth(joinParts([truncateToWidth(shrinkable, keep), ...rest], sep), width);
}

export default function (pi: ExtensionAPI) {
  let quota: TakoQuota | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let barStyle: BarStyle = readStyle();

  async function refreshQuota(force = false): Promise<void> {
    try {
      quota = await fetchTakoQuota(force);
      requestRender?.();
    } catch {
      /* keep last snapshot */
    }
  }

  function applyFooter(ctx: ExtensionContext): void {
    try {
      if (ctx.mode !== "tui") return;
    } catch {
      return;
    }
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose() {
          unsub();
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const cwd = tildePath(process.cwd());
          const branch = footerData.getGitBranch();
          const modelId = ctx.model?.id || "no-model";
          const live = ctx.getContextUsage();
          const window = ctx.model?.contextWindow || live?.contextWindow || 128000;
          const usedTokens = lastValidTokens(ctx, live);
          const remain = usedTokens == null ? null : remainPct(usedTokens, window);
          const barWidth = Math.max(8, Math.min(16, width - 28));
          const bar =
            remain == null || barStyle === "off"
              ? null
              : remainColor(remain, theme, contextBar(remain, barWidth, barStyle));
          const pct = remain == null ? "?" : remainColor(remain, theme, `${remain}%`);
          const tokens = usedTokens == null ? `?/${formatK(window)}` : `${formatK(usedTokens)}/${formatK(window)}`;
          const context = joinParts(["⚡", bar, pct, tokens], " ");
          const money = formatQuotaFooter(quota, theme);
          const sep = theme.fg("muted", " │ ");

          const top = fitLine([`📁 ${cwd}`, branch ? `🌿 ${branch}` : null, `🤖 ${modelId}`], sep, width);
          const bottom = fitLine([context, money, "🐙 Tako"], sep, width);
          return [top, bottom];
        },
      };
    });
  }

  pi.registerCommand("tfooter", {
    description: "Toggle footer context bar: blocks, braille, or off",
    handler: async (args, ctx) => {
      const next = parseStyle(args) ?? nextStyle(barStyle);
      barStyle = next;
      writeStyle(next);
      applyFooter(ctx);
      ctx.ui.notify(`Footer bar: ${next}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    applyFooter(ctx);
    queueMicrotask(() => applyFooter(ctx));
    void refreshQuota(true);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => void refreshQuota(true), 60_000);
    refreshTimer.unref?.();
  });

  pi.on("agent_end", () => {
    void refreshQuota(true);
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    requestRender = undefined;
  });
}
