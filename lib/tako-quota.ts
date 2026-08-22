/**
 * Tako quota for footer / welcome.
 * Prefers /apiStats/api/user-quota (window + week + day). Wallet balance is
 * shown when the payload includes it.
 */
import { TAKO_BASE, resolveTakoNumericApiId } from "./tako-auth.ts";

const FETCH_MS = 4000;
const CACHE_MS = 60_000;

export type QuotaSlot = {
  used: number;
  limit: number;
  usedPct: number;
  remainPct: number;
  windowMinutes?: number;
};

export type TakoQuota = {
  balance?: number;
  window?: QuotaSlot;
  weekly?: QuotaSlot;
  daily?: QuotaSlot;
  fetchedAt: number;
  error?: string;
};

type ThemeFg = { fg: (token: string, text: string) => string };

let cache: TakoQuota | undefined;
let inflight: Promise<TakoQuota> | undefined;

function money(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (Math.abs(n) >= 100) return `$${Math.round(n)}`;
  if (Math.abs(n) >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

function slot(used: number, limit: number, windowMinutes?: number): QuotaSlot | undefined {
  if (!(limit > 0) || !Number.isFinite(used)) return undefined;
  const usedPct = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  return { used, limit, usedPct, remainPct: 100 - usedPct, windowMinutes };
}

function windowLabel(minutes: number | undefined, fallbackH: number): string {
  if (minutes && minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes && minutes > 0) return `${Math.round(minutes / 60)}h`;
  return `${fallbackH}h`;
}

function usedTone(usedPct: number, theme: ThemeFg, text: string): string {
  if (usedPct >= 90) return theme.fg("error", text);
  if (usedPct >= 70) return theme.fg("warning", text);
  return theme.fg("success", text);
}

function formatSlot(label: string, item: QuotaSlot, theme: ThemeFg): string {
  return `${label} ${usedTone(item.usedPct, theme, `${item.usedPct}%`)}`;
}

export async function fetchTakoQuota(force = false): Promise<TakoQuota> {
  const now = Date.now();
  if (!force && cache && now - cache.fetchedAt < CACHE_MS) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    const apiId = await resolveTakoNumericApiId();
    if (!apiId) {
      cache = { fetchedAt: Date.now(), error: "missing apiId" };
      return cache;
    }
    try {
      const res = await fetch(`${TAKO_BASE}/apiStats/api/user-quota`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiId }),
        signal: AbortSignal.timeout(FETCH_MS),
      });
      if (!res.ok) {
        cache = { fetchedAt: Date.now(), error: `quota http ${res.status}` };
        return cache;
      }
      const json = (await res.json()) as {
        balance?: number;
        plan?: {
          daily_cost_limit?: number;
          weekly_cost_limit?: number;
          window_cost_limit?: number;
          window_minutes?: number;
        };
        usage?: { dailyCost?: number; weeklyCost?: number; windowCost?: number };
      };
      if (!json.plan || !json.usage) {
        cache = { fetchedAt: Date.now(), error: "quota payload" };
        return cache;
      }
      const minutes = json.plan.window_minutes && json.plan.window_minutes > 0 ? json.plan.window_minutes : 300;
      cache = {
        fetchedAt: Date.now(),
        balance: typeof json.balance === "number" && Number.isFinite(json.balance) ? json.balance : undefined,
        window: slot(json.usage.windowCost ?? 0, json.plan.window_cost_limit ?? 0, minutes),
        weekly: slot(json.usage.weeklyCost ?? 0, json.plan.weekly_cost_limit ?? 0, 7 * 1440),
        daily: slot(json.usage.dailyCost ?? 0, json.plan.daily_cost_limit ?? 0, 1440),
      };
      return cache;
    } catch (err) {
      cache = { fetchedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
      return cache;
    } finally {
      inflight = undefined;
    }
  })();

  return inflight;
}

/** Compact footer chunk: 💰 $12.34 · 5h 0% · 7d 100% */
export function formatQuotaFooter(quota: TakoQuota | undefined, theme: ThemeFg): string | undefined {
  if (!quota || quota.error) return undefined;
  const parts: string[] = [];
  if (quota.balance != null) parts.push(money(quota.balance));
  if (quota.window) {
    parts.push(formatSlot(windowLabel(quota.window.windowMinutes, 5), quota.window, theme));
  } else if (quota.daily) {
    parts.push(formatSlot("Day", quota.daily, theme));
  }
  if (quota.weekly) parts.push(formatSlot("7d", quota.weekly, theme));
  if (parts.length === 0) return undefined;
  return `💰 ${parts.join(" · ")}`;
}
