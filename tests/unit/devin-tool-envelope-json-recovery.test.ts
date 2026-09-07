import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDevinToolRequest } from "../../open-sse/executors/devin-agentic/toolParser.ts";

/**
 * Tolerant envelope parsing: frontier models behind the Devin summarizer
 * sometimes malform the <tool> JSON (markdown fences, trailing commas, stray
 * prose around the object). Live repro: dva/gpt-6-astra-low returned
 * invalid_tool_json and the single generic repair repeated the malformation.
 */
describe("parseDevinToolRequest — envelope JSON recovery", () => {
  const tools = [
    {
      name: "bash",
      description: "run",
      input_schema: { type: "object", properties: { command: { type: "string" } } },
    },
  ];

  it("parses a clean envelope (unchanged)", () => {
    const tool = parseDevinToolRequest(
      '<tool>{"name":"bash","arguments":{"command":"uname -a"}}</tool>',
      tools
    );
    assert.equal(tool?.name, "bash");
    assert.deepEqual(tool?.input, { command: "uname -a" });
  });

  it("recovers a markdown-fenced envelope", () => {
    const tool = parseDevinToolRequest(
      '<tool>```json\n{"name":"bash","arguments":{"command":"echo hi"}}\n```</tool>',
      tools
    );
    assert.equal(tool?.name, "bash");
    assert.deepEqual(tool?.input, { command: "echo hi" });
  });

  it("recovers trailing commas", () => {
    const tool = parseDevinToolRequest(
      '<tool>{"name":"bash","arguments":{"command":"echo hi",},}</tool>',
      tools
    );
    assert.equal(tool?.name, "bash");
    assert.deepEqual(tool?.input, { command: "echo hi" });
  });

  it("recovers prose around the balanced object inside the envelope", () => {
    const tool = parseDevinToolRequest(
      '<tool>Sure! Here is the call: {"name":"bash","arguments":{"command":"echo hi"}} — done.</tool>',
      tools
    );
    assert.equal(tool?.name, "bash");
    assert.deepEqual(tool?.input, { command: "echo hi" });
  });

  it("keeps escaped quotes inside strings intact during extraction", () => {
    const tool = parseDevinToolRequest(
      '<tool>{"name":"bash","arguments":{"command":"echo \\"quoted\\" {brace}"}}</tool>',
      tools
    );
    assert.deepEqual(tool?.input, { command: 'echo "quoted" {brace}' });
  });

  it("still rejects unparseable envelopes with a detailed error", () => {
    assert.throws(
      () => parseDevinToolRequest("<tool>{not json at all</tool>", tools),
      /not valid JSON: .+/
    );
  });
});

describe("isExecutionTraceEcho guard (via executor repair path)", () => {
  // Indirect: the detection lives in the executor; assert the regex behaviours
  // it relies on so the guard's semantics stay pinned.
  const echo = (t: string) =>
    !t.includes("<tool>") &&
    (/\[Assistant Tool Use\]/.test(t) || (/\[Tool Result\]/.test(t) && /tool_use_id:/.test(t)));

  it("flags fabricated trace transcripts", () => {
    const realFailure = `[Assistant Tool Use]\nid: tool_devin_3c6e12c4c84c16f0\nname: multi_web_content_read\narguments: {"url":"https://x"}\n\n[User]\n[Tool Result]\ntool_use_id: tool_devin_3c6e2c4c84c16f0\nis_error: false\ncontent: page text`;
    assert.equal(echo(realFailure), true);
  });

  it("does not flag clean final text", () => {
    assert.equal(echo("The provider page uses a card grid with alias-based routes."), false);
  });

  it("does not flag a real envelope", () => {
    assert.equal(echo('<tool>{"name":"bash","arguments":{"command":"ls"}}</tool>'), false);
  });
});
