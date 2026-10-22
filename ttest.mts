// Local reproduction of the openai->claude translation with a seeded thinking store
import { openaiToClaudeRequest } from "/home/oi/tmp/omniroute-v3852/open-sse/translator/request/openai-to-claude.ts";
import { storeClaudeThinkingBlocks, restoreClaudeThinkingBlocks } from "/home/oi/tmp/omniroute-v3852/open-sse/services/claudeThinkingStore.ts";

// Seed the store the way the response path would for a turn with:
// thinking(text+sig) followed by TWO tool_use blocks (interleaved original: [thinking1, tool1, thinking2, tool2])
storeClaudeThinkingBlocks({
  provider: "claude",
  model: "claude-opus-5-5",
  toolUseIds: ["toolu_A", "toolu_B"],
  blocks: [
    { type: "thinking", thinking: "plan A", signature: "sigA" },
    { type: "thinking", thinking: "plan B", signature: "sigB" },
  ],
});
console.log("restore lookup:", JSON.stringify(restoreClaudeThinkingBlocks({ toolUseIds: ["toolu_A","toolu_B"], provider: "claude", model: "claude-opus-5-5" })));

const body = {
  model: "claude/claude-opus-5-5",
  messages: [
    { role: "user", content: "q1" },
    // pi-style replay: no reasoning, two tool calls in the latest assistant turn
    { role: "assistant", content: "", tool_calls: [
      { id: "toolu_A", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } },
      { id: "toolu_B", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Rome\"}" } },
    ]},
    { role: "user", content: "Tool result for toolu_A: 18C.\nTool result for toolu_B: 22C." },
    { role: "user", content: "say DONE" },
  ],
  tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
  reasoning_effort: "high",
  max_tokens: 500,
};
const out = openaiToClaudeRequest(body as any, { provider: "claude", model: "claude-opus-5-5" } as any);
// print the LAST assistant message block layout
const msgs = (out as any).messages || (out as any).body?.messages;
console.log("thinking:", JSON.stringify((out as any).thinking ?? (out as any).body?.thinking));
const lastA = [...msgs].reverse().find((m: any) => m.role === "assistant");
console.log("latest assistant block order:", lastA.content.map((b: any) => b.type === "thinking" ? `thinking(${b.thinking?.slice(0,8)},sig=${b.signature?.slice(0,6)})` : b.type === "redacted_thinking" ? `redacted(${(b.data||"").slice(0,10)})` : `${b.type}${b.name ? ":" + b.name : ""}`));
console.log("n_msgs:", msgs.length, "| roles:", msgs.map((m: any) => m.role).join(","));
