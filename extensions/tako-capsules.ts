/**
 * /installed — list configured skills and packages. No persistent widget.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SKILL_MARKERS = ["SKILL.md", "skill.md"];

function settingsPath(): string {
  return join(process.env.HOME || "", ".pi", "agent", "settings.json");
}

function readSettings(): { skills?: unknown; packages?: unknown } {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf-8"));
  } catch {
    return {};
  }
}

function shortName(raw: string): string {
  return raw
    .replace(/^npm:/, "")
    .replace(/^local\//, "")
    .replace(/^git:/, "")
    .replace(/^@[^/]+\//, "")
    .replace(/^pi-/, "")
    .trim();
}

function skillLabel(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const marker of SKILL_MARKERS) {
    const p = join(dir, marker);
    if (!existsSync(p)) continue;
    try {
      const head = readFileSync(p, "utf-8").slice(0, 400);
      const named = head.match(/^name:\s*["']?([^\n"']+)/m);
      if (named?.[1]) return named[1].trim();
    } catch {
      /* fall through */
    }
    return basename(dir);
  }
  return basename(dir);
}

function collectSkills(ctx: ExtensionContext): string[] {
  const labels = new Set<string>();
  const addDir = (dir: string | undefined) => {
    if (!dir || !existsSync(dir)) return;
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const label = skillLabel(join(dir, ent.name));
        if (label) labels.add(label);
      }
    } catch {
      /* ignore */
    }
  };

  addDir(join(ctx.cwd, ".agents", "skills"));
  addDir(join(process.env.HOME || "", ".agents", "skills"));
  addDir(join(process.env.HOME || "", ".pi", "agent", "skills"));

  const settings = readSettings();
  if (Array.isArray(settings.skills)) {
    for (const p of settings.skills) {
      if (typeof p !== "string") continue;
      const label = skillLabel(p) ?? shortName(p);
      if (label) labels.add(label);
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

function collectExtensions(): string[] {
  const settings = readSettings();
  if (!Array.isArray(settings.packages)) return [];
  return settings.packages
    .map((p) => (typeof p === "string" ? shortName(p) : ""))
    .filter(Boolean);
}

function formatList(title: string, items: string[]): string {
  return items.length > 0 ? `${title}: ${items.join(", ")}` : `${title}: (none)`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("installed", {
    description: "List installed skills and packages",
    handler: async (_args, ctx) => {
      const skills = collectSkills(ctx);
      const extensions = collectExtensions();
      ctx.ui.notify(
        [formatList("Skills", skills), formatList("Ext", extensions)].join("  ·  "),
        "info",
      );
    },
  });
}
