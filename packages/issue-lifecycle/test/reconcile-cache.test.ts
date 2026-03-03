import assert from "node:assert/strict";
import test from "node:test";
import { main, requireExactRelease } from "../src/reconcile.ts";

const rejection = "Pinned reconciliation requires an exact release a4s@vX.Y.Z, never a moving ref";

test("cache guard accepts exact build IDs and historical SemVer releases", () => {
  for (const ref of ["a4s@r462", "a4s@v0.7.8"]) {
    assert.doesNotThrow(() => requireExactRelease(ref));
  }
});

test("cache guard rejects moving and malformed refs with the existing message", async () => {
  for (const ref of ["a4s@v0", "a4s@r", "a4s@r0462", "a4s@r-1", "a4s@r462.1", "a4s@r462extra", "a4s@v0.7", "a4s@v00.7.8", "a4s@v0.7.8-beta", "a4s@main", ""]) {
    assert.throws(() => requireExactRelease(ref), { message: rejection });
    await assert.rejects(main(["cache", "--release", ref]), { message: rejection });
  }
});
