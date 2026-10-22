import { readFileSync } from "node:fs";
const body = JSON.parse(readFileSync("/tmp/failreq.json", "utf8"));
const store = await import("./open-sse/services/claudeThinkingStore.ts");
// Seed an entry for the 3-tool turn (client msg 1): original interleaved [T1,uA,T2,uB,T3,uC]
const ids = body.messages[3].tool_calls.map((t: any) => t.id);
store.storeClaudeThinkingBlocks({
  toolUseIds: ids,
  provider: "claude",
  model: "claude-opus-5-5",
  blocks: [
    { type: "thinking", thinking: "a", signature: "sigA" },
    { type: "thinking", thinking: "b", signature: "sigB" },
    { type: "thinking", thinking: "c", signature: "sigC" },
  ],
  sequence: [
    { kind: "thinking", block: { type: "thinking", thinking: "a", signature: "sigA" } },
    { kind: "tool_use", toolUseId: ids[0] },
    { kind: "thinking", block: { type: "thinking", thinking: "b", signature: "sigB" } },
    { kind: "tool_use", toolUseId: ids[1] },
    { kind: "thinking", block: { type: "thinking", thinking: "c", signature: "sigC" } },
    { kind: "tool_use", toolUseId: ids[2] },
  ],
});
const { openaiToClaudeRequest } = await import("./open-sse/translator/request/openai-to-claude.ts");
const { prepareClaudeRequest } = await import("./open-sse/translator/helpers/claudeHelper.ts");
const out: any = openaiToClaudeRequest(body.model, body, true, { _provider: "claude" });
const prepared: any = prepareClaudeRequest(out, "claude", false, "claude-opus-5-5");
prepared.messages.slice(0, 6).forEach((m: any, i: number) => {
  const blocks = Array.isArray(m.content) ? m.content : [{ type: "str" }];
  const layout = blocks.map((b: any) => b.type === "thinking" ? `T(${(b.signature||"").slice(0,4)})` : b.type === "redacted_thinking" ? `R` : b.type === "tool_use" ? `u(${(b.id||"").slice(-4)})` : b.type === "tool_result" ? "res" : "txt").join(",");
  console.log(i, m.role, blocks.length, layout.slice(0,110));
});
