/**
 * Claude signed-thinking continuity store.
 *
 * When a Claude-format upstream answers an OpenAI Chat Completions or Responses
 * client, the client only receives the reasoning TEXT (`reasoning_content` /
 * reasoning summary). The signed `thinking` / `redacted_thinking` blocks that
 * Anthropic needs back on the next tool-loop turn are lost, so openai-to-claude
 * could only send a `redacted_thinking` placeholder (#5312) — the model loses its
 * own reasoning continuity across tool calls.
 *
 * This store keeps the exact signed blocks server-side, keyed by the `tool_use`
 * ids of the assistant turn that produced them (same pattern as
 * geminiThoughtSignatureStore), so the request translator can restore them in
 * front of the owning `tool_use` on the next turn.
 *
 * Invariants:
 * - Memory only, TTL + size bounded. Thinking text and signatures never reach the
 *   DB or any log line (thinkingSignatureDiagnostics invariants).
 * - Bound to provider + model: a signature replayed to a different model or
 *   provider is a hard 400 (#6953), so a binding mismatch restores nothing.
 * - All-or-nothing: a turn is stored only when every thinking-ish block is
 *   replayable (non-empty signature / data); a partial set would reorder the turn.
 */

import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../config/defaultThinkingSignature.ts";

export type ClaudeSignedThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/**
 * Ordered interleaving of one assistant turn's thinking and tool_use blocks, as
 * Anthropic emitted them. The Messages API validates the LATEST assistant
 * message's thinking blocks against the original response — including their
 * positions — so a restore must reinsert each thinking block directly before
 * the tool_use that followed it in the original turn (2026-10-22 production:
 * restoring interleaved blocks by unshifting them all to the front of the
 * message reordered them and Anthropic answered 400 "`thinking` or
 * `redacted_thinking` blocks in the latest assistant message cannot be
 * modified").
 */
export type ClaudeThinkingSequenceItem =
  | { kind: "thinking"; block: ClaudeSignedThinkingBlock }
  | { kind: "tool_use"; toolUseId: string }
  /** Position-only marker: a text block sat inside the turn (no restore possible). */
  | { kind: "text" };

/** Restore plan: thinking blocks to reinsert, each directly before its tool_use. */
export type ClaudeThinkingRestorePlan = Array<{
  beforeToolUseId: string;
  blocks: ClaudeSignedThinkingBlock[];
}>;

type Entry = {
  provider: string;
  model: string;
  blocks: ClaudeSignedThinkingBlock[];
  /** Original interleaving with the turn's tool_use blocks; absent on legacy writes. */
  sequence?: ClaudeThinkingSequenceItem[];
  size: number;
  expiresAt: number;
};

export const CLAUDE_THINKING_MEMORY_TTL_MS = 1000 * 60 * 60;
export const MAX_CLAUDE_THINKING_ENTRIES = 1000;
/** Upper bound for one assistant turn (sum of thinking text + signature/data chars). */
export const MAX_CLAUDE_THINKING_ENTRY_CHARS = 2 * 1024 * 1024;
const MAX_CLAUDE_THINKING_TOTAL_CHARS = 64 * 1024 * 1024;

const entries = new Map<string, Entry>();
let totalChars = 0;

function normalizeProvider(provider: unknown): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

/**
 * Anthropic echoes the dated snapshot (`claude-sonnet-4-5-20250929`) while the
 * request may use the alias (`claude-sonnet-4-5`); both name the same model, so
 * the binding compares the undated form. Any other difference is a different model.
 */
export function normalizeClaudeThinkingModel(model: unknown): string {
  if (typeof model !== "string") return "";
  let normalized = model.trim().toLowerCase();
  const slash = normalized.lastIndexOf("/");
  if (slash >= 0) normalized = normalized.slice(slash + 1);
  return normalized.replace(/-\d{8}$/, "");
}

function normalizeBlock(block: unknown): ClaudeSignedThinkingBlock | null {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const record = block as Record<string, unknown>;
  if (record.type === "thinking") {
    if (typeof record.thinking !== "string") return null;
    if (typeof record.signature !== "string" || record.signature.length === 0) return null;
    return { type: "thinking", thinking: record.thinking, signature: record.signature };
  }
  if (record.type === "redacted_thinking") {
    if (typeof record.data !== "string" || record.data.length === 0) return null;
    return { type: "redacted_thinking", data: record.data };
  }
  return null;
}

