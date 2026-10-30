import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/reconcile.ts";

test("retired reconciler cache/render pin interfaces are not retained", async () => {
  for (const args of [["cache", "--release", "a4s@r462"], ["render", "--artifact", "r462@sha#digest"]]) {
    await assert.rejects(main(args), /Usage: a4s reconcile classify/);
  }
});
