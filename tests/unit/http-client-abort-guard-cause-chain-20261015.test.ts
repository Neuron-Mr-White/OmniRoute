// 2026-10-15 production exit 7 — two sibling escapes killed the process
// (systemd restart → ~17 s nginx 502 storm). Both were already handled by the
// request layer; only the stray copy delivered to the process guard was
// process-fatal. Hot-patched into compiled chunks on 2026-10-15 and carried at
// source since the v3.8.52 rebuild:
//
//   1. undici `InformationalError` (code UND_ERR_INFO) — an interim 1xx event
//      undici already consumes internally; a leaked copy reached the guard
//      unclassified next to ECANCELED, the closest benign sibling.
//   2. `TypeError: terminated` — undici/Node wrap the syscall failure, and the
//      real code (e.g. ECONNRESET) rides on `cause`, which none of the
//      classifiers inspected.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isClientAbortError,
  shouldSwallowUncaught,
} from "../../src/shared/utils/httpClientAbortGuard.mjs";

test("isClientAbortError recognizes undici InformationalError (UND_ERR_INFO)", () => {
  const err = Object.assign(new Error("Request failed"), { code: "UND_ERR_INFO" });
  assert.equal(isClientAbortError(err), true);
  // Arbitrary TypeErrors must still crash loudly.
  assert.equal(isClientAbortError(new TypeError("cannot read properties of undefined")), false);
});

test("shouldSwallowUncaught classifies undici InformationalError as benign", () => {
  const err = Object.assign(new Error("Request failed"), { code: "UND_ERR_INFO" });
  assert.equal(shouldSwallowUncaught(err, "uncaughtException"), true);
  assert.equal(shouldSwallowUncaught(err, "unhandledRejection"), true);
});

test("shouldSwallowUncaught walks the cause chain for wrapped failures", () => {
  // Exact production shape: undici terminates the body and wraps the syscall
  // error — the classifier-relevant code lives on `cause`, not on the error.
  const terminated = new TypeError("terminated", {
    cause: Object.assign(new Error("other side closed"), { code: "ECONNRESET" }),
  });
  assert.equal(shouldSwallowUncaught(terminated, "uncaughtException"), true);

  // fetch failed wrapping a socket error (same wrapper family).
  const fetchFailed = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }),
  });
  assert.equal(shouldSwallowUncaught(fetchFailed, "unhandledRejection"), true);

  // One benign level deeper (undici can chain twice: terminated → info → code).
  const nested = new TypeError("terminated", {
    cause: Object.assign(new Error("Request failed"), { code: "UND_ERR_INFO" }),
  });
  assert.equal(shouldSwallowUncaught(nested, "uncaughtException"), true);
});

test("shouldSwallowUncaught still crashes on a wrapped genuine bug", () => {
  const bug = new TypeError("cannot read properties of undefined (reading 'map')", {
    cause: Object.assign(new Error("boom"), { code: "EINVAL" }),
  });
  assert.equal(shouldSwallowUncaught(bug, "uncaughtException"), false);
  // An unclassified wrapper with no cause stays fatal too.
  assert.equal(shouldSwallowUncaught(new TypeError("terminated"), "uncaughtException"), false);
});