function blockSize(block: ClaudeSignedThinkingBlock): number {
  return block.type === "thinking"
    ? block.thinking.length + block.signature.length
    : block.data.length;
}

/**
 * Validate/normalize a caller-supplied sequence: every thinking block and every
 * tool_use id of the turn must appear exactly once, in a consistent order.
 */
function normalizeSequence(
  sequence: unknown,
  blocks: ClaudeSignedThinkingBlock[],
  toolUseIds: string[]
): ClaudeThinkingSequenceItem[] | undefined {
  if (!Array.isArray(sequence) || sequence.length === 0) return undefined;
  const items: ClaudeThinkingSequenceItem[] = [];
  const seenBlocks = new Set<ClaudeSignedThinkingBlock>();
  const seenToolIds = new Set<string>();
  for (const raw of sequence) {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    if (item.kind === "text") {
      items.push({ kind: "text" });
    } else if (item.kind === "tool_use") {
      const id = item.toolUseId;
      if (typeof id !== "string" || !toolUseIds.includes(id) || seenToolIds.has(id)) return undefined;
      seenToolIds.add(id);
      items.push({ kind: "tool_use", toolUseId: id });
    } else if (item.kind === "thinking") {
      const normalized = normalizeBlock(item.block);
      if (!normalized || seenBlocks.has(normalized)) return undefined;
      seenBlocks.add(normalized);
      items.push({ kind: "thinking", block: normalized });
    } else {
      return undefined;
    }
  }
  if (seenBlocks.size !== blocks.length || seenToolIds.size !== toolUseIds.length) return undefined;
  return items;
}

function cloneBlocks(blocks: ClaudeSignedThinkingBlock[]): ClaudeSignedThinkingBlock[] {
  return blocks.map((block) => ({ ...block }));
}

function deleteKey(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  totalChars -= entry.size;
}

function pruneExpired(now: number) {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) deleteKey(key);
  }
  while (
    entries.size > MAX_CLAUDE_THINKING_ENTRIES ||
    totalChars > MAX_CLAUDE_THINKING_TOTAL_CHARS
  ) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) break;
    deleteKey(oldestKey);
  }
}

function collectToolUseIds(toolUseIds: unknown): string[] {
  if (!Array.isArray(toolUseIds)) return [];
  return toolUseIds.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Remember the signed thinking blocks of one assistant turn under each of its
 * tool_use ids. No-op unless the turn owns tool calls and every block is replayable.
 */
export function storeClaudeThinkingBlocks(args: {
  toolUseIds: unknown;
  blocks: unknown;
  provider: unknown;
  model: unknown;
  /** Original interleaving with the turn's tool_use blocks (see the type doc). */
  sequence?: unknown;
}): boolean {
  const toolUseIds = collectToolUseIds(args.toolUseIds);
  const model = normalizeClaudeThinkingModel(args.model);
  if (toolUseIds.length === 0 || !model || !Array.isArray(args.blocks)) return false;
  if (args.blocks.length === 0) return false;

  const blocks = args.blocks.map(normalizeBlock);
  if (!blocks.every(Boolean)) return false;
  const normalizedBlocks = blocks as ClaudeSignedThinkingBlock[];
  const sequence = normalizeSequence(args.sequence, normalizedBlocks, toolUseIds);
  const size = normalizedBlocks.reduce((sum, block) => sum + blockSize(block), 0);
  if (size > MAX_CLAUDE_THINKING_ENTRY_CHARS) return false;

  const now = Date.now();
  const provider = normalizeProvider(args.provider);
  for (const toolUseId of toolUseIds) {
    deleteKey(toolUseId);
    entries.set(toolUseId, {
      provider,
      model,
      blocks: cloneBlocks(normalizedBlocks),
      sequence: sequence?.map((item) => ({ ...item })),
      size,
      expiresAt: now + CLAUDE_THINKING_MEMORY_TTL_MS,
    });
    totalChars += size;
  }
  pruneExpired(now);
  return true;
}

/**
 * Non-streaming counterpart of the claude-to-openai stream capture: remember the
 * signed thinking blocks of a complete Claude Messages response that owns tool_use
 * blocks. The response's own `model` wins over the request model, like the stream.
 */
export function storeClaudeThinkingFromResponse(
  responseBody: unknown,
  binding: { provider: unknown; model: unknown }
): boolean {
  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    return false;
  }
  const root = responseBody as Record<string, unknown>;
  if (!Array.isArray(root.content)) return false;
  const sequence: ClaudeThinkingSequenceItem[] = [];
  const blocks: unknown[] = [];
  const toolUseIds: unknown[] = [];
  for (const block of root.content) {
    const type = (block as Record<string, unknown> | null)?.type;
    if (type === "thinking" || type === "redacted_thinking") {
      const normalized = normalizeBlock(block);
      if (normalized) {
        blocks.push(block);
        sequence.push({ kind: "thinking", block: normalized });
      }
    } else if (type === "tool_use") {
      const id = (block as Record<string, unknown>).id;
      if (typeof id === "string" && id) {
        toolUseIds.push(id);
        sequence.push({ kind: "tool_use", toolUseId: id });
      }
    } else if (type === "text") {
      sequence.push({ kind: "text" });
    }
  }
  return storeClaudeThinkingBlocks({
    toolUseIds,
    blocks,
    sequence,
    provider: binding.provider,
    model: typeof root.model === "string" && root.model ? root.model : binding.model,
  });
}

