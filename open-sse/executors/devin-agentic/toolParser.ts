import { createHash } from "node:crypto";
import { asRecord, DevinAgenticBridgeError, type AnthropicTool, type JsonRecord } from "./types.ts";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateSchema(value: unknown, schema: JsonRecord, path: string): string[] {
  const errors: string[] = [];
  const expectedType = schema.type;
  if (typeof expectedType === "string") {
    const actual = typeOf(value);
    if (expectedType === "integer") {
      if (!Number.isInteger(value)) errors.push(`${path} must be integer`);
    } else if (actual !== expectedType) {
      errors.push(`${path} must be ${expectedType}, got ${actual}`);
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
    errors.push(
      `${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`
    );
  }

  if (schema.type === "object" || (value && typeof value === "object" && !Array.isArray(value))) {
    const record = asRecord(value);
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!(key in record)) errors.push(`${path}.${key} is required`);
    }

    const properties = asRecord(schema.properties);
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in record)
        errors.push(...validateSchema(record[key], asRecord(propSchema), `${path}.${key}`));
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    const itemSchema = asRecord(schema.items);
    value.forEach((item, index) =>
      errors.push(...validateSchema(item, itemSchema, `${path}[${index}]`))
    );
  }

  return errors;
}

/**
 * Best-effort JSON recovery for the content of a <tool> envelope:
 *  1. strip markdown code fences (```json ... ``` / ``` ... ```)
 *  2. extract the first balanced brace-delimited object
 *  3. remove trailing commas before `}` / `]`
 * Returns the parsed record, or null when nothing parseable remains.
 */
