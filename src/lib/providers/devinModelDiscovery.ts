import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { SyncedAvailableModelInput } from "@/lib/db/models/synced";

/**
 * Live model discovery for the Devin CLI providers (`devin-cli-agentic` / dva,
 * `devin-cli` / dv).
 *
 * These providers have no HTTP model-list endpoint — the only authoritative
 * source is the authenticated official Devin CLI:
 *
 *     devin models list --format json
 *
 * run inside the same isolated sandbox HOME the ACP executor uses
 * (DEVIN_AGENTIC_HOME), so discovery never touches host credentials. The
 * static registry catalog (DEVIN_MODEL_CATALOG) stays as the offline
 * operator-curated fallback; the sync button replaces the synced AvailableModels
 * list with the live output (mirroring volcenginePlanModelDiscovery).
 */

const DEVIN_DISCOVERY_TIMEOUT_MS = 30_000;
const DEVIN_DISCOVERY_MAX_BUFFER = 8 * 1024 * 1024;

/** Providers whose model list is discovered via the Devin CLI. */
const DEVIN_DISCOVERY_PROVIDERS = new Set(["devin-cli-agentic", "devin-cli"]);

export function providerSupportsDevinDiscovery(provider: string | null | undefined): boolean {
  return (
    typeof provider === "string" && DEVIN_DISCOVERY_PROVIDERS.has(provider.trim().toLowerCase())
  );
}

function resolveDevinCliBin(): string {
  const envBin = process.env.CLI_DEVIN_AGENTIC_BIN?.trim() || process.env.CLI_DEVIN_BIN?.trim();
  if (envBin) return envBin;

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const winPath = path.join(localAppData, "devin", "cli", "bin", "devin.exe");
    if (fs.existsSync(winPath)) return winPath;
    return "devin.exe";
  }

  for (const candidate of [
    path.join(os.homedir(), ".local", "share", "devin", "bin", "devin"),
    path.join(os.homedir(), ".devin", "bin", "devin"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "devin";
}

function buildDevinDiscoveryEnv(): { env: NodeJS.ProcessEnv; home: string } {
  const home = process.env.DEVIN_AGENTIC_HOME?.trim() || "";
  if (
    !home ||
    !path.isAbsolute(home) ||
    !(home === "/home/bridge" || home.includes("/.sandbox/"))
  ) {
    throw new Error(
      "DEVIN_AGENTIC_HOME must be set to the bridge sandbox home before Devin model discovery can run"
    );
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
  if (process.env.TERM) env.TERM = process.env.TERM;
  return { env, home };
}

type DevinModelsJsonVariant = {
  model_uid?: unknown;
  label?: unknown;
  max_context_tokens?: unknown;
  max_output_tokens?: unknown;
  cost_tier?: unknown;
  cost_summary?: unknown;
  is_new?: unknown;
  is_beta?: unknown;
};

type DevinModelsJsonFamily = {
  family_label?: unknown;
  family_uid?: unknown;
  variants?: unknown;
};

/**
 * Pure parser: normalized models from a `devin models list --format json`
 * payload. Exported for unit tests.
 */
export function parseDevinModelsJson(payload: unknown): SyncedAvailableModelInput[] {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const families = Array.isArray(record.families) ? record.families : [];
  const models: SyncedAvailableModelInput[] = [];

  for (const family of families) {
    if (!family || typeof family !== "object" || Array.isArray(family)) continue;
    const fam = family as DevinModelsJsonFamily;
    const familyLabel =
      typeof fam.family_label === "string" && fam.family_label.trim()
        ? fam.family_label.trim()
        : "";
    const variants = Array.isArray(fam.variants) ? fam.variants : [];
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const v = variant as DevinModelsJsonVariant;
      const id = typeof v.model_uid === "string" ? v.model_uid.trim() : "";
      if (!id) continue;
      const label = typeof v.label === "string" && v.label.trim() ? v.label.trim() : id;
      const notes: string[] = [];
      if (familyLabel) notes.push(familyLabel);
      if (typeof v.cost_summary === "string" && v.cost_summary.trim())
        notes.push(v.cost_summary.trim());
      if (v.is_new === true) notes.push("new");
      if (v.is_beta === true) notes.push("beta");

      const inputTokenLimit = Number.isFinite(v.max_context_tokens as number)
        ? Number(v.max_context_tokens)
        : undefined;
      const outputTokenLimit = Number.isFinite(v.max_output_tokens as number)
        ? Number(v.max_output_tokens)
        : undefined;

      models.push({
        id,
        name: label,
        source: "imported",
        supportedEndpoints: ["chat"],
        ...(inputTokenLimit !== undefined ? { inputTokenLimit } : {}),
        ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
        ...(notes.length > 0 ? { description: notes.join(" · ") } : {}),
      });
    }
  }

  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** Run `devin models list --format json` in the sandboxed HOME and parse it. */
export async function fetchDevinAvailableModels(): Promise<SyncedAvailableModelInput[]> {
  const { env, home } = buildDevinDiscoveryEnv();
  const bin = resolveDevinCliBin();

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ["models", "list", "--format", "json"], {
      env,
      cwd: home,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`Devin CLI model discovery timed out after ${DEVIN_DISCOVERY_TIMEOUT_MS}ms`)
      );
    }, DEVIN_DISCOVERY_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > DEVIN_DISCOVERY_MAX_BUFFER) {
        child.kill("SIGTERM");
        reject(new Error("Devin CLI model discovery output exceeded the size limit"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8").slice(0, 2000);
    });
    child.on("error", (spawnError) => {
      clearTimeout(timer);
      reject(
        new Error(
          spawnError.message.includes("ENOENT") || spawnError.message.includes("not found")
            ? `Devin CLI not found: ${bin}`
            : `Devin CLI spawn error: ${spawnError.message}`
        )
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out);
      else
        reject(
          new Error(
            `Devin CLI model discovery failed (exit ${code})${err.trim() ? `: ${err.trim().slice(0, 400)}` : ""}`
          )
        );
    });
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Devin CLI model discovery returned invalid JSON");
  }
  const models = parseDevinModelsJson(parsed);
  if (models.length === 0) {
    throw new Error("Devin CLI model discovery returned no models");
  }
  return models;
}
