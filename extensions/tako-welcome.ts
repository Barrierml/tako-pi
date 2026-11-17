/**
 * Startup welcome: daily announcement above the editor.
 * Quota lives in the footer. Shows on session start, hides after the first agent turn.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getTakoIdentity, TAKO_CONFIG_PATH, type TakoConfig, type TakoIdentity } from "../lib/tako-auth.ts";

const WIDGET = "tako-welcome";
const FETCH_MS = 2500;

type Announcement = {
  id: string;
  title: string;
  content: string;
  type?: string;
};

async function fetchAnnouncement(identity: TakoIdentity): Promise<Announcement | undefined> {
  try {
    const res = await fetch(identity.announcementsUrl, {
      headers: { Authorization: `Bearer ${identity.apiKey}` },
      signal: AbortSignal.timeout(FETCH_MS),
      redirect: "error",
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { announcement?: Announcement | null };
    const a = json?.announcement;
    if (!a || typeof a.id !== "string" || typeof a.title !== "string") return undefined;
    return { id: a.id, title: a.title, content: a.content ?? "", type: a.type };
  } catch {
    return undefined;
  }
}

function wrapText(text: string, width: number, maxLines = 4): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (words.join(" ").length > lines.join(" ").length) {
    const last = lines[lines.length - 1];
    if (last) lines[lines.length - 1] = truncateToWidth(last, Math.max(4, width - 1)) + "…";
  }
  return lines;
}

function renderWelcome(theme: Theme, announcement: Announcement, width: number): string[] {
  const w = Math.max(24, width);
  const dim = (s: string) => theme.fg("dim", s);
  const accent = (s: string) => theme.fg("accent", s);
  const lines = [accent(`📢 ${announcement.title}`)];
  for (const line of wrapText(announcement.content || "No details", w, 3)) {
    lines.push(dim(line));
  }
  return lines.map((line) => truncateToWidth(line, w));
}

function markAnnouncementSeen(id: string): void {
  try {
    if (!existsSync(TAKO_CONFIG_PATH)) return;
    const cfg = JSON.parse(readFileSync(TAKO_CONFIG_PATH, "utf-8")) as TakoConfig;
    const seen = Array.isArray(cfg.seenAnnouncementIds) ? cfg.seenAnnouncementIds : [];
    if (seen.includes(id)) return;
    const next = [...seen, id].slice(-100);
    writeFileSync(TAKO_CONFIG_PATH, JSON.stringify({ ...cfg, seenAnnouncementIds: next }, null, 2) + "\n");
  } catch {
    /* ignore */
  }
}

export default function (pi: ExtensionAPI) {
  let visible = false;
  let cached: Announcement | undefined;

  function show(ctx: ExtensionContext, announcement: Announcement): void {
    cached = announcement;
    visible = true;
    ctx.ui.setWidget(
      WIDGET,
      (_tui, theme) => ({
        invalidate() {},
        render(width: number) {
          return renderWelcome(theme, announcement, width);
        },
      }),
      { placement: "aboveEditor" },
    );
  }

  function hide(ctx: ExtensionContext): void {
    visible = false;
    ctx.ui.setWidget(WIDGET, undefined);
  }

  async function load(): Promise<Announcement | undefined> {
    const identity = getTakoIdentity();
    if (!identity) return undefined;
    const announcement = await fetchAnnouncement(identity);
    if (announcement) markAnnouncementSeen(announcement.id);
    return announcement;
  }

  pi.registerCommand("welcome", {
    description: "Show or hide the Tako announcement panel",
    handler: async (_args, ctx) => {
      if (visible) {
        hide(ctx);
        return;
      }
      if (cached) {
        show(ctx, cached);
        return;
      }
      try {
        const announcement = await load();
        if (!announcement) {
          ctx.ui.notify("No announcement today", "info");
          return;
        }
        show(ctx, announcement);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (event.reason && event.reason !== "startup" && event.reason !== "reload") return;
    try {
      const announcement = await load();
      if (announcement) show(ctx, announcement);
    } catch {
      /* keep startup quiet */
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (visible) hide(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    hide(ctx);
  });
}
