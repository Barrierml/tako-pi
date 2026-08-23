/**
 * One tool: pick a tier, write a prompt, get the child's last text back.
 *
 * Spawns `pi --mode json` directly. Does not use npm:pi-subagents.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const EXT_DIR = join(homedir(), ".pi", "agent", "local", "tako-pi", "extensions");
const WIDGET = "tako-spawn-fleet";
const TIMEOUT_MS = 10 * 60 * 1000;
const TIER_MODEL = {
  normal: { provider: "tako", id: "mimo-v2.5", thinking: "low" },
} as const;
const THINKING = new Set(["off", "low", "medium", "high"]);
const HIDDEN_TOOLS = new Set([
  "subagent",
  "subagent_wait",
  "scout",
  "researcher",
  "worker",
  "reviewer",
  "oracle",
  "delegate",
]);
const READ_TOOLS = ["read", "bash", "grep", "find", "ls"];
const WRITE_TOOLS = ["edit", "write"];
const SPAWN_HINT =
  "Pick tier only. normal = cheap/fast recon. self = parent session for hard or risky work. Do not pass provider model ids.";
const PARENT_GUIDELINES = [
  "Use task when work should run in a child. Pass prompt and optional tier/readonly only.",
  "Do not call spawn, subagent, subagent_wait, scout, reviewer, oracle, or worker. task already waits and returns the child report.",
  "Do not write workflowScript or pick provider model ids. Parallel = two task calls. Serial = task again after the first report.",
];
const CHILD_RULES = [
  "You are a one-shot child agent.",
  "Do only this assignment.",
  "Your last message must be the complete report the parent will use. Do not stop after notes like \"let me compile\" or \"checking more details\".",
  "Do not spawn other agents. You have no task, spawn, subagent, or subagent_wait tools.",
].join("\n");

type Tier = "normal" | "self";
type Job = {
  id: string;
  tier: Tier;
  readonly: boolean;
  prompt: string;
  startedAt: number;
  tool?: string;
  state: "running" | "done";
};

const jobs = new Map<string, Job>();
let ui: ExtensionUIContext | undefined;
let tick: ReturnType<typeof setInterval> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseTier(raw: unknown): Tier {
  const text = asString(raw).toLowerCase();
  if (text === "self" || text === "hard" || text === "inherit") return "self";
  return "normal";
}

function clampThinking(raw: unknown): string | undefined {
  const text = asString(raw).toLowerCase();
  if (THINKING.has(text)) return text;
  if (text === "none" || text === "minimal" || text === "min") return "off";
  if (text === "med") return "medium";
  return undefined;
}

function oneLine(text: string, max = 72): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function taskHeadline(params: { prompt?: unknown; tier?: unknown; readonly?: unknown }): string {
  const prompt = oneLine(asString(params.prompt) || "(no prompt)");
  const bits = [parseTier(params.tier)];
  if (params.readonly === true) bits.push("ro");
  return `${bits.join(" · ")}  ${prompt}`;
}

function childRules(readonly: boolean): string {
  if (!readonly) return CHILD_RULES;
  return `${CHILD_RULES}\nDo not edit, write, or create files. Read-only.`;
}

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function hideOrchestratorTools(pi: ExtensionAPI): void {
  const active = pi.getActiveTools().filter((name) => !HIDDEN_TOOLS.has(name));
  if (!active.includes("task")) active.push("task");
  pi.setActiveTools(active);
}

function paint(): void {
  if (!ui) return;
  const live = [...jobs.values()].filter((job) => job.state === "running");
  if (live.length === 0) {
    ui.setWidget(WIDGET, undefined);
    stopTick();
    return;
  }
  const lines = live.map((job) => {
    const sec = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
    const bits = [job.tier];
    if (job.readonly) bits.push("ro");
    const tool = job.tool ? `  ${job.tool}` : "";
    return `● task  ${bits.join(" · ")}  ${oneLine(job.prompt, 42)}   ${sec}s${tool}`;
  });
  ui.setWidget(WIDGET, lines, { placement: "belowEditor" });
}

function startTick(): void {
  if (tick) return;
  tick = setInterval(paint, 1000);
  tick.unref?.();
}

function stopTick(): void {
  if (!tick) return;
  clearInterval(tick);
  tick = undefined;
}

function resolveChildModel(
  tier: Tier,
  ctx: ExtensionContext,
): { spec: string; thinking?: string; provider: string } {
  if (tier === "self" && ctx.model) {
    return {
      spec: `${ctx.model.provider}/${ctx.model.id}`,
      thinking: clampThinking(ctx.thinkingLevel),
      provider: String(ctx.model.provider),
    };
  }
  const mapped = TIER_MODEL.normal;
  return {
    spec: `${mapped.provider}/${mapped.id}`,
    thinking: mapped.thinking,
    provider: mapped.provider,
  };
}

function childExtensions(provider: string): string[] {
  if (provider === "tako-tiny32k") return [join(EXT_DIR, "tako-tiny32k.ts")];
  if (provider === "tako") return [join(EXT_DIR, "tako-provider.ts")];
  return [];
}

function piLaunch(): { command: string; prefix: string[] } {
  const argv1 = process.argv[1];
  if (argv1 && /\.(?:mjs|cjs|js)$/i.test(argv1)) {
    return { command: process.execPath, prefix: [argv1] };
  }
  const base = process.execPath.split(/[\\/]/).pop() ?? "";
  if (/^pi(?:\.exe)?$/i.test(base)) return { command: process.execPath, prefix: [] };
  return { command: "pi", prefix: [] };
}

function assistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!isRecord(block) || block.type !== "text") return [];
      const text = asString(block.text);
      return text ? [text] : [];
    })
    .join("")
    .trim();
}

function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = assistantText(messages[i]);
    if (text) return text;
  }
  return "";
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const raw = line.trim();
  if (!raw.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function killChild(child: ChildProcessWithoutNullStreams): void {
  if (child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }, 2000).unref?.();
}

type ChildResult = {
  text: string;
  error?: string;
  code: number | null;
  stderr: string;
};

function runChild(args: string[], cwd: string, signal: AbortSignal | undefined, onEvent: (event: Record<string, unknown>) => void): Promise<ChildResult> {
  const launch = piLaunch();
  const child = spawn(launch.command, [...launch.prefix, ...args], {
    cwd,
    env: { ...process.env, TAKO_SPAWN_CHILD: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let text = "";
  let error = "";
  let settled = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const consume = (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseJsonLine(line);
      if (!event) continue;
      onEvent(event);
      if (event.type === "message_end") {
        const next = assistantText(event.message);
        if (next) text = next;
        if (isRecord(event.message)) {
          const stop = asString(event.message.stopReason);
          if (stop === "error" || stop === "aborted") {
            error = asString(event.message.errorMessage) || stop;
          }
        }
      }
      if (event.type === "agent_end") {
        const last = lastAssistantText(event.messages);
        if (last) text = last;
      }
    }
  };

  child.stdout.on("data", consume);
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killChild(child);
      finish(undefined, new Error(`task timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    const onAbort = () => {
      killChild(child);
      finish(undefined, new Error("task aborted"));
    };

    const finish = (value?: ChildResult, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(value as ChildResult);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.on("error", (err) => finish(undefined, err));
    child.on("close", (code) => {
      consume("\n");
      finish({
        text,
        error: error || undefined,
        code,
        stderr: stderr.trim(),
      });
    });
  });
}

function childPrompt(prompt: string, readonly: boolean): string {
  return `${childRules(readonly)}\n\n${prompt}`;
}

function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("")
    .trim();
}

function renderTaskResult(
  result: { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
  expanded: boolean,
  theme: Theme,
): Text {
  const details = isRecord(result.details) ? result.details : {};
  const report = resultText(result);
  const error = asString(details.error);
  if (!expanded) {
    if (result.isError || error) {
      return new Text(theme.fg("error", oneLine(error || report || "task failed")), 0, 0);
    }
    return new Text(theme.fg("muted", oneLine(report || "(empty)")), 0, 0);
  }
  const sections = [
    "=== child system ===",
    asString(details.system) || childRules(details.readonly === true),
    "",
    "=== child user ===",
    asString(details.prompt) || "(no prompt)",
    "",
    result.isError || error ? "=== error ===" : "=== report ===",
    error && report && error !== report ? `${error}\n\n${report}` : report || error || "(empty)",
  ];
  const model = asString(details.model);
  const thinking = asString(details.thinking);
  if (model) {
    sections.splice(0, 0, `model  ${model}${thinking ? `:${thinking}` : ""}`, "");
  }
  return new Text(sections.join("\n"), 0, 0);
}

export default function (pi: ExtensionAPI) {
  if (process.env.TAKO_SPAWN_CHILD === "1") return;

  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Run one child with a prompt, wait, return its text. No roles. Call twice for two jobs. Do not use spawn, subagent, scout, reviewer, or workflowScript. " +
      SPAWN_HINT,
    promptSnippet:
      'Use task({ prompt, tier: "normal" }) for simple jobs, task({ prompt, tier: "self" }) for hard jobs. Do not use spawn, subagent, or subagent_wait.',
    promptGuidelines: PARENT_GUIDELINES,
    executionMode: "parallel",
    parameters: Type.Object({
      prompt: Type.String({ description: "The entire assignment for the child" }),
      tier: Type.Optional(
        Type.String({
          description: "normal = cheap/fast. self = parent session. Default normal.",
        }),
      ),
      readonly: Type.Optional(Type.Boolean({ description: "If true, child must not edit files" })),
    }),
    renderCall(args, theme) {
      const title = theme.fg("toolTitle", theme.bold("task"));
      return new Text(`${title}  ${theme.fg("muted", taskHeadline(args))}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      return renderTaskResult(result, expanded, theme);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const prompt = asString(params.prompt);
      if (!prompt) return textResult("task needs prompt", { error: "no-prompt" }, true);

      const tier = parseTier(params.tier);
      const readonly = params.readonly === true;
      const model = resolveChildModel(tier, ctx);
      const tools = readonly ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS];
      const work = mkdtempSync(join(tmpdir(), "tako-spawn-"));
      const rulesPath = join(work, "rules.md");
      const taskPath = join(work, "task.md");
      writeFileSync(rulesPath, childRules(readonly), { mode: 0o600 });
      writeFileSync(taskPath, prompt, { mode: 0o600 });

      const args = [
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--approve",
        "--model",
        model.thinking ? `${model.spec}:${model.thinking}` : model.spec,
        "--tools",
        tools.join(","),
        "--append-system-prompt",
        rulesPath,
        `@${taskPath}`,
      ];
      for (const ext of childExtensions(model.provider)) {
        args.push("--extension", ext);
      }

      const job: Job = {
        id: crypto.randomUUID(),
        tier,
        readonly,
        prompt,
        startedAt: Date.now(),
        state: "running",
      };
      if (ctx.hasUI) ui = ctx.ui;
      jobs.set(job.id, job);
      startTick();
      paint();

      try {
        const result = await runChild(args, ctx.cwd, signal, (event) => {
          if (event.type === "tool_execution_start") {
            const name = asString(event.toolName);
            if (name) job.tool = name;
            paint();
          }
        });
        const body = result.text.trim();
        if (result.error && !body) {
          return textResult(result.error, { tier, model: model.spec, error: result.error, prompt, system: childRules(readonly) }, true);
        }
        if (!body) {
          const fallback = result.stderr || "Child finished with no text.";
          return textResult(fallback, { tier, model: model.spec, code: result.code, error: fallback, prompt, system: childRules(readonly) }, true);
        }
        return textResult(body, {
          tier,
          model: model.spec,
          thinking: model.thinking,
          readonly,
          prompt,
          system: childRules(readonly),
          elapsedMs: Date.now() - job.startedAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(message, { error: message, tier, model: model.spec, prompt, system: childRules(readonly) }, true);
      } finally {
        job.state = "done";
        jobs.delete(job.id);
        paint();
        rmSync(work, { recursive: true, force: true });
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ui = ctx.ui;
    hideOrchestratorTools(pi);
    paint();
  });
  pi.on("before_agent_start", () => {
    hideOrchestratorTools(pi);
  });
  pi.on("session_shutdown", () => {
    jobs.clear();
    stopTick();
    ui?.setWidget(WIDGET, undefined);
  });
}
