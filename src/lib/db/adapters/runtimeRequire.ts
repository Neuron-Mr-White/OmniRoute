// src/lib/db/adapters/runtimeRequire.ts
/**
 * Load optional database drivers from the runtime rather than bundling them.
 *
 * The standalone server is emitted as CommonJS chunks and externalizes the
 * native database packages. Keep those requests as static `require()` calls so
 * webpack preserves the external boundary. Development and tests run as ESM,
 * where `require` is unavailable; the `createRequire(import.meta.url)` fallback
 * handles those callers.
 *
 * Bundler CJS shims (Turbopack chunk runtime) can reject aliased require
 * expressions with "Cannot find module ... expression is too dynamic" even
 * though the package is present in the runtime's node_modules — which silently
 * degraded every DB handle opened from a route chunk to the sql.js WASM
 * in-memory adapter (writes never reached disk; model syncs "succeeded" in
 * memory only). The fallback anchors a createRequire at the runtime root
 * (cwd carries the traced package.json + node_modules) so the native
 * better-sqlite3 driver always loads in standalone deployments.
 */
import * as nodeModule from "node:module";
import * as nodePath from "node:path";

function requireFromRuntimeRoot(specifier: string): unknown {
  try {
    const rootRequire = nodeModule.createRequire(nodePath.join(process.cwd(), "package.json"));
    return rootRequire(specifier);
  } catch {
    return nodeModule.createRequire(import.meta.url)(specifier);
  }
}

function esmRuntimeRequire(specifier: string): unknown {
  return requireFromRuntimeRoot(specifier);
}

export function runtimeRequire(specifier: string): unknown {
  const isCjs = typeof module !== "undefined" && typeof module.require === "function";
  if (isCjs) {
    const req = module.require;
    try {
      switch (specifier) {
        case "better-sqlite3":
          return req("better-sqlite3");
        case "node:sqlite":
          return req("node:sqlite");
        case "bun:sqlite":
          return req("bun:sqlite");
        case "sql.js":
          return req("sql.js");
        case "sqlite-vec":
          return req("sqlite-vec");
      }
      throw new Error(`Unsupported SQLite driver module: ${specifier}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/too dynamic|Cannot find module/.test(message)) throw err;
      return requireFromRuntimeRoot(specifier);
    }
  }

  return esmRuntimeRequire(specifier);
}
