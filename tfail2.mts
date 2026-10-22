import { readFileSync } from "node:fs";
const body = JSON.parse(readFileSync("/tmp/failreq.json", "utf8"));
const { openaiToClaudeRequest } = await import("./open-sse/translator/request/openai-to-claude.ts");
const { prepareClaudeRequest } = await import("./open-sse/translator/helpers/claudeHelper.ts");
const out: any = openaiToClaudeRequest(body.model, body, true, { _provider: "claude" });
const prepared: any = prepareClaudeRequest(out, "claude", false, "claude-opus-5-5");
prepared.messages.forEach((m: any, i: number) => {
  const blocks = Array.isArray(m.content) ? m.content : [{ type: "str" }];
  const layout = blocks.map((b: any) => b.type === "thinking" ? "T" : b.type === "redacted_thinking" ? "R" : b.type === "tool_use" ? `u(${b.name?.slice(0,12)})` : b.type === "tool_result" ? "res" : b.type === "text" ? "txt" : b.type).join(",");
  console.log(i, m.role, blocks.length, layout.slice(0, 120));
});
