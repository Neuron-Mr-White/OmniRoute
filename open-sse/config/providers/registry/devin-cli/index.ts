import type { RegistryEntry } from "../../shared.ts";
import { DEVIN_MODEL_CATALOG } from "../devin/catalog.ts";

/**
 * The Devin CLI provider — ONE provider, full agentic bridge.
 *
 * Historically split in two (`devin-cli`/dv: openai-format, text-only;
 * `devin-cli-agentic`/dva: claude-format agentic bridge). The split was
 * confusing: the text-only lane could not perform any agentic bridge feature.
 * Merged here: provider id `devin-cli` (the oauth/login surface, pricing,
 * icons and usage fetchers already key on it) exposing the agentic executor
 * under the `dva` alias, with tool-calling catalog semantics.
 *
 * Authentication: the operator's Devin subscription oauth connection (token
 * passed to the CLI as WINDSURF_API_KEY) with the isolated bridge sandbox
 * (DEVIN_AGENTIC_HOME) still owning the credential filesystem — see
 * executors/devin-cli-agentic.ts.
 */
export const devin_cliProvider: RegistryEntry = {
  id: "devin-cli",
  alias: "dva",
  format: "claude",
  executor: "devin-cli-agentic",
  baseUrl: "devin://acp/stdio",
  authType: "oauth",
  authHeader: "none",
  defaultContextLength: 200000,
  models: DEVIN_MODEL_CATALOG.map((model) => ({
    ...model,
    toolCalling: true,
    supportsReasoning: false,
    supportsVision: false,
  })),
};
