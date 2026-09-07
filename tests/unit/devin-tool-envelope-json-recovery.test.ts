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
      "<tool>{\"name\":\"bash\",\"arguments\":{\"command\":\"echo \\\"quoted\\\" {brace}\"}}</tool>",
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
    (/\[Assistant Tool Use\]/.test(t) ||
      (/\[Tool Result\]/.test(t) && /tool_use_id:/.test(t)));

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

describe("parseDevinToolRequest — tolerant narrative extraction (mixed_tool_narrative)", () => {
  const tools = [
    { name: "bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } },
  ];
  it("extracts a single envelope wrapped in prose and carries the narrative", () => {
    const tool = parseDevinToolRequest(
      "Let me search the routes first.\n<tool>{\"name\":\"bash\",\"arguments\":{\"command\":\"grep -r routes web/src\"}}</tool>\nThat should find them.",
      tools
    );
    assert.equal(tool?.name, "bash");
    assert.deepEqual(tool?.input, { command: "grep -r routes web/src" });
    assert.match(tool?.narrative || "", /Let me search the routes first/);
    assert.match(tool?.narrative || "", /That should find them/);
  });
  it("still throws on multiple envelopes", () => {
    assert.throws(
      () =>
        parseDevinToolRequest(
          '<tool>{"name":"bash","arguments":{"command":"a"}}</tool> and <tool>{"name":"bash","arguments":{"command":"b"}}</tool>',
          tools
        ),
      /more than one tool request/
    );
  });
});

describe("parseDevinToolRequest — unclosed trailing envelope (live repro: dva/gpt-5-6-luna-medium)", () => {
  const tools = [
    {
      name: "read",
      description: "read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ];

  it("accepts an envelope with EOF instead of </tool> (exact live text)", () => {
    // The model emitted exactly this three turns in a row — no closing tag.
    const tool = parseDevinToolRequest(
      '<tool>{"name":"read","arguments":{"path":"/tmp/pi-bash-3c4bb50343930090.log"}}',
      tools
    );
    assert.equal(tool?.name, "read");
    assert.deepEqual(tool?.input, { path: "/tmp/pi-bash-3c4bb50343930090.log" });
    assert.equal(tool?.narrative, undefined);
  });

  it("carries preceding prose as narrative for an unclosed envelope", () => {
    const tool = parseDevinToolRequest(
      'Reading the delegate log now.\n<tool>{"name":"read","arguments":{"path":"/tmp/x.log"}}  ',
      tools
    );
    assert.equal(tool?.name, "read");
    assert.equal(tool?.narrative, "Reading the delegate log now.");
  });

  it("keeps fail-open when the text after <tool> is not an envelope", () => {
    const tool = parseDevinToolRequest(
      "I considered using <tool> syntax but decided against it entirely.",
      tools
    );
    assert.equal(tool, null);
  });

  it("still rejects multiple closed envelopes (strictness kept)", () => {
    assert.throws(
      () =>
        parseDevinToolRequest(
          '<tool>{"name":"read","arguments":{"path":"/a"}}</tool>\n<tool>{"name":"read","arguments":{"path":"/b"}}</tool>',
          tools
        ),
      /more than one tool request/
    );
  });
});
