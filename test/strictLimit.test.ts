/**
 * The API refuses a request whose strict tools have more than 16 parameters that can take more
 * than one type ("Schemas contains too many parameters with union types"). Talk and a launch
 * offer every tool, which went over it and failed every turn. Every mode must stay within it,
 * while still offering all of its tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, AGENT_MODEL, AGENT_MODES, MODE_TOOLS, STRICT_UNION_LIMIT, unionParameters } from "../server/agent/loop.ts";
import { ActionStore } from "../server/agent/approvals.ts";
import { makeCtx } from "./helpers/agentCtx.ts";

const done = { id: "m", type: "message", role: "assistant", model: AGENT_MODEL, content: [{ type: "text", text: "Hi!" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } as any;

for (const mode of AGENT_MODES) {
  for (const marketplace of [false, true]) {
    test(`${mode}${marketplace ? " with eBay" : ""}: strict tools stay within the API's union limit and every tool is still offered`, async () => {
      const sent: any[] = [];
      const client = { beta: { messages: { create: async (params: any) => { sent.push(params); return done; } } } };
      await runAgent({ mode, client, store: new ActionStore(), userId: "u1", context: () => makeCtx(), sleep: async () => {}, marketplace, allowWebSearch: true } as any, "Hello");
      const tools: any[] = sent[0].tools;
      const strictUnions = tools.filter((t) => t.strict).reduce((n, t) => n + unionParameters(t.input_schema), 0);
      assert.ok(strictUnions <= STRICT_UNION_LIMIT, `${strictUnions} union parameters in strict tools`);
      const offered = new Set(tools.map((t) => t.name));
      for (const name of MODE_TOOLS[mode]) {
        if (!marketplace && ["ebay_categories", "ebay_item_specifics", "propose_listing"].includes(name)) continue;
        assert.ok(offered.has(name), `${name} is offered`);
      }
    });
  }
}
