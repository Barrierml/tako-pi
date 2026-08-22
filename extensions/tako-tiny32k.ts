/**
 * Isolated 32k test provider for mid-turn auto-compact.
 *
 * Same Tako key/endpoint as the live catalog, but a fake 32k window so a long
 * tool loop can trip compact without shrinking grok-4.6. Switch with:
 *   /model tako-tiny32k grok-4.6
 * then /new before testing. Leave the current session on tako/grok-4.6.
 *
 * Use /effort off or low — high thinking can eat the whole 32k by itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TAKO_BASE } from "../lib/tako-auth.ts";

const WINDOW = 32_000;
const MAX_TOKENS = 4096;

export default function (pi: ExtensionAPI) {
  pi.registerProvider("tako-tiny32k", {
    name: "Tako 32k test",
    baseUrl: `${TAKO_BASE}/api`,
    apiKey: "!node -p \"require(require('os').homedir() + '/.tako/config.json').apiKey\"",
    api: "anthropic-messages",
    models: [
      {
        id: "grok-4.6",
        name: "grok-4.6 (32k test)",
        reasoning: true,
        input: ["text"],
        contextWindow: WINDOW,
        maxTokens: MAX_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