function recoverEnvelopeJson(raw: string): JsonRecord | null {
  let candidate = raw.trim();

  const fence = candidate.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (fence) candidate = fence[1].trim();
  candidate = candidate.replace(/^[`\s]+|[`\s]+$/g, "");

  const start = candidate.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  let extracted = candidate.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
  try {
    return asRecord(JSON.parse(extracted));
  } catch {
    // Position-aware repair (regex cannot tell key slot from value slot):
    // a string in KEY position missing its ':' (`"name" "read"`) and a value
    // end missing its ',' before the next entry (`"read" "arguments"`).
    const repaired = repairJsonSlips(extracted);
    if (repaired !== extracted) {
      try {
        return asRecord(JSON.parse(repaired));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Tiny stateful JSON slip repairer for tool envelopes. Tracks object/array
// frames and key/value expectation so it inserts the RIGHT missing token:
// ':' after a key string, ',' between a completed value and the next token.
function repairJsonSlips(input: string): string {
  const isValueStart = (c: string) =>
    c === '"' || c === "{" || c === "[" || /[\d-]/.test(c) || /^[tfn]/.test(c);
  type Frame = { kind: "o" | "a"; wantKey: boolean };
  const frames: Frame[] = [];
  let out = "";
  let i = 0;
  let lastWasValue = false;
  const n = input.length;
  const frame = () => frames[frames.length - 1];
  while (i < n) {
    const c = input[i];
    if (/\s/.test(c)) {
      out += c;
      i += 1;
      continue;
    }
    if (c === "{" || c === "[") {
      frames.push({ kind: c === "{" ? "o" : "a", wantKey: c === "{" });
      out += c;
      lastWasValue = false;
      i += 1;
      continue;
    }
    if (c === "}" || c === "]") {
      frames.pop();
      out += c;
      lastWasValue = true;
      i += 1;
      continue;
    }
    if (c === "," || c === ":") {
      if (c === "," && frame()?.kind === "o") frame()!.wantKey = true;
      if (c === ":" && frame()?.kind === "o") frame()!.wantKey = false;
      out += c;
      lastWasValue = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let str = '"';
      while (j < n) {
        if (input[j] === "\\" && j + 1 < n) {
          str += input[j] + input[j + 1];
          j += 2;
          continue;
        }
        str += input[j];
        if (input[j] === '"') break;
        j += 1;
      }
      const tokenEnd = j;
      let b = tokenEnd + 1;
      while (b < n && /\s/.test(input[b])) b += 1;
      const next = b < n ? input[b] : "";
      let prefix = "";
      let suffix = "";
      const current = frame();
      const inObject = current?.kind === "o";
      if (lastWasValue && next && next !== "," && next !== "}" && next !== "]") {
        prefix = ",";
      }
      if (current && inObject && current.wantKey && next && next !== ":" && isValueStart(next)) {
        suffix = ":";
      }
      out += prefix + str + suffix;
      if (current && inObject) {
        if (suffix === ":") current.wantKey = false;
        else if (!current.wantKey) lastWasValue = true;
      } else {
        lastWasValue = true;
      }
      i = tokenEnd + 1;
      continue;
    }
    // numbers / literals: consume the run, mark a value complete
    const m = /^[^,{}\[\]\s"]+/u.exec(input.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
    } else {
      out += c;
      i += 1;
    }
    lastWasValue = true;
  }
  return out;
}

export function parseDevinToolRequest(text: string, tools: AnthropicTool[], idSeed = "") {
  const matches = [...text.matchAll(/<tool>\s*([\s\S]*?)\s*<\/tool>/g)];
  if (matches.length === 0) {
    // Tolerant: an UNCLOSED trailing envelope (model truncated before the
    // closing tag) is still a usable tool request — EOF implies closure.
    // Live repro: dva/gpt-5-6-luna-medium emitted
    // `<tool>{"name":"read","arguments":{...}}` with no `</tool>` three turns
    // in a row; fail-open shipped it as plain text and the client session
    // stalled. If the remainder does not parse as an envelope, keep returning
    // null so the narrative guards and fail-open path still apply.
    const trailing = /<tool>\s*([\s\S]*?)\s*$/.exec(text);
    if (trailing === null) return null;
    let payload: ReturnType<typeof asRecord> | null = null;
    try {
      payload = asRecord(JSON.parse(trailing[1] || "{}"));
    } catch {
      payload = recoverEnvelopeJson(trailing[1] || "");
    }
    if (payload === null) return null;
    return finalizeDevinToolRequest(
      payload,
      text.replace(trailing[0], "").trim() || undefined,
      tools,
      idSeed
    );
  }
  if (matches.length > 1) {
    throw new DevinAgenticBridgeError(
      "Devin response contained more than one tool request; parallel tool use is not supported",
      "multiple_tool_requests"
    );
  }

  // Tolerant: exactly one envelope embedded in narrative prose is still a
  // usable tool request — extract the envelope and carry the surrounding
  // prose as a text block (Anthropic allows text + tool_use in one message).
  // Previously this threw mixed_tool_narrative → one repair → often another
  // narrated envelope → 400 killed the whole client session (live repro:
  // rsbridge agent, dva/*). Strictness is only kept for MULTIPLE envelopes.
  const narrative =
    text.trim() !== matches[0][0].trim()
      ? text.replace(matches[0][0], "").trim()
      : undefined;

  let payload: JsonRecord;
  try {
    payload = asRecord(JSON.parse(matches[0][1] || "{}"));
  } catch (error) {
    // Tolerant recovery for common frontier-model envelope malformations:
    // markdown fences around the JSON (```json ... ```), trailing commas, and
    // stray prose around a balanced object. Without this, one malformed
    // envelope + one equally malformed repair attempt hard-fails the whole
    // turn with invalid_tool_json (live repro: dva/gpt-6-astra-low).
    const recovered = recoverEnvelopeJson(matches[0][1] || "");
    if (recovered === null) {
      throw new DevinAgenticBridgeError(
        `Devin tool request was not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        } [raw body: ${(matches[0][1] || "").slice(0, 160)}]`,
        "invalid_tool_json"
      );
    }
    payload = recovered;
  }

  return finalizeDevinToolRequest(payload, narrative, tools, idSeed);
}

function finalizeDevinToolRequest(
  payload: JsonRecord,
  narrative: string | undefined,
  tools: AnthropicTool[],
  idSeed: string
) {
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name)
    throw new DevinAgenticBridgeError("Devin tool request is missing name", "missing_tool_name");

  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new DevinAgenticBridgeError(`Devin requested unknown tool: ${name}`, "unknown_tool");
  }

  const input = asRecord(payload.arguments);
  const schema = tool.input_schema || { type: "object", properties: {} };
  const errors = validateSchema(input, schema, "arguments");
  if (errors.length > 0) {
    throw new DevinAgenticBridgeError(
      `Devin tool arguments failed schema validation: ${errors.join("; ")}`,
      "invalid_tool_arguments"
    );
  }

  const digest = createHash("sha256")
    .update(`${idSeed}:${name}:${stableJson(input)}`)
    .digest("hex")
    .slice(0, 16);
  return { id: `tool_devin_${digest}`, name, input, ...(narrative ? { narrative } : {}) };
}
