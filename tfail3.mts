import { readFileSync } from "node:fs";
const body = JSON.parse(readFileSync("/tmp/failreq.json", "utf8"));
const { translateRequest, initState } = await import("./open-sse/translator/index.ts");
const { FORMATS } = await import("./open-sse/translator/formats.ts");
const state = initState(FORMATS.OPENAI);
const result: any = translateRequest(body, state, { provider: "claude", model: "claude-opus-5-5", targetFormat: FORMATS.CLAUDE });
const msgs = result.body?.messages ?? result.messages;
console.log("msgs:", msgs.length);
msgs.forEach((m: any, i: number) => {
  const blocks = Array.isArray(m.content) ? m.content : [{ type: "str" }];
  const layout = blocks.map((b: any) => b.type === "thinking" ? `T(${(b.signature||"").length})` : b.type === "redacted_thinking" ? `R(${(b.data||"").length})` : b.type === "tool_use" ? "u" : b.type === "tool_result" ? "res" : "txt").join(",");
  if (m.role === "assistant" || layout.includes("T(") || layout.includes("R(")) console.log(i, m.role, blocks.length, layout.slice(0,100));
});
console.log("thinking:", JSON.stringify(result.body?.thinking ?? result.thinking));
