import { readFileSync } from "node:fs";
const body = JSON.parse(readFileSync("/tmp/failreq.json", "utf8"));
console.log("model:", body.model, "| effort:", body.reasoning_effort, "| tools:", (body.tools||[]).length, "| msgs:", body.messages.length);
const { openaiToClaudeRequest } = await import("./open-sse/translator/request/openai-to-claude.ts");
const { prepareClaudeRequest } = await import("./open-sse/translator/helpers/claudeHelper.ts");
const out: any = openaiToClaudeRequest(body.model, body, true, { _provider: "claude" });
const prepared: any = prepareClaudeRequest(out, "claude", false, "claude-opus-5-5");
const msgs = prepared.messages;
console.log("translated msgs:", msgs.length);
// find latest assistant + message at translated index 3
const lastA = [...msgs].map((m,i)=>({m,i})).reverse().find(x=>x.m.role==="assistant");
console.log("latest assistant at translated idx:", lastA!.i, "blocks:", lastA!.m.content.length);
console.log("latest assistant layout:", lastA!.m.content.map((b:any)=> b.type==="thinking" ? `T(sig=${(b.signature||"").slice(0,8)}…${(b.signature||"").length})` : b.type==="redacted_thinking" ? `R(data=${(b.data||"").slice(0,8)})` : `${b.type}${b.name?":"+b.name:""}`).join(" | ").slice(0, 600));
const m3 = msgs[3];
console.log("\ntranslated msgs[3] role:", m3.role, "blocks:", m3.content.length);
console.log("msgs[3] layout:", m3.content.map((b:any)=> b.type==="thinking" ? `T(sig=${(b.signature||"").slice(0,8)})` : b.type==="redacted_thinking" ? `R(data=${(b.data||"").slice(0,8)})` : `${b.type}${b.name?":"+b.name:""}`).join(" | ").slice(0, 600));
console.log("\nthinking:", JSON.stringify(prepared.thinking));
