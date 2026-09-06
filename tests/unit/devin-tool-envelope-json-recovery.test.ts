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