/**
 * Positional restore plan: for each tool_use id of the replayed assistant
 * message, the signed thinking blocks that must sit directly before it —
 * mirroring the original turn's interleaving.
 *
 * Only restores when the replayed message's tool_use id SEQUENCE exactly equals
 * the stored turn's (same ids, same order). A subset, a superset, or a different
 * order means the client edited/compacted/merged the turn, and no honest
 * positional restore exists — returning null falls back to the #5312
 * placeholder path.
 */
export function restoreClaudeThinkingPlan(args: {
  toolUseIds: unknown;
  provider: unknown;
  model: unknown;
}): ClaudeThinkingRestorePlan | null {
  const toolUseIds = collectToolUseIds(args.toolUseIds);
  const model = normalizeClaudeThinkingModel(args.model);
  if (toolUseIds.length === 0 || !model) return null;

  pruneExpired(Date.now());
  const provider = normalizeProvider(args.provider);
  for (const toolUseId of toolUseIds) {
    const entry = entries.get(toolUseId);
    if (!entry) continue;
    if (entry.provider !== provider || entry.model !== model) return null;

    const entryToolIds = (entry.sequence ?? [])
      .filter((item) => item.kind === "tool_use")
      .map((item) => (item as { kind: "tool_use"; toolUseId: string }).toolUseId);
    // A text block inside the turn (thinking + "Let me check…" commentary +
    // tool_use) makes positional restore impossible: an OpenAI replay carries
    // one flat text content and cannot reproduce where the text sat between
    // thinking/tool_use blocks, and Anthropic validates thinking-block
    // POSITIONS (2026-10-22 production: same-account restore with text
    // interleaved 400'd "cannot be modified"). Restore nothing — the #5312
    // placeholder path is accepted verbatim.
    if ((entry.sequence ?? []).some((item) => item.kind === "text")) return null;
    // Legacy entries without a stored sequence: approximate the old behavior
    // (all blocks before the first tool_use) — the store is memory-only, so
    // entries never outlive a restart and this path only serves races during a
    // rolling deploy.
    if (!entry.sequence || entryToolIds.length === 0) {
      return [{ beforeToolUseId: toolUseIds[0], blocks: cloneBlocks(entry.blocks) }];
    }
    if (
      entryToolIds.length !== toolUseIds.length ||
      entryToolIds.some((id, index) => id !== toolUseIds[index])
    ) {
      return null;
    }

    const plan: ClaudeThinkingRestorePlan = [];
    let pending: ClaudeSignedThinkingBlock[] = [];
    for (const item of entry.sequence) {
      if (item.kind === "thinking") {
        pending.push(item.block);
      } else {
        plan.push({ beforeToolUseId: item.toolUseId, blocks: pending });
        pending = [];
      }
    }
    // Defensive: a trailing thinking run with no following tool_use attaches to
    // the last tool_use (Anthropic never emits this shape, but tolerate it).
    if (pending.length > 0 && plan.length > 0) {
      plan[plan.length - 1].blocks.push(...pending);
    }
    return plan;
  }
  return null;
}

