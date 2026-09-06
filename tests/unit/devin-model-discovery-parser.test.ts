import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDevinModelsJson,
  providerSupportsDevinDiscovery,
} from "../../src/lib/providers/devinModelDiscovery";

describe("devinModelDiscovery — parseDevinModelsJson", () => {
  const payload = {
    families: [
      {
        family_label: "Claude Opus 5",
        family_uid: "claude-opus-5",
        aliases: ["opus"],
        variants: [
          {
            model_uid: "claude-opus-5-max",
            label: "Claude Opus 5 Max",
            max_context_tokens: 1000000,
            max_output_tokens: 128000,
            cost_tier: "High cost",
            cost_summary: "$5 / 1M Input · $25 / 1M Output",
            is_new: false,
            is_beta: false,
          },
          {
            model_uid: "claude-opus-5-max-fast",
            label: "Claude Opus 5 Max Fast",
            max_context_tokens: 1000000,
            max_output_tokens: 128000,
            cost_tier: "High cost",
            cost_summary: "$10 / 1M Input · $50 / 1M Output",
            is_new: false,
            is_beta: false,
          },
        ],
      },
      {
        family_label: "Claude Fable 5.1",
        family_uid: "claude-fable-5.1",
        variants: [
          {
            model_uid: "claude-fable-5-1-medium",
            label: "Claude Fable 5.1 Medium",
            max_context_tokens: 1000000,
            max_output_tokens: 128000,
            cost_summary: "$10 / 1M Input",
            is_new: true,
            is_beta: true,
          },
        ],
      },
      {
        family_label: "Broken",
        family_uid: "broken",
        variants: [{ label: "no uid" }, null, { model_uid: "" }],
      },
    ],
  };

  it("normalizes families/variants into synced-available inputs", () => {
    const models = parseDevinModelsJson(payload);
    assert.equal(models.length, 3);
    assert.deepEqual(
      models.map((m) => m.id),
      ["claude-fable-5-1-medium", "claude-opus-5-max", "claude-opus-5-max-fast"]
    );
    const max = models.find((m) => m.id === "claude-opus-5-max")!;
    assert.equal(max.name, "Claude Opus 5 Max");
    assert.equal(max.source, "imported");
    assert.equal(max.inputTokenLimit, 1000000);
    assert.equal(max.outputTokenLimit, 128000);
    assert.match(max.description!, /Claude Opus 5/);
    assert.match(max.description!, /\$5 \/ 1M Input/);
    const fable = models.find((m) => m.id === "claude-fable-5-1-medium")!;
    assert.match(fable.description!, /new/);
    assert.match(fable.description!, /beta/);
  });

  it("skips malformed variants without throwing", () => {
    const models = parseDevinModelsJson(payload);
    assert.ok(models.every((m) => typeof m.id === "string" && m.id.length > 0));
  });

  it("returns [] for non-object payloads", () => {
    assert.deepEqual(parseDevinModelsJson(null), []);
    assert.deepEqual(parseDevinModelsJson("nope"), []);
    assert.deepEqual(parseDevinModelsJson({ families: "x" }), []);
  });
});

describe("devinModelDiscovery — providerSupportsDevinDiscovery", () => {
  it("matches the devin CLI providers case-insensitively", () => {
    assert.equal(providerSupportsDevinDiscovery("devin-cli-agentic"), true);
    assert.equal(providerSupportsDevinDiscovery("DEVIN-CLI"), true);
    assert.equal(providerSupportsDevinDiscovery("devin-cli-agentic "), true);
    assert.equal(providerSupportsDevinDiscovery("devin-desktop"), false);
    assert.equal(providerSupportsDevinDiscovery("claude"), false);
    assert.equal(providerSupportsDevinDiscovery(null), false);
  });
});
