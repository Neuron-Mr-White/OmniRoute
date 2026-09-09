// Kept in lockstep with the newest stable Codex CLI release our identity should
// fingerprint as (npm @openai/codex; 0.153.4 as of 2026-09-09). Models shipped
// with a higher minimal_client_version (e.g. gpt-6-astra @ 0.153.0) are
// filtered out of model discovery whenever this lags — see
// shouldImportCodexModel() in src/app/api/providers/[id]/models/discovery/codex.ts.
// Overridable per-deployment via the CODEX_CLIENT_VERSION env.
export const DEFAULT_CODEX_CLIENT_VERSION = "0.153.4";
export const CODEX_CLI_RS_ORIGINATOR = "codex_cli_rs";

export function getCodexCliRsHeaders(
  version = DEFAULT_CODEX_CLIENT_VERSION
): Record<string, string> {
  return {
    "User-Agent": `${CODEX_CLI_RS_ORIGINATOR}/${version}`,
    originator: CODEX_CLI_RS_ORIGINATOR,
  };
}