/**
 * Flat-blocks view of the positional plan (legacy convenience): blocks in
 * document order. Used by callers that only need to know whether an entry hits.
 * Return fresh copies of the signed blocks stored for the first tool_use id that
 * hits with the same provider + model binding, or null.
 */
export function restoreClaudeThinkingBlocks(args: {
  toolUseIds: unknown;
  provider: unknown;
  model: unknown;
}): ClaudeSignedThinkingBlock[] | null {
  const plan = restoreClaudeThinkingPlan(args);
  if (!plan) return null;
  const flat: ClaudeSignedThinkingBlock[] = [];
  for (const insertion of plan) flat.push(...cloneBlocks(insertion.blocks));
  return flat;
}

function sameBlock(stored: ClaudeSignedThinkingBlock, block: unknown): boolean {
  const normalized = normalizeBlock(block);
  if (!normalized) return false;
  if (stored.type === "thinking") {
    return normalized.type === "thinking" && normalized.signature === stored.signature;
  }
  return normalized.type === "redacted_thinking" && normalized.data === stored.data;
}

function isStoredBlock(block: unknown): boolean {
  for (const entry of entries.values()) {
    if (entry.blocks.some((stored) => sameBlock(stored, block))) return true;
  }
  return false;
}

function forgetEntriesHolding(blocks: unknown[]) {
  const keys: string[] = [];
  for (const [key, entry] of entries) {
    if (entry.blocks.some((stored) => blocks.some((block) => sameBlock(stored, block)))) {
      keys.push(key);
    }
  }
  for (const key of keys) deleteKey(key);
}

/**
 * Signature-recovery fallback: Anthropic rejected a thinking signature. The
 * active tool-use cycle is otherwise preserved verbatim by the recovery, so any
 * block this store restored there is swapped for the pre-restore #5312
 * `redacted_thinking` placeholder and forgotten, so later turns do not replay it
 * again. Returns null when the content holds no server-restored block.
 */
export function downgradeRestoredClaudeThinking(content: unknown): unknown[] | null {
  if (!Array.isArray(content) || entries.size === 0) return null;
  const restored = content.filter(isStoredBlock);
  if (restored.length === 0) return null;

  forgetEntriesHolding(restored);
  const kept = content.filter((block) => !restored.includes(block));
  const hasThinking = kept.some((block) => {
    const type = (block as Record<string, unknown> | null)?.type;
    return type === "thinking" || type === "redacted_thinking";
  });
  const hasToolUse = kept.some(
    (block) => (block as Record<string, unknown> | null)?.type === "tool_use"
  );
  if (!hasThinking && hasToolUse) {
    kept.unshift({ type: "redacted_thinking", data: DEFAULT_THINKING_CLAUDE_SIGNATURE });
  }
  return kept;
}

/**
 * Drop whatever the stream capture stored for the tool calls of a reconstructed
 * client response (Chat `choices[].message.tool_calls[].id` or Responses
 * `output[].call_id`). Used when the turn must not be retained at all, e.g. a
 * response that may echo video transcript cues.
 */
export function forgetClaudeThinkingForClientResponse(responseBody: unknown): void {
  if (!responseBody || typeof responseBody !== "object" || entries.size === 0) return;
  const root = responseBody as Record<string, unknown>;
  const ids: string[] = [];
  if (Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      const toolCalls = (choice as { message?: { tool_calls?: unknown } } | null)?.message
        ?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const toolCall of toolCalls) {
        const id = (toolCall as { id?: unknown } | null)?.id;
        if (typeof id === "string") ids.push(id);
      }
    }
  }
  const output = Array.isArray(root.output)
    ? root.output
    : Array.isArray((root.response as { output?: unknown } | undefined)?.output)
      ? ((root.response as { output: unknown[] }).output as unknown[])
      : [];
  for (const item of output) {
    const callId = (item as { call_id?: unknown } | null)?.call_id;
    if (typeof callId === "string") ids.push(callId);
  }
  for (const id of ids) deleteKey(id);
}

export function clearClaudeThinkingStore() {
  entries.clear();
  totalChars = 0;
}

export function getClaudeThinkingStoreSizeForTests() {
  pruneExpired(Date.now());
  return entries.size;
}
