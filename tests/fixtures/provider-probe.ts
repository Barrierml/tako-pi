/**
 * Drives extensions/tako-provider.ts with a fake ExtensionAPI and a stubbed
 * catalog fetch, then prints what was registered. The raw key is never
 * printed; the test compares SHA-256 fingerprints.
 */
import { createHash } from "node:crypto";
import extension from "../../extensions/tako-provider.ts";

type Registered = {
  name: string;
  baseUrl: string;
  apiKeySha256: string | null;
  modelIds: string[];
};

const registered: Registered[] = [];
const pi = {
  registerProvider(name: string, config: { baseUrl?: string; apiKey?: string; models?: { id: string }[] }) {
    registered.push({
      name,
      baseUrl: config.baseUrl ?? "",
      apiKeySha256:
        typeof config.apiKey === "string" ? createHash("sha256").update(config.apiKey).digest("hex") : null,
      modelIds: (config.models ?? []).map((model) => model.id),
    });
  },
  on() {},
};

const catalog = {
  models: [{ slug: "fixture-chat", display_name: "Fixture Chat", context_window: 131072, model_category: "chat" }],
};
globalThis.fetch = async () =>
  new Response(JSON.stringify(catalog), { status: 200, headers: { "Content-Type": "application/json" } });

await extension(pi as never);
process.stdout.write(JSON.stringify({ registered }));
