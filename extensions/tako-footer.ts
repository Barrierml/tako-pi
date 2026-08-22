/**
 * Tako-style Pi footer.
 *
 * 📁 ~/path │ 🌿 main │ 🤖 grok-4.6 │ ⚡73% 34k/128k │ 💰 5h 0% · 7d 100% │ 🐙 Tako
 */
import { homedir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { fetchTakoQuota, formatQuotaFooter, type TakoQuota } from "../lib/tako-quota.ts";

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

function remainColor(remain: number, theme: { fg: (token: string, text: string) => string }): string {
  if (remain <= 20) return theme.fg("error", `${remain}%`);
  if (remain <= 50) return theme.fg("warning", `${remain}%`);
  return theme.fg("success", `${remain}%`);
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

export default function (pi: ExtensionAPI) {
  let quota: TakoQuota | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;

  async function refreshQuota(force = false): Promise<void> {
    try {
      quota = await fetchTakoQuota(force);
      requestRender?.();
    } catch {
      /* keep last snapshot */
    }
  }

  function applyFooter(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
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
          const context =
            usedTokens == null
              ? `⚡?/${formatK(window)}`
              : `⚡${remainColor(remainPct(usedTokens, window), theme)} ${formatK(usedTokens)}/${formatK(window)}`;
          const money = formatQuotaFooter(quota, theme);

          const parts = [
            `📁 ${cwd}`,
            branch ? `🌿 ${branch}` : null,
            `🤖 ${modelId}`,
            context,
            money ?? null,
            "🐙 Tako",
          ].filter(Boolean) as string[];

          const sep = theme.fg("muted", " │ ");
          return [truncateToWidth(parts.join(sep), width)];
        },
      };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    applyFooter(ctx);
    setTimeout(() => applyFooter(ctx), 0);
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
