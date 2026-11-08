/**
 * Smoke-test: confirms every Claude model id the app references actually resolves against the
 * live API (i.e. isn't a 404 like the old "claude-sonnet-5"). Makes one tiny call per model.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run smoke:models
 *
 * Costs a few tokens per model. Exit code 0 = all valid, 1 = one or more failed, 2 = no key.
 */
import Anthropic from "@anthropic-ai/sdk";

// Keep this list in sync with AGENT_MODEL in server/agent/loop.ts. If you add a model anywhere,
// add it here.
const MODELS = ["claude-opus-5-5"];

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first:  ANTHROPIC_API_KEY=sk-... npm run smoke:models");
  process.exit(2);
}

const client = new Anthropic();
let failed = 0;

for (const model of MODELS) {
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
    });
    // The API may echo a dated variant; accept a match in either direction.
    const ok = res.model.startsWith(model) || model.startsWith(res.model);
    console.log(`${ok ? "PASS" : "WARN"}  ${model}  -> served by ${res.model}`);
    if (!ok) failed++;
  } catch (e) {
    const status = e?.status ?? "?";
    console.error(`FAIL  ${model}  -> ${status} ${e?.name ?? ""}: ${e?.message ?? e}`);
    failed++;
  }
}

console.log(failed ? `\n${failed} model id(s) failed.` : "\nAll model ids valid.");
process.exit(failed ? 1 : 0);
