import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DevinCliAgenticExecutor } from "../../open-sse/executors/devin-cli-agentic.ts";
import { replaceSyncedAvailableModelsForConnection } from "../../src/lib/db/models";

/**
 * #devin-models-sync: assertRoutableDevinModel must accept ids that are not in
 * the static DEVIN_MODEL_CATALOG when the dashboard sync persisted them as
 * synced AvailableModels (live `devin models list` discovery). A mock ACP bin
 * answers the protocol so a passing model gate reaches a real tool_use round
 * trip; an unknown id must still 400 before any spawn.
 */

const MOCK_BIN = path.join(os.tmpdir(), `devin-mock-${process.pid}.mjs`);
fs.writeFileSync(
  MOCK_BIN,
  `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
    } else if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } }) + "\\n");
    } else if (msg.method === "session/prompt") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { stopReason: "end_turn", content: [{ type: "text", text: '<tool>{"name":"bash","arguments":{"command":"echo hi"}}</tool>' }] },
        }) + "\\n"
      );
    }
  }
});
`
);
fs.chmodSync(MOCK_BIN, 0o755);

const SANDBOX_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "devin-sync-test-"));
const SANDBOX_HOME = path.join(SANDBOX_BASE, ".sandbox", "home");
fs.mkdirSync(SANDBOX_HOME, { recursive: true });

test.after(() => {
  fs.rmSync(MOCK_BIN, { force: true });
  fs.rmSync(SANDBOX_BASE, { recursive: true, force: true });
});

async function runExecutor(model: string) {
  const prevBin = process.env.CLI_DEVIN_AGENTIC_BIN;
  const prevHome = process.env.DEVIN_AGENTIC_HOME;
  process.env.CLI_DEVIN_AGENTIC_BIN = MOCK_BIN;
  process.env.DEVIN_AGENTIC_HOME = SANDBOX_HOME;
  try {
    const executor = new DevinCliAgenticExecutor();
    return await executor.execute({
      model,
      body: {
        tools: [
          {
            name: "bash",
            description: "run",
            input_schema: { type: "object", properties: { command: { type: "string" } } },
          },
        ],
        messages: [{ role: "user", content: "run echo hi" }],
      },
      stream: false,
      credentials: null,
    });
  } finally {
    if (prevBin === undefined) delete process.env.CLI_DEVIN_AGENTIC_BIN;
    else process.env.CLI_DEVIN_AGENTIC_BIN = prevBin;
    if (prevHome === undefined) delete process.env.DEVIN_AGENTIC_HOME;
    else process.env.DEVIN_AGENTIC_HOME = prevHome;
  }
}

test("synced-only devin model id routes (dashboard sync widens the gate)", async () => {
  await replaceSyncedAvailableModelsForConnection("devin-cli-agentic", "sync-gate-test", [
    { id: "glm-9-preview-synced", name: "GLM 9 Preview (synced)" },
  ]);
  const result = await runExecutor("glm-9-preview-synced");
  assert.equal(result.response.status, 200);
  const body = JSON.parse(await result.response.text());
  assert.equal(body.stop_reason, "tool_use");
  assert.equal(body.content[0].name, "bash");
});

test("unknown devin model id still 400s before spawn", async () => {
  const result = await runExecutor("not-in-any-catalog");
  assert.equal(result.response.status, 400);
  const body = JSON.parse(await result.response.text());
  assert.equal(body.error.code, "unknown_devin_model");
});
